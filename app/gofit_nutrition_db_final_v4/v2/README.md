# gofit.today Nutrition Database v2

Source-backed build. No dummy calories or fabricated serving sizes.

Coverage: IFCT 2017 (542 food records); INDB (1014 recipes + 333 ingredient references); UK FCT (144 records); USDA-derived ingredient table (54 records). Canonical records: 1752.

Important: raw/cooked/boiled/parboiled/fried/roasted/etc. remain distinct where sources distinguish them. Chicken cuts and goat/mutton source records are not silently merged. IFCT 100g is an analytical basis, not a household serving. Conflicting source values are flagged, not averaged.

Files: foods.csv, food_source_records.csv, food_aliases.csv, food_nutrients_core.csv, food_portions.csv, cooking_yield_factors.csv, recipes.csv, recipe_ingredients.csv, data_quality_flags.csv, source snapshots, data_sources.csv.

Licensing: ICMR-NIN's IFCT 2017 publication states electronic storage/reproduction for creating a product requires prior written permission. Resolve this before shipping IFCT values commercially.
