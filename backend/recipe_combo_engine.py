"""
Recipe and combination foundations:
- deterministic recipe nutrition math
- combination fingerprinting and persisted combo templates
"""
from __future__ import annotations

import json
import os
import re
import time
from typing import Callable

import db


def _norm(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", (value or "").lower())).strip()


_SEED_TEMPLATES = [
    {
        "template_key": "south_indian_breakfast",
        "display_name": "South Indian Breakfast",
        "meal_type": "breakfast",
        "cuisine": "south_indian",
        "training_context": "any",
        "meal_size": "regular",
        "source": "system",
        "roles": [
            {"role_key": "staple", "requirement": "required", "position": 0},
            {"role_key": "protein", "requirement": "optional", "position": 1},
            {"role_key": "condiment", "requirement": "optional", "position": 2},
            {"role_key": "beverage", "requirement": "optional", "position": 3},
        ],
    },
    {
        "template_key": "north_indian_breakfast",
        "display_name": "North Indian Breakfast",
        "meal_type": "breakfast",
        "cuisine": "north_indian",
        "training_context": "any",
        "meal_size": "regular",
        "source": "system",
        "roles": [
            {"role_key": "staple", "requirement": "required", "position": 0},
            {"role_key": "protein", "requirement": "optional", "position": 1},
            {"role_key": "side", "requirement": "optional", "position": 2},
            {"role_key": "beverage", "requirement": "optional", "position": 3},
        ],
    },
    {
        "template_key": "indian_home_lunch",
        "display_name": "Indian Home Lunch",
        "meal_type": "lunch",
        "cuisine": "indian",
        "training_context": "any",
        "meal_size": "regular",
        "source": "system",
        "roles": [
            {"role_key": "staple", "requirement": "required", "position": 0},
            {"role_key": "protein", "requirement": "required", "position": 1},
            {"role_key": "vegetable", "requirement": "required", "position": 2},
            {"role_key": "side", "requirement": "optional", "position": 3},
            {"role_key": "condiment", "requirement": "optional", "position": 4},
        ],
    },
    {
        "template_key": "indian_snack",
        "display_name": "Indian Snack",
        "meal_type": "snack",
        "cuisine": "indian",
        "training_context": "any",
        "meal_size": "light",
        "source": "system",
        "roles": [
            {"role_key": "snack_base", "requirement": "required", "position": 0},
            {"role_key": "protein", "requirement": "optional", "position": 1},
            {"role_key": "beverage", "requirement": "optional", "position": 2},
        ],
    },
    {
        "template_key": "light_indian_dinner",
        "display_name": "Light Indian Dinner",
        "meal_type": "dinner",
        "cuisine": "indian",
        "training_context": "rest",
        "meal_size": "light",
        "source": "system",
        "roles": [
            {"role_key": "staple", "requirement": "required", "position": 0},
            {"role_key": "protein", "requirement": "required", "position": 1},
            {"role_key": "vegetable", "requirement": "required", "position": 2},
            {"role_key": "side", "requirement": "optional", "position": 3},
        ],
    },
    {
        "template_key": "post_workout_meal",
        "display_name": "Post-Workout Meal",
        "meal_type": "snack",
        "cuisine": "indian",
        "training_context": "strength",
        "meal_size": "regular",
        "source": "system",
        "roles": [
            {"role_key": "protein", "requirement": "required", "position": 0},
            {"role_key": "staple", "requirement": "optional", "position": 1},
            {"role_key": "snack_base", "requirement": "optional", "position": 2},
        ],
    },
]

_SEED_FOOD_ROLES = [
    ("idli", "staple"),
    ("plain_dosa", "staple"),
    ("masala_dosa", "staple"),
    ("upma", "staple"),
    ("poha", "staple"),
    ("pongal", "staple"),
    ("roti", "staple"),
    ("chapati_roti", "staple"),
    ("naan", "staple"),
    ("paratha", "staple"),
    ("puri", "staple"),
    ("cooked_rice", "staple"),
    ("brown_rice", "staple"),
    ("dal", "protein"),
    ("dal_makhani", "protein"),
    ("rajma", "protein"),
    ("chole", "protein"),
    ("paneer", "protein"),
    ("tofu", "protein"),
    ("egg", "protein"),
    ("boiled_egg", "protein"),
    ("chicken", "protein"),
    ("fish", "protein"),
    ("curd", "side"),
    ("raita", "side"),
    ("onion_raita", "side"),
    ("mixed_sabzi", "vegetable"),
    ("salad", "vegetable"),
    ("coconut_chutney", "condiment"),
    ("peanut_chutney", "condiment"),
    ("pickle", "condiment"),
    ("tea", "beverage"),
    ("coffee", "beverage"),
    ("buttermilk", "beverage"),
    ("banana", "snack_base"),
    ("apple", "snack_base"),
    ("nuts_mix", "snack_base"),
    ("roasted_chana", "snack_base"),
]


def combo_fingerprint(keys: list[str]) -> str:
    clean = sorted({k.strip().lower() for k in keys if isinstance(k, str) and k.strip()})
    return "|".join(clean)


def init_db() -> None:
    with db.write_lock(), db.connect() as c:
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS gofit_recipes (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                recipe_code   TEXT NOT NULL UNIQUE,
                name          TEXT NOT NULL,
                servings      REAL NOT NULL DEFAULT 1,
                source        TEXT NOT NULL DEFAULT 'user',
                notes         TEXT,
                created_at    REAL NOT NULL,
                updated_at    REAL NOT NULL
            )
            """
        )
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS gofit_recipe_ingredients (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                recipe_id      INTEGER NOT NULL,
                food_key       TEXT NOT NULL,
                quantity       REAL NOT NULL,
                quantity_unit  TEXT NOT NULL,
                position       INTEGER NOT NULL DEFAULT 0,
                notes          TEXT
            )
            """
        )
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS gofit_cooking_yields (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                food_key        TEXT NOT NULL,
                cooking_method  TEXT NOT NULL,
                yield_factor    REAL NOT NULL,
                source          TEXT,
                notes           TEXT,
                UNIQUE (food_key, cooking_method)
            )
            """
        )
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS gofit_meal_combinations (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                combo_key     TEXT NOT NULL UNIQUE,
                display_name  TEXT NOT NULL,
                fingerprint   TEXT NOT NULL,
                source        TEXT NOT NULL DEFAULT 'editorial',
                created_at    REAL NOT NULL
            )
            """
        )
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS gofit_meal_combination_items (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                combination_id   INTEGER NOT NULL,
                side_food_key    TEXT NOT NULL,
                side_count       REAL NOT NULL DEFAULT 1,
                reason           TEXT,
                position         INTEGER NOT NULL DEFAULT 0,
                UNIQUE (combination_id, side_food_key)
            )
            """
        )
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS gofit_meal_templates (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                template_key      TEXT NOT NULL UNIQUE,
                display_name      TEXT NOT NULL,
                meal_type         TEXT NOT NULL,
                cuisine           TEXT,
                training_context  TEXT,
                meal_size         TEXT NOT NULL DEFAULT 'regular',
                source            TEXT NOT NULL DEFAULT 'system',
                active            INTEGER NOT NULL DEFAULT 1,
                notes             TEXT,
                created_at        REAL NOT NULL,
                updated_at        REAL NOT NULL
            )
            """
        )
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS gofit_meal_template_roles (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                template_id   INTEGER NOT NULL,
                role_key      TEXT NOT NULL,
                requirement   TEXT NOT NULL,
                min_items     INTEGER NOT NULL DEFAULT 0,
                max_items     INTEGER,
                position      INTEGER NOT NULL DEFAULT 0,
                UNIQUE (template_id, role_key, requirement)
            )
            """
        )
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS gofit_food_role_map (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                food_key    TEXT NOT NULL,
                role_key    TEXT NOT NULL,
                weight      REAL NOT NULL DEFAULT 1,
                source      TEXT NOT NULL DEFAULT 'system',
                created_at  REAL NOT NULL,
                UNIQUE (food_key, role_key)
            )
            """
        )
        c.execute("CREATE INDEX IF NOT EXISTS idx_recipe_name ON gofit_recipes(name)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_combo_fingerprint ON gofit_meal_combinations(fingerprint)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_meal_templates_meal_type ON gofit_meal_templates(meal_type)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_meal_templates_training ON gofit_meal_templates(training_context)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_food_role_map_food_key ON gofit_food_role_map(food_key)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_food_role_map_role_key ON gofit_food_role_map(role_key)")
        _seed_editorial_combos(c)
        _seed_meal_templates(c)
        _seed_food_roles(c)


