"""
gofit.today — payments (Razorpay).

Pro upgrades are processed with Razorpay. The flow is authoritative on the
server so the client never sees the key secret and can't self-grant Pro:

  1. POST /pay/order   (Bearer) -> create a Razorpay order for the signed-in
                                    account (amount fixed server-side), persist
                                    it, and return the public {keyId, orderId,...}.
  2. Client opens Razorpay Checkout (web: checkout.js; native: the hosted
     /pay/checkout page via an in-app browser).
  3. POST /pay/verify  {order_id, payment_id, signature}
                                 -> verify the HMAC signature with the key
                                    secret, then mark THAT order's account Pro.
                                    No bearer needed: the signature proves the
                                    payment and the order is bound to an account.
  4. POST /pay/webhook           -> durable backstop. Razorpay calls this with a
                                    signed body; on payment.captured / order.paid
                                    we mark the order's account Pro (idempotent).

Config (env / .env):
  RAZORPAY_KEY_ID           public key id (rzp_test_… / rzp_live_…)
  RAZORPAY_KEY_SECRET       secret — server only, never shipped
  RAZORPAY_WEBHOOK_SECRET   secret configured on the Razorpay webhook
  PRO_PRICE_PAISE           price in paise (default 29900 = ₹299)
  PRO_CURRENCY              default INR
  PRO_PLAN_NAME             shown in checkout
"""
import os
import time
import json
import hmac
import base64
import hashlib
import logging
import urllib.request
import urllib.error
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

import db
import auth
import audit

log = logging.getLogger("gofit.pay")

router = APIRouter(prefix="/pay", tags=["payments"])

RAZORPAY_KEY_ID = os.environ.get("RAZORPAY_KEY_ID", "").strip()
RAZORPAY_KEY_SECRET = os.environ.get("RAZORPAY_KEY_SECRET", "").strip()
RAZORPAY_WEBHOOK_SECRET = os.environ.get("RAZORPAY_WEBHOOK_SECRET", "").strip()

PRO_PRICE_PAISE = int(os.environ.get("PRO_PRICE_PAISE", "29900"))
PRO_CURRENCY = os.environ.get("PRO_CURRENCY", "INR").strip() or "INR"
PRO_PLAN_NAME = os.environ.get("PRO_PLAN_NAME", "gofit.today Pro").strip()

_RZP_API = "https://api.razorpay.com/v1"


def configured() -> bool:
    """True when both Razorpay keys are present (payments can run)."""
    return bool(RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET)


