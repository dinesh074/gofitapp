-- ============================================================================
-- PROPOSAL ONLY -- NOT YET APPLIED.
-- ============================================================================
-- This migration is a design draft for the canonical Food Intelligence Graph
-- described in GOFIT_MASTER_ARCHITECTURE_PROMPT.txt. It has NOT been run
-- against any database (local or production) and must not be applied without
-- explicit review and approval.
--
-- Why this exists (read before touching): a first attempt at this graph
-- (21 `nutri_*` tables) was built, populated, found to have real data-quality
-- gaps (e.g. rows with no real nutrient value silently defaulting to a
-- fabricated 0), and was fully reverted -- all 21 tables were DROP TABLE
-- CASCADE'd and every backend endpoint was moved back onto the older curated
-- `foods` table (`FOOD_DB` in backend/main.py, ~1040 dishes). See
-- docs/roadmap.md's "Anti-repeat strategy for the dummy-data failure" section
-- for the required guardrails before this (or any successor) design is ever
-- populated with real data:
--   - import in small reviewed batches, never one bulk unvalidated load
--   - every nutrient value carries source_id + value_status + confidence
--   - unknown stays NULL/value_status='missing', never a fabricated 0
--   - compare graph-backed outputs against the current curated FOOD_DB
--     outputs (see backend/validate_food_graph.py once it has real data to
--     compare against) before any endpoint cuts over
--   - cut over ONE surface (e.g. /foods/search) at a time, not all at once
--
-- This design is purely additive: it does not touch, rename, or drop any
-- existing table (`foods`, `meal_logs`, `profiles`, etc.). The existing
-- `foods` table / FOOD_DB remains the live source of truth until a future,
-- separately-approved migration explicitly cuts a specific endpoint over,
-- verified side-by-side first.
-- ============================================================================

-- --- Provenance registry --------------------------------------------------
-- Every nutrient value in this graph must point back to a source_id here.
-- Never insert a food_nutrients row without one.
CREATE TABLE IF NOT EXISTS data_sources (
    source_id       TEXT PRIMARY KEY,
    source_name     TEXT NOT NULL,
    source_type     TEXT NOT NULL,   -- e.g. 'government_db', 'lab_analysis', 'publisher', 'derived'
    version         TEXT,
    publisher       TEXT,
    url             TEXT,
    license_status  TEXT,            -- e.g. 'public_domain', 'licensed', 'internal_curation'
    allowed_use     TEXT,            -- free text describing permitted use, so nothing gets
                                     -- used beyond what its license actually allows
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --- Canonical food entity --------------------------------------------------
CREATE TABLE IF NOT EXISTS food_entities (
    food_id           TEXT PRIMARY KEY,
    canonical_name    TEXT NOT NULL,
    entity_type       TEXT NOT NULL CHECK (entity_type IN (
        'ingredient', 'dish', 'recipe', 'breakfast', 'snack', 'dessert',
        'beverage', 'restaurant_food', 'packaged_food', 'meal_combination'
    )),
    region            TEXT,           -- north/south/west/east/northeast/central/pan_indian
    cuisine           TEXT,
    homemade_kind     TEXT CHECK (homemade_kind IN (
        'homemade', 'restaurant', 'street_food', 'packaged'
    )),
    status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
        'draft', 'staged', 'reviewed', 'published'
    )),                              -- admin pipeline gate -- see ADMIN DATA PIPELINE
                                     -- section of the master prompt: staging ->
                                     -- normalization -> validation -> review ->
                                     -- production. Nothing reaches user-facing
                                     -- endpoints below 'published'.
    source_id         TEXT REFERENCES data_sources(source_id),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS food_aliases (
    id          BIGSERIAL PRIMARY KEY,
    food_id     TEXT NOT NULL REFERENCES food_entities(food_id) ON DELETE CASCADE,
    alias       TEXT NOT NULL,
    language    TEXT,                -- 'en', 'hi', 'hinglish', region-language code
    UNIQUE (food_id, alias)
);

