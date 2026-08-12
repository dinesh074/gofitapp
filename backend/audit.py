"""
gofit.today — audit log.

A durable, append-only record of money- and security-relevant events: Razorpay
order creation, payment verification (success AND failure -- a forged/replayed
signature attempt is exactly the kind of thing you want a permanent record of,
not just a line in a log file that vanishes on the next restart), webhook
deliveries, Pro grants, and account sign-ins.

This is deliberately NOT a replacement for the Razorpay dashboard, which stays
the source of truth for what actually happened with money. This is OUR side's
record of what OUR server did and why, so a real question like "did this
person's payment go through, when, and was it verified via the client
callback or the webhook backstop?" can be answered by querying our own DB
instead of reconstructing it from memory or console logs.

Write-once by design: nothing in this module ever UPDATEs or DELETEs a row.
The only mutation path is `record()` (INSERT). There is no admin endpoint to
edit or remove entries -- if a row is wrong, the fix is a new row, not editing
history, same principle as a paper ledger.

Endpoints (mounted under /admin):
  GET /admin/audit  (X-Admin-Key)  -> recent audit rows, most recent first.
                                       404s (not 401) when ADMIN_KEY is unset,
                                       so its mere existence isn't advertised.
"""
import os
import time
import logging
from typing import Optional

from fastapi import APIRouter, Header, HTTPException, Request

import db

log = logging.getLogger("gofit.audit")

router = APIRouter(prefix="/admin", tags=["admin"])

# Separate from APP_API_KEY on purpose: that key gates the mobile app's own
# calls, this one gates a human looking at the audit trail. Leave unset to
# disable the read endpoint entirely -- the table is still written either way,
# so audit capture doesn't depend on ever configuring this.
ADMIN_KEY = os.environ.get("ADMIN_KEY", "").strip()


def init_db() -> None:
    with db.connect() as c:
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at REAL NOT NULL,
                event TEXT NOT NULL,
                account_id INTEGER,
                order_id TEXT,
                payment_id TEXT,
                amount INTEGER,
                currency TEXT,
                status TEXT NOT NULL,
                detail TEXT,
                ip TEXT
            )
            """
        )
        c.execute("CREATE INDEX IF NOT EXISTS idx_audit_account ON audit_log(account_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_audit_order ON audit_log(order_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_log(event)")


def _client_ip(request: Optional[Request]) -> Optional[str]:
    if request is None:
        return None
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else None


def record(
    event: str,
    status: str,
    account_id: Optional[int] = None,
    order_id: Optional[str] = None,
    payment_id: Optional[str] = None,
    amount: Optional[int] = None,
    currency: Optional[str] = None,
    detail: Optional[str] = None,
    request: Optional[Request] = None,
) -> None:
    """Append one row. Best-effort: a broken audit write must never break the
    real request it's describing, so failures are swallowed (and logged)."""
    try:
        with db.write_lock(), db.connect() as c:
            c.execute(
                "INSERT INTO audit_log "
                "(created_at, event, account_id, order_id, payment_id, amount, currency, status, detail, ip) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                (
                    time.time(),
                    event,
                    account_id,
                    order_id,
                    payment_id,
                    amount,
                    currency,
                    status,
                    detail,
                    _client_ip(request),
                ),
            )
    except Exception:
        log.exception("audit write failed for event=%s status=%s", event, status)


@router.get("/audit")
def list_audit(
    limit: int = 100,
    event: Optional[str] = None,
    account_id: Optional[int] = None,
    x_admin_key: str = Header(default=""),
):
    """Recent audit rows, most recent first. Requires X-Admin-Key == ADMIN_KEY.

    404s (rather than 401/403) when ADMIN_KEY isn't configured, so an
    unconfigured deployment doesn't even reveal that this endpoint exists."""
    if not ADMIN_KEY:
        raise HTTPException(status_code=404, detail="Not found")
    if x_admin_key.strip() != ADMIN_KEY:
        raise HTTPException(status_code=401, detail="Invalid admin key")
    limit = max(1, min(limit, 500))
    clauses, params = [], []
    if event:
        clauses.append("event = ?")
        params.append(event)
    if account_id is not None:
        clauses.append("account_id = ?")
        params.append(account_id)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with db.connect() as c:
        rows = c.execute(
            f"SELECT * FROM audit_log {where} ORDER BY created_at DESC LIMIT ?",
            (*params, limit),
        ).fetchall()
    return {"rows": [dict(r) for r in rows]}
