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
from pydantic import BaseModel, Field, field_validator, ValidationInfo

import db
import auth
import entitlements

log = logging.getLogger("gofit.plan")
router = APIRouter(tags=["plan"])

# Injected by main.py at startup (see configure()). Kept as module globals so the
# route handlers can reach the food DB + Gemini without importing main.
_pick_for_slot: Optional[Callable] = None
_ai_note: Optional[Callable] = None
_pick_meal_for_slot: Optional[Callable] = None
_build_day_plan: Optional[Callable] = None


def configure(
    pick_for_slot: Callable,
    ai_note: Callable,
    pick_meal_for_slot: Optional[Callable] = None,
    build_day_plan: Optional[Callable] = None,
) -> None:
    """Wire in the food-selection + AI-note callables owned by main.py."""
    global _pick_for_slot, _ai_note, _pick_meal_for_slot, _build_day_plan
    _pick_for_slot = pick_for_slot
    _ai_note = ai_note
    _pick_meal_for_slot = pick_meal_for_slot
    _build_day_plan = build_day_plan


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
# `anchor_grain` marks the meals that, for an Indian plate, should be BUILT
# AROUND a grain staple (rice / roti / etc.) with the protein + veg alongside,
# rather than being an arbitrary pile of curries. This is what makes lunch and
# dinner read like real meals ("rice + dal + sabzi") instead of "rajma + chole".
SLOTS = [
    ("breakfast", "Breakfast", 0.25, True),
    ("lunch", "Lunch", 0.35, True),
    ("snack", "Snack", 0.15, False),
    ("dinner", "Dinner", 0.25, True),
]

# Portion is expressed as servings of the chosen dish, rounded to a half serving
# and clamped. A single item is capped low (MAX_ITEM_SERVINGS) so a slot COMBINES
# a few complementary dishes to hit its budget rather than asking for one giant
# helping -- that is what keeps the macros balanced instead of, say, tripling a
# fat-heavy paneer dish just to reach the calorie number. Capped at 1.5 so the
# plan never reads as "two poha / two sambar" -- an odd-looking double serving --
# and instead pairs a second complementary dish.
MIN_SERVINGS = 0.5
MAX_ITEM_SERVINGS = 1.5
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
# A wider pool used only when hunting for a grain anchor -- grains rank below
# protein dishes on macro-fit, so we look deeper to make sure rice/roti/etc. are
# actually reachable for the meal's base.
GRAIN_POOL = 70
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


# Grain / carbohydrate staples that form the BASE of an Indian meal. A main meal
# (lunch/dinner) is anchored on one of these so the plate reads like real food
# ("rice + dal + sabzi") instead of a stack of curries with no grain. Matched as
# whole words against the dish name so "fried rice" counts but "ricotta" doesn't.
_GRAIN_WORDS = {
    "rice", "roti", "chapati", "chapatti", "phulka", "naan", "paratha", "parantha",
    "puri", "poori", "bhatura", "kulcha", "thepla", "bhakri", "pulao", "pulav",
    "biryani", "khichdi", "poha", "upma", "idli", "dosa", "uttapam", "appam",
    "dalia", "daliya", "oats", "vermicelli", "sevai", "paniyaram", "pongal",
    "sabudana", "millet", "bajra", "jowar", "ragi", "quinoa", "bread", "sandwich",
}


def _is_grain(food: dict) -> bool:
    name = (food.get("name") or food.get("key", "")).lower().replace("_", " ").replace("-", " ")
    toks = set(name.split())
    return bool(toks & _GRAIN_WORDS)


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
            str(int(round((targets.get("fiber_g", 0) or 0) / 5.0))),
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
    out = {
        "key": food["key"],
        "name": food.get("name") or food["key"].replace("_", " ").title(),
        "unit": food.get("unit", "serving"),
        "count": servings,
        "kcal": round(servings * (food.get("kcal_per_unit", 0) or 0)),
        "protein_g": round(servings * (food.get("protein_g_per_unit", 0) or 0), 1),
        "carbs_g": round(servings * (food.get("carbs_g_per_unit", 0) or 0), 1),
        "fat_g": round(servings * (food.get("fat_g_per_unit", 0) or 0), 1),
    }
    if food.get("fiber_g") is not None:
        out["fiber_g"] = round(servings * (food.get("fiber_g") or 0), 1)
    return out


