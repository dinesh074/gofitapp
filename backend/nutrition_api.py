"""
gofit.today — read-only /api/nutrition surface over the Food Intelligence
Graph (nutri_* tables). First real API for the new graph -- everything before
this only existed as engine functions with no HTTP surface.

Deliberately read-only and account-gated (auth.require_account) but not
admin-gated: food master data is public/read-only per
GOFIT_MASTER_ARCHITECTURE_PROMPT.txt's SECURITY section. Write endpoints
(food creation, nutrient edits, source mapping) are explicitly out of scope
for Month 1 and are not built here.

Business logic stays in nutrition_engine.py / dietary_rules.py /
portion_engine.py -- this module is only routing + request/response shaping,
per the spec's "keep business logic out of route handlers" rule.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request

import auth
import db
import nutrition_engine
import dietary_rules
import portion_engine

log = logging.getLogger("gofit.nutrition_api")

router = APIRouter(prefix="/api/nutrition", tags=["nutrition"])


@router.get("/foods/search")
def search_foods(q: str, request: Request, limit: int = 20):
    """Search the NEW Food Intelligence Graph (nutri_foods), separate from
    the existing /foods/search endpoint in main.py which searches the old,
    live scanner `foods` table. Both exist side by side until the Month 4
    scanner migration decides which becomes canonical (see docs/architecture.md)."""
    auth.require_account(request)
    query = (q or "").strip()
    if not query:
        return {"results": []}
    limit = max(1, min(50, limit))
    like = f"%{query.lower()}%"
    with db.connect() as c:
        rows = c.execute(
            """
            SELECT DISTINCT f.food_id, f.canonical_name, f.entity_type, f.region, f.cuisine, f.status
            FROM nutri_foods f
            LEFT JOIN nutri_food_aliases a ON a.food_id = f.food_id
            WHERE LOWER(f.canonical_name) LIKE ? OR LOWER(a.alias) LIKE ?
            LIMIT ?
            """,
            (like, like, limit),
        ).fetchall()
    return {"results": [dict(r) for r in rows]}


@router.get("/foods/{food_id}")
def get_food(food_id: str, request: Request):
    auth.require_account(request)
    food = nutrition_engine.get_food(food_id)
    if not food:
        raise HTTPException(404, "food_not_found")
    return food


@router.get("/foods/{food_id}/nutrients")
def get_food_nutrients(food_id: str, request: Request):
    auth.require_account(request)
    food = nutrition_engine.get_food(food_id)
    if not food:
        raise HTTPException(404, "food_not_found")
    return {"food_id": food_id, "nutrients": nutrition_engine.get_food_nutrients(food_id)}


@router.get("/foods/{food_id}/portions")
def get_food_portions(food_id: str, request: Request):
    auth.require_account(request)
    food = nutrition_engine.get_food(food_id)
    if not food:
        raise HTTPException(404, "food_not_found")
    return {"food_id": food_id, "portions": portion_engine.list_portions(food_id)}


@router.get("/foods/{food_id}/portion-nutrition")
def get_portion_nutrition(food_id: str, request: Request, portion_id: str | None = None, grams: float | None = None):
    auth.require_account(request)
    result = nutrition_engine.calculate_portion_nutrition(food_id, portion_id=portion_id, grams=grams)
    if result.get("error") == "food_not_found":
        raise HTTPException(404, "food_not_found")
    if result.get("error") == "portion_not_found":
        raise HTTPException(404, "portion_not_found")
    return result


@router.get("/foods/{food_id}/diet-check")
def diet_check(food_id: str, request: Request, profile: str):
    """One food against one diet profile -- see dietary_rules.matches_diet
    for the currently-supported profile set. Returns 'not_yet_supported' for
    profiles without a real rule yet, never a guessed answer."""
    auth.require_account(request)
    food = nutrition_engine.get_food(food_id)
    if not food:
        raise HTTPException(404, "food_not_found")
    return {"food_id": food_id, "diet_profile": profile, "result": dietary_rules.matches_diet(food_id, profile)}


@router.get("/recipes/{recipe_id}")
def get_recipe(recipe_id: str, request: Request):
    auth.require_account(request)
    with db.connect() as c:
        row = c.execute("SELECT * FROM nutri_recipes WHERE recipe_id=?", (recipe_id,)).fetchone()
    if not row:
        raise HTTPException(404, "recipe_not_found")
    return dict(row)


@router.get("/recipes/{recipe_id}/nutrition")
def get_recipe_nutrition(recipe_id: str, request: Request):
    auth.require_account(request)
    result = nutrition_engine.calculate_recipe_nutrition(recipe_id)
    if result.get("error") == "recipe_not_found":
        raise HTTPException(404, "recipe_not_found")
    return result


@router.get("/recipes/{recipe_id}/ingredients")
def get_recipe_ingredients(recipe_id: str, request: Request):
    auth.require_account(request)
    with db.connect() as c:
        recipe = c.execute("SELECT recipe_id FROM nutri_recipes WHERE recipe_id=?", (recipe_id,)).fetchone()
        if not recipe:
            raise HTTPException(404, "recipe_not_found")
        rows = c.execute(
            """
            SELECT ri.ingredient_food_id, f.canonical_name, ri.quantity, ri.unit, ri.preparation, ri.sequence
            FROM nutri_recipe_ingredients ri
            JOIN nutri_foods f ON f.food_id = ri.ingredient_food_id
            WHERE ri.recipe_id=? ORDER BY ri.sequence
            """,
            (recipe_id,),
        ).fetchall()
    return {"recipe_id": recipe_id, "ingredients": [dict(r) for r in rows]}
