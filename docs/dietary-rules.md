# gofit.today — current dietary rules state

There is **no standalone `DietaryRuleEngine` module in the repo today**. Current
diet logic lives mainly in `backend/main.py`.

## What exists today

### Jain / Sattvic classification
`main.py::classify_diet_tags(name, aliases)` returns:
- `yes`
- `no`
- `depends`

This is better than a boolean and is based on rule sets of:
- non-veg words
- onion/garlic words
- root-vegetable words
- stimulant words
- plain-safe words
- masala override

The results are stored in `foods.jain_status` and `foods.sattvic_status`.

### Veg / vegan / eggetarian filtering
`main.py::_food_diet_ok(food, diet)` filters recommendation/search candidates.

Important current behavior:
- if a food dict had explicit `vegetarian` / `vegan` / `eggetarian` fields, it
  would use them
- the live `foods` table does **not** currently store those columns
- so in practice the function falls back to text heuristics

### Where current diet logic is used
- `/foods/recommend`
- `plan.py` daily plan generation via injected pickers
- onboarding/profile diet field

## What already aligns with the spec

- Jain/Sattvic are **not** modeled as booleans in storage today.
- Rules are deterministic, not delegated to the LLM.
- Dietary filtering is server-side, not purely cosmetic client UI.

## What is missing versus the master spec

- configurable `dietary_profiles`
- `dietary_rules`
- `dietary_rule_exclusions`
- `dietary_rule_requirements`
- per-profile recipe validation
- allergen master data with `contains` / `may_contain` / `free_from` /
  `unknown`
- support for broader rule families:
  - halal
  - kosher
  - pescatarian
  - no beef / no pork / no seafood
  - dairy-free / gluten-free / etc.
- user-specific selectable strict/custom rulesets

## Current risks

1. Name-based heuristics are acceptable for the current curated catalog but are
   not sufficient for a trustworthy graph-scale dietary engine.
2. There is no ingredient-level validation for recipes yet.
3. There is no sourced allergen dataset, so allergen safety cannot be claimed.

## Migration recommendation

### Keep now
- `classify_diet_tags()` word lists
- three-state Jain/Sattvic semantics
- server-side filtering pattern

### Add later, after approval
1. `dietary_profiles` and profile selection
2. rule tables with exclusions/requirements
3. ingredient-level recipe validation
4. sourced allergen registry
5. compatibility layer mapping current `diet` values to richer rulesets

## Do not do

- Do not reintroduce a `food.jain=true` style model.
- Do not infer allergen safety from AI output.
- Do not bulk-tag thousands of foods without provenance or review.
