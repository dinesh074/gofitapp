"""
gofit.today -- transactional email (Resend).

One tiny wrapper around Resend's HTTP API so the rest of the backend can call
`send_email(...)` without caring which provider is behind it. If RESEND_API_KEY
isn't set (local dev, or before you've created a Resend account), sends are
skipped with a log line instead of raising -- registration/login must never
fail just because email isn't configured yet.

Setup (one-time):
  1. Create a free account at https://resend.com
  2. Add + verify the sending domain (build.in) under Domains -- add the DNS
     records Resend gives you (SPF/DKIM) at your domain registrar. Until the
     domain is verified, Resend will reject sends from info@build.in.
  3. Create an API key under API Keys, set RESEND_API_KEY in .env.
  4. Optionally override RESEND_FROM (defaults to "gofit.today <info@build.in>").
"""
import json
import logging
import os
import urllib.request

log = logging.getLogger("gofit")

RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "").strip()
RESEND_FROM = os.environ.get("RESEND_FROM", "gofit.today <info@build.in>").strip()
RESEND_URL = "https://api.resend.com/emails"


def send_email(to: str, subject: str, html: str) -> bool:
    """Best-effort send. Returns True if actually sent, False otherwise (never
    raises -- callers use this for welcome/OTP mail, which must not block or
    break the auth flow it's attached to)."""
    if not RESEND_API_KEY:
        log.warning("email skipped (RESEND_API_KEY not set): to=%s subject=%r", to, subject)
        return False
    if not to:
        return False
    body = json.dumps(
        {"from": RESEND_FROM, "to": [to], "subject": subject, "html": html}
    ).encode("utf-8")
    req = urllib.request.Request(
        RESEND_URL,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {RESEND_API_KEY}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            ok = 200 <= resp.status < 300
            if not ok:
                log.warning("resend send failed: status=%s to=%s", resp.status, to)
            return ok
    except Exception as e:
        log.warning("resend send error: %s to=%s", e, to)
        return False


def _shell(title: str, body_html: str) -> str:
    return f"""
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <div style="text-align:center;margin-bottom:24px">
        <span style="font-size:22px;font-weight:800;color:#0F9D58">gofit.today</span>
      </div>
      <div style="background:#fff;border:1px solid #eee;border-radius:16px;padding:28px">
        <h2 style="margin:0 0 12px;color:#111;font-size:20px">{title}</h2>
        {body_html}
      </div>
      <p style="text-align:center;color:#999;font-size:12px;margin-top:20px">
        gofit.today &middot; sent to you because you have an account with us
      </p>
    </div>
    """


def send_welcome_email(to: str, name: str) -> bool:
    body = f"""
      <p style="color:#444;font-size:15px;line-height:1.5">
        Hi {name or "there"}, welcome to <b>gofit.today</b> — your account is ready.
        Log your first meal to get your personalised calorie and macro targets.
      </p>
    """
    return send_email(to, "Welcome to gofit.today 🎉", _shell("Welcome aboard!", body))


def send_otp_email(to: str, code: str) -> bool:
    body = f"""
      <p style="color:#444;font-size:15px;line-height:1.5">Your sign-in code is:</p>
      <p style="font-size:32px;font-weight:800;letter-spacing:6px;color:#0F9D58;margin:16px 0">{code}</p>
      <p style="color:#999;font-size:13px">This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>
    """
    return send_email(to, f"{code} is your gofit.today sign-in code", _shell("Sign-in code", body))
