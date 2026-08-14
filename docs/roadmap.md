# gofit.today — implementation roadmap (flat priority order)

This replaces the older month-based framing for this repo. It keeps the master
prompt’s **P0–P5 dependency order** but expresses it as a flat checklist.

## Guardrails before any implementation

- No destructive schema changes without approval.
- No new large food dataset imports without provenance and validation.
- No second parallel nutrition system.
- No migration that breaks the current `FOOD_DB` mobile contract early.
- Use `supabase/migrations/` for approved schema work.

## P0 — canonical foundations

**Goal:** design and land the minimum trustworthy graph and service boundaries.

### Next actions
- [ ] Freeze the current `FOOD_DB` API contract (`kcal_per_unit`, macro fields,
      optional micros/metadata) as the compatibility target.
- [ ] Design the additive canonical schema with explicit mappings from current
      `foods`, `meal_logs`, `profiles`, `training_logs`, and `user_prefs`.
- [ ] Define `data_sources` and per-nutrient provenance fields before any import.
- [ ] Extract architecture-level service boundaries:
      `FoodCatalogService`, `NutritionService`, `DietaryRuleService`,
      `PortionService`, `ScanResolutionService`.
- [ ] Write migration plans for schema additions only after approval.
- [ ] Define a validation harness comparing graph-backed outputs to current
      curated `FOOD_DB` outputs for a small review set.

**Complexity:** medium  
**Risk:** high, because bad foundation decisions recreate the trust failure.

## P1 — search and manual logging on canonical entities

**Goal:** make the new graph useful first where risk is lowest.

### Next actions
- [ ] Add canonical food search over approved graph data.
- [ ] Add alias/translation support without breaking current search UX.
- [ ] Introduce reference-based logging (`food_logs`) alongside existing
      `meal_logs`.
- [ ] Add deterministic portion scaling for approved portions only.
- [ ] Backfill or dual-write only after comparison checks pass.

**Complexity:** medium  
**Risk:** medium

## P2 — scanner candidate resolution and correction loop

**Goal:** move AI scan authority downward and human/canonical validation upward.

### Next actions
- [ ] Change scan AI output to candidate foods + confidence + portion guess,
      not authoritative nutrition.
- [ ] Add `ai_scan_results` and `ai_corrections`.
- [ ] Route candidate resolution through canonical food search/matching.
- [ ] Require clarification on medium/low confidence cases.
- [ ] Keep unmatched items explicitly unresolved instead of inventing values.

**Complexity:** medium-high  
**Risk:** high

## P3 — recipe and combination foundations

**Goal:** build trustworthy multi-food modeling before scale.

### Next actions
- [ ] Add recipe, ingredient, and yield tables only for validated data.
- [ ] Implement deterministic recipe nutrition from ingredients + yields.
- [ ] Add meal templates.
- [ ] Extract current `food_combos.json` and `plan.py` concepts into reusable
      combination services.
- [ ] Add deterministic combination fingerprinting and duplicate rules.

**Complexity:** high  
**Risk:** high

## P4 — micronutrients, substitutions, planning

**Goal:** turn canonical food intelligence into adaptive planning.

### Next actions
- [ ] Add daily/weekly nutrition aggregation from FoodEntity-based logs.
- [ ] Add micronutrient gap reporting with cautious wording.
- [ ] Add substitution engine.
- [ ] Extend planning with budget, time, ingredients, and training context.
- [ ] Add grocery-list generation from validated recipes/plans.

**Complexity:** high  
**Risk:** medium-high

## P5 — AI coach and optimization

**Goal:** layer a safe conversational system on top of deterministic tools.

### Next actions
- [ ] Implement tool-using coach interfaces on top of deterministic services.
- [ ] Add observability for AI latency, failure, correction rate, and cost.
- [ ] Add provider-routing strategy if justified.
- [ ] Consider materialized combinations only after real usage proves value.
- [ ] Evaluate pgvector/Redis/other infra only when workload justifies them.

**Complexity:** high  
**Risk:** medium

## Anti-repeat strategy for the dummy-data failure

Before any future graph cutover:
- import in **small reviewed batches**
- require **real provenance on every nutrient**
- keep unknown values **missing**, never zero
- compare outputs against current curated flows
- cut over one surface at a time

That mitigation is mandatory; it is the main lesson from the reverted `nutri_*`
attempt.