def _slot_has_incompatible_pair(slot_items: list[dict]) -> bool:
    keys = [str(i.get("key", "")).lower() for i in slot_items]
    names = [str(i.get("name", "")).lower() for i in slot_items]
    def _has(token: str) -> bool:
        return any(token in k for k in keys) or any(token in n for n in names)
    # Hard reject rules from product constraints.
    if _has("biryani") and _has("sambar"):
        return True
    if _has("naan") and len(slot_items) == 1:
        return True
    return False


def _looks_staple_only(slot_items: list[dict]) -> bool:
    if len(slot_items) != 1:
        return False
    t = f"{slot_items[0].get('key', '')} {slot_items[0].get('name', '')}".lower()
    return any(w in t for w in _STAPLE_WORDS)


def _plan_quality_score(plan: dict, targets: dict) -> float:
    totals = plan.get("totals", {})
    t_kcal = max(1.0, float(targets.get("kcal", 0) or 0))
    t_p = max(1.0, float(targets.get("protein_g", 0) or 0))
    t_c = max(1.0, float(targets.get("carbs_g", 0) or 0))
    t_f = max(1.0, float(targets.get("fat_g", 0) or 0))
    kcal_ratio = float(totals.get("kcal", 0) or 0) / t_kcal
    p_ratio = float(totals.get("protein_g", 0) or 0) / t_p
    c_ratio = float(totals.get("carbs_g", 0) or 0) / t_c
    f_ratio = float(totals.get("fat_g", 0) or 0) / t_f
    score = 0.0
    score += abs(1.0 - kcal_ratio) * 2.0
    score += max(0.0, 0.9 - p_ratio) * 4.0
    score += max(0.0, c_ratio - 1.1) * 2.0
    score += max(0.0, f_ratio - 1.1) * 2.0
    for s in plan.get("slots", []):
        if s.get("slot") in ("lunch", "dinner") and _looks_staple_only(s.get("items", [])):
            score += 3.0
        if _slot_has_incompatible_pair(s.get("items", [])):
            score += 6.0
    return score


def _validate_plan(plan: dict, targets: dict) -> tuple[bool, str]:
    totals = plan.get("totals", {})
    t_kcal = max(1.0, float(targets.get("kcal", 0) or 0))
    t_p = max(1.0, float(targets.get("protein_g", 0) or 0))
    t_c = max(1.0, float(targets.get("carbs_g", 0) or 0))
    t_f = max(1.0, float(targets.get("fat_g", 0) or 0))
    kcal_ratio = float(totals.get("kcal", 0) or 0) / t_kcal
    p_ratio = float(totals.get("protein_g", 0) or 0) / t_p
    c_ratio = float(totals.get("carbs_g", 0) or 0) / t_c
    f_ratio = float(totals.get("fat_g", 0) or 0) / t_f
    if p_ratio < 0.8:
        return False, f"protein too low ({p_ratio:.2f}x target)"
    if c_ratio > 1.2:
        return False, f"carbs too high ({c_ratio:.2f}x target)"
    if f_ratio > 1.2:
        return False, f"fat too high ({f_ratio:.2f}x target)"
    if kcal_ratio < 0.88 or kcal_ratio > 1.12:
        return False, f"calories off target ({kcal_ratio:.2f}x)"
    for s in plan.get("slots", []):
        items = s.get("items", [])
        if s.get("slot") in ("lunch", "dinner") and _looks_staple_only(items):
            return False, f"{s.get('slot')} is staple-only"
        if _slot_has_incompatible_pair(items):
            return False, f"{s.get('slot')} contains incompatible foods"
    return True, "ok"


def _sum_items(items: list) -> dict:
    out = {
        "kcal": round(sum(i["kcal"] for i in items)),
        "protein_g": round(sum(i["protein_g"] for i in items), 1),
        "carbs_g": round(sum(i["carbs_g"] for i in items), 1),
        "fat_g": round(sum(i["fat_g"] for i in items), 1),
    }
    fibre_vals = [i.get("fiber_g") for i in items if i.get("fiber_g") is not None]
    if fibre_vals:
        out["fiber_g"] = round(sum(fibre_vals), 1)
    return out


