# gofit.today — Nutrition Engine

One central engine, not scattered arithmetic. Implemented in
`backend/nutrition_engine.py` this cycle, reading real data from the `nutri_*`
tables (see `data-model.md`). Never fabricates values — a missing nutrient
stays `None` in the response with its `value_status`, it is never coerced to 0.

## Functions (Month 1 scope — implemented)
- `get_food_nutrients(food_id)` — every stored nutrient row for one food,
  each carrying `amount`, `unit`, `value_status`, `source_id`, `confidence`.
- `calculate_portion_nutrition(food_id, portion_id | grams)` — scales a food's
  per-100g nutrient values to a given portion (via `nutri_portions.gram_weight`)
  or an explicit gram amount. If `gram_weight` is unknown for a requested
  portion, returns the portion unscaled with a `"scale_status": "no_gram_weight"`
  flag rather than guessing a conversion.
- `calculate_recipe_nutrition(recipe_id)` — sums `quantity`-weighted ingredient
  nutrition across `nutri_recipe_ingredients`, joined to each ingredient's own
  `nutri_food_nutrients`. Falls back to the recipe's own pre-calculated
  `nutri_food_nutrients` row (linked via `nutri_recipes.food_id`) when an
  ingredient is missing standalone nutrient data (documented in
  `architecture.md`'s risks — INDB recipes came with dish-level values
  already; this lets us cross-check recipe-derived vs. source-provided sums
  later without silently overwriting either).

## Functions (not yet implemented — later months)
- `calculate_meal_nutrition()`, `calculate_daily_nutrition()`,
  `calculate_weekly_nutrition()` — depend on `food_logs`/`daily_nutrition`
  tables that don't exist yet (Month 3 logging work).

## Design rules followed
- All math lives here, not in the AI layer and not duplicated per-endpoint.
- `value_status` is always propagated up to the API response — clients (or a
  future "Estimated vs Verified" UI label, already shipped for the scanner)
  can distinguish measured/calculated/estimated/trace/missing.
- Basis-aware: every nutrient amount is per_100g by default; scaling always
  goes through one function (`_scale`) so portion math can't drift between
  callers.
