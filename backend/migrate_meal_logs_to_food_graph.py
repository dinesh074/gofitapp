"""
One-time backfill: bridge pre-existing meal_logs rows into the canonical
food graph (gofit_food_logs / gofit_food_log_items).

Background: food_graph.record_food_log() only started being called from
progress.py's POST /logs handler once the canonical food graph was
introduced -- so every meal_logs row written BEFORE that point (and, until
this same session's fix, every row logged without an itemized food_items
breakdown) has no corresponding gofit_food_logs row. This script closes that
gap for existing data; the /logs handler fix (progress.py add_log) keeps it
closed going forward.

Safe to re-run: record_food_log() is idempotent per legacy_meal_log_id (it
looks up any existing gofit_food_logs row with that legacy id first and
returns its id instead of inserting a duplicate), so running this twice (or
after new meal_logs rows have been bridged normally) just no-ops for rows
that are already bridged.

Usage:
    python migrate_meal_logs_to_food_graph.py            # apply
    python migrate_meal_logs_to_food_graph.py --dry-run   # report only
"""
from __future__ import annotations

import json
import sys

import db
import food_graph


def _unbridged_meal_logs() -> list[dict]:
    with db.connect() as c:
        rows = c.execute(
            """
            SELECT ml.id, ml.account_id, ml.date, ml.dish, ml.food_items_json
            FROM meal_logs ml
            LEFT JOIN gofit_food_logs gfl ON gfl.legacy_meal_log_id = ml.id
            WHERE gfl.id IS NULL
            ORDER BY ml.id ASC
            """
        ).fetchall()
    return [dict(r) for r in rows]


def main() -> None:
    dry_run = "--dry-run" in sys.argv
    pending = _unbridged_meal_logs()
    print(f"Found {len(pending)} meal_logs row(s) not yet bridged into the canonical food graph.")
    if not pending:
        return
    if dry_run:
        for row in pending[:20]:
            print(f"  would bridge meal_log id={row['id']} account={row['account_id']} "
                  f"date={row['date']} dish={row['dish']!r}")
        if len(pending) > 20:
            print(f"  ... and {len(pending) - 20} more")
        print("Dry run only -- no writes made. Re-run without --dry-run to apply.")
        return

    bridged = 0
    failed = 0
    for row in pending:
        items = None
        raw = row.get("food_items_json")
        if raw:
            try:
                loaded = json.loads(raw)
                items = loaded if isinstance(loaded, list) else None
            except (TypeError, ValueError):
                items = None
        try:
            food_graph.record_food_log(
                row["account_id"],
                row["date"],
                row["dish"],
                legacy_meal_log_id=row["id"],
                items=items,
            )
            bridged += 1
        except Exception as ex:
            failed += 1
            print(f"  FAILED meal_log id={row['id']}: {ex}")
    print(f"Bridged {bridged} row(s), {failed} failure(s).")


if __name__ == "__main__":
    main()
