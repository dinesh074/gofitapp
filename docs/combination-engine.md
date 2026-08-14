# gofit.today — current combination and planning state

There is **no master-spec CombinationEngine module** in the repo today, but two
real pieces already exist and should be treated as reusable precursors.

## Existing precursor #1: curated pairings

`backend/food_combos.json` + `main.py::/foods/combos`

What it does now:
- given one or more meal items, return typical accompaniments
- deduplicate sides
- exclude foods already on the plate
- resolve side nutrition from `FOOD_DB`

This is a primitive but real version of:
- meal combinations
- combination items
- accompaniment knowledge

## Existing precursor #2: deterministic day planner

`backend/plan.py`

What it does now:
- split the day into breakfast/lunch/snack/dinner
- assign per-slot calorie/macro budgets
- pick foods from ranked `FOOD_DB`
- avoid repetition by exact dish and ingredient-family heuristics
- prefer grain anchors for lunch/dinner
- persist one plan per account/day
- adapt future slots to remaining macros

This is not the target combination engine, but it is already a deterministic
ranking/generation service.

## Existing recommendation logic outside the planner

`main.py::/foods/recommend`
- ranks foods against remaining calories/macros
- applies diet filtering
- adds optional AI phrasing on top of deterministic ranking

This is effectively a small single-item ranking engine already in production.

## What is missing versus the master spec

- canonical meal template table
- canonical meal combination tables
- combination item provenance/fingerprints
- multi-food substitution engine
- micronutrient-gap-aware ranking
- budget/time/available-ingredient filtering
- weekly planning optimizer
- grocery list generation
- dynamic + materialized combination storage strategy

## Current code assets worth reusing

- `_recommend_score()` in `main.py`
- `_rank_foods()` in `main.py`
- slot-building logic in `plan.py`
- family/repetition controls in `plan.py`
- pairing editorial data in `food_combos.json`

## Current technical debt

- combination logic is split between:
  - `food_combos.json`
  - `main.py`
  - `plan.py`
  - some client heuristics in `app/mealSuggest.ts`
- none of it is backed by a canonical FoodEntity graph
- no deterministic combination fingerprinting exists yet

## Migration recommendation

1. Keep current pairings and planner working.
2. Extract shared ranking/generation code into backend services.
3. Introduce meal templates before attempting large combination materialization.
4. Do not create huge combination tables before canonical foods, portions,
   dietary rules, and recipe math are trustworthy.

## Risk to avoid

Do **not** generate a large combination corpus from unvalidated food records.
That would recreate the exact trust problem that caused the graph rollback.
