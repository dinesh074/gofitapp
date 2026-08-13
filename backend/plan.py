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
import random
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
# A dish may appear at most this many times across the whole day. Repetition was
# the #1 complaint ("paneer / rajma three times a day"), so an EXACT dish now
# never repeats within a day.
MAX_DISH_PER_DAY = 1
# ...and the same primary ingredient (its "family": paneer, rajma, aloo, dal,
# chicken) is capped too, so near-duplicate DB entries ("rajma", "rajma curry",
# "rajma masala") can't sneak the same thing onto the plate three times. Two
# lets a protein staple anchor two meals without dominating the whole day.
MAX_FAMILY_PER_DAY = 2
# The plan is built by SAMPLING from the top of the ranked pool rather than
# always taking the single best-fit dish. This is what gives variety across
# meals AND makes "New plan" produce a genuinely different day each time (the
# ranking still keeps every pick a sensible macro fit -- we just don't always
# grab rank #1). Pull a wider pool so the sampler has room to vary.
CANDIDATE_POOL = 24
# Sample each pick from the top-N eligible candidates, weighted toward the best
# fit. Bigger = more variety / looser macro fit; smaller = tighter / repetitive.
TOP_SAMPLE = 6

# Tokens that describe a preparation rather than the core ingredient. Stripped
# when deriving a dish's "family" so "paneer butter masala" and "kadai paneer"
# both resolve to the family "paneer".
_PREP_WORDS = {
    "curry", "masala", "gravy", "dry", "fry", "fried", "sabzi", "sabji", "bhaji",
    "tadka", "tikka", "roasted", "grilled", "steamed", "boiled", "spicy", "hot",
    "special", "home", "style", "homestyle", "plain", "fresh", "classic", "with",
    "and", "the", "of", "in", "ka", "ki", "ke", "wala", "wali", "veg", "non",
    "half", "full", "plate", "bowl", "serving", "regular", "large", "small",
}


def _family(food: dict) -> str:
    """The dish's primary ingredient, used to stop three near-identical dishes
    (rajma / rajma curry / rajma masala) all landing on the same day. Takes the
    first meaningful token of the name, skipping preparation words."""
    name = (food.get("name") or food.get("key", "")).lower().replace("_", " ").replace("-", " ")
    for tok in name.split():
        t = tok.strip()
        if len(t) > 2 and t not in _PREP_WORDS:
            return t
    return name.strip() or food.get("key", "")


def _choose(rng: random.Random, cands: list, sample: bool):
    """Pick a dish. For a slot's ANCHOR (first) pick we sample from the top of
    the eligible pool, weighted steeply toward the best fit, so meals vary and
    'New plan' yields a different day. For FILLER picks we take the single best
    fit so the slot still lands on its macro budget (variety shouldn't cost
    accuracy on the dishes that top up protein/calories)."""
    if not cands:
        return None
    if not sample:
        return cands[0]
    top = cands[:TOP_SAMPLE]
    # gentle falloff -> higher-ranked (better macro fit) dishes are favoured but
    # the anchor genuinely varies across meals and across 'New plan' taps.
    weights = [1.0 / (i + 1) for i in range(len(top))]
    return rng.choices(top, weights=weights, k=1)[0]


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


def _build_slot(slot_key: str, label: str, frac: float, targets: dict, diet: str, goal: str, used: dict, used_family: dict, rng: random.Random) -> dict:
    """Greedily fill one slot toward its share of the day's budget, re-ranking
    the food DB against the SHRINKING remaining budget after each pick. Because
    the scorer penalises fat/calorie overshoot, once protein or fat is met the
    next pick naturally skews leaner/carbier -- so a slot ends up balanced rather
    than one macro-lopsided dish scaled up. `used`/`used_family` count how many
    times each exact dish and each ingredient family have been placed today so
    nothing repeats (variety); picks are SAMPLED from the top of the pool so the
    day varies and 'New plan' yields a different day."""
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
        foods = _pick_for_slot(rem, diet, goal, CANDIDATE_POOL) or []
        # Candidates that aren't already used up for the day (by exact dish OR by
        # ingredient family), aren't already in THIS slot, and (once the slot has
        # something) wouldn't blow the fat budget even at the minimum portion --
        # so a lean protein still gets in but another fat-dense dish is skipped
        # in favour of a leaner option.
        slot_keys = {it["key"] for it in items}

        def _ok(f: dict) -> bool:
            if used.get(f["key"], 0) >= MAX_DISH_PER_DAY or f["key"] in slot_keys:
                return False
            if used_family.get(_family(f), 0) >= MAX_FAMILY_PER_DAY:
                return False
            fpu = f.get("fat_g_per_unit", 0) or 0
            if items and fpu > 0 and rem["fat_g"] > 0 and MIN_SERVINGS * fpu > rem["fat_g"] * 1.6:
                return False
            return True

        eligible = [f for f in foods if _ok(f)]
        food = _choose(rng, eligible, sample=(len(items) == 0))
        if food is None:
            break
        servings = _size_item(food, rem)
        item = _scale_item(food, servings)
        items.append(item)
        used[food["key"]] = used.get(food["key"], 0) + 1
        fam = _family(food)
        used_family[fam] = used_family.get(fam, 0) + 1
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


