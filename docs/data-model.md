# gofit.today — current data model

This is the **actual live schema** inspected from Postgres, not the deleted
`nutri_*` design.

## Active schema selection

- App schema: `gofit`
- Search path at runtime: `gofit, public`
- Backend mode in this environment: `postgres`

## `gofit` tables

### Food and scan support
- `foods`
- `analyze_cache`
- `unmatched_dishes`

### Identity / auth / product
- `accounts`
- `tokens`
- `otp_codes`
- `push_tokens`
- `devices`
- `notification_prefs`
- `pro_orders`

### User health data
- `profiles`
- `meal_logs`
- `weight_logs`
- `scan_history`
- `daily_summary`
- `log_days`
- `meal_plans`
- `water_logs`
- `habit_logs`
- `training_logs`
- `exercise_logs`
- `user_prefs`

### Community / social
- `users`
- `groups`
- `memberships`
- `challenges`
- `posts`
- `post_likes`
- `post_comments`
- `notifications`

### Ops / review
- `feedback`
- `audit_log`

## `public` tables

Legacy duplicates exist in `public`:
- `challenges`
- `groups`
- `memberships`
- `post_comments`
- `post_likes`
- `posts`
- `users`

These are not the intended active tables because `db.py` sets the search path to
prefer `gofit`.

## Current canonical food table: `foods`

The shipped app is currently built on `gofit.foods` with **1040** rows.

### Columns
- `key`
- `unit`
- `kcal_per_unit`
- `protein_g`
- `carbs_g`
- `fat_g`
- `fiber_g`
- `sugar_g`
- `sodium_mg`
- `potassium_mg`
- `calcium_mg`
- `iron_mg`
- `health_score`
- `benefits_json`
- `watch_outs_json`
- `micros_json`
- `aliases_json`
- `source_name`
- `source`
- `jain_status`
- `sattvic_status`

### What this means
- Nutrients are stored **per serving unit**, not per 100g.
- Units are consumer-facing (`plate`, `bowl`, `slice`, `biscuit`, etc.).
- Aliases and descriptive panels live as JSON blobs inside the row.
- Provenance is coarse (`source_name`, `source`) rather than per-nutrient.
- Jain/Sattvic are stored as three-state text values, derived from name/alias
  heuristics.

### Important limitation
There are **no physical columns** for `vegetarian`, `vegan`, or `eggetarian` in
the live `foods` table. Current diet filtering therefore relies on text
heuristics in `main.py`.

## Existing user-data tables

### `profiles`
Current merged profile table: onboarding and target inputs in one row.
- body stats
- activity
- diet
- goal
- goal pace / kind

This is the closest current equivalent to future `users`, `user_goals`, and
part of `user_preferences`.

### `meal_logs`
Current meal storage is **resolved totals**, not FoodEntity references.
- date, dish, kcal, macros
- timestamp
- meal_type
- photo_path
- `micros` JSON
- `micros_estimated`

This is useful app data, but it is not yet the master prompt’s `food_logs`
model.

### `daily_summary`
Materialized day totals for fast charts and summaries.

### `meal_plans`
Stores serialized daily plans keyed by `(account_id, date)` plus a coarse
signature of targets/diet/goal.

## Current social / product tables

### Product/account
- `accounts` contains identity, Pro flag, scan counters.
- `tokens`, `otp_codes`, `push_tokens`, `devices`, `notification_prefs` support
  auth and notifications.
- `pro_orders` supports Razorpay reconciliation.

### Social
`users`, `groups`, `memberships`, `posts`, `post_likes`, `post_comments`,
`notifications`, `challenges`.

These are unrelated to the future food graph, but they already consume nutrition
payloads when users share meals.

## Mapping current schema to master-spec concepts

### Closest existing equivalents
- `foods` → temporary stand-in for canonical food master
- `profiles` → partial user/profile/goal store
- `user_prefs` → partial user-preferences store
- `meal_logs` → partial meal log store
- `training_logs` → partial training context store
- `exercise_logs` → partial training sessions store
- `unmatched_dishes` → primitive correction/review queue

### Missing master-spec tables
- `food_aliases`
- `food_translations`
- `food_variants`
- `food_preparations`
- `nutrients`
- `food_nutrients`
- `food_nutrient_sources`
- `portions`
- `portion_conversions`
- `recipes`
- `recipe_ingredients`
- `recipe_steps`
- `recipe_variants`
- `cooking_yields`
- `dietary_profiles`
- `dietary_rules`
- `dietary_rule_exclusions`
- `dietary_rule_requirements`
- `food_allergens`
- `regional_foods`
- `regional_aliases`
- `meal_templates`
- `meal_combinations`
- `meal_combination_items`
- `food_substitutions`
- `user_goals`
- `user_nutrition_targets`
- graph-style `food_logs`
- `training_context`
- `daily_nutrition`
- `weekly_nutrition`
- `ai_scan_results`
- `ai_corrections`
- `data_sources`
- optional combo-materialization tables (`combination_candidates`,
  `combination_validated`, `combination_scores`)

## Schema-level conflicts to resolve carefully

1. The spec’s future `users` name conflicts with existing community `users`.
2. Future `food_logs` cannot simply replace current `meal_logs`; migration needs
   coexistence and backfill strategy.
3. Future `user_preferences` / `user_goals` / `user_nutrition_targets` overlap
   with data already split across `profiles` and `user_prefs`.
4. Legacy duplicates in `public` mean new migrations must always be schema-aware.

## Recommended additive migration approach

- Keep current tables intact.
- Add canonical graph tables with unambiguous names and provenance fields.
- Introduce reference-based logging alongside current `meal_logs`.
- Backfill only after validation and approval.
- Defer destructive consolidation until canonical graph usage is proven.
