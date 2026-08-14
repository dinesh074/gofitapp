# gofit.today — Data Model

Real, as-inspected schema for both the existing production tables and the new
`nutri_*` Food Intelligence Graph tables (all in the single `gofit` Postgres
schema — see `architecture.md` for why nothing lives in a separate schema).

## Existing tables (unchanged by this work)
- `foods` — live scanner/food DB. `key` TEXT PK, `unit`, `kcal_per_unit`,
  `protein_g`, `carbs_g`, `fat_g`, `fiber_g`, `sugar_g`, `sodium_mg`,
  `potassium_mg`, `calcium_mg`, `iron_mg`, `health_score`, `benefits_json`,
  `watch_outs_json`, `micros_json`, `aliases_json`, `jain_status`,
  `sattvic_status`, `source_name`, `source`.
- `accounts`, `profiles`, `otp_codes`, `tokens`, `meal_logs`, `exercise_logs`,
  `unmatched_dishes`, community tables — see `backend/auth.py`,
  `backend/community.py`, `backend/progress.py` for exact columns; unchanged.

## New tables — `nutri_*` (this cycle, `gofit_today_nutrition_db_v1/schema_postgres.sql`)

All PKs are `TEXT` (not UUID) so the real INDB source IDs
(`INDB_RECIPE_ASC001`, `SRC_FOOD_L002`, `RECIPE_ASC001`, ...) load unmodified.

| Table | Role | Live rows |
|---|---|---|
| `nutri_data_sources` | Provenance registry (`source_id` PK) | 13 |
| `nutri_nutrient_dictionary` | Fixed nutrient vocabulary (`nutrient_code` PK, group, unit, basis) | 85 |
| `nutri_foods` | Canonical FoodEntity: `food_id`, `canonical_name`, `entity_type` (ingredient/dish/...), `region`, `cuisine`, diet booleans, `source_id`, `status` | 1,347 |
| `nutri_food_nutrients` | Per-food nutrient values, **never fabricated**: `amount` nullable, `value_status` (measured/calculated/estimated/trace/missing), `source_id` | 41,064 |
| `nutri_food_nutrient_sources` | Extended per-value citation trail | 0 (not yet populated beyond primary `source_id`) |
| `nutri_food_aliases` | Alias/transliteration/misspelling → `food_id` | 1,892 |
| `nutri_food_translations` | Structured per-language translated names | 0 |
| `nutri_portions` | Household portion → gram/ml weight | 1,014 |
| `nutri_portion_conversions` | Free-form unit → gram conversions | 5 (generic tsp/tbsp/cup/ml water-basis, confidence='low' — Month 2) |
| `nutri_recipes` | Recipe metadata → optional `food_id` | 1,014 |
| `nutri_recipe_ingredients` | Recipe → ingredient `food_id` + quantity/unit | 10,271 |
| `nutri_recipe_steps` | Recipe instructions | 0 (INDB package didn't include step text) |
| `nutri_cooking_yields` | Raw→cooked yield factors | 0 (empty template — do not fabricate) |
| `nutri_meal_combinations` / `nutri_meal_combination_items` | Combination-engine output (Month 6+) | 0 |
| `nutri_food_tags` | Free tag/value pairs (e.g. dietary tags) | 0 |
| `nutri_food_allergens` | Allergen presence states | 0 (empty template — do not fabricate) |
| `nutri_food_images` | Image metadata | 0 |
| `nutri_validation_rules` | Documentation table of data-quality gates | 10 |
| `nutri_food_catalog_plan` | 20k-slot ingestion blueprint (planned names only) | 0 (cleared — superseded by real data; keep for later gap-filling reference in the CSV, not re-imported blind) |
| `nutri_seed_foods` | First 57 canonical names for the original mapping pass | 57 |

## Data source

`GOFIT_REAL_INDB_DATABASE/` (Indian Nutrient Databank, CC BY 4.0): 1,347 real
foods (1,014 recipes + 333 ingredient components), 41,064 sourced nutrient
observations across 39 nutrient codes, 1,014 recipes with 10,271 real
ingredient-quantity mappings, 1,014 portions, 1,892 aliases. Verified zero
orphaned foreign keys after load (`backend/load_real_indb.py`).

## Month 2 fixes (see backend/populate_portion_conversions.py, backend/backfill_diet_flags.py)

- `nutri_foods.vegetarian/vegan/eggetarian` backfilled for all 1,347 rows
  (previously 100% NULL) using the existing word-list classifier PLUS real
  recipe-ingredient names — catching composite dishes whose own name doesn't
  reveal what's inside. 319 non-vegetarian / 765 non-vegan foods found this
  way, vs. 129/353 with name-only classification (main.py's original
  method). Re-run `backfill_diet_flags.py` after any bulk food import.
- Generic (food-agnostic) tsp/tbsp/cup/ml → gram conversions added so
  `calculate_recipe_nutrition` can sum the 51% of recipe_ingredient rows
  that use those units instead of skipping them.

## Known gaps vs the full spec's table list (still open)
Not yet created (Month 2+ per roadmap, only when there's real data to put in
them — never as empty scaffolding pretending to be populated):
`food_variants`, `food_preparations`, `recipe_variants`, `dietary_profiles`,
`dietary_rule_exclusions`, `dietary_rule_requirements`, `regional_foods`,
`regional_aliases`, `meal_templates`, `food_substitutions`, `user_preferences`,
`user_goals`, `user_nutrition_targets`, `food_logs` (graph-referencing —
distinct from the existing free-text `meal_logs`), `training_sessions`,
`training_context`, `daily_nutrition`, `weekly_nutrition`, `ai_scan_results`,
`ai_corrections`, `combination_candidates`, `combination_validated`,
`combination_scores`.
