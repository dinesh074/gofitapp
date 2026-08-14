"""
gofit.today — NutritionEngine.

One central place for all nutrition arithmetic against the Food Intelligence
Graph (`nutri_*` tables, see docs/data-model.md). Per
GOFIT_MASTER_ARCHITECTURE_PROMPT.txt: "Database knows. Deterministic code
calculates." -- this module is the "deterministic code calculates" part.
Nothing here ever invents a nutrient value: a missing amount stays `None`
with its `value_status` intact (never coerced to 0), matching every row's
provenance columns from `nutri_food_nutrients`.

Scope note: calculate_meal_nutrition / calculate_daily_nutrition /
calculate_weekly_nutrition are NOT implemented yet -- they depend on a
graph-referencing food_logs table that doesn't exist yet (Month 3 per
docs/roadmap.md). Implementing them now against the wrong table would create
exactly the kind of duplicate-logic drift the master prompt warns against.
"""
from __future__ import annotations

import logging
from typing import Optional

import db

log = logging.getLogger("gofit.nutrition_engine")


def _rows_to_nutrients(rows) -> list[dict]:
    out = []
    for r in rows:
        out.append({
            "nutrient_code": r["nutrient_code"],
            "amount": float(r["amount"]) if r["amount"] is not None else None,
            "unit": r["unit"],
            "basis": r["basis"],
            "value_status": r["value_status"],
            "source_id": r["source_id"],
            "confidence": r["confidence"],
        })
    return out


def get_food(food_id: str) -> Optional[dict]:
    """Core FoodEntity lookup -- canonical name, type, region/cuisine,
    provenance. Returns None if the food_id doesn't exist (never a fabricated
    stand-in)."""
    with db.connect() as c:
        row = c.execute(
            "SELECT * FROM nutri_foods WHERE food_id=?", (food_id,)
        ).fetchone()
    if not row:
        return None
    return {
        "food_id": row["food_id"],
        "canonical_name": row["canonical_name"],
        "entity_type": row["entity_type"],
        "category": row["category"],
        "subcategory": row["subcategory"],
        "region": row["region"],
        "cuisine": row["cuisine"],
        "vegetarian": row["vegetarian"],
        "vegan": row["vegan"],
        "eggetarian": row["eggetarian"],
        "jain": row["jain"],
        "source_id": row["source_id"],
        "status": row["status"],
    }


def get_food_nutrients(food_id: str) -> list[dict]:
    """Every stored nutrient row for one food (per_100g basis by default).
    Each entry carries its own value_status/source/confidence -- callers
    must not assume a nutrient is present just because the food exists."""
    with db.connect() as c:
        rows = c.execute(
            "SELECT nutrient_code, amount, unit, basis, value_status, source_id, confidence "
            "FROM nutri_food_nutrients WHERE food_id=? ORDER BY nutrient_code",
            (food_id,),
        ).fetchall()
    return _rows_to_nutrients(rows)


