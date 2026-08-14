"""
gofit.today — DietaryRuleEngine.

Per GOFIT_MASTER_ARCHITECTURE_PROMPT.txt: Jain/Sattvic must be configurable
rulesets, not `food.jain = true` booleans; allergen safety must never be
inferred by an LLM. This module wraps the classifier that already exists in
main.py (`classify_diet_tags`) rather than duplicating a second one -- it was
already a real three-tier (yes/no/depends) rule engine driven by dish-name/
alias text, not a boolean, so Month 1 reuses it instead of throwing it away.
"""
from __future__ import annotations

import logging

import db

log = logging.getLogger("gofit.dietary_rules")

# Diet profiles with a real rule implemented below. Anything else returns
# "not_yet_supported" rather than a guessed answer -- see matches_diet().
_SUPPORTED_PROFILES = {"vegetarian", "vegan", "eggetarian", "jain", "sattvic"}


def _classify_diet_tags(name: str, aliases: list) -> tuple:
    """Deferred import to avoid a circular import with main.py (main.py
    imports this module's sibling engines; main.py itself still owns the
    canonical classifier implementation)."""
    import main as _main  # noqa: PLC0415
    return _main.classify_diet_tags(name, aliases)


def _get_food_row(food_id: str):
    with db.connect() as c:
        return c.execute(
            "SELECT food_id, canonical_name, vegetarian, vegan, eggetarian, jain "
            "FROM nutri_foods WHERE food_id=?",
            (food_id,),
        ).fetchone()


def _get_aliases(food_id: str) -> list[str]:
    with db.connect() as c:
        rows = c.execute(
            "SELECT alias FROM nutri_food_aliases WHERE food_id=?", (food_id,)
        ).fetchall()
    return [r["alias"] for r in rows]


def _recipe_ingredient_names(food_id: str) -> list[str]:
    """Every ingredient's canonical name for the recipe backing this food, if
    any -- real INDB data the original main.py classifier never had access
    to (it only ever saw a single dish name/alias list)."""
    with db.connect() as c:
        rows = c.execute(
            """
            SELECT f.canonical_name FROM nutri_recipe_ingredients ri
            JOIN nutri_recipes r ON r.recipe_id = ri.recipe_id
            JOIN nutri_foods f ON f.food_id = ri.ingredient_food_id
            WHERE r.food_id = ?
            """,
            (food_id,),
        ).fetchall()
    return [r["canonical_name"] for r in rows]


def _get_classification_text(food_id: str, canonical_name: str) -> str:
    """Text to run the word-list classifiers against: the food's own name +
    aliases, PLUS -- when a real recipe exists for this food -- every
    ingredient's canonical name. This is a real improvement over main.py's
    original classifier (which only ever saw a single dish name/alias list,
    since it had no ingredient data to draw on): a dish like "Hot tea (Garam
    Chai)" doesn't mention "milk" in its own name, so name-only
    classification wrongly calls it vegan. Cross-referencing
    nutri_recipe_ingredients (real INDB data, not available to the old
    classifier) fixes exactly this class of error."""
    parts = [canonical_name] + _get_aliases(food_id) + _recipe_ingredient_names(food_id)
    return " ".join(parts)


def is_vegetarian(food_id: str) -> str:
    """Returns 'yes'/'no'/'unknown'. Prefers the explicit nutri_foods column
    (backfilled including recipe-ingredient text, see backfill_diet_flags.py);
    falls back to a live classification (also ingredient-aware) for any food
    not yet backfilled."""
    row = _get_food_row(food_id)
    if not row:
        return "unknown"
    if row["vegetarian"] is not None:
        return "yes" if row["vegetarian"] else "no"
    import main as _main  # noqa: PLC0415
    text = _main._norm(_get_classification_text(food_id, row["canonical_name"]))
    if _main._word_in(_main._NON_VEG_WORDS, text):
        return "no"
    return "yes"


def is_vegan(food_id: str) -> str:
    """Returns 'yes'/'no'/'unknown'. Prefers the explicit column; falls back
    to main.py's vegan word list (_NON_VEG_WORDS + _DAIRY_WORDS) run against
    ingredient-aware text, the same rule the existing recommender uses for a
    vegan diet filter."""
    row = _get_food_row(food_id)
    if not row:
        return "unknown"
    if row["vegan"] is not None:
        return "yes" if row["vegan"] else "no"
    import main as _main  # noqa: PLC0415
    text = _main._norm(_get_classification_text(food_id, row["canonical_name"]))
    if _main._word_in(_main._NON_VEG_WORDS, text) or _main._word_in(_main._DAIRY_WORDS, text):
        return "no"
    return "yes"


def is_eggetarian(food_id: str) -> str:
    """Returns 'yes'/'no'/'unknown'. Prefers the explicit column; falls back
    to main.py's meat/fish word list (non-veg minus egg words) run against
    ingredient-aware text, so an eggetarian food can still contain egg but
    never meat/fish."""
    row = _get_food_row(food_id)
    if not row:
        return "unknown"
    if row["eggetarian"] is not None:
        return "yes" if row["eggetarian"] else "no"
    import main as _main  # noqa: PLC0415
    text = _main._norm(_get_classification_text(food_id, row["canonical_name"]))
    if _main._word_in(_main._MEAT_FISH_WORDS, text):
        return "no"
    return "yes"


def is_jain(food_id: str) -> str:
    """Returns 'yes'/'no'/'depends'/'unknown' -- never a boolean, per spec.
    Ingredient-aware (see _get_classification_text) -- a dish's own name
    doesn't have to mention onion/garlic/root veg for the recipe to contain
    them."""
    row = _get_food_row(food_id)
    if not row:
        return "unknown"
    aliases = _get_aliases(food_id) + _recipe_ingredient_names(food_id)
    jain, _ = _classify_diet_tags(row["canonical_name"], aliases)
    return jain


def is_sattvic(food_id: str) -> str:
    """Ingredient-aware, same reasoning as is_jain."""
    row = _get_food_row(food_id)
    if not row:
        return "unknown"
    aliases = _get_aliases(food_id) + _recipe_ingredient_names(food_id)
    _, sattvic = _classify_diet_tags(row["canonical_name"], aliases)
    return sattvic


def contains_allergen(food_id: str, allergen_code: str) -> str:
    """Returns 'contains'/'may_contain'/'free_from'/'unknown'.
    nutri_food_allergens is currently an empty table (no sourced allergen
    dataset exists in this repo yet) -- always 'unknown' today, which is the
    honest answer, not a guess. Never infer from an LLM per the spec."""
    with db.connect() as c:
        row = c.execute(
            "SELECT presence FROM nutri_food_allergens WHERE food_id=? AND allergen_code=?",
            (food_id, allergen_code),
        ).fetchone()
    return row["presence"] if row else "unknown"


def matches_diet(food_id: str, diet_profile: str) -> str:
    """Dispatches to the specific rule for profiles with real signal today.
    Anything else returns 'not_yet_supported' -- see _SUPPORTED_PROFILES."""
    profile = (diet_profile or "").strip().lower()
    if profile not in _SUPPORTED_PROFILES:
        return "not_yet_supported"
    if profile == "vegetarian":
        return is_vegetarian(food_id)
    if profile == "vegan":
        return is_vegan(food_id)
    if profile == "eggetarian":
        return is_eggetarian(food_id)
    if profile == "jain":
        return is_jain(food_id)
    if profile == "sattvic":
        return is_sattvic(food_id)
    return "not_yet_supported"  # pragma: no cover -- unreachable given the set check above
