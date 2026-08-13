"""Per-account UI preferences that need to follow the user across devices.

Currently stores the Home dashboard layout (which modules are shown, and in what
order). This is a real, persisted data model -- not local-only device state --
so a user who reorders their dashboard on one device sees the same layout on the
next. The layout is stored as a small JSON blob keyed by account.
"""

import json
import logging
import time

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

import db
import auth

log = logging.getLogger("gofit.prefs")

router = APIRouter(prefix="/prefs", tags=["prefs"])


def init_db():
    with db.write_lock(), db.connect() as c:
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS user_prefs (
                account_id  INTEGER PRIMARY KEY,
                home_layout TEXT,
                updated_at  REAL
            )
            """
        )


class HomeLayout(BaseModel):
    # Ordered list of module keys top-to-bottom. Client owns the canonical set of
    # keys and merges anything missing, so adding a new module later still shows
    # up for existing users instead of vanishing.
    order: list[str]
    # Keys the user has chosen to hide.
    hidden: list[str] = []


@router.get("/home")
def get_home(request: Request):
    acct = auth.require_account(request)
    with db.connect() as c:
        row = c.execute(
            "SELECT home_layout FROM user_prefs WHERE account_id=?", (acct["id"],)
        ).fetchone()
    if not row or not row["home_layout"]:
        # Null = "never customized"; the client falls back to its default order.
        return {"layout": None}
    try:
        return {"layout": json.loads(row["home_layout"])}
    except (ValueError, TypeError):
        return {"layout": None}


@router.put("/home")
def put_home(body: HomeLayout, request: Request):
    acct = auth.require_account(request)
    # Defensive caps so a malformed client can't write an unbounded blob.
    order = [str(k)[:40] for k in body.order][:40]
    hidden = [str(k)[:40] for k in body.hidden][:40]
    payload = json.dumps({"order": order, "hidden": hidden})
    now = time.time()
    with db.write_lock(), db.connect() as c:
        c.execute(
            """
            INSERT INTO user_prefs (account_id, home_layout, updated_at)
            VALUES (?,?,?)
            ON CONFLICT(account_id) DO UPDATE SET
                home_layout = excluded.home_layout,
                updated_at  = excluded.updated_at
            """,
            (acct["id"], payload, now),
        )
    return {"layout": {"order": order, "hidden": hidden}}
