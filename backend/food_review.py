"""
gofit.today — unmatched-dish review queue (grows the verified food DB over time).

Every scan is anchored against the real food DB (see main.py's anchor_items());
when an item DOESN'T match, its macros/micros currently come from the AI's own
per-photo estimate (source="ai" -- see micros.ts's "Estimated" labeling on the
client). That's fine for one meal, but if we never look at what keeps failing
to match, real coverage gaps (pav bhaji, vada pav, bhel puri, etc. -- flagged
in an earlier audit) just repeat forever with nobody noticing which dishes are
most worth curating next.

This module is the durable log of that: every unmatched item name increments a
counter and refreshes a sample of the AI's own estimate, so a human (or a
future automated pass) can query "what are our most-scanned dishes that still
have no verified DB entry" and prioritize adding exactly those -- turning
implicit usage into a real backlog instead of leaving the gap invisible. There
is no automatic "training" here (no model weights change); this is a data
curation queue, same principle as the existing indian_food_db_expanded.json
draft, just fed from real usage instead of a one-off manual pass.

Endpoints (mounted under /admin):
  GET /admin/unmatched-foods  (X-Admin-Key)  -> most-frequently-scanned
                                                 dishes with no DB match yet,
                                                 ranked by seen_count desc.
                                                 Same gate as /admin/audit.
"""
import json
import time
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Header

import db
from audit import ADMIN_KEY  # reuse the same admin secret, one gate for all /admin/*

log = logging.getLogger("gofit.food_review")

router = APIRouter(prefix="/admin", tags=["admin"])


def init_db() -> None:
    with db.connect() as c:
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS unmatched_dishes (
                name          TEXT PRIMARY KEY,
                seen_count    INTEGER NOT NULL DEFAULT 1,
                first_seen_at REAL NOT NULL,
                last_seen_at  REAL NOT NULL,
                sample_kcal   REAL,
                sample_protein_g REAL,
                sample_carbs_g REAL,
                sample_fat_g  REAL,
                sample_micros_json TEXT
            )
            """
        )


def record_unmatched(name: str, item: dict) -> None:
    """Upsert one unmatched-item sighting. Best-effort/non-fatal -- a failure
    here must never break the actual /analyze response the user is waiting on."""
    key = (name or "").strip().lower()
    if not key:
        return
    try:
        micros = item.get("micros_estimate")
        micros_json = json.dumps(micros) if micros else None
        now = time.time()
        with db.write_lock(), db.connect() as c:
            c.execute(
                """
                INSERT INTO unmatched_dishes
                    (name, seen_count, first_seen_at, last_seen_at,
                     sample_kcal, sample_protein_g, sample_carbs_g, sample_fat_g, sample_micros_json)
                VALUES (?,1,?,?,?,?,?,?,?)
                ON CONFLICT(name) DO UPDATE SET
                    seen_count = unmatched_dishes.seen_count + 1,
                    last_seen_at = excluded.last_seen_at,
                    sample_kcal = excluded.sample_kcal,
                    sample_protein_g = excluded.sample_protein_g,
                    sample_carbs_g = excluded.sample_carbs_g,
                    sample_fat_g = excluded.sample_fat_g,
                    sample_micros_json = excluded.sample_micros_json
                """,
                (
                    key, now, now,
                    item.get("kcal_per_unit"), item.get("protein_g_per_unit"),
                    item.get("carbs_g_per_unit"), item.get("fat_g_per_unit"),
                    micros_json,
                ),
            )
    except Exception:
        log.exception("record_unmatched failed for %r (non-fatal)", key)


@router.get("/unmatched-foods")
def list_unmatched_foods(limit: int = 100, x_admin_key: str = Header(default="")):
    """Most-scanned dishes with no verified DB entry, ranked by how often
    real users have hit them -- the actual priority list for growing
    indian_food_db.json next, instead of guessing which dishes matter."""
    if not ADMIN_KEY:
        raise HTTPException(status_code=404, detail="Not found")
    if x_admin_key.strip() != ADMIN_KEY:
        raise HTTPException(status_code=401, detail="Invalid admin key")
    limit = max(1, min(limit, 500))
    with db.connect() as c:
        rows = c.execute(
            "SELECT * FROM unmatched_dishes ORDER BY seen_count DESC, last_seen_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        if d.get("sample_micros_json"):
            try:
                d["sample_micros"] = json.loads(d["sample_micros_json"])
            except (TypeError, ValueError):
                d["sample_micros"] = None
        d.pop("sample_micros_json", None)
        out.append(d)
    return {"rows": out}
