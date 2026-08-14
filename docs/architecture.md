# gofit.today — architecture gap report

This document is the **read-only investigation phase** required by
`GOFIT_MASTER_ARCHITECTURE_PROMPT.txt`. It reflects the repo and live database
state **after** commit `83cf8c5` reverted the experimental `nutri_*` graph and
deleted the nutri-only backend modules.

## 1) Current architecture summary

### Backend
- **Framework**: FastAPI modular monolith.
- **Entry point**: `backend/main.py`.
- **Persistence layer**: `backend/db.py` exposes a tiny sqlite-like API over
  either SQLite or Postgres. In this environment it is using **Postgres** with
  schema-first search path `gofit, public`.
- **Primary food system in production today**: curated `foods` table loaded into
  in-memory `FOOD_DB` on startup.
- **Food analysis flow today**:
  1. `/analyze` or `/analyze/text` calls Gemini through `ai_provider.py`.
  2. Gemini returns item guesses with calories/macros/micro estimates.
  3. `main.py::anchor_items()` tries to match each item to `FOOD_DB`.
  4. If matched, DB values replace AI values.
  5. If unmatched, AI estimates remain and the item is logged to
     `unmatched_dishes`.
- **Packaged food flow**: `/analyze/barcode` is deterministic OpenFoodFacts,
  independent from Gemini and scan credits.
- **Meal planning flow**: `backend/plan.py` builds a persisted daily plan from
  targets and `FOOD_DB`; food selection is injected from `main.py`.

### Frontend
- **Framework**: Expo React Native / TypeScript.
- **Navigation**: `RootTabs.tsx` bottom tabs + stack screens (`Scan`,
  `FoodSelector`, `DayLog`, `MealDetail`).
- **Network boundary**: `app/api.ts` is the central contract layer.
- **Current nutrition UX** is built around the existing `FOOD_DB` contract:
  per-unit kcal/macros plus optional micros/health metadata.

## 2) Existing backend modules and responsibilities

### `main.py`
Owns the food catalog bootstrap, photo/text scan prompts, matching logic, food
search, food combos, food recommendations, verdict logic, health/readiness, and
wiring of all routers.

### Feature routers
- `auth.py` — accounts, bearer tokens, OTP, devices, notification prefs.
- `progress.py` — profile, meal logs, weight logs, day summaries, streaks.
- `plan.py` — persisted daily meal plans.
- `barcode.py` — packaged-food lookup.
- `wellness.py` — water, habits, training context.
- `exercise.py` — activity catalog and exercise logs.
- `prefs.py` — synced UI preferences.
- `entitlements.py` — Free/Pro feature gating.
- `payments.py` — Razorpay order/verify/webhook.
- `community.py` — groups, feed, posts, comments, notifications.
- `feedback.py` — user feedback intake.
- `food_review.py` — unmatched food review queue.
- `audit.py` — append-only admin audit log.

## 3) Existing APIs

### Food and nutrition
- `GET /foods/search`
- `GET /foods/combos`
- `POST /foods/recommend`
- `POST /meals/verdict`
- `POST /analyze`
- `POST /analyze/text`
- `POST /analyze/barcode`

### Logging and profile
- `GET/PUT /profile`
- `GET/POST /logs`
- `DELETE /logs/{id}`
- `GET/POST /weights`
- `GET /summary`
- `GET /streak`
- `GET /log-days`
- `GET /scans/history`

### Planner / wellness / exercise
- `POST /plan/today`
- `GET/POST /water`
- `GET/POST /habits`
- `GET/PUT /training`
- `GET /exercise/catalog`
- `GET /exercise/logs`
- `GET /exercise/summary`
- `POST /exercise/log`
- `DELETE /exercise/log/{entry_id}`

### Auth / product / social / admin
- `/auth/*`, `/entitlements`, `/pay/*`, `/community/*`, `/feedback`,
  `/admin/feedback`, `/admin/unmatched-foods`, `/admin/audit`

## 4) Existing frontend flows that consume food data

### Home
`HomeScreen.tsx` is the densest nutrition surface:
- photo scan
- describe meal / voice-to-text
- barcode scan
- swap misidentified items via `FoodSearchSheet`
- add suggested pairings via `/foods/combos`
- portion adjustment
- day nutrition and micronutrient rollups
- persisted daily plan card

### Dedicated scan flow
`ScanScreen.tsx` is a full-screen capture → analyze → edit → log flow using the
same `AnalysisResult` shape as Home.

### Manual search flow
`FoodSelectorScreen.tsx` searches `/foods/search` and logs foods directly using
`kcal_per_unit`, `protein_g_per_unit`, `carbs_g_per_unit`, `fat_g_per_unit`.

### Portion editing
`PortionPicker.tsx` adjusts the existing `count` multiplier and approximates
bulk foods as `count * 100g`; it is **UI-only**, not backed by a canonical
portion conversion service.

### Plan consumption
`TodayPlanCard.tsx` renders `POST /plan/today` results as slot/item lists with
per-item counts and macros.

### Logged meal inspection
`DayLogScreen.tsx` and `MealDetailScreen.tsx` read server-synced meal logs and
show kcal/macros plus optional micronutrients.

### Community reuse
`FeedScreen.tsx` can reuse `analyzeImage()` to attach detected meal macros to a
social post.