CREATE TABLE IF NOT EXISTS food_translations (
    id          BIGSERIAL PRIMARY KEY,
    food_id     TEXT NOT NULL REFERENCES food_entities(food_id) ON DELETE CASCADE,
    language    TEXT NOT NULL,
    name        TEXT NOT NULL,
    UNIQUE (food_id, language)
);

-- --- Nutrients (with mandatory provenance) ---------------------------------
CREATE TABLE IF NOT EXISTS nutrient_dictionary (
    nutrient_code   TEXT PRIMARY KEY,   -- e.g. 'energy_kcal', 'protein_g', 'vitamin_b12_ug'
    display_name    TEXT NOT NULL,
    unit            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS food_nutrients (
    id              BIGSERIAL PRIMARY KEY,
    food_id         TEXT NOT NULL REFERENCES food_entities(food_id) ON DELETE CASCADE,
    nutrient_code   TEXT NOT NULL REFERENCES nutrient_dictionary(nutrient_code),
    amount          NUMERIC,          -- NULL when value_status='missing' -- NEVER 0 as a
                                     -- stand-in for unknown. See DO NOT list:
                                     -- "turn missing nutrients into zero".
    value_status    TEXT NOT NULL CHECK (value_status IN (
        'measured', 'calculated', 'estimated', 'trace', 'missing'
    )),
    confidence      NUMERIC CHECK (confidence >= 0 AND confidence <= 1),
    source_id       TEXT NOT NULL REFERENCES data_sources(source_id),
    source_record_id TEXT,
    source_version  TEXT,
    UNIQUE (food_id, nutrient_code)
);

-- --- Portions ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portions (
    id              BIGSERIAL PRIMARY KEY,
    food_id         TEXT NOT NULL REFERENCES food_entities(food_id) ON DELETE CASCADE,
    unit_label      TEXT NOT NULL,    -- 'katori', 'bowl', 'cup', 'plate', '1 idli', '2 roti', etc.
    grams           NUMERIC,          -- NULL if not yet mapped to weight
    confidence      NUMERIC CHECK (confidence >= 0 AND confidence <= 1),
    source_id       TEXT REFERENCES data_sources(source_id)
);

CREATE TABLE IF NOT EXISTS cooking_yields (
    id              BIGSERIAL PRIMARY KEY,
    food_id         TEXT NOT NULL REFERENCES food_entities(food_id) ON DELETE CASCADE,
    raw_state       TEXT NOT NULL,    -- 'raw'
    cooked_state    TEXT NOT NULL,    -- 'boiled', 'steamed', 'fried', 'deep_fried', 'air_fried',
                                     -- 'grilled', 'roasted', 'pressure_cooked'
    yield_factor    NUMERIC NOT NULL, -- cooked_weight / raw_weight
    source_id       TEXT REFERENCES data_sources(source_id)
);

-- --- Recipes ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recipes (
    recipe_id       TEXT PRIMARY KEY,
    food_id         TEXT REFERENCES food_entities(food_id),
    servings        NUMERIC NOT NULL,
    yield_grams     NUMERIC,
    raw_or_cooked   TEXT,
    source_id       TEXT REFERENCES data_sources(source_id)
);

CREATE TABLE IF NOT EXISTS recipe_ingredients (
    id              BIGSERIAL PRIMARY KEY,
    recipe_id       TEXT NOT NULL REFERENCES recipes(recipe_id) ON DELETE CASCADE,
    food_id         TEXT NOT NULL REFERENCES food_entities(food_id),
    quantity        NUMERIC,          -- NULL = missing quantity -- flag, don't guess
    unit            TEXT,
    preparation     TEXT
);

CREATE TABLE IF NOT EXISTS recipe_steps (
    id              BIGSERIAL PRIMARY KEY,
    recipe_id       TEXT NOT NULL REFERENCES recipes(recipe_id) ON DELETE CASCADE,
    step_number     INTEGER NOT NULL,
    instruction     TEXT NOT NULL,
    UNIQUE (recipe_id, step_number)
);

-- --- Dietary rules (configurable rulesets, not booleans) --------------------
CREATE TABLE IF NOT EXISTS dietary_profiles (
    profile_code    TEXT PRIMARY KEY,  -- 'vegetarian', 'vegan', 'jain', 'sattvic', 'halal', ...
    display_name    TEXT NOT NULL,
    description     TEXT
);

CREATE TABLE IF NOT EXISTS dietary_rule_exclusions (
    id              BIGSERIAL PRIMARY KEY,
    profile_code    TEXT NOT NULL REFERENCES dietary_profiles(profile_code) ON DELETE CASCADE,
    excludes        TEXT NOT NULL     -- ingredient/category tag excluded by this profile
);

CREATE TABLE IF NOT EXISTS dietary_rule_requirements (
    id              BIGSERIAL PRIMARY KEY,
    profile_code    TEXT NOT NULL REFERENCES dietary_profiles(profile_code) ON DELETE CASCADE,
    requires        TEXT NOT NULL     -- e.g. Jain: "no root vegetables", configurable per user
);

CREATE TABLE IF NOT EXISTS food_allergens (
    id              BIGSERIAL PRIMARY KEY,
    food_id         TEXT NOT NULL REFERENCES food_entities(food_id) ON DELETE CASCADE,
    allergen        TEXT NOT NULL,    -- milk, egg, peanut, tree_nut, soy, wheat_gluten, sesame, fish, shellfish
    state           TEXT NOT NULL CHECK (state IN ('contains', 'may_contain', 'free_from', 'unknown')),
    UNIQUE (food_id, allergen)
);

-- --- Meal combinations / templates ------------------------------------------
CREATE TABLE IF NOT EXISTS meal_templates (
    template_id     TEXT PRIMARY KEY,
    name            TEXT NOT NULL,     -- 'grain + protein + vegetable + side', 'thali', etc.
    slots           JSONB NOT NULL     -- ordered slot definitions
);

CREATE TABLE IF NOT EXISTS meal_combinations (
    combination_id      TEXT PRIMARY KEY,
    template_id         TEXT REFERENCES meal_templates(template_id),
    fingerprint         TEXT NOT NULL UNIQUE,  -- deterministic hash of normalized
                                               -- (food_id, portion, preparation) set
                                               -- so item-order never creates a duplicate
    status              TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN (
        'candidate', 'validated', 'rejected'
    ))
);

