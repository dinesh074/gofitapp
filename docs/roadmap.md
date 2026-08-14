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
- [x] Freeze the current `FOOD_DB` API contract (`kcal_per_unit`, macro fields,
      optional micros/metadata) as the compatibility target. See
      `docs/data-model.md` and `backend/_contract_baseline/` (real captured
      `/foods/search`, `/foods/combos`, `/foods/recommend`, `/health` responses
      for idli/mutton/paneer/veg/nonveg -- use these as the regression
      baseline before any future refactor of this code).
- [x] Design the additive canonical schema with explicit mappings from current
      `foods`, `meal_logs`, `profiles`, `training_logs`, and `user_prefs` --
      see `supabase/migrations/20260815_proposed_food_intelligence_graph.sql`.
      **PROPOSAL ONLY, NOT APPLIED** to any database. Purely additive (no
      existing table touched). Needs review before use.
- [x] Define `data_sources` and per-nutrient provenance fields before any
      import -- included in the proposal migration above (`data_sources`,
      `food_nutrients.source_id`/`value_status`/`confidence`).
- [x] Extract architecture-level service boundaries:
      `FoodCatalogService`, `NutritionService`, `DietaryRuleService`,
      `PortionService`, `ScanResolutionService`.
- [x] Write migration plans for schema additions only after approval --
      implemented as additive SQL in
      `supabase/migrations/20260815_000001_gofit_canonical_food_graph.sql`.
- [x] Define a validation harness comparing graph-backed outputs to current
      curated `FOOD_DB` outputs for a small review set.
      Implemented in `backend/validate_food_graph_contract.py` against
      `_contract_baseline/search_{idli,paneer,mutton}.json`.

**Complexity:** medium  
**Risk:** high, because bad foundation decisions recreate the trust failure.

## P1 — search and manual logging on canonical entities

**Goal:** make the new graph useful first where risk is lowest.

### Next actions
- [x] Add canonical food search over approved graph data.
- [ ] Add alias/translation support without breaking current search UX.
- [x] Introduce reference-based logging (`food_logs`) alongside existing
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
- [x] Add `ai_scan_results` and `ai_corrections`.
- [x] Route candidate resolution through canonical food search/matching.
- [ ] Require clarification on medium/low confidence cases.
- [ ] Keep unmatched items explicitly unresolved instead of inventing values.

**Complexity:** medium-high  
**Risk:** high

## P3 — recipe and combination foundations

**Goal:** build trustworthy multi-food modeling before scale.

### Next actions
- [x] Add recipe, ingredient, and yield tables only for validated data.
- [x] Implement deterministic recipe nutrition from ingredients + yields.
- [ ] Add meal templates.
- [x] Extract current `food_combos.json` and `plan.py` concepts into reusable
      combination services.
- [x] Add deterministic combination fingerprinting and duplicate rules.

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
