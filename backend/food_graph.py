"""
Canonical Food Intelligence Graph (additive, compatibility-safe).
"""
from __future__ import annotations

import json
import logging
import os
import re
import time

import db

log = logging.getLogger("gofit.food_graph")


def _norm(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", (value or "").lower())).strip()


def _ensure_column(c, table: str, column: str, decl: str) -> None:
    if column not in db.table_columns(c, table):
        c.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")


def init_db() -> None:
    with db.write_lock(), db.connect() as c:
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS gofit_data_sources (
                code            TEXT PRIMARY KEY,
                display_name    TEXT NOT NULL,
                kind            TEXT NOT NULL,
                provenance_json TEXT,
                created_at      REAL NOT NULL
            )
            """
        )
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS gofit_food_entities (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                food_key      TEXT NOT NULL UNIQUE,
                display_name  TEXT NOT NULL,
                default_unit  TEXT NOT NULL,
                source_name   TEXT,
                source_code   TEXT,
                created_at    REAL NOT NULL
            )
            """
        )
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS gofit_food_aliases (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                food_id     INTEGER NOT NULL,
                alias_text  TEXT NOT NULL,
                alias_norm  TEXT NOT NULL,
                created_at  REAL NOT NULL,
                UNIQUE (food_id, alias_norm)
            )
            """
        )
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS gofit_food_nutrients (
                food_id              INTEGER PRIMARY KEY,
                kcal_per_unit        REAL NOT NULL DEFAULT 0,
                protein_g_per_unit   REAL NOT NULL DEFAULT 0,
                carbs_g_per_unit     REAL NOT NULL DEFAULT 0,
                fat_g_per_unit       REAL NOT NULL DEFAULT 0,
                fiber_g              REAL,
                sugar_g              REAL,
                sodium_mg            REAL,
                potassium_mg         REAL,
                calcium_mg           REAL,
                iron_mg              REAL,
                micros_json          TEXT,
                health_score         REAL,
                jain_status          TEXT,
                sattvic_status       TEXT,
                updated_at           REAL NOT NULL
            )
            """
        )
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS gofit_food_portions (
                food_id          INTEGER NOT NULL,
                portion_name     TEXT NOT NULL,
                grams            REAL,
                unit_multiplier  REAL NOT NULL DEFAULT 1,
                PRIMARY KEY (food_id, portion_name)
            )
            """
        )
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS gofit_food_logs (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id          INTEGER NOT NULL,
                date                TEXT NOT NULL,
                dish                TEXT NOT NULL,
                created_at          REAL NOT NULL,
                legacy_meal_log_id  INTEGER UNIQUE
            )
            """
        )
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS gofit_food_log_items (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                food_log_id   INTEGER NOT NULL,
                food_id       INTEGER,
                item_name     TEXT NOT NULL,
                count         REAL NOT NULL,
                unit          TEXT NOT NULL,
                kcal          REAL NOT NULL,
                protein_g     REAL NOT NULL,
                carbs_g       REAL NOT NULL,
                fat_g         REAL NOT NULL,
                micros_json   TEXT,
                source        TEXT,
                created_at    REAL NOT NULL
            )
            """
        )
        # Unit-level scan metrics persistence: keep the exact per-unit values
        # shown in the scan UI, not only scaled totals.
        _ensure_column(c, "gofit_food_log_items", "kcal_per_unit", "REAL")
        _ensure_column(c, "gofit_food_log_items", "protein_g_per_unit", "REAL")
        _ensure_column(c, "gofit_food_log_items", "carbs_g_per_unit", "REAL")
        _ensure_column(c, "gofit_food_log_items", "fat_g_per_unit", "REAL")
        _ensure_column(c, "gofit_food_log_items", "micros_per_unit_json", "TEXT")
        _ensure_column(c, "gofit_food_log_items", "micros_source", "TEXT")
        _ensure_column(c, "gofit_food_log_items", "raw_item_json", "TEXT")
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS gofit_ai_scan_results (
                id                 INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id         INTEGER NOT NULL,
                raw_items_json     TEXT NOT NULL,
                resolved_items_json TEXT NOT NULL,
                confidence         REAL NOT NULL,
                status             TEXT NOT NULL,
                created_at         REAL NOT NULL
            )
            """
        )
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS gofit_ai_corrections (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                scan_result_id INTEGER NOT NULL,
                account_id     INTEGER NOT NULL,
                item_name      TEXT NOT NULL,
                from_food_id   INTEGER,
                to_food_id     INTEGER,
                note           TEXT,
                created_at     REAL NOT NULL
            )
            """
        )
        c.execute("CREATE INDEX IF NOT EXISTS idx_gofit_food_alias_norm ON gofit_food_aliases(alias_norm)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_gofit_food_logs_account_date ON gofit_food_logs(account_id, date)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_gofit_scan_account_time ON gofit_ai_scan_results(account_id, created_at)")
        _seed_sources(c)
        _seed_from_current_foods(c)
        renamed = _apply_display_name_overrides(c)
        if renamed:
            log.info("food_graph: applied %d curated display-name override(s)", renamed)


def _apply_display_name_overrides(c) -> int:
    """Correct a small set of auto-generated display names that don't match
    how the dish is actually eaten/described in India. `_seed_from_current_foods`
    auto-derives most display names via `key.replace('_', ' ').title()`, which
    got "cooked_rice" -> "Cooked Rice" -- and separately, our vision-model
    matcher was leaving the AI's raw guess (often "steamed rice") on screen
    instead of this canonical name at all. Indian home-style rice is
    boiled/cooked in water, not steamed, so the canonical name should read
    "Cooked rice" (sentence case, matching sibling entries like "Boiled rice",
    "Lemon rice"). Idempotent -- only updates rows that don't already match,
    so this is cheap to run on every boot and safe to extend with more
    overrides later."""
    overrides = {
        "cooked_rice": "Cooked rice",
    }
    n = 0
    for key, name in overrides.items():
        row = c.execute("SELECT display_name FROM gofit_food_entities WHERE food_key=?", (key,)).fetchone()
        if row is not None and row["display_name"] != name:
            c.execute("UPDATE gofit_food_entities SET display_name=? WHERE food_key=?", (name, key))
            n += 1
    return n


def _seed_sources(c) -> None:
    now = time.time()
    rows = [
        ("legacy_foods", "Legacy curated foods", "curated", {"owner": "gofit", "version": "v1"}),
        ("open_food_facts", "OpenFoodFacts", "label", {"url": "https://world.openfoodfacts.org"}),
        ("ai_estimated", "AI estimated nutrients", "estimated", {"note": "Unmatched scan estimate"}),
    ]
    for code, name, kind, prov in rows:
        c.execute(
            "INSERT OR IGNORE INTO gofit_data_sources (code, display_name, kind, provenance_json, created_at) VALUES (?,?,?,?,?)",
            (code, name, kind, json.dumps(prov), now),
        )


def _seed_from_current_foods(c) -> None:
    cnt = c.execute("SELECT COUNT(*) AS n FROM gofit_food_entities").fetchone()["n"]
    if cnt > 0:
        return
    try:
        foods = c.execute("SELECT * FROM foods").fetchall()
    except Exception:
        foods = []
    if not foods:
        foods = _fallback_seed_foods_from_json()
    if not foods:
        return
    now = time.time()
    for row in foods:
        key = row["key"]
        display = row["source_name"] or key.replace("_", " ").title()
        c.execute(
            "INSERT OR IGNORE INTO gofit_food_entities (food_key, display_name, default_unit, source_name, source_code, created_at) VALUES (?,?,?,?,?,?)",
            (
                key,
                display,
                row["unit"] or "serving",
                row["source_name"],
                row["source"] or "legacy_foods",
                now,
            ),
        )
        food = c.execute("SELECT id FROM gofit_food_entities WHERE food_key=?", (key,)).fetchone()
        if not food:
            continue
        food_id = food["id"]
        c.execute(
            """
            INSERT INTO gofit_food_nutrients
            (food_id, kcal_per_unit, protein_g_per_unit, carbs_g_per_unit, fat_g_per_unit,
             fiber_g, sugar_g, sodium_mg, potassium_mg, calcium_mg, iron_mg, micros_json,
             health_score, jain_status, sattvic_status, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(food_id) DO UPDATE SET
                kcal_per_unit=excluded.kcal_per_unit,
                protein_g_per_unit=excluded.protein_g_per_unit,
                carbs_g_per_unit=excluded.carbs_g_per_unit,
                fat_g_per_unit=excluded.fat_g_per_unit,
                fiber_g=excluded.fiber_g,
                sugar_g=excluded.sugar_g,
                sodium_mg=excluded.sodium_mg,
                potassium_mg=excluded.potassium_mg,
                calcium_mg=excluded.calcium_mg,
                iron_mg=excluded.iron_mg,
                micros_json=excluded.micros_json,
                health_score=excluded.health_score,
                jain_status=excluded.jain_status,
                sattvic_status=excluded.sattvic_status,
                updated_at=excluded.updated_at
            """,
            (
                food_id,
                row["kcal_per_unit"] or 0,
                row["protein_g"] or 0,
                row["carbs_g"] or 0,
                row["fat_g"] or 0,
                row["fiber_g"],
                row["sugar_g"],
                row["sodium_mg"],
                row["potassium_mg"],
                row["calcium_mg"],
                row["iron_mg"],
                row["micros_json"],
                row["health_score"],
                row["jain_status"] if "jain_status" in row.keys() else None,
                row["sattvic_status"] if "sattvic_status" in row.keys() else None,
                now,
            ),
        )
        aliases = []
        raw_aliases = row["aliases_json"]
        if raw_aliases:
            try:
                aliases = json.loads(raw_aliases)
            except Exception:
                aliases = []
        aliases = [display, key.replace("_", " "), *aliases]
        for alias in aliases:
            a = (alias or "").strip()
            n = _norm(a)
            if not n:
                continue
            c.execute(
                "INSERT OR IGNORE INTO gofit_food_aliases (food_id, alias_text, alias_norm, created_at) VALUES (?,?,?,?)",
                (food_id, a, n, now),
            )
        c.execute(
            "INSERT OR IGNORE INTO gofit_food_portions (food_id, portion_name, grams, unit_multiplier) VALUES (?,?,?,?)",
            (food_id, row["unit"] or "serving", None, 1.0),
        )
    log.info("food_graph: seeded %d canonical food entities from foods table", len(foods))


def _fallback_seed_foods_from_json() -> list[dict]:
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "indian_food_db.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            payload = json.load(f)
    except Exception:
        return []
    out: list[dict] = []
    for food in payload.get("foods", []) or []:
        out.append(
            {
                "key": food.get("key"),
                "source_name": food.get("_source_name"),
                "unit": food.get("unit", "serving"),
                "source": food.get("_source", "legacy_foods"),
                "kcal_per_unit": food.get("kcal_per_unit", 0),
                "protein_g": food.get("protein_g", 0),
                "carbs_g": food.get("carbs_g", 0),
                "fat_g": food.get("fat_g", 0),
                "fiber_g": food.get("fiber_g"),
                "sugar_g": food.get("sugar_g"),
                "sodium_mg": food.get("sodium_mg"),
                "potassium_mg": food.get("potassium_mg"),
                "calcium_mg": food.get("calcium_mg"),
                "iron_mg": food.get("iron_mg"),
                "micros_json": json.dumps(food.get("micros")) if food.get("micros") else None,
                "health_score": food.get("health_score"),
                "aliases_json": json.dumps(food.get("aliases", [])),
                "jain_status": food.get("jain_status"),
                "sattvic_status": food.get("sattvic_status"),
            }
        )
    return out


def _row_to_food(row) -> dict:
    return {
        "id": row["id"],
        "key": row["food_key"],
        "name": row["display_name"],
        "unit": row["default_unit"],
        "kcal_per_unit": row["kcal_per_unit"],
        "protein_g": row["protein_g_per_unit"],
        "carbs_g": row["carbs_g_per_unit"],
        "fat_g": row["fat_g_per_unit"],
        "fiber_g": row["fiber_g"],
        "sugar_g": row["sugar_g"],
        "sodium_mg": row["sodium_mg"],
        "potassium_mg": row["potassium_mg"],
        "calcium_mg": row["calcium_mg"],
        "iron_mg": row["iron_mg"],
        "health_score": row["health_score"],
        "jain_status": row["jain_status"],
        "sattvic_status": row["sattvic_status"],
        "micros": json.loads(row["micros_json"]) if row["micros_json"] else None,
    }


def search_foods(query: str, limit: int = 20) -> list[dict]:
    q = _norm(query)
    if not q:
        return []
    lim = max(1, min(50, int(limit)))
    with db.connect() as c:
        rows = c.execute(
            """
            SELECT
                fe.id, fe.food_key, fe.display_name, fe.default_unit,
                fn.kcal_per_unit, fn.protein_g_per_unit, fn.carbs_g_per_unit, fn.fat_g_per_unit,
                fn.fiber_g, fn.sugar_g, fn.sodium_mg, fn.potassium_mg, fn.calcium_mg, fn.iron_mg,
                fn.health_score, fn.jain_status, fn.sattvic_status, fn.micros_json,
                fa.alias_norm
            FROM gofit_food_entities fe
            JOIN gofit_food_nutrients fn ON fn.food_id = fe.id
            LEFT JOIN gofit_food_aliases fa ON fa.food_id = fe.id
            WHERE fa.alias_norm LIKE ? OR fe.food_key LIKE ? OR fe.display_name LIKE ?
            """,
            (f"%{q}%", f"%{q}%", f"%{q}%"),
        ).fetchall()
    scored: dict[int, tuple[int, dict]] = {}
    for r in rows:
        score = 0
        alias = _norm(r["alias_norm"] or "")
        key = _norm(r["food_key"] or "")
        name = _norm(r["display_name"] or "")
        if alias == q or key == q or name == q:
            score = 100
        elif alias.startswith(q) or key.startswith(q) or name.startswith(q):
            score = 80
        elif q in alias or q in key or q in name:
            score = 60
        if score <= 0:
            continue
        food = _row_to_food(r)
        prev = scored.get(food["id"])
        if prev is None or score > prev[0]:
            scored[food["id"]] = (score, food)
    out = sorted(scored.values(), key=lambda x: (x[0], -len(x[1]["key"])), reverse=True)
    return [f for _, f in out[:lim]]


def resolve_food_by_name(name: str) -> dict | None:
    hits = search_foods(name, limit=1)
    return hits[0] if hits else None


def compatibility_food_suggestion(food: dict) -> dict:
    out = {
        "key": food["key"],
        "name": food.get("name") or food["key"].replace("_", " ").title(),
        "unit": food.get("unit") or "serving",
        "kcal_per_unit": food.get("kcal_per_unit", 0),
        "protein_g_per_unit": food.get("protein_g", 0),
        "carbs_g_per_unit": food.get("carbs_g", 0),
        "fat_g_per_unit": food.get("fat_g", 0),
    }
    for k in ("fiber_g", "sugar_g", "sodium_mg", "potassium_mg", "calcium_mg", "iron_mg", "health_score"):
        v = food.get(k)
        if v is not None:
            out[k] = v
    if food.get("micros"):
        out["micros"] = food["micros"]
    for k in ("jain_status", "sattvic_status"):
        v = food.get(k)
        if v:
            out[k] = v
    return out


def record_food_log(
    account_id: int,
    date_key: str,
    dish: str,
    *,
    legacy_meal_log_id: int | None,
    items: list[dict] | None,
) -> int | None:
    now = time.time()
    with db.write_lock(), db.connect() as c:
        if legacy_meal_log_id is not None:
            row = c.execute(
                "SELECT id FROM gofit_food_logs WHERE legacy_meal_log_id=?",
                (legacy_meal_log_id,),
            ).fetchone()
            if row:
                return row["id"]
        cur = c.execute(
            "INSERT INTO gofit_food_logs (account_id, date, dish, created_at, legacy_meal_log_id) VALUES (?,?,?,?,?)",
            (account_id, date_key, dish, now, legacy_meal_log_id),
        )
        food_log_id = cur.lastrowid
        if not food_log_id:
            row = c.execute(
                "SELECT id FROM gofit_food_logs WHERE account_id=? AND date=? AND dish=? ORDER BY id DESC LIMIT 1",
                (account_id, date_key, dish),
            ).fetchone()
            food_log_id = row["id"] if row else None
        if not food_log_id:
            return None
        if items:
            for it in items:
                name = str(it.get("item") or dish).strip() or dish
                count = float(it.get("count") or 1)
                unit = str(it.get("unit") or "serving")
                micros = it.get("micros")
                micros_per_unit = it.get("micros_per_unit")
                micros_json = json.dumps(micros) if isinstance(micros, dict) else None
                micros_per_unit_json = json.dumps(micros_per_unit) if isinstance(micros_per_unit, dict) else None
                raw_item_json = json.dumps(it) if isinstance(it, dict) else None
                match = resolve_food_by_name(name)
                c.execute(
                    """
                    INSERT INTO gofit_food_log_items
                    (food_log_id, food_id, item_name, count, unit, kcal, protein_g, carbs_g, fat_g, micros_json, source, created_at,
                     kcal_per_unit, protein_g_per_unit, carbs_g_per_unit, fat_g_per_unit, micros_per_unit_json, micros_source, raw_item_json)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        food_log_id,
                        match["id"] if match else None,
                        name,
                        count,
                        unit,
                        float(it.get("kcal_total") or 0),
                        float(it.get("protein_g") or 0),
                        float(it.get("carbs_g") or 0),
                        float(it.get("fat_g") or 0),
                        micros_json,
                        str(it.get("source") or ("db" if match else "legacy")),
                        now,
                        float(it.get("kcal_per_unit") or 0),
                        float(it.get("protein_g_per_unit") or 0),
                        float(it.get("carbs_g_per_unit") or 0),
                        float(it.get("fat_g_per_unit") or 0),
                        micros_per_unit_json,
                        str(it.get("micros_source") or "") or None,
                        raw_item_json,
                    ),
                )
        return food_log_id