def _build_slot(
    slot_key: str,
    label: str,
    frac: float,
    anchor_grain: bool,
    targets: dict,
    diet: str,
    goal: str,
    training_context: str,
    used: dict,
    used_family: dict,
    rng: random.Random,
) -> dict:
    """Greedily fill one slot toward its share of the day's budget, re-ranking
    the food DB against the SHRINKING remaining budget after each pick. Because
    the scorer penalises fat/calorie overshoot, once protein or fat is met the
    next pick naturally skews leaner/carbier -- so a slot ends up balanced rather
    than one macro-lopsided dish scaled up. `used`/`used_family` count how many
    times each exact dish and each ingredient family have been placed today so
    nothing repeats (variety); picks are SAMPLED from the top of the pool so the
    day varies and 'New plan' yields a different day. When `anchor_grain` is set
    (lunch/dinner), the FIRST pick is forced to be a grain staple (rice/roti/...)
    so the meal is built on a real base, not just a pile of curries."""
    budget = {
        "kcal": targets["kcal"] * frac,
        "protein_g": targets["protein_g"] * frac,
        "carbs_g": targets["carbs_g"] * frac,
        "fat_g": targets["fat_g"] * frac,
    }
    if _pick_meal_for_slot is not None:
        try:
            built = _pick_meal_for_slot(budget, diet, goal, slot_key, training_context, MAX_ITEMS_PER_SLOT) or []
            if built:
                used_local: list[dict] = []
                for it in built:
                    key = str(it.get("key", "")).strip()
                    if not key:
                        continue
                    if used.get(key, 0) >= MAX_DISH_PER_DAY:
                        continue
                    fam = _family(it)
                    if used_family.get(fam, 0) >= MAX_FAMILY_PER_DAY:
                        continue
                    used[key] = used.get(key, 0) + 1
                    used_family[fam] = used_family.get(fam, 0) + 1
                    used_local.append(it)
                if used_local:
                    slot = {
                        "slot": slot_key,
                        "label": label,
                        "target_kcal": round(budget["kcal"]),
                        "items": used_local,
                    }
                    slot.update(_sum_items(used_local))
                    return slot
        except TypeError:
            # Older call signatures are still accepted by fallback picker logic.
            pass
    rem = dict(budget)
    items: list = []
    for _ in range(MAX_ITEMS_PER_SLOT):
        if rem["kcal"] < budget["kcal"] * SLOT_FILL_STOP:
            break
        is_anchor = len(items) == 0
        # For a main-meal anchor pull a WIDER pool so the grain staples (which are
        # carb-heavy and rank below protein dishes on macro-fit) are actually in
        # reach, then restrict to grains. Fillers use the normal pool.
        pool = (GRAIN_POOL if (is_anchor and anchor_grain) else CANDIDATE_POOL)
        role_hint = "staple" if (is_anchor and anchor_grain) else ("snack_base" if (is_anchor and slot_key == "snack") else "protein")
        # Backward-compatible call shape: newer pickers can use slot/training/role
        # context; older ones still receive the 4-arg signature.
        try:
            foods = _pick_for_slot(rem, diet, goal, pool, slot_key, training_context, role_hint) or []
        except TypeError:
            foods = _pick_for_slot(rem, diet, goal, pool) or []
        # Candidates that aren't already used up for the day (by exact dish OR by
        # ingredient family), aren't already in THIS slot, and (once the slot has
        # something) wouldn't blow the fat budget even at the minimum portion --
        # so a lean protein still gets in but another fat-dense dish is skipped
        # in favour of a leaner option.
        slot_keys = {it["key"] for it in items}
        slot_has_grain = any(_is_grain({"key": it["key"], "name": it["name"]}) for it in items)

        def _ok(f: dict) -> bool:
            if used.get(f["key"], 0) >= MAX_DISH_PER_DAY or f["key"] in slot_keys:
                return False
            if used_family.get(_family(f), 0) >= MAX_FAMILY_PER_DAY:
                return False
            # One grain base per meal -- once a slot has its grain, further picks
            # are the protein/veg alongside it, never a second bread/rice.
            if slot_has_grain and _is_grain(f):
                return False
            fpu = f.get("fat_g_per_unit", 0) or 0
            if items and fpu > 0 and rem["fat_g"] > 0 and MIN_SERVINGS * fpu > rem["fat_g"] * 1.6:
                return False
            return True

        eligible = [f for f in foods if _ok(f)]
        if is_anchor and anchor_grain:
            grains = [f for f in eligible if _is_grain(f)]
            if grains:
                eligible = grains  # meal is built on a grain base
        food = _choose(rng, eligible, sample=is_anchor)
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


