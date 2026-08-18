# GoFit Nutrition Database — Final Integration Package

Every CSV filename is the intended table name. Import the files under `tables/`. `TABLE_MANIFEST.json` maps each filename/table to its columns.

This package combines the source-backed v2 foundation, regional coverage, meat/fish/prawn layer, and portion/serving layer. Source-backed nutrition is kept separate from regional discovery/candidate records; no fabricated calories are added.

## Important integration rule
Do not treat plate, bowl, handi, or piece as universal gram conversions. Resolve them through source-defined servings, food-specific portions, recipe yield, or user calibration.

## Main tables
- `cooking_yield_factors` → `cooking_yield_factors.csv`
- `data_quality_flags` → `data_quality_flags.csv`
- `data_sources` → `data_sources.csv`
- `food_aliases` → `food_aliases.csv`
- `food_nutrients_core` → `food_nutrients_core.csv`
- `food_portions` → `food_portions.csv`
- `food_source_records` → `food_source_records.csv`
- `foods` → `foods.csv`
- `ifct2017_nutrients_full_long` → `ifct2017_nutrients_full_long.csv`
- `indb_ingredient_reference_map` → `indb_ingredient_reference_map.csv`
- `indian_bread_naan_paratha_catalog` → `indian_bread_naan_paratha_catalog.csv`
- `meat_fish_prawn_catalog` → `meat_fish_prawn_catalog.csv`
- `meat_fish_prawn_family_counts` → `meat_fish_prawn_family_counts.csv`
- `meat_fish_prawn_resolver_rules` → `meat_fish_prawn_resolver_rules.csv`
- `nutrition_usage_policy` → `nutrition_usage_policy.csv`
- `portion_input_schema` → `portion_input_schema.csv`
- `portion_resolution_rules` → `portion_resolution_rules.csv`
- `recipe_ingredients` → `recipe_ingredients.csv`
- `recipe_preparation_gap_list` → `recipe_preparation_gap_list.csv`
- `recipe_source_defined_servings` → `recipe_source_defined_servings.csv`
- `recipes` → `recipes.csv`
- `regional_coverage_catalog` → `regional_coverage_catalog.csv`
- `regional_data_quality_rules` → `regional_data_quality_rules.csv`
- `regional_recipe_aliases` → `regional_recipe_aliases.csv`
- `regional_recipe_catalog` → `regional_recipe_catalog.csv`
- `regional_recipe_ingredients_key` → `regional_recipe_ingredients_key.csv`
- `regional_recipe_sources` → `regional_recipe_sources.csv`
- `source_backed_food_specific_portions` → `source_backed_food_specific_portions.csv`
- `source_snapshot_ifct2017_542` → `source_snapshot_ifct2017_542.csv`
- `source_snapshot_indb_recipes_1014` → `source_snapshot_indb_recipes_1014.csv`
- `source_snapshot_ukfct_144` → `source_snapshot_ukfct_144.csv`
- `source_snapshot_usda_54` → `source_snapshot_usda_54.csv`
- `standard_household_measures` → `standard_household_measures.csv`
- `unresolved_source_records` → `unresolved_source_records.csv`
- `variant_resolution_rules` → `variant_resolution_rules.csv`