def _seed_editorial_combos(c) -> None:
    n = c.execute("SELECT COUNT(*) AS n FROM gofit_meal_combinations").fetchone()["n"]
    if n > 0:
        return
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "food_combos.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            payload = json.load(f)
    except Exception:
        return
    combos = payload.get("combos", {}) or {}
    now = time.time()
    for combo_key, entry in combos.items():
        sides = entry.get("sides", []) or []
        fp = combo_fingerprint([combo_key, *[str(s.get("key", "")) for s in sides]])
        cur = c.execute(
            "INSERT OR IGNORE INTO gofit_meal_combinations (combo_key, display_name, fingerprint, source, created_at) VALUES (?,?,?,?,?)",
            (
                combo_key,
                (entry.get("display") or combo_key.replace("_", " ").title()),
                fp,
                "editorial",
                now,
            ),
        )
        combo_id = cur.lastrowid
        if not combo_id:
            row = c.execute(
                "SELECT id FROM gofit_meal_combinations WHERE combo_key=?",
                (combo_key,),
            ).fetchone()
            combo_id = row["id"] if row else None
        if not combo_id:
            continue
        for idx, side in enumerate(sides):
            side_key = str(side.get("key") or "").strip()
            if not side_key:
                continue
            c.execute(
                """
                INSERT OR IGNORE INTO gofit_meal_combination_items
                (combination_id, side_food_key, side_count, reason, position)
                VALUES (?,?,?,?,?)
                """,
                (
                    combo_id,
                    side_key,
                    float(side.get("count") or 1),
                    (side.get("reason") or None),
                    idx,
                ),
            )