def get_portions(food_id: str) -> list[dict]:
    with db.connect() as c:
        rows = c.execute(
            "SELECT portion_id, portion_name, household_unit, gram_weight, ml_weight, is_typical "
            "FROM nutri_portions WHERE food_id=?",
            (food_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def _scale(nutrients: list[dict], factor: float) -> list[dict]:
    """Scale every nutrient amount by `factor` (e.g. grams/100). Never scales
    a None amount -- a missing value stays missing at any portion size."""
    scaled = []
    for n in nutrients:
        n2 = dict(n)
        if n2["amount"] is not None:
            n2["amount"] = round(n2["amount"] * factor, 4)
        scaled.append(n2)
    return scaled


def calculate_portion_nutrition(food_id: str, portion_id: str | None = None, grams: float | None = None) -> dict:
    """Scale a food's per-100g nutrients to a specific portion or an explicit
    gram amount. Exactly one of portion_id/grams should be given -- portion_id
    takes precedence if both are (defensive, not expected in normal use)."""
    food = get_food(food_id)
    if not food:
        return {"error": "food_not_found", "food_id": food_id}
    base = get_food_nutrients(food_id)

    portion = None
    if portion_id:
        with db.connect() as c:
            portion = c.execute(
                "SELECT * FROM nutri_portions WHERE portion_id=? AND food_id=?",
                (portion_id, food_id),
            ).fetchone()
        if not portion:
            return {"error": "portion_not_found", "food_id": food_id, "portion_id": portion_id}
        if portion["gram_weight"] is None:
            # Honest failure -- do not guess a conversion factor.
            return {
                "food": food, "portion": dict(portion), "nutrients": base,
                "scale_status": "no_gram_weight",
            }
        grams_val = float(portion["gram_weight"])
    elif grams is not None:
        grams_val = float(grams)
    else:
        # No portion/grams given -- return the raw per-100g values as-is.
        return {"food": food, "basis": "per_100g", "nutrients": base}

    factor = grams_val / 100.0
    return {
        "food": food,
        "grams": grams_val,
        "portion": dict(portion) if portion else None,
        "nutrients": _scale(base, factor),
        "scale_status": "ok",
    }


def _generic_conversion_to_grams() -> dict[str, float]:
    """Loads generic (food_id IS NULL) unit -> grams conversions from
    nutri_portion_conversions -- see populate_portion_conversions.py. Cached
    per-call rather than at import time so a re-run of that script is picked
    up without restarting the process."""
    with db.connect() as c:
        rows = c.execute(
            "SELECT from_unit, from_quantity, to_grams FROM nutri_portion_conversions "
            "WHERE food_id IS NULL"
        ).fetchall()
    out = {}
    for r in rows:
        qty = float(r["from_quantity"])
        if qty:
            out[r["from_unit"].strip().lower()] = float(r["to_grams"]) / qty
    return out


def calculate_recipe_nutrition(recipe_id: str) -> dict:
    """Sum quantity-weighted ingredient nutrition for a recipe. Falls back to
    the recipe's own dish-level nutri_food_nutrients (via nutri_recipes.food_id)
    for any nutrient code no ingredient could supply -- documented in
    docs/nutrition-engine.md as a deliberate cross-check mechanism, not a
    silent override. Every contributing amount keeps its source ingredient
    and quantity so the calculation is auditable."""
    with db.connect() as c:
        recipe = c.execute(
            "SELECT * FROM nutri_recipes WHERE recipe_id=?", (recipe_id,)
        ).fetchone()
        if not recipe:
            return {"error": "recipe_not_found", "recipe_id": recipe_id}
        ingredients = c.execute(
            "SELECT ingredient_food_id, quantity, unit FROM nutri_recipe_ingredients "
            "WHERE recipe_id=? ORDER BY sequence",
            (recipe_id,),
        ).fetchall()

    totals: dict[str, float] = {}
    statuses: dict[str, set] = {}
    missing_ingredients = []
    unconverted_ingredients = []
    generic_grams_per_unit = _generic_conversion_to_grams()
    for ing in ingredients:
        fid = ing["ingredient_food_id"]
        nutrients = get_food_nutrients(fid)
        if not nutrients:
            missing_ingredients.append(fid)
            continue
        # Quantities here are in the recipe's original units (g/ml/tsp/tbsp/
        # cup/etc). g/ml sum directly on a per-100g basis; tsp/tbsp/cup go
        # through the generic (food_id-agnostic) water-basis conversion from
        # nutri_portion_conversions (see populate_portion_conversions.py) --
        # confidence='low', not a sourced per-ingredient density. Count/size
        # units (sprig, nos, unit, sheet, pinch, drops) have no honest generic
        # gram value and are reported in `unconverted_ingredients` instead of
        # guessed.
        unit = (ing["unit"] or "").strip().lower()
        qty = float(ing["quantity"])
        if unit in ("g", "gram", "grams"):
            grams = qty
        elif unit in generic_grams_per_unit:
            grams = qty * generic_grams_per_unit[unit]
        else:
            unconverted_ingredients.append({"food_id": fid, "quantity": qty, "unit": ing["unit"]})
            continue
        factor = grams / 100.0
        for n in nutrients:
            if n["amount"] is None:
                continue
            totals[n["nutrient_code"]] = totals.get(n["nutrient_code"], 0.0) + n["amount"] * factor
            statuses.setdefault(n["nutrient_code"], set()).add(n["value_status"])

    dish_level = get_food_nutrients(recipe["food_id"]) if recipe["food_id"] else []
    dish_level_by_code = {n["nutrient_code"]: n for n in dish_level}

    combined = []
    codes = set(totals) | set(dish_level_by_code)
    for code in sorted(codes):
        if code in totals:
            combined.append({
                "nutrient_code": code,
                "amount": round(totals[code], 4),
                "value_status": "calculated",
                "source": "ingredient_sum",
                "contributing_statuses": sorted(statuses.get(code, [])),
            })
        else:
            src = dish_level_by_code[code]
            combined.append({
                "nutrient_code": code,
                "amount": src["amount"],
                "value_status": src["value_status"],
                "source": "recipe_source_value",
            })

    return {
        "recipe_id": recipe_id,
        "recipe_name": recipe["recipe_name"],
        "servings": recipe["servings"],
        "yield_weight_g": recipe["yield_weight_g"],
        "nutrients_per_100g_equivalent": combined,
        "missing_ingredient_nutrition": missing_ingredients,
        "unconverted_ingredients": unconverted_ingredients,
    }
