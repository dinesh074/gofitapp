"""
gofit.today — the AI daily meal plan (persisted, profile-driven, NOT random).

Why this module exists
----------------------
The old "Your next meal" card was a deterministic on-device scorer over a small
static idea list: with a fixed budget it produced the same top pick every time,
so it felt canned and nothing was ever saved. This module replaces that with a
real PLAN:

  * Generated server-side from the user's actual daily targets (kcal + macros),
    which the client computes with its single-source-of-truth nutrition engine
    (nutrition.ts -> computeGoal, pace-aware). Same trust model the /foods/
    recommend and /meals/verdict endpoints already use.
  * Built from the real food DB (839+ dishes, diet-filtered server-side where
    the veg/non-veg/jain data lives), split across breakfast / lunch / snack /
    dinner so it reads like an actual day of eating.
  * PERSISTED per account per day and keyed by a signature of the targets, so it
    is STABLE across reloads and only regenerates when the profile / goal / pace
    (hence the targets) materially change, or the user explicitly asks for a new
    plan. This is the "persistent on the AI and the database" the product needs.
  * Enriched with ONE short Gemini "coach note", best-effort and cached-by-persist
    (only composed when a plan is actually (re)generated), never blocking the
    deterministic plan if the model is slow or unavailable.

Food selection + AI phrasing live in main.py (which owns FOOD_DB and the Gemini
model). They are injected via configure() so this module never imports the big
app module (no circular import).

Endpoints (Bearer-authenticated; consume NO scan credit, never call the vision
model):
  POST /plan/today     -> {plan, cached}. Returns the saved plan when its
                          signature still matches the posted targets; otherwise
                          generates, persists and returns a fresh one.
                          Body: {targets:{kcal,protein_g,carbs_g,fat_g}, diet,
                          goal, date:"YYYY-MM-DD", regenerate:false}
"""
import json
import time
import logging
from typing import Callable, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import db
import auth

log = logging.getLogger("gofit.plan")
router = APIRouter(tags=["plan"])

# Injected by main.py at startup (see configure()). Kept as module globals so the
# route handlers can reach the food DB + Gemini without importing main.
_pick_for_slot: Optional[Callable] = None
_ai_note: Optional[Callable] = None


def configure(pick_for_slot: Callable, ai_note: Callable) -> None:
    """Wire in the food-selection + AI-note callables owned by main.py."""
    global _pick_for_slot, _ai_note
    _pick_for_slot = pick_for_slot
    _ai_note = ai_note