def _seed_meal_templates(c) -> None:
    now = time.time()
    for t in _SEED_TEMPLATES:
        c.execute(
            """
            INSERT INTO gofit_meal_templates
            (template_key, display_name, meal_type, cuisine, training_context, meal_size, source, active, notes, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(template_key) DO UPDATE SET
                display_name=excluded.display_name,
                meal_type=excluded.meal_type,
                cuisine=excluded.cuisine,
                training_context=excluded.training_context,
                meal_size=excluded.meal_size,
                source=excluded.source,
                active=excluded.active,
                notes=excluded.notes,
                updated_at=excluded.updated_at
            """,
            (
                t["template_key"],
                t["display_name"],
                t["meal_type"],
                t.get("cuisine"),
                t.get("training_context"),
                t.get("meal_size") or "regular",
                t.get("source") or "system",
                1,
                t.get("notes"),
                now,
                now,
            ),
        )
        row = c.execute("SELECT id FROM gofit_meal_templates WHERE template_key=?", (t["template_key"],)).fetchone()
        if not row:
            continue
        template_id = row["id"]
        c.execute("DELETE FROM gofit_meal_template_roles WHERE template_id=?", (template_id,))
        for role in t.get("roles", []):
            c.execute(
                """
                INSERT INTO gofit_meal_template_roles
                (template_id, role_key, requirement, min_items, max_items, position)
                VALUES (?,?,?,?,?,?)
                """,
                (
                    template_id,
                    str(role.get("role_key") or "").strip(),
                    str(role.get("requirement") or "optional").strip(),
                    int(role.get("min_items") or 0),
                    (int(role["max_items"]) if role.get("max_items") is not None else None),
                    int(role.get("position") or 0),
                ),
            )


