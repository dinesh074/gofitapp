"""
gofit.today — PortionEngine.

Household-unit <-> gram/ml conversions for the Food Intelligence Graph.
Separate from NutritionEngine (which only scales already-known gram amounts)
because portion resolution is a lookup/matching problem, not arithmetic --
keeping them apart means the combination engine (Month 6+) can ask "what
portions exist for this food" without pulling in nutrient-scaling logic, and
vice versa.

Never guesses a gram weight. If nutri_portions has no gram_weight for a
requested portion, that is returned honestly (see resolve_portion) rather
than assumed -- matches NutritionEngine.calculate_portion_nutrition's same
"no_gram_weight" honesty rule.
"""
from __future__ import annotations

import logging

import db

log = logging.getLogger("gofit.portion_engine")

# Fallback only for the generic conversions module (not food-specific)
# that ship with the spec's own portion vocabulary, so a bare "1 tsp" or
# "1 cup" still resolves to grams even before nutri_portion_conversions has
# been populated per-food. Water-basis approximation (1 ml ~= 1 g) -- flagged
# with confidence="low" so callers can tell this apart from a sourced,
# food-specific conversion.
_GENERIC_HOUSEHOLD_ML = {
    "teaspoon": 5, "tsp": 5,
    "tablespoon": 15, "tbsp": 15,
    "cup": 240,
    "glass": 240,
    "katori": 150,
    "bowl": 300,
    "ladle": 60,
}


def list_portions(food_id: str) -> list[dict]:
    with db.connect() as c:
        rows = c.execute(
            "SELECT portion_id, portion_name, household_unit, gram_weight, ml_weight, "
            "is_typical, source_id, confidence FROM nutri_portions WHERE food_id=?",
            (food_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def resolve_portion(food_id: str, portion_name: str | None = None, household_unit: str | None = None) -> dict:
    """Find the best-matching stored portion for a food. Returns
    {"status": "found", "portion": {...}} or {"status": "not_found"} --
    never invents a gram weight for a food that has none stored."""
    portions = list_portions(food_id)
    if not portions:
        return {"status": "not_found", "reason": "no_portions_for_food"}

    if portion_name:
        for p in portions:
            if (p["portion_name"] or "").strip().lower() == portion_name.strip().lower():
                return {"status": "found", "portion": p}
    if household_unit:
        for p in portions:
            if (p["household_unit"] or "").strip().lower() == household_unit.strip().lower():
                return {"status": "found", "portion": p}

    typical = [p for p in portions if p["is_typical"]]
    if typical:
        return {"status": "found", "portion": typical[0], "note": "no_exact_match_used_typical"}
    return {"status": "found", "portion": portions[0], "note": "no_exact_match_used_first"}


def generic_household_unit_to_grams(unit: str) -> dict:
    """Non-food-specific fallback conversion (e.g. "1 cup" -> ~240g/ml).
    Always low confidence -- prefer resolve_portion()'s per-food, sourced
    conversion whenever one exists."""
    key = (unit or "").strip().lower()
    grams = _GENERIC_HOUSEHOLD_ML.get(key)
    if grams is None:
        return {"status": "not_found", "unit": unit}
    return {
        "status": "found", "unit": key, "grams": grams,
        "confidence": "low", "note": "generic_water_basis_approximation_not_food_specific",
    }
