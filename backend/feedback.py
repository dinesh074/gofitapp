"""
gofit.today — in-app feedback & feature requests.

A simple way for signed-in users to tell us what's broken or what they want
next, without leaving the app. Every submission is tied to the real account
that sent it (so we can follow up), never anonymous -- by the time someone
can reach this screen they're already signed in (the app is Google-only),
so there's no extra friction in requiring it here too.

Endpoints:
  POST /feedback         (Bearer) {category, message} -> {ok, id}
  GET  /admin/feedback   (X-Admin-Key) -> recent submissions, most recent
                          first. Same gate as /admin/audit -- 404s when
                          ADMIN_KEY is unset.
"""
import time
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Header, Request
from pydantic import BaseModel, Field

import db
import auth
from audit import ADMIN_KEY  # reuse the same admin secret, one gate for both

log = logging.getLogger("gofit.feedback")

router = APIRouter(tags=["feedback"])

_CATEGORIES = {"bug", "feature", "general"}


def init_db() -> None:
    with db.connect() as c:
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS feedback (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id INTEGER NOT NULL,
                category   TEXT NOT NULL DEFAULT 'general',
                message    TEXT NOT NULL,
                status     TEXT NOT NULL DEFAULT 'new',
                created_at REAL NOT NULL
            )
            """
        )
        c.execute("CREATE INDEX IF NOT EXISTS idx_feedback_account ON feedback(account_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at)")


class FeedbackBody(BaseModel):
    category: str = Field("general", max_length=20)
    message: str = Field(..., min_length=3, max_length=2000)


@router.post("/feedback")
def submit_feedback(body: FeedbackBody, request: Request):
    """Record one piece of feedback against the signed-in account."""
    acct = auth.require_account(request)
    category = body.category.strip().lower()
    if category not in _CATEGORIES:
        category = "general"
    message = body.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="Feedback message can't be empty.")

    with db.write_lock(), db.connect() as c:
        cur = c.execute(
            "INSERT INTO feedback (account_id, category, message, status, created_at) "
            "VALUES (?,?,?,?,?)",
            (acct["id"], category, message, "new", time.time()),
        )
        new_id = cur.lastrowid
    log.info("feedback #%s from account %s [%s]", new_id, acct["id"], category)
    return {"ok": True, "id": new_id}


@router.get("/admin/feedback")
def list_feedback(
    limit: int = 100,
    category: Optional[str] = None,
    status: Optional[str] = None,
    x_admin_key: str = Header(default=""),
):
    """Recent feedback, most recent first. Same X-Admin-Key gate as /admin/audit."""
    if not ADMIN_KEY:
        raise HTTPException(status_code=404, detail="Not found")
    if x_admin_key.strip() != ADMIN_KEY:
        raise HTTPException(status_code=401, detail="Invalid admin key")
    limit = max(1, min(limit, 500))
    clauses, params = [], []
    if category:
        clauses.append("category = ?")
        params.append(category)
    if status:
        clauses.append("status = ?")
        params.append(status)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with db.connect() as c:
        rows = c.execute(
            f"""
            SELECT f.*, a.name AS account_name, a.email AS account_email
            FROM feedback f
            LEFT JOIN accounts a ON a.id = f.account_id
            {where}
            ORDER BY f.created_at DESC LIMIT ?
            """,
            (*params, limit),
        ).fetchall()
    return {"rows": [dict(r) for r in rows]}