## 5) Current nutrition data contract

The app is currently built around these payload shapes:

### `FoodSuggestion` / search result
- `key`
- `name`
- `unit`
- `kcal_per_unit`
- `protein_g_per_unit`
- `carbs_g_per_unit`
- `fat_g_per_unit`
- optional `fiber_g`, `sugar_g`, `sodium_mg`, `potassium_mg`, `calcium_mg`,
  `iron_mg`, `micros`, `health_score`, `benefits`, `watch_outs`

### `AnalysisResult.items[]`
- `item`
- `count`
- `unit`
- `countable`
- `kcal_per_unit`
- `protein_g_per_unit`
- `carbs_g_per_unit`
- `fat_g_per_unit`
- computed totals per item
- optional micronutrient panel and `micros_source`

This is the contract any future FoodEntity migration must preserve or adapt via
an anti-corruption layer.

## 6) Reusable components

Keep and extend these instead of rebuilding:
- `db.py` connection shim and schema search-path handling
- router-per-feature FastAPI structure
- `ai_provider.py` abstraction
- `auth.require_account()` / `entitlements.require_pro()`
- `progress.py` logging and summary persistence
- `main.py::classify_diet_tags()` for current Jain/Sattvic three-state logic
- `food_review.py` unmatched queue as a real gap-signal source
- `app/api.ts` as the single client contract layer
- `TodayPlanCard` + `plan.py` as early deterministic recommendation/planning
  infrastructure

## 7) Duplicates and conflicts

### Database conflicts
- `public` still contains legacy `users`, `groups`, `memberships`, `challenges`,
  `posts`, `post_comments`, `post_likes`.
- `gofit` contains active versions of those same tables.
- `db.py` sets search_path to `gofit, public`, so the app resolves to `gofit`
  first; the `public` copies are technical debt and a migration hazard.

### Domain-model conflicts
- The app already has `accounts` + `profiles`, while the master spec proposes
  `users`, `user_preferences`, `user_goals`, `user_nutrition_targets`.
- Current `meal_logs` store resolved dish text + totals, not FoodEntity
  references.
- Current `training_logs` and `exercise_logs` partly overlap with future
  `training_context` and `training_sessions`.
- `food_combos.json` and `plan.py` contain recommendation/combination logic
  outside a canonical food graph.

### AI/logic conflicts
- `ai_provider.py` exists, but `main.py` still carries legacy Gemini imports,
  `GEN_CONFIG`, and deprecated `get_client()`.
- Nutrition arithmetic is spread across `main.py`, `barcode.py`, and `plan.py`;
  there is no central `NutritionEngine`.

## 8) History note: graph attempt existed and was removed

This repo already attempted the graph path and then backed out:
- `385499e` wired `/foods/search` and `/foods/recommend` to the Food
  Intelligence Graph.
- `bd9d5e0` fixed a real bug where search exposed fabricated `0 kcal` results.
- `83cf8c5` reverted the graph usage and deleted:
  - `nutrition_api.py`
  - `nutrition_engine.py`
  - `dietary_rules.py`
  - `portion_engine.py`
  - `month2_audit.py`
  - `backfill_diet_flags.py`
  - `load_real_indb.py`
  - `populate_portion_conversions.py`

The current plan must acknowledge that history and avoid repeating the same
trust failure.

## 9) Gap versus the master architecture

### Already present in some form
- modular monolith backend
- AI provider abstraction
- food search
- photo/text/barcode logging
- persisted meal logs
- persisted daily plans
- partial dietary logic
- unmatched-food capture

### Missing or only partial
- canonical FoodEntity graph
- provenance registry on every nutrient value
- central NutritionEngine
- central PortionEngine
- configurable DietaryRuleEngine rulesets/profiles
- recipe engine with ingredient/yield provenance
- meal template and combination engines
- substitution engine
- daily/weekly nutrition aggregation on FoodEntity references
- AI scan results/corrections tables
- staging/normalization/review data pipeline

## 10) Migration strategy

1. **Do not touch current food endpoints first.**
2. Additive schema only, via `supabase/migrations/`, after approval.
3. Introduce a canonical FoodEntity layer behind new internal services, not by
   rewriting route handlers in place.
4. Preserve the current `FOOD_DB` response contract while the new graph is
   immature.
5. Import only small, provenance-backed, reviewed datasets.
6. Move one surface at a time: search → manual logging → recipe math → scanner →
   planner/combination logic.

## 11) Main risks

- **Repeat of dummy-data trust loss**: highest risk.  
  **Mitigation**: only ingest small validated batches with explicit provenance,
  keep missing as missing, and gate cutover behind comparison tests against
  current curated results.
- Current scanner still accepts unmatched AI nutrition estimates as user-facing
  values.
- Public-schema duplicates can confuse future migrations if unqualified SQL is
  introduced outside `db.py`.
- A future graph migration can break the mobile app if it changes the
  `kcal_per_unit` contract too early.

## 12) Recommended implementation order

See `docs/roadmap.md`. Short version:
- P0: schema/service design only, additive migration plan, provenance-first
- P1: search/manual logging over canonical FoodEntity
- P2: scanner candidate resolution and correction loop
- P3: recipe + combination foundations
- P4: micronutrient/substitution/planning
- P5: AI coach and optimization

No large schema change should start until this report is reviewed and approved.