# --- storage -----------------------------------------------------------------
def init_db() -> None:
    """Create the pro_orders table (order -> account binding + status)."""
    with db.connect() as c:
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS pro_orders (
                order_id   TEXT PRIMARY KEY,
                account_id INTEGER NOT NULL,
                amount     INTEGER NOT NULL,
                currency   TEXT NOT NULL,
                status     TEXT NOT NULL DEFAULT 'created',
                payment_id TEXT,
                created_at REAL NOT NULL
            )
            """
        )


def _save_order(order_id: str, account_id: int, amount: int, currency: str) -> None:
    with db.connect() as c:
        c.execute(
            "INSERT OR IGNORE INTO pro_orders "
            "(order_id, account_id, amount, currency, status, created_at) "
            "VALUES (?,?,?,?,?,?)",
            (order_id, account_id, amount, currency, "created", time.time()),
        )


def _get_order(order_id: str) -> Optional[dict]:
    with db.connect() as c:
        row = c.execute(
            "SELECT * FROM pro_orders WHERE order_id=?", (order_id,)
        ).fetchone()
    return dict(row) if row else None


def _mark_paid(order_id: str, payment_id: str) -> None:
    with db.connect() as c:
        c.execute(
            "UPDATE pro_orders SET status='paid', payment_id=? WHERE order_id=?",
            (payment_id, order_id),
        )


# --- Razorpay REST -----------------------------------------------------------
def _rzp_create_order(amount: int, currency: str, account_id: int) -> dict:
    """Create a Razorpay order via the REST API (HTTP Basic key_id:key_secret)."""
    payload = json.dumps(
        {
            "amount": amount,
            "currency": currency,
            "receipt": f"pro_{account_id}_{int(time.time())}",
            "notes": {"account_id": str(account_id), "plan": PRO_PLAN_NAME},
        }
    ).encode("utf-8")
    basic = base64.b64encode(
        f"{RAZORPAY_KEY_ID}:{RAZORPAY_KEY_SECRET}".encode("utf-8")
    ).decode("ascii")
    req = urllib.request.Request(
        f"{_RZP_API}/orders",
        data=payload,
        headers={
            "Authorization": f"Basic {basic}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")
        log.warning("razorpay order failed: %s %s", e.code, detail)
        raise HTTPException(status_code=502, detail="Could not start the payment. Please try again.")
    except Exception as e:
        log.warning("razorpay order error: %s", e)
        raise HTTPException(status_code=502, detail="Could not reach the payment provider.")


def _verify_payment_signature(order_id: str, payment_id: str, signature: str) -> bool:
    """Checkout handler signature: HMAC_SHA256(order_id|payment_id, key_secret)."""
    expected = hmac.new(
        RAZORPAY_KEY_SECRET.encode("utf-8"),
        f"{order_id}|{payment_id}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, (signature or "").strip())


def _verify_webhook_signature(raw_body: bytes, signature: str) -> bool:
    expected = hmac.new(
        RAZORPAY_WEBHOOK_SECRET.encode("utf-8"),
        raw_body,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, (signature or "").strip())


def _grant_pro(order_id: str, payment_id: str, source: str) -> Optional[dict]:
    """Idempotently mark an order paid and flip its account to Pro.

    `source` records HOW we found out ("verify" = client-side checkout
    callback, "webhook" = Razorpay's own server-to-server confirmation) --
    useful later for spotting the difference between "user closed the app
    before the callback fired" (webhook-only) vs the normal path."""
    order = _get_order(order_id)
    if not order:
        log.warning("verify: unknown order %s", order_id)
        return None
    already_paid = order["status"] == "paid"
    if not already_paid:
        _mark_paid(order_id, payment_id)
    account = auth.set_pro(order["account_id"], True)
    audit.record(
        "pro_granted",
        status="already_paid" if already_paid else "success",
        account_id=order["account_id"],
        order_id=order_id,
        payment_id=payment_id,
        amount=order["amount"],
        currency=order["currency"],
        detail=f"source={source}",
    )
    return account


# --- request models ----------------------------------------------------------
class VerifyBody(BaseModel):
    razorpay_order_id: str = Field(..., min_length=6, max_length=64)
    razorpay_payment_id: str = Field(..., min_length=6, max_length=64)
    razorpay_signature: str = Field(..., min_length=16, max_length=256)


# --- endpoints ---------------------------------------------------------------
@router.get("/config")
def pay_config():
    """Public: lets the client know if real payments are available."""
    return {
        "configured": configured(),
        "keyId": RAZORPAY_KEY_ID if configured() else "",
        "amount": PRO_PRICE_PAISE,
        "currency": PRO_CURRENCY,
        "name": PRO_PLAN_NAME,
    }


@router.post("/order")
def create_order(request: Request):
    """Create a Razorpay order for the signed-in account (amount fixed here)."""
    if not configured():
        raise HTTPException(status_code=503, detail="Payments are not configured yet.")
    acct = auth.require_account(request)
    try:
        order = _rzp_create_order(PRO_PRICE_PAISE, PRO_CURRENCY, acct["id"])
    except HTTPException as e:
        audit.record(
            "order_create_failed",
            status=str(e.status_code),
            account_id=acct["id"],
            amount=PRO_PRICE_PAISE,
            currency=PRO_CURRENCY,
            detail=e.detail,
            request=request,
        )
        raise
    _save_order(order["id"], acct["id"], PRO_PRICE_PAISE, PRO_CURRENCY)
    audit.record(
        "order_created",
        status="created",
        account_id=acct["id"],
        order_id=order["id"],
        amount=PRO_PRICE_PAISE,
        currency=PRO_CURRENCY,
        request=request,
    )
    contact = auth.account_contact(acct["id"])
    return {
        "keyId": RAZORPAY_KEY_ID,
        "orderId": order["id"],
        "amount": order["amount"],
        "currency": order["currency"],
        "name": PRO_PLAN_NAME,
        "prefill": {"name": contact["name"], "email": contact["email"]},
    }


@router.post("/verify")
def verify(body: VerifyBody, request: Request):
    """Verify the checkout signature and upgrade the order's account to Pro."""
    if not configured():
        raise HTTPException(status_code=503, detail="Payments are not configured yet.")
    order = _get_order(body.razorpay_order_id)
    if not _verify_payment_signature(
        body.razorpay_order_id, body.razorpay_payment_id, body.razorpay_signature
    ):
        # A bad signature on /verify is either a client bug or someone probing
        # the endpoint with a guessed/forged signature -- worth a permanent
        # record either way, tied to the account if we can resolve one.
        audit.record(
            "payment_verify_failed",
            status="invalid_signature",
            account_id=order["account_id"] if order else None,
            order_id=body.razorpay_order_id,
            payment_id=body.razorpay_payment_id,
            request=request,
        )
        raise HTTPException(status_code=400, detail="Payment could not be verified.")
    account = _grant_pro(body.razorpay_order_id, body.razorpay_payment_id, source="verify")
    if not account:
        audit.record(
            "payment_verify_failed",
            status="unknown_order",
            order_id=body.razorpay_order_id,
            payment_id=body.razorpay_payment_id,
            request=request,
        )
        raise HTTPException(status_code=404, detail="Order not found.")
    return {"ok": True, "account": account}


@router.post("/webhook")
async def webhook(request: Request):
    """Durable backstop: Razorpay posts a signed event; grant Pro on capture."""
    raw = await request.body()
    sig = request.headers.get("x-razorpay-signature", "")
    if not RAZORPAY_WEBHOOK_SECRET or not _verify_webhook_signature(raw, sig):
        # An unsigned/mis-signed request to a payment webhook is worth keeping
        # a record of -- it's either a misconfigured webhook secret on our end
        # or someone hitting the endpoint directly.
        audit.record("webhook_rejected", status="invalid_signature", request=request)
        raise HTTPException(status_code=400, detail="Invalid signature")
    try:
        event = json.loads(raw.decode("utf-8"))
    except Exception:
        audit.record("webhook_rejected", status="bad_payload", request=request)
        raise HTTPException(status_code=400, detail="Bad payload")

    kind = event.get("event", "")
    entity = (
        event.get("payload", {})
        .get("payment", {})
        .get("entity", {})
    )
    order_id = entity.get("order_id")
    payment_id = entity.get("id", "")
    audit.record(
        "webhook_received",
        status="processed",
        order_id=order_id,
        payment_id=payment_id,
        detail=kind,
        request=request,
    )
    if kind in ("payment.captured", "order.paid") and order_id:
        _grant_pro(order_id, payment_id, source="webhook")
    return {"ok": True}


@router.get("/checkout", response_class=HTMLResponse)
def checkout(order_id: str, key: str, amount: int, name: str = PRO_PLAN_NAME,
             email: str = "", contact_name: str = "", currency: str = PRO_CURRENCY,
             redirect: str = ""):
    """Hosted Razorpay Checkout page for the native in-app-browser flow.

    Opens checkout.js for `order_id`; on success POSTs to /pay/verify, then
    redirects to the app's return URL with ?status=success|cancelled|failed."""
    tokens = {
        "{{KEY}}": key,
        "{{ORDER_ID}}": order_id,
        "{{AMOUNT}}": str(amount),
        "{{CURRENCY}}": currency,
        "{{NAME}}": name,
        "{{EMAIL}}": email,
        "{{CONTACT_NAME}}": contact_name,
        "{{REDIRECT}}": redirect,
    }
    html = _CHECKOUT_HTML
    for k, v in tokens.items():
        html = html.replace(k, json.dumps(v)[1:-1])  # JS-string-safe escaping
    return HTMLResponse(content=html)


_CHECKOUT_HTML = """<!doctype html>
<html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>gofit.today Pro</title>
<style>
  html,body{height:100%;margin:0;background:#0B7A4B;color:#fff;
    font-family:-apple-system,Segoe UI,Roboto,sans-serif;display:flex;
    align-items:center;justify-content:center;text-align:center}
  .card{padding:24px}
  .dot{width:40px;height:40px;border:4px solid rgba(255,255,255,.35);
    border-top-color:#fff;border-radius:50%;margin:0 auto 14px;
    animation:spin 1s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
</style></head>
<body>
  <div class="card"><div class="dot"></div><div id="msg">Opening secure checkout…</div></div>
  <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
  <script>
    var REDIRECT = "{{REDIRECT}}";
    function done(status){
      if (REDIRECT) {
        var sep = REDIRECT.indexOf("?") >= 0 ? "&" : "?";
        window.location.replace(REDIRECT + sep + "status=" + status);
      } else {
        document.getElementById("msg").textContent =
          status === "success" ? "Payment successful. You can close this window."
                               : "Payment " + status + ". You can close this window.";
      }
    }
    function verify(resp){
      fetch("/pay/verify", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          razorpay_order_id: resp.razorpay_order_id,
          razorpay_payment_id: resp.razorpay_payment_id,
          razorpay_signature: resp.razorpay_signature
        })
      }).then(function(r){ done(r.ok ? "success" : "failed"); })
        .catch(function(){ done("failed"); });
    }
    var rzp = new Razorpay({
      key: "{{KEY}}",
      order_id: "{{ORDER_ID}}",
      amount: {{AMOUNT}},
      currency: "{{CURRENCY}}",
      name: "{{NAME}}",
      description: "Pro subscription",
      prefill: { name: "{{CONTACT_NAME}}", email: "{{EMAIL}}" },
      theme: { color: "#0B7A4B" },
      handler: verify,
      modal: { ondismiss: function(){ done("cancelled"); } }
    });
    rzp.on("payment.failed", function(){ done("failed"); });
    rzp.open();
  </script>
</body></html>"""