def build_plan(
    targets: dict,
    diet: str,
    goal: str,
    date_key: str,
    training_context: str = "",
    account_id: Optional[int] = None,
    rng: Optional[random.Random] = None,
) -> dict:
    rng = rng or random.Random()
    slots = []
    if _build_day_plan is not None:
        try:
            shared_slots = _build_day_plan(
                account_id=account_id,
                date_key=date_key,
                targets=targets,
                diet=diet,
                goal=goal,
                training_context=training_context,
            )
            if isinstance(shared_slots, list) and shared_slots:
                slots = shared_slots
        except Exception as ex:
            log.info("plan: shared day planner failed (%s) -- falling back to slot builder", ex)
    if not slots:
        used: dict = {}
        used_family: dict = {}
        slots = [
            _build_slot(k, l, f, ag, targets, diet, goal, training_context, used, used_family, rng)
            for k, l, f, ag in SLOTS
        ]
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
    fiber_g: Optional[float] = Field(None, ge=0, le=500)

    # The client computes these locally (nutrition.ts) and a transient
    # NaN during a profile edit/reload (e.g. a field briefly blank) serializes
    # to JSON `null`. Coerce that -- and any other non-finite value -- to 0
    # instead of hard-422ing the whole plan request: a client-side bug in one
    # macro shouldn't take down the plan for the rest of the (valid) numbers.
    @field_validator("kcal", "protein_g", "carbs_g", "fat_g", "fiber_g", mode="before")
    @classmethod
    def _coerce_missing_to_zero(cls, v, info: ValidationInfo):
        if v is None:
            return None if info.field_name == "fiber_g" else 0
        try:
            f = float(v)
        except (TypeError, ValueError):
            return None if info.field_name == "fiber_g" else 0
        if f == f and f not in (float("inf"), float("-inf")):
            return f
        return None if info.field_name == "fiber_g" else 0  # f == f is False for NaN


# The clock hour (local) by which each meal is assumed to be over. Used to decide
# which slots are still AHEAD of the user so only those get re-portioned to the
# calories/macros they have left -- meals already behind them are left as they
# were (a record of what was suggested), never resized retroactively.
_SLOT_END_HOUR = {"breakfast": 10, "lunch": 15, "snack": 18, "dinner": 24}
_CORE_KEYS = ("kcal", "protein_g", "carbs_g", "fat_g")
_OPTIONAL_KEYS = ("fiber_g",)
_NUTRIENT_KEYS = _CORE_KEYS + _OPTIONAL_KEYS

_STATUS_ON = 0.05
_STATUS_SLIGHT = 0.12
_STAPLE_WORDS = (
    "roti", "chapati", "naan", "rice", "biryani", "poha", "upma", "idli", "dosa",
    "puri", "paratha", "khichdi", "pulao", "pongal",
)


def _slot_actionable(slot: dict, hour: Optional[int]) -> bool:
    if "upcoming" in slot:
        return bool(slot.get("upcoming"))
    if hour is None:
        return True
    return hour < _SLOT_END_HOUR.get(slot.get("slot", ""), 24)


def _metric_status(have: float, target: float) -> str:
    if target <= 0:
        return "on_target"
    d = (have - target) / target
    if abs(d) <= _STATUS_ON:
        return "on_target"
    if d < 0:
        return "slightly_below" if abs(d) <= _STATUS_SLIGHT else "significantly_below"
    return "slightly_above" if abs(d) <= _STATUS_SLIGHT else "significantly_above"


def _attach_plan_sections(plan: dict, hour: Optional[int]) -> dict:
    completed_slots: list[str] = []
    planned_slots: list[str] = []
    next_slot: Optional[str] = None
    next_label: Optional[str] = None
    for s in plan.get("slots", []):
        actionable = _slot_actionable(s, hour)
        s["actionable"] = actionable
        s["completed"] = not actionable
        if actionable:
            planned_slots.append(s.get("slot"))
            if next_slot is None and s.get("items"):
                next_slot = s.get("slot")
                next_label = s.get("label")
        else:
            completed_slots.append(s.get("slot"))
    if next_slot is None and planned_slots:
        # Fallback if upcoming slots are intentionally empty after adaptation.
        first = next((s for s in plan.get("slots", []) if s.get("slot") == planned_slots[0]), None)
        next_slot = planned_slots[0]
        next_label = first.get("label") if first else planned_slots[0]
    plan["completed_slots"] = completed_slots
    plan["planned_slots"] = planned_slots
    plan["next_slot"] = next_slot
    plan["next_meal"] = next_label
    return plan


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
        **({"fiber_g": round((it.get("fiber_g", 0) or 0) * r, 1)} if ("fiber_g" in it) else {}),
    }