def _seed_food_roles(c) -> None:
    now = time.time()
    for food_key, role_key in _SEED_FOOD_ROLES:
        c.execute(
            """
            INSERT OR IGNORE INTO gofit_food_role_map
            (food_key, role_key, weight, source, created_at)
            VALUES (?,?,?,?,?)
            """,
            (food_key, role_key, 1.0, "system", now),
        )


def list_meal_templates(meal_type: str = "", training_context: str = "", limit: int = 30) -> list[dict]:
    mt = (meal_type or "").strip().lower()
    tc = (training_context or "").strip().lower()
    lim = max(1, min(100, int(limit)))
    where = ["t.active=1"]
    params: list = []
    if mt:
        where.append("(t.meal_type=? OR t.meal_type='any')")
        params.append(mt)
    if tc:
        where.append("(t.training_context IS NULL OR t.training_context='' OR t.training_context='any' OR t.training_context=?)")
        params.append(tc)
    sql = (
        "SELECT t.id, t.template_key, t.display_name, t.meal_type, t.cuisine, "
        "t.training_context, t.meal_size, t.source, t.notes "
        "FROM gofit_meal_templates t "
        f"WHERE {' AND '.join(where)} "
        "ORDER BY t.meal_type ASC, t.display_name ASC LIMIT ?"
    )
    params.append(lim)
    with db.connect() as c:
        rows = c.execute(sql, tuple(params)).fetchall()
        if not rows:
            return []
        by_id: dict[int, dict] = {}
        template_ids: list[int] = []
        for r in rows:
            tid = int(r["id"])
            template_ids.append(tid)
            by_id[tid] = {
                "template_key": r["template_key"],
                "display_name": r["display_name"],
                "meal_type": r["meal_type"],
                "cuisine": r["cuisine"],
                "training_context": r["training_context"],
                "meal_size": r["meal_size"],
                "source": r["source"],
                "notes": r["notes"],
                "roles": [],
            }
        ph = ",".join(["?"] * len(template_ids))
        role_rows = c.execute(
            f"""
            SELECT template_id, role_key, requirement, min_items, max_items, position
            FROM gofit_meal_template_roles
            WHERE template_id IN ({ph})
            ORDER BY template_id ASC, position ASC, role_key ASC
            """,
            tuple(template_ids),
        ).fetchall()
    for rr in role_rows:
        by_id[int(rr["template_id"])]["roles"].append(
            {
                "role_key": rr["role_key"],
                "requirement": rr["requirement"],
                "min_items": rr["min_items"],
                "max_items": rr["max_items"],
                "position": rr["position"],
            }
        )
    return [by_id[int(r["id"])] for r in rows]


def list_food_roles(food_key: str = "", role_key: str = "", limit: int = 100) -> list[dict]:
    fk = (food_key or "").strip().lower()
    rk = (role_key or "").strip().lower()
    lim = max(1, min(300, int(limit)))
    where = []
    params: list = []
    if fk:
        where.append("food_key=?")
        params.append(fk)
    if rk:
        where.append("role_key=?")
        params.append(rk)
    sql = "SELECT food_key, role_key, weight, source FROM gofit_food_role_map"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY food_key ASC, role_key ASC LIMIT ?"
    params.append(lim)
    with db.connect() as c:
        rows = c.execute(sql, tuple(params)).fetchall()
    return [dict(r) for r in rows]