def init_db() -> None:
    with db.connect() as c:
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS meal_plans (
                account_id INTEGER NOT NULL,
                date       TEXT NOT NULL,
                signature  TEXT NOT NULL,
                plan_json  TEXT NOT NULL,
                created_at REAL NOT NULL,
                PRIMARY KEY (account_id, date)
            )
            """
        )


# The day split -- each slot gets a fraction of the daily calorie budget. Sums
# to 1.0. Lunch is the biggest meal, a lighter snack bridges the afternoon.
SLOTS = [
    ("breakfast", "Breakfast", 0.25),
    ("lunch", "Lunch", 0.35),
    ("snack", "Snack", 0.15),
    ("dinner", "Dinner", 0.25),
]

# Portion is expressed as servings of the chosen dish, rounded to a half serving
# and clamped. A single item is capped low (MAX_ITEM_SERVINGS) so a slot COMBINES
# a few complementary dishes to hit its budget rather than asking for one giant
# helping -- that is what keeps the macros balanced instead of, say, tripling a
# fat-heavy paneer dish just to reach the calorie number.
MIN_SERVINGS = 0.5
MAX_ITEM_SERVINGS = 2.0
MAX_ITEMS_PER_SLOT = 3
# Stop adding to a slot once this little of its calorie budget is left.
SLOT_FILL_STOP = 0.12
# A dish may appear at most this many times across the whole day. Strict "never
# repeat" reads as more varied but exhausts the limited pool of protein-dense
# staples (paneer/rajma/dal) early, forcing low-protein fillers into later
# slots; allowing a staple to recur once keeps the day's protein far closer to
# target while still avoiding the "same dish four times" look.
MAX_DISH_PER_DAY = 2


def _signature(targets: dict, diet: str, goal: str) -> str:
    """A COARSE fingerprint of what the plan is built from. Two profiles that
    round to the same targets share a plan-shape; a real change to weight / goal
    / pace shifts the targets enough to change this and trigger a regenerate."""
    return "|".join(
        [
            diet,
            goal,
            str(int(round(targets["kcal"] / 50.0))),
            str(int(round(targets["protein_g"] / 5.0))),
            str(int(round(targets["carbs_g"] / 10.0))),
            str(int(round(targets["fat_g"] / 5.0))),
        ]
    )


def _size_item(food: dict, rem: dict) -> float:
    """How many servings of this dish to place, limited by BOTH the remaining
    calorie budget and the remaining fat budget (so a fat-dense dish like paneer
    can't be scaled up to hit calories and blow the day's fat target -- it gets
    a smaller portion and a leaner dish fills the rest). Rounded to a half
    serving and clamped."""
    kpu = food.get("kcal_per_unit", 0) or 0
    if kpu <= 0:
        return 1.0
    caps = [rem["kcal"] / kpu]
    fpu = food.get("fat_g_per_unit", 0) or 0
    if fpu > 0 and rem["fat_g"] > 0:
        caps.append(rem["fat_g"] / fpu)  # never exceed this slot's fat share
    half = round(min(caps) * 2) / 2.0
    return min(MAX_ITEM_SERVINGS, max(MIN_SERVINGS, half))


def _scale_item(food: dict, servings: float) -> dict:
    """Scale a _food_suggestion-shaped record (per-unit macros) to a portion."""
    return {
        "key": food["key"],
        "name": food.get("name") or food["key"].replace("_", " ").title(),
        "unit": food.get("unit", "serving"),
        "count": servings,
        "kcal": round(servings * (food.get("kcal_per_unit", 0) or 0)),
        "protein_g": round(servings * (food.get("protein_g_per_unit", 0) or 0), 1),
        "carbs_g": round(servings * (food.get("carbs_g_per_unit", 0) or 0), 1),
        "fat_g": round(servings * (food.get("fat_g_per_unit", 0) or 0), 1),
    }


def _sum_items(items: list) -> dict:
    return {
        "kcal": round(sum(i["kcal"] for i in items)),
        "protein_g": round(sum(i["protein_g"] for i in items), 1),
        "carbs_g": round(sum(i["carbs_g"] for i in items), 1),
        "fat_g": round(sum(i["fat_g"] for i in items), 1),
    }


def _build_slot(slot_key: str, label: str, frac: float, targets: dict, diet: str, goal: str, used: dict) -> dict:
    """Greedily fill one slot toward its share of the day's budget, re-ranking
    the food DB against the SHRINKING remaining budget after each pick. Because
    the scorer penalises fat/calorie overshoot, once protein or fat is met the
    next pick naturally skews leaner/carbier -- so a slot ends up balanced rather
    than one macro-lopsided dish scaled up. `used` counts how many times each
    dish has been placed today so nothing appears more than MAX_DISH_PER_DAY
    times (variety) while still letting protein staples recur once."""
    budget = {
        "kcal": targets["kcal"] * frac,
        "protein_g": targets["protein_g"] * frac,
        "carbs_g": targets["carbs_g"] * frac,
        "fat_g": targets["fat_g"] * frac,
    }
    rem = dict(budget)
    items: list = []
    for _ in range(MAX_ITEMS_PER_SLOT):
        if rem["kcal"] < budget["kcal"] * SLOT_FILL_STOP:
            break
        foods = _pick_for_slot(rem, diet, goal, 16) or []
        # First candidate that isn't already used up for the day, isn't already
        # in THIS slot, and (once the slot has something) wouldn't blow the fat
        # budget even at the minimum portion -- so a lean protein still gets in
        # but another fat-dense dish is skipped in favour of a leaner option.
        slot_keys = {it["key"] for it in items}

        def _ok(f: dict) -> bool:
            if used.get(f["key"], 0) >= MAX_DISH_PER_DAY or f["key"] in slot_keys:
                return False
            fpu = f.get("fat_g_per_unit", 0) or 0
            if items and fpu > 0 and rem["fat_g"] > 0 and MIN_SERVINGS * fpu > rem["fat_g"] * 1.6:
                return False
            return True

        food = next((f for f in foods if _ok(f)), None)
        if food is None:
            break
        servings = _size_item(food, rem)
        item = _scale_item(food, servings)
        items.append(item)
        used[food["key"]] = used.get(food["key"], 0) + 1
        rem["kcal"] -= item["kcal"]
        rem["protein_g"] -= item["protein_g"]
        rem["carbs_g"] -= item["carbs_g"]
        rem["fat_g"] -= item["fat_g"]
    slot = {
        "slot": slot_key,
        "label": label,
        "target_kcal": round(budget["kcal"]),
        "items": items,
    }
    slot.update(_sum_items(items))
    return slot


def _deterministic_note(plan: dict) -> str:
    t = plan["targets"]
    return (
        f"A ~{int(t['kcal'])} kcal day across four meals, aiming for about "
        f"{int(t['protein_g'])} g protein. Tune the portions to your appetite — "
        "this is your starting plan, not a rule."
    )


def build_plan(targets: dict, diet: str, goal: str, date_key: str) -> dict:
    used: dict = {}
    slots = [_build_slot(k, l, f, targets, diet, goal, used) for k, l, f in SLOTS]
    totals = _sum_items([it for s in slots for it in s["items"]])
    plan = {
        "date": date_key,
        "signature": _signature(targets, diet, goal),
        "targets": {k: round(targets[k], 1) for k in ("kcal", "protein_g", "carbs_g", "fat_g")},
        "totals": totals,
        "slots": slots,
        "generated_at": time.time(),
    }
    note = ""
    if _ai_note is not None:
        try:
            note = (_ai_note(plan, diet, goal) or "").strip()
        except Exception as ex:  # never let the AI note break the plan
            log.info("plan: AI note failed (%s) -- using deterministic note", ex)
    plan["coach_note"] = note or _deterministic_note(plan)
    return plan


def _load_saved(account_id: int, date_key: str) -> Optional[dict]:
    with db.connect() as c:
        row = c.execute(
            "SELECT signature, plan_json FROM meal_plans WHERE account_id=? AND date=?",
            (account_id, date_key),
        ).fetchone()
    if not row:
        return None
    try:
        return {"signature": row["signature"], "plan": json.loads(row["plan_json"])}
    except Exception:
        return None


def _save(account_id: int, date_key: str, signature: str, plan: dict) -> None:
    with db.write_lock(), db.connect() as c:
        c.execute(
            """
            INSERT INTO meal_plans (account_id, date, signature, plan_json, created_at)
            VALUES (?,?,?,?,?)
            ON CONFLICT(account_id, date) DO UPDATE SET
                signature=excluded.signature, plan_json=excluded.plan_json,
                created_at=excluded.created_at
            """,
            (account_id, date_key, signature, json.dumps(plan), time.time()),
        )


class Targets(BaseModel):
    kcal: float = Field(0, ge=0, le=20000)
    protein_g: float = Field(0, ge=0, le=2000)
    carbs_g: float = Field(0, ge=0, le=2000)
    fat_g: float = Field(0, ge=0, le=2000)


class PlanBody(BaseModel):
    targets: Targets
    diet: str = "veg"
    goal: str = "maintain"
    date: str
    regenerate: bool = False


@router.post("/plan/today")
def plan_today(body: PlanBody, request: Request):
    acct = auth.require_account(request)
    if _pick_for_slot is None:
        raise HTTPException(status_code=503, detail="plan engine not configured")
    date_key = (body.date or "").strip()[:10]
    if len(date_key) != 10:
        raise HTTPException(status_code=422, detail="date must be YYYY-MM-DD")
    targets = {
        "kcal": max(0.0, body.targets.kcal),
        "protein_g": max(0.0, body.targets.protein_g),
        "carbs_g": max(0.0, body.targets.carbs_g),
        "fat_g": max(0.0, body.targets.fat_g),
    }
    if targets["kcal"] <= 0:
        raise HTTPException(status_code=422, detail="a positive calorie target is required")
    diet = (body.diet or "veg").strip().lower()
    goal = (body.goal or "maintain").strip().lower()
    sig = _signature(targets, diet, goal)

    if not body.regenerate:
        saved = _load_saved(acct["id"], date_key)
        if saved and saved.get("signature") == sig:
            return {"plan": saved["plan"], "cached": True}

    plan = build_plan(targets, diet, goal, date_key)
    _save(acct["id"], date_key, sig, plan)
    return {"plan": plan, "cached": False}
