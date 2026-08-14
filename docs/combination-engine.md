# gofit.today — Combination Engine

**Status: not started.** Scoped for Month 6 per `roadmap.md`, after logging
(Month 3), scanner rework (Month 4), and recipe intelligence (Month 5) exist
for it to build on. Documented now (per the master prompt's required doc set)
so the eventual design is anchored to what's real today, not speculative.

## What it will need from work already done
- `nutri_foods` + `nutri_recipes` + `nutri_portions` as the candidate pool.
- `dietary_rules.py`'s rule functions for the "apply dietary rules" filter
  step.
- `nutrition_engine.py`'s portion/recipe nutrition functions for the
  "apply calorie/macro constraints" and "score micronutrients" steps.

## Planned pipeline (unchanged from the master prompt, restated for traceability)
Filter candidates → dietary rules → allergens → exclusions → calorie
constraints → macro constraints → score micronutrients → meal-type
constraints → regional/cuisine preferences → user preferences → variety/
diversity → rank → return top candidates.

## Explicitly deferred until Month 6
`generateMeal`, `findMeals`, `rankMeals`, `findSubstitutions`,
`findMealsForNutritionGap`, `generateDailyPlan`, `generateWeeklyPlan`, meal
templates, `combination_candidates`/`combination_validated`/
`combination_scores` tables, duplicate fingerprinting. None of this exists
yet — do not assume otherwise when reading the codebase.