def estimate_recipe(
    ingredients: list[dict],
    resolve_food: Callable[[str], dict | None],
) -> dict:
    items: list[dict] = []
    for ing in ingredients:
        token = str(ing.get("food_key") or ing.get("name") or "").strip()
        if not token:
            continue
        food = resolve_food(token)
        if not food:
            continue
        qty = float(ing.get("quantity") or ing.get("count") or 1)
        qty = max(0.0, qty)
        item = {
            "food_key": food["key"],
            "name": food.get("name") or food["key"].replace("_", " ").title(),
            "unit": str(ing.get("quantity_unit") or ing.get("unit") or food.get("unit") or "serving"),
            "count": qty,
            "kcal": round(qty * float(food.get("kcal_per_unit") or 0)),
            "protein_g": round(qty * float(food.get("protein_g_per_unit") or 0), 1),
            "carbs_g": round(qty * float(food.get("carbs_g_per_unit") or 0), 1),
            "fat_g": round(qty * float(food.get("fat_g_per_unit") or 0), 1),
        }
        items.append(item)
    totals = {
        "kcal": round(sum(i["kcal"] for i in items)),
        "protein_g": round(sum(i["protein_g"] for i in items), 1),
        "carbs_g": round(sum(i["carbs_g"] for i in items), 1),
        "fat_g": round(sum(i["fat_g"] for i in items), 1),
    }
    return {"items": items, "totals": totals}


def save_recipe(recipe_code: str, name: str, servings: float, source: str, notes: str | None, ingredients: list[dict]) -> int | None:
    now = time.time()
    with db.write_lock(), db.connect() as c:
        c.execute(
            """
            INSERT INTO gofit_recipes (recipe_code, name, servings, source, notes, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(recipe_code) DO UPDATE SET
                name=excluded.name,
                servings=excluded.servings,
                source=excluded.source,
                notes=excluded.notes,
                updated_at=excluded.updated_at
            """,
            (recipe_code, name, servings, source, notes, now, now),
        )
        row = c.execute("SELECT id FROM gofit_recipes WHERE recipe_code=?", (recipe_code,)).fetchone()
        if not row:
            return None
        recipe_id = row["id"]
        c.execute("DELETE FROM gofit_recipe_ingredients WHERE recipe_id=?", (recipe_id,))
        for idx, ing in enumerate(ingredients):
            c.execute(
                """
                INSERT INTO gofit_recipe_ingredients
                (recipe_id, food_key, quantity, quantity_unit, position, notes)
                VALUES (?,?,?,?,?,?)
                """,
                (
                    recipe_id,
                    str(ing.get("food_key") or "").strip(),
                    float(ing.get("quantity") or 1),
                    str(ing.get("quantity_unit") or "serving"),
                    idx,
                    (ing.get("notes") or None),
                ),
            )
        return recipe_id


def search_recipes(query: str, limit: int = 20) -> list[dict]:
    q = _norm(query)
    if not q:
        return []
    lim = max(1, min(50, int(limit)))
    with db.connect() as c:
        rows = c.execute(
            """
            SELECT id, recipe_code, name, servings, source
            FROM gofit_recipes
            WHERE lower(name) LIKE ? OR lower(recipe_code) LIKE ?
            ORDER BY name ASC
            LIMIT ?
            """,
            (f"%{q}%", f"%{q}%", lim),
        ).fetchall()
    return [dict(r) for r in rows]


def load_recipe(recipe_id: int) -> dict | None:
    with db.connect() as c:
        row = c.execute(
            "SELECT id, recipe_code, name, servings, source, notes FROM gofit_recipes WHERE id=?",
            (recipe_id,),
        ).fetchone()
        if not row:
            return None
        ingredients = c.execute(
            """
            SELECT food_key, quantity, quantity_unit, notes
            FROM gofit_recipe_ingredients
            WHERE recipe_id=?
            ORDER BY position ASC
            """,
            (recipe_id,),
        ).fetchall()
    data = dict(row)
    data["ingredients"] = [dict(r) for r in ingredients]
    return data