CREATE TABLE IF NOT EXISTS meal_combination_items (
    id                  BIGSERIAL PRIMARY KEY,
    combination_id      TEXT NOT NULL REFERENCES meal_combinations(combination_id) ON DELETE CASCADE,
    food_id             TEXT NOT NULL REFERENCES food_entities(food_id),
    portion_id          BIGINT REFERENCES portions(id),
    quantity            NUMERIC NOT NULL
);

CREATE TABLE IF NOT EXISTS food_substitutions (
    id              BIGSERIAL PRIMARY KEY,
    food_id         TEXT NOT NULL REFERENCES food_entities(food_id) ON DELETE CASCADE,
    substitute_id   TEXT NOT NULL REFERENCES food_entities(food_id),
    reason          TEXT              -- 'protein', 'dairy', 'carb', etc.
);

-- --- AI scan / correction loop ----------------------------------------------
CREATE TABLE IF NOT EXISTS ai_scan_results (
    id              BIGSERIAL PRIMARY KEY,
    scan_id         TEXT NOT NULL,
    candidate_food  TEXT,
    confidence      NUMERIC,
    portion_guess   JSONB,
    resolved_food_id TEXT REFERENCES food_entities(food_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_corrections (
    id              BIGSERIAL PRIMARY KEY,
    scan_id         TEXT,
    correction_type TEXT NOT NULL,    -- 'wrong_food', 'wrong_portion', 'wrong_preparation', 'wrong_source_type'
    original_value  TEXT,
    corrected_value TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
