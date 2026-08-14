# gofit.today — Current Architecture Summary

(Gap report required by `GOFIT_MASTER_ARCHITECTURE_PROMPT.txt` "FIRST IMPLEMENTATION TASK".
Written from direct inspection of this repo and the live production Postgres database —
not assumed.)

## Stack today
- **Frontend**: Expo React Native (`app/`), TypeScript, React Navigation, a shared
  design system (`app/theme.ts`, `Icon.tsx`, `CalorieRing.tsx`).
- **Backend**: FastAPI, modular monolith (`backend/main.py` + per-feature routers:
  `auth.py`, `community.py`, `progress.py`, `payments.py`, `barcode.py`, `wellness.py`,
  `plan.py`, `exercise.py`, `prefs.py`, `entitlements.py`, `feedback.py`, `food_review.py`,
  `audit.py`). Each feature is an `APIRouter` mounted with `app.include_router(...)` in
  `main.py` — this pattern should be reused for any new nutrition-graph API surface,
  not a new framework/pattern.
- **Database**: Supabase-hosted Postgres, single project, single schema (`gofit`),
  reached through a thin sqlite3-compatible shim in `backend/db.py`. `db.py` also
  supports local SQLite for dev with zero code changes (`DATABASE_URL` unset =
  SQLite; set = Postgres). All access goes through `db.connect()` — no ORM.
- **AI today**: Google Gemini via the `google-genai` SDK, called *directly* in
  `main.py` (`get_client()` / `_generate()` around line 1459). `MODEL` env var
  picks the model name (`FOOD_MODEL`, default `gemini-3.5-flash-lite`). This is
  the single place Gemini calls are wired — good news for building an
  `AIProvider` abstraction (see `ai-architecture.md`), since nothing else in the
  codebase calls Gemini directly.
- **Auth**: Google Sign-In + a newly-added (this cycle) email-code / OTP flow,
  both terminating in the same `accounts` table (`backend/auth.py`).
- **Email**: Resend HTTP API wrapper (`backend/email_service.py`), no-ops safely
  if unconfigured.
- **Hosting**: Render (backend), EAS (Android builds), Supabase (DB/Auth/Storage).
  No Kubernetes/GPU/Redis/Kafka/microservices — matches the doc's MVP-infra rule
  already, nothing to undo there.

## Existing database tables (real, verified against production)
All in the **`gofit`** Postgres schema (`PG_SCHEMA` env var, `backend/db.py:58`):

| Table | Purpose | Rows (approx, live) |
|---|---|---|
| `foods` | The **current, live** scanner/food DB. Simple shape: `key` (PK), `unit`, `kcal_per_unit`, `protein_g/carbs_g/fat_g`, optional micros as JSON blobs (`micros_json`), `aliases_json`, `jain_status`/`sattvic_status` (rule-classified from name text), `source_name`/`source`. | ~1,040 |
| `accounts` | Google/OTP identity, `google_sub` or `otp-{email}` unique key | 18 |
| `profiles` | Onboarding output: height/weight/diet/goal/activity per account | 14 |
| `otp_codes` | OTP login codes (hashed, expiring) — added this cycle | — |
| `tokens` | Session tokens | — |
| `meal_logs`, `exercise_logs` | User food/exercise logs | — |
| `unmatched_dishes` | Telemetry: dishes Gemini scanned but couldn't match to `foods` | 8 |
| community/social tables (`posts`, `post_comments`, `notifications`, `groups`, etc.) | Community feature | — |
| **`nutri_*` tables (added this cycle, see `data-model.md`)** | The new Food Intelligence Graph foundation, loaded with real INDB data | 1,347 foods / 41k nutrients / 1,014 recipes |

**Important existing conflict already resolved**: the master-prompt spec's core
entity is also called `foods`. Rather than collide with the live `foods` table
(which the shipped app currently reads from every scan), the new graph tables
were prefixed `nutri_` (`nutri_foods`, `nutri_food_nutrients`, ...) inside the
same `gofit` schema. Full mapping and rationale in `data-model.md`.

## Existing APIs (backend/main.py + routers)
- `GET /foods/search`, `GET /foods/combos`, `POST /foods/recommend` — read against
  the **old** `foods` table + `food_combos.json` (curated pairing JSON).
- `POST /analyze`, `POST /analyze/text` — the scanner: Gemini Vision/text → JSON →
  matched against `FOOD_DB` (loaded from `foods` table at boot).