def record_scan_result(account_id: int, raw_items: list, resolved_items: list, confidence: float, status: str) -> int | None:
    with db.write_lock(), db.connect() as c:
        cur = c.execute(
            """
            INSERT INTO gofit_ai_scan_results (account_id, raw_items_json, resolved_items_json, confidence, status, created_at)
            VALUES (?,?,?,?,?,?)
            """,
            (
                account_id,
                json.dumps(raw_items or []),
                json.dumps(resolved_items or []),
                float(confidence or 0),
                status or "resolved",
                time.time(),
            ),
        )
        return cur.lastrowid


def record_scan_correction(
    account_id: int,
    scan_result_id: int,
    item_name: str,
    *,
    from_food_name: str | None,
    to_food_name: str | None,
    note: str | None,
) -> int | None:
    from_food = resolve_food_by_name(from_food_name or "") if from_food_name else None
    to_food = resolve_food_by_name(to_food_name or "") if to_food_name else None
    with db.write_lock(), db.connect() as c:
        cur = c.execute(
            """
            INSERT INTO gofit_ai_corrections
            (scan_result_id, account_id, item_name, from_food_id, to_food_id, note, created_at)
            VALUES (?,?,?,?,?,?,?)
            """,
            (
                scan_result_id,
                account_id,
                item_name,
                from_food["id"] if from_food else None,
                to_food["id"] if to_food else None,
                (note or "")[:500] or None,
                time.time(),
            ),
        )
        return cur.lastrowid
