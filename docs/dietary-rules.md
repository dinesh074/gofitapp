# gofit.today — Dietary Rule Engine

Implemented in `backend/dietary_rules.py` this cycle. Configurable rulesets,
not `food.jain = true` booleans — matches the spec's explicit requirement.

## What exists already (kept, not rebuilt)
`main.py`'s `classify_diet_tags()` already does real work: a three-tier
(`yes`/`no`/`depends`) Jain/Sattvic classifier driven by word-boundary
matching against a dish's name/aliases (non-veg words, onion/garlic words,
root-veg words, stimulant words, a "plain-safe" whitelist, and a "masala"
override that was found as a real false-positive during development). This
is a legitimate first-pass rule engine and Month 1's `DietaryRuleEngine`
reuses its word lists rather than duplicating a second classifier.

## New this cycle (`dietary_rules.py`)
- `is_vegetarian/is_vegan/is_eggetarian(food)` — driven by the `nutri_foods`
  boolean columns (`vegetarian`, `vegan`, `eggetarian`) where set; falls back
  to the name/alias word-list classifier when the column is `NULL` (most rows
  today, since INDB didn't supply these flags — see `data-model.md`).
- `is_jain(food)` / `is_sattvic(food)` — wraps `classify_diet_tags`, returns
  `yes`/`no`/`depends`, never a boolean.
- `contains_allergen(food, allergen_code)` — checks `nutri_food_allergens`
  (currently empty — always returns `unknown` honestly rather than guessing;
  the spec explicitly forbids inferring allergen safety from an LLM or from
  absence of data).
- `matches_diet(food, diet_profile)` — dispatches to the above for the ~10
  diet profiles that have real signal today (vegetarian/vegan/eggetarian/
  jain/sattvic); profiles without implemented rules yet (halal/kosher/
  pescatarian/etc.) return `"not_yet_supported"` rather than a false answer.

## Not yet implemented
Configurable per-user rulesets (`dietary_profiles`/`dietary_rule_exclusions`/
`dietary_rule_requirements` tables), `validateRecipe()` against a selected
profile, and allergen data itself (needs a real sourced allergen dataset —
none exists in the repo yet, so `nutri_food_allergens` stays empty rather
than guessed).