def _adapt_plan(plan: dict, targets: dict, consumed: dict, hour: Optional[int]) -> dict:
    """Return a COPY of the day's plan adapted to what the user has actually
    logged so far: meals still ahead of them (by clock hour) are re-portioned so
    that, together, they fill exactly the calories/macros left in the day. The
    day's dish choices stay put (stability); only portions move. Nothing is
    persisted -- the saved plan remains the clean full-day version; this is the
    live view layered on top for the current moment."""
    adapted = json.loads(json.dumps(plan))  # deep copy, never mutate the saved plan
    keys = [k for k in _NUTRIENT_KEYS if (k in targets and k in consumed)]
    raw_remaining = {m: targets[m] - consumed.get(m, 0.0) for m in keys}
    remaining = {m: max(0.0, raw_remaining[m]) for m in keys}
    over_target = {m: max(0.0, -raw_remaining[m]) for m in keys}

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

    adapted["consumed"] = {m: round(consumed.get(m, 0.0), 1) for m in keys}
    adapted["remaining"] = {m: round(remaining[m], 1) for m in keys}
    adapted["over_target"] = {m: round(over_target[m], 1) for m in keys}
    adapted["adapted"] = True
    # Keep the totals row consistent with the (re-portioned) slots on screen.
    adapted["totals"] = _sum_items([it for s in adapted["slots"] for it in s["items"]])
    adapted = _attach_plan_sections(adapted, hour)
    planned = _sum_items([it for s in adapted["slots"] if s.get("actionable") for it in s["items"]])
    projected = {m: round((adapted["consumed"].get(m, 0.0) + planned.get(m, 0.0)), 1) for m in keys}
    adapted["planned"] = {m: round(planned.get(m, 0.0), 1) for m in keys}
    adapted["projected"] = projected
    adapted["status"] = {m: _metric_status(projected[m], targets[m]) for m in keys}
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
    training: Optional[str] = None


@router.post("/plan/today")
def plan_today(body: PlanBody, request: Request):
    # Personalized meal planning is a Pro feature. require_pro resolves the
    # account and (when ENFORCE_PRO is on) 402s Free accounts with a paywall.
    acct = entitlements.require_pro(request, "meal_planning")
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
    if body.targets.fiber_g is not None:
        targets["fiber_g"] = max(0.0, body.targets.fiber_g)
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
        if body.consumed.fiber_g is not None:
            consumed["fiber_g"] = max(0.0, body.consumed.fiber_g)

    def _respond(plan: dict, cached: bool) -> dict:
        # The saved plan is always the clean full-day version; adaptation to
        # what's been logged is a live view layered on top, never persisted.
        if consumed is not None:
            return {"plan": _adapt_plan(plan, targets, consumed, body.hour), "cached": cached}
        base = _attach_plan_sections(json.loads(json.dumps(plan)), body.hour)
        base["planned"] = _sum_items([it for s in base["slots"] if s.get("actionable") for it in s["items"]])
        base["status"] = {m: _metric_status(base["planned"][m], targets[m]) for m in _CORE_KEYS}
        if "fiber_g" in targets and "fiber_g" in base["planned"]:
            base["status"]["fiber_g"] = _metric_status(base["planned"]["fiber_g"], targets["fiber_g"])
        return {"plan": base, "cached": cached}

    if not body.regenerate:
        saved = _load_saved(acct["id"], date_key)
        if saved and saved.get("signature") == sig:
            return _respond(saved["plan"], True)

    best_plan = None
    best_score = 1e18
    seed = abs(hash((acct["id"], date_key, sig))) % 1_000_000
    for i in range(8):
        cand = build_plan(
            targets,
            diet,
            goal,
            date_key,
            training_context=((body.training or "").strip().lower()),
            account_id=acct["id"],
            rng=random.Random(seed + i),
        )
        ok, reason = _validate_plan(cand, targets)
        score = _plan_quality_score(cand, targets)
        if score < best_score:
            best_score = score
            best_plan = cand
        if ok:
            best_plan = cand
            log.info("plan validation: accepted on attempt %d (score=%.3f)", i + 1, score)
            break
        log.info("plan validation: rejected attempt %d (%s, score=%.3f)", i + 1, reason, score)
    plan = best_plan or build_plan(
        targets,
        diet,
        goal,
        date_key,
        training_context=((body.training or "").strip().lower()),
        account_id=acct["id"],
    )
    _save(acct["id"], date_key, sig, plan)
    return _respond(plan, False)