def build_plan(targets: dict, diet: str, goal: str, date_key: str, rng: Optional[random.Random] = None) -> dict:
    rng = rng or random.Random()
    used: dict = {}
    used_family: dict = {}
    slots = [_build_slot(k, l, f, targets, diet, goal, used, used_family, rng) for k, l, f in SLOTS]
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


# The clock hour (local) by which each meal is assumed to be over. Used to decide
# which slots are still AHEAD of the user so only those get re-portioned to the
# calories/macros they have left -- meals already behind them are left as they
# were (a record of what was suggested), never resized retroactively.
_SLOT_END_HOUR = {"breakfast": 10, "lunch": 15, "snack": 18, "dinner": 24}
_MACRO_KEYS = ("kcal", "protein_g", "carbs_g", "fat_g")


def _rescale_item(it: dict, factor: float) -> dict:
    """Re-portion a plan item by `factor`, keeping the same dish (continuity --
    we resize the day, we don't swap dishes on the user mid-meal). Servings are
    clamped to the normal half-serving range so a portion never becomes silly."""
    base = it.get("count", 0) or 0
    new_count = round(base * factor * 2) / 2.0
    new_count = min(MAX_ITEM_SERVINGS, max(MIN_SERVINGS, new_count))
    r = (new_count / base) if base else 1.0
    return {
        **it,
        "count": new_count,
        "kcal": round((it.get("kcal", 0) or 0) * r),
        "protein_g": round((it.get("protein_g", 0) or 0) * r, 1),
        "carbs_g": round((it.get("carbs_g", 0) or 0) * r, 1),
        "fat_g": round((it.get("fat_g", 0) or 0) * r, 1),
    }


def _adapt_plan(plan: dict, targets: dict, consumed: dict, hour: Optional[int]) -> dict:
    """Return a COPY of the day's plan adapted to what the user has actually
    logged so far: meals still ahead of them (by clock hour) are re-portioned so
    that, together, they fill exactly the calories/macros left in the day. The
    day's dish choices stay put (stability); only portions move. Nothing is
    persisted -- the saved plan remains the clean full-day version; this is the
    live view layered on top for the current moment."""
    adapted = json.loads(json.dumps(plan))  # deep copy, never mutate the saved plan
    remaining = {m: max(0.0, targets[m] - consumed.get(m, 0.0)) for m in _MACRO_KEYS}

    def _upcoming(slot_key: str) -> bool:
        if hour is None:
            return True  # no clock -> treat the whole day as still ahead
        return hour < _SLOT_END_HOUR.get(slot_key, 24)

    up = [s for s in adapted["slots"] if _upcoming(s["slot"])]
    base_up_kcal = sum(max(0.0, s.get("target_kcal", 0) or 0) for s in up)

    for s in adapted["slots"]:
        if not _upcoming(s["slot"]):
            s["upcoming"] = False
            continue
        s["upcoming"] = True
        if remaining["kcal"] <= 1 or base_up_kcal <= 0:
            # Day's budget already met -> upcoming meals become optional.
            s["items"] = []
            s["over_budget"] = remaining["kcal"] <= 1
        else:
            share = (max(0.0, s.get("target_kcal", 0) or 0)) / base_up_kcal
            want_kcal = remaining["kcal"] * share
            have_kcal = sum((it.get("kcal", 0) or 0) for it in s["items"]) or 0
            factor = (want_kcal / have_kcal) if have_kcal > 0 else 1.0
            s["items"] = [_rescale_item(it, factor) for it in s["items"]]
        s.update(_sum_items(s["items"]))

    adapted["consumed"] = {m: round(consumed.get(m, 0.0), 1) for m in _MACRO_KEYS}
    adapted["remaining"] = {m: round(remaining[m], 1) for m in _MACRO_KEYS}
    adapted["adapted"] = True
    # Keep the totals row consistent with the (re-portioned) slots on screen.
    adapted["totals"] = _sum_items([it for s in adapted["slots"] for it in s["items"]])
    return adapted


class PlanBody(BaseModel):
    targets: Targets
    diet: str = "veg"
    goal: str = "maintain"
    date: str
    regenerate: bool = False
    # What the user has already logged today, and their local clock hour. When
    # provided, the meals still ahead of them are re-portioned to the budget they
    # have left (see _adapt_plan). Optional so the base plan still works alone.
    consumed: Optional[Targets] = None
    hour: Optional[int] = Field(None, ge=0, le=23)


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

    consumed = None
    if body.consumed is not None:
        consumed = {
            "kcal": max(0.0, body.consumed.kcal),
            "protein_g": max(0.0, body.consumed.protein_g),
            "carbs_g": max(0.0, body.consumed.carbs_g),
            "fat_g": max(0.0, body.consumed.fat_g),
        }

    def _respond(plan: dict, cached: bool) -> dict:
        # The saved plan is always the clean full-day version; adaptation to
        # what's been logged is a live view layered on top, never persisted.
        if consumed is not None:
            return {"plan": _adapt_plan(plan, targets, consumed, body.hour), "cached": cached}
        return {"plan": plan, "cached": cached}

    if not body.regenerate:
        saved = _load_saved(acct["id"], date_key)
        if saved and saved.get("signature") == sig:
            return _respond(saved["plan"], True)

    plan = build_plan(targets, diet, goal, date_key)
    _save(acct["id"], date_key, sig, plan)
    return _respond(plan, False)