- `POST /meals/verdict` — rule-based "should I eat this" advice, optional AI polish.
- `auth.py`: `/auth/google`, `/auth/otp/request`, `/auth/otp/verify`, `/auth/me`.
- `progress.py`, `exercise.py`, `wellness.py`, `plan.py`, `prefs.py`,
  `entitlements.py`, `community.py`, `payments.py`, `barcode.py`, `feedback.py`,
  `food_review.py`, `audit.py` — feature-specific, not nutrition-graph related.
- **Nothing yet reads the new `nutri_*` tables** — this is the immediate gap
  Month 1 foundation work closes (`nutrition_api.py`, see below).

## Existing frontend flows relevant to nutrition
- Scan tab → `POST /analyze` → shows AI-estimated nutrition immediately (no
  confidence tiering, no candidate-list UX yet — the spec's scanner section
  describes a richer confidence-tiered flow that doesn't exist yet).
- Manual food search → `GET /foods/search` against the old `foods` table.
- Meal combos ("goes well with") → `GET /foods/combos` against curated JSON,
  not the graph.
- No recipe browsing, no dietary-profile selector beyond onboarding's basic
  diet field, no substitution UI, no planner UI yet.

## Reusable components (keep, don't rebuild)
- `db.py`'s SQLite/Postgres shim — reuse as-is for all new nutrition-graph code.
- Router-per-feature pattern (`APIRouter` + `include_router`) — reuse for
  `nutrition_api.py`.
- `auth.require_account(request)` — reuse for any account-scoped nutrition
  endpoint (e.g. logging against the graph later).
- The existing rule-based Jain/Sattvic classifier in `main.py`
  (`classify_diet_tags`) — a real, working three-tier (yes/no/depends)
  classifier from dish-name text. This is a legitimate first-pass
  `DietaryRuleEngine.isJain()`/`isSattvic()` implementation to build on, not
  throw away — the spec explicitly wants configurable rulesets, and this
  already avoids the boolean trap.

## Known technical debt / duplicates
1. **Two `foods` concepts** in the same schema now (`foods` live / `nutri_foods`
   graph) — intentional short-term duplication, not yet reconciled. Long-term,
   the live scanner should be migrated onto the graph (Month 4 per roadmap),
   not sooner — don't break the shipping app to do this early.
2. Gemini calls are centralized already (`main.py:_generate`) but not behind an
   interface — trivial to wrap (Month 1 task, done this cycle, see
   `ai-architecture.md`).
3. No `data_sources`-style registry existed for the *old* `foods` table (only
   free-text `source_name`/`source` columns) — the new `nutri_data_sources`
   table is the first real provenance registry in this codebase.
4. No automated data-quality validation jobs exist yet for either `foods` or
   `nutri_*` tables (spec's "Data Quality" section) — not built this cycle,
   flagged as a Month 2+ task.

## Migration strategy
- **No destructive changes.** The new `nutri_*` tables are purely additive
  inside the existing `gofit` schema — verified via `information_schema` that
  no existing table was touched.
- Schema changes going forward use `IF NOT EXISTS`/`ALTER TABLE ADD COLUMN IF
  NOT EXISTS` guards (matching `db.py`'s own migration style, e.g.
  `_init_foods_table` in `main.py`), not a separate migrations-runner
  framework — consistent with "modular monolith, no premature tooling."
- The live `foods` table is left untouched until Month 4 (scanner rework) is
  reached — the app keeps working throughout.

## Recommended implementation order (unchanged from roadmap, restated for this report)
1. **Month 1 (this cycle)**: `NutritionEngine`, `DietaryRuleEngine`,
   `PortionEngine`, `AIProvider` abstraction, first read-only `/api/nutrition/*`
   surface over the real `nutri_*` data. All additive, zero risk to the live app.
2. Month 2+: per `roadmap.md`.

## Risks
- **41k nutrient rows / 1,347 foods is a strong Phase-1 seed but far short of
  the 20k target** — do not present this as "done," it's a real foundation,
  not the finished catalog.
- Recipe-derived nutrition (ingredient → yield → sum) is not implemented yet;
  `nutri_food_nutrients` values for the 1,014 INDB recipes are pre-calculated
  by the source dataset (`value_status='calculated'`), not derived live by our
  own `NutritionEngine` yet — Month 1's engine should be able to recompute and
  cross-check these, not just read them back.
- Old `foods` table and new `nutri_foods` will drift out of sync if edited
  independently — needs a conscious decision (Month 4) about which becomes
  canonical, not an accidental one.

## Complexity estimate per phase
See `roadmap.md` for per-month estimates; Month 1 (delivered this cycle) was
low-to-medium complexity (additive engines + one read-only router, no schema
risk). Months 6–7 (combination engine, 1M-scale generation) are the highest
complexity/risk items in the whole roadmap.
