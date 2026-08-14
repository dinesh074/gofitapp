# gofit.today — current nutrition engine state

There is **no standalone `NutritionEngine` module in the repo today**. The
authoritative nutrition behavior is split across existing modules.

## What currently performs nutrition work

### 1) `main.py::anchor_items()`
This is the most important current nutrition function.

Responsibilities:
- match AI-scanned item names to `FOOD_DB`
- replace AI kcal/macros with curated DB values on a match
- copy optional micros and descriptive metadata
- compute per-item totals and meal totals
- mark unmatched items as `source="ai"`
- log unmatched items to `unmatched_dishes`

### 2) `main.py::_food_suggestion()`
Transforms `FOOD_DB` rows into the API shape used by manual search,
recommendations, pairings, and plan building:
- `kcal_per_unit`
- `protein_g_per_unit`
- `carbs_g_per_unit`
- `fat_g_per_unit`
- optional micros and health metadata

### 3) `barcode.py::_build_result()`
Performs deterministic packaged-food nutrition assembly from OpenFoodFacts:
- per-100g sanity checks
- per-serving fallback logic
- maps label values to app response shape

### 4) `plan.py`
Not a nutrition engine, but it does deterministic macro-aware arithmetic for:
- slot budgets
- serving scaling
- plan adaptation to remaining macros

## What is already good

- When a food matches `FOOD_DB`, the app does **not** trust the LLM’s calories.
- Barcode nutrition is deterministic and source-backed.
- Meal totals are recomputed from item-level values after edits.
- Micronutrient estimates are labeled separately from verified DB matches.

## What is not aligned with the master spec yet

### Missing central service
The spec expects one central engine with functions like:
- `calculateFoodNutrition()`
- `calculatePortionNutrition()`
- `calculateRecipeNutrition()`
- `calculateMealNutrition()`
- `calculateDailyNutrition()`
- `calculateWeeklyNutrition()`

Today those responsibilities are scattered.

### Missing provenance
Current `foods` rows have only coarse row-level provenance (`source_name`,
`source`). The master spec requires provenance on **every nutrient value**.

### Missing missing-value semantics
The master spec requires `NULL + value_status='missing'`. Current `foods`
payloads do not model per-nutrient status at all.

### Missing canonical basis handling
Current production food data is per serving unit. The future graph needs a clean
base model for:
- per 100g
- per serving
- per household portion
- raw vs cooked
- recipe-derived values

### Current trust gap
For unmatched scanned items, the app still presents AI-estimated nutrition.
That is convenient UX, but it is **not** the master spec’s target trust model.

## Current migration-safe interpretation

Treat the current system as:
- a working **FOOD_DB-backed nutrition layer**
- plus a **best-effort AI fallback**
- but **not yet** the target NutritionEngine

## Recommended next service split

### P0 extraction targets
Create internal services first, without changing endpoints:
1. `FoodCatalogService`
   - search curated food rows
   - alias resolution
   - row → API shape mapping
2. `NutritionService`
   - scale per-unit serving nutrition
   - sum item totals
   - sum meal totals
3. `ScanResolutionService`
   - AI candidate → canonical food match / unmatched state
4. `BarcodeNutritionService`
   - isolated packaged-food math

This gives the app a real service boundary before any FoodEntity schema appears.

## Target-state migration notes

- Do not rebuild the deleted `nutrition_engine.py` blindly.
- First preserve the current `kcal_per_unit` contract for the mobile app.
- Then introduce graph-backed calculations behind a compatibility mapper.
- Only cut search/logging/scanner over once graph outputs are verified against
  curated FOOD_DB behavior.
