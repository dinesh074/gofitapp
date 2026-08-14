# gofit.today — Roadmap

Restates `GOFIT_MASTER_ARCHITECTURE_PROMPT.txt`'s 12-month plan, annotated
with real progress. Tracked task-by-task in the session's todo list (`m1-foundation`
… `m12-optimize`, each depending on the previous).

## Month 1 — Foundation (in progress, this cycle)
**Scope**: schema, FoodEntity, NutritionEngine, DietaryRuleEngine,
PortionEngine, API, AI abstraction.

Delivered:
- `nutri_*` schema in the existing `gofit` Postgres schema, loaded with real
  INDB data (1,347 foods, 41,064 nutrients, 1,014 recipes) — see
  `data-model.md`.
- `backend/nutrition_engine.py` — `get_food`, `get_food_nutrients`,
  `calculate_portion_nutrition`, `calculate_recipe_nutrition`.
- `backend/dietary_rules.py` — `is_vegetarian/vegan/eggetarian/jain/sattvic`,
  `contains_allergen`, `matches_diet`, reusing the existing name-based
  classifier from `main.py` rather than duplicating it.
- `backend/portion_engine.py` — `list_portions`, `resolve_portion`,
  `generic_household_unit_to_grams`.
- `backend/ai_provider.py` — `AIProvider` interface, `GeminiProvider`
  (extracted from `main.py` unchanged), `FutureQwenProvider`/
  `FutureOpenAIProvider` placeholders, `get_provider()` env-driven switch.
  `main.py`'s `_generate()` now routes through it.
- `backend/nutrition_api.py` — first read-only `/api/nutrition/*` HTTP
  surface over the graph (search, food detail, nutrients, portions,
  diet-check, recipe detail/nutrition/ingredients). Mounted in `main.py`
  alongside (not replacing) the existing `/foods/*` endpoints.
- Docs: `architecture.md`, `data-model.md`, `nutrition-engine.md`,
  `dietary-rules.md`, `combination-engine.md`, `ai-architecture.md`,
  this file.

Not done yet (explicitly deferred, not forgotten):
- `calculate_meal_nutrition/daily/weekly` (need `food_logs` — Month 3).
- Configurable per-user dietary rulesets / `dietary_profiles` table.
- Any write/admin endpoints for the graph.
- Migrating the live scanner off the old `foods` table (Month 4, deliberate).

## Month 2 — Food intelligence
Canonical foods, aliases, Indian/regional mapping, nutrient sources,
portions, recipes — expanding the real dataset toward the ~20,000 Phase 1
target.

Delivered this cycle (real gaps found by auditing the Month-1 load, fixed
not fabricated):
- Populated `nutri_portion_conversions` with generic tsp/tbsp/cup/ml → gram
  conversions (water-basis, confidence='low') so recipe nutrition math can
  use the 51% of `nutri_recipe_ingredients` rows that aren't already in g/ml.
- Fixed `calculate_recipe_nutrition` to use those conversions — verified
  ingredients that previously fell into `unconverted_ingredients` now
  contribute correctly.
- Backfilled `nutri_foods.vegetarian/vegan/eggetarian` for all 1,347 foods
  (previously 100% NULL), using the existing classifier PLUS real
  recipe-ingredient names — a real accuracy improvement over name-only
  classification (found 765 non-vegan / 319 non-vegetarian foods vs.
  353/129 with name-only checks).

Explicitly NOT done (real, audited gaps — not invented data):
- Region/cuisine are 100% placeholder ("India"/"Indian") — the INDB source
  has no real per-food regional tagging (Punjab/Gujarat/South
  Indian/Bengali/etc.). Needs a real data source before this can be filled
  in; fabricating regions was rejected as dishonest.
- Expanding beyond the 1,347 real foods toward the ~20,000 target — no new
  bulk data source identified yet this cycle.
- `nutri_food_nutrient_sources` (extended per-value citation trail) still
  empty.

## Month 3 — Logging
Manual logging parser, voice logging, search, daily nutrition aggregation,
`food_logs` referencing `nutri_foods`. Not started.

## Month 4 — Scanner
Rebuild the scanner pipeline around the graph with confidence tiers and
`ai_scan_results`/`ai_corrections`. This is when the live `foods` table vs.
`nutri_foods` decision gets made (see `architecture.md` risks). Not started.

## Month 5 — Recipe intelligence
Ingredient decomposition, raw/cooked yields, homemade vs. restaurant,
recipe variants. Not started (though `calculate_recipe_nutrition` from Month
1 is a first step toward this).

## Month 6 — Combination engine
Deterministic generate/find/rank/substitute functions, meal templates, first
~100k validated combinations. Documented (`combination-engine.md`) but not
started.

## Month 7 — 1M combinations
Scale generation/dedup/validation/scoring to the full target distribution.
Not started.

## Month 8 — Planning + micronutrient gaps
Daily/weekly planner, "Fix My Day", micronutrient gap engine. Not started.

## Month 9 — Training-aware nutrition
Pre/post-workout, recovery, training-day carb adjustments. Not started.

## Month 10 — Substitutions + grocery
Substitution engine, grocery list generation, budget/cooking-time filters.
Not started.

## Month 11 — AI coach
Tool-using conversational coach (`search_food`, `find_meals`,
`generate_daily_plan`, etc. as callable tools). Not started.

## Month 12 — Optimize
Evaluate Qwen/self-hosting/GPU/pgvector/Redis only if real usage justifies
it. Not started (correctly — nothing before this should be built
prematurely either).
