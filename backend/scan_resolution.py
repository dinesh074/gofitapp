"""
Scanner confidence/correction loop endpoints.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import auth
import db
import food_graph

router = APIRouter(tags=["scan-resolution"])


class CorrectionBody(BaseModel):
    scan_result_id: int = Field(..., gt=0)
    item_name: str = Field(..., min_length=1, max_length=120)
    from_food_name: str | None = Field(default=None, max_length=120)
    to_food_name: str | None = Field(default=None, max_length=120)
    note: str | None = Field(default=None, max_length=500)


@router.get("/scan/results")
def scan_results(request: Request, limit: int = 50):
    acct = auth.require_account(request)
    lim = max(1, min(200, limit))
    with db.connect() as c:
        rows = c.execute(
            "SELECT id, confidence, status, created_at FROM gofit_ai_scan_results WHERE account_id=? ORDER BY id DESC LIMIT ?",
            (acct["id"], lim),
        ).fetchall()
    return {
        "results": [
            {
                "id": r["id"],
                "confidence": r["confidence"],
                "status": r["status"],
                "created_at": r["created_at"],
            }
            for r in rows
        ]
    }


@router.post("/scan/corrections")
def add_scan_correction(body: CorrectionBody, request: Request):
    acct = auth.require_account(request)
    with db.connect() as c:
        row = c.execute(
            "SELECT id FROM gofit_ai_scan_results WHERE id=? AND account_id=?",
            (body.scan_result_id, acct["id"]),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Scan result not found")
    cid = food_graph.record_scan_correction(
        acct["id"],
        body.scan_result_id,
        body.item_name.strip(),
        from_food_name=(body.from_food_name or "").strip() or None,
        to_food_name=(body.to_food_name or "").strip() or None,
        note=(body.note or "").strip() or None,
    )
    return {"ok": True, "id": cid}

