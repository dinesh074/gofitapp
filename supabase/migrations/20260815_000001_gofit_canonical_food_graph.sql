
   -- Additive canonical food graph foundation for gofit.today
-- Safe migration: creates new tables only, does not alter or drop existing ones.

CREATE SCHEMA IF NOT EXISTS gofit;

CREATE TABLE IF NOT EXISTS gofit.gofit_data_sources (
    code            TEXT PRIMARY KEY,
    display_name    TEXT NOT NULL,
    kind            TEXT NOT NULL,
    provenance_json TEXT,
    created_at      DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS gofit.gofit_food_entities (
    id            BIGSERIAL PRIMARY KEY,
    food_key      TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    default_unit  TEXT NOT NULL,
    source_name   TEXT,
    source_code   TEXT,
    created_at    DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS gofit.gofit_food_aliases (
    id          BIGSERIAL PRIMARY KEY,
    food_id     BIGINT NOT NULL REFERENCES gofit.gofit_food_entities(id),
    alias_text  TEXT NOT NULL,
    alias_norm  TEXT NOT NULL,
    created_at  DOUBLE PRECISION NOT NULL,
    UNIQUE (food_id, alias_norm)
);

CREATE INDEX IF NOT EXISTS idx_gofit_food_alias_norm
    ON gofit.gofit_food_aliases(alias_norm);

CREATE TABLE IF NOT EXISTS gofit.gofit_food_nutrients (
    food_id              BIGINT PRIMARY KEY REFERENCES gofit.gofit_food_entities(id),
    kcal_per_unit        DOUBLE PRECISION NOT NULL DEFAULT 0,
    protein_g_per_unit   DOUBLE PRECISION NOT NULL DEFAULT 0,
    carbs_g_per_unit     DOUBLE PRECISION NOT NULL DEFAULT 0,
    fat_g_per_unit       DOUBLE PRECISION NOT NULL DEFAULT 0,
    fiber_g              DOUBLE PRECISION,
    sugar_g              DOUBLE PRECISION,
    sodium_mg            DOUBLE PRECISION,
    potassium_mg         DOUBLE PRECISION,
    calcium_mg           DOUBLE PRECISION,
    iron_mg              DOUBLE PRECISION,
    micros_json          TEXT,
    health_score         DOUBLE PRECISION,
    jain_status          TEXT,
    sattvic_status       TEXT,
    updated_at           DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS gofit.gofit_food_portions (
    food_id          BIGINT NOT NULL REFERENCES gofit.gofit_food_entities(id),
    portion_name     TEXT NOT NULL,
    grams            DOUBLE PRECISION,
    unit_multiplier  DOUBLE PRECISION NOT NULL DEFAULT 1,
    PRIMARY KEY (food_id, portion_name)
);

CREATE TABLE IF NOT EXISTS gofit.gofit_food_logs (
    id                  BIGSERIAL PRIMARY KEY,
    account_id          BIGINT NOT NULL,
    date                TEXT NOT NULL,
    dish                TEXT NOT NULL,
    created_at          DOUBLE PRECISION NOT NULL,
    legacy_meal_log_id  BIGINT UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_gofit_food_logs_account_date
    ON gofit.gofit_food_logs(account_id, date);

CREATE TABLE IF NOT EXISTS gofit.gofit_food_log_items (
    id            BIGSERIAL PRIMARY KEY,
    food_log_id   BIGINT NOT NULL REFERENCES gofit.gofit_food_logs(id),
    food_id       BIGINT REFERENCES gofit.gofit_food_entities(id),
    item_name     TEXT NOT NULL,
    count         DOUBLE PRECISION NOT NULL,
    unit          TEXT NOT NULL,
    kcal          DOUBLE PRECISION NOT NULL,
    protein_g     DOUBLE PRECISION NOT NULL,
    carbs_g       DOUBLE PRECISION NOT NULL,
    fat_g         DOUBLE PRECISION NOT NULL,
    micros_json   TEXT,
    source        TEXT,
    created_at    DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS gofit.gofit_ai_scan_results (
    id                  BIGSERIAL PRIMARY KEY,
    account_id          BIGINT NOT NULL,
    raw_items_json      TEXT NOT NULL,
    resolved_items_json TEXT NOT NULL,
    confidence          DOUBLE PRECISION NOT NULL,
    status              TEXT NOT NULL,
    created_at          DOUBLE PRECISION NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gofit_scan_account_time
    ON gofit.gofit_ai_scan_results(account_id, created_at);

CREATE TABLE IF NOT EXISTS gofit.gofit_ai_corrections (
    id             BIGSERIAL PRIMARY KEY,
    scan_result_id BIGINT NOT NULL REFERENCES gofit.gofit_ai_scan_results(id),
    account_id     BIGINT NOT NULL,
    item_name      TEXT NOT NULL,
    from_food_id   BIGINT REFERENCES gofit.gofit_food_entities(id),
    to_food_id     BIGINT REFERENCES gofit.gofit_food_entities(id),
    note           TEXT,
    created_at     DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS gofit.gofit_recipes (
    id            BIGSERIAL PRIMARY KEY,
    recipe_code   TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    servings      DOUBLE PRECISION NOT NULL DEFAULT 1,
    source        TEXT NOT NULL DEFAULT 'user',
    notes         TEXT,
    created_at    DOUBLE PRECISION NOT NULL,
    updated_at    DOUBLE PRECISION NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gofit_recipe_name ON gofit.gofit_recipes(name);

CREATE TABLE IF NOT EXISTS gofit.gofit_recipe_ingredients (
    id             BIGSERIAL PRIMARY KEY,
    recipe_id      BIGINT NOT NULL REFERENCES gofit.gofit_recipes(id),
    food_key       TEXT NOT NULL,
    quantity       DOUBLE PRECISION NOT NULL,
    quantity_unit  TEXT NOT NULL,
    position       INTEGER NOT NULL DEFAULT 0,
    notes          TEXT
);

CREATE TABLE IF NOT EXISTS gofit.gofit_cooking_yields (
    id              BIGSERIAL PRIMARY KEY,
    food_key        TEXT NOT NULL,
    cooking_method  TEXT NOT NULL,
    yield_factor    DOUBLE PRECISION NOT NULL,
    source          TEXT,
    notes           TEXT,
    UNIQUE (food_key, cooking_method)
);

CREATE TABLE IF NOT EXISTS gofit.gofit_meal_combinations (
    id            BIGSERIAL PRIMARY KEY,
    combo_key     TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    fingerprint   TEXT NOT NULL,
    source        TEXT NOT NULL DEFAULT 'editorial',
    created_at    DOUBLE PRECISION NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gofit_combo_fingerprint
    ON gofit.gofit_meal_combinations(fingerprint);

CREATE TABLE IF NOT EXISTS gofit.gofit_meal_combination_items (
    id               BIGSERIAL PRIMARY KEY,
    combination_id   BIGINT NOT NULL REFERENCES gofit.gofit_meal_combinations(id),
    side_food_key    TEXT NOT NULL,
    side_count       DOUBLE PRECISION NOT NULL DEFAULT 1,
    reason           TEXT,
    position         INTEGER NOT NULL DEFAULT 0,
    UNIQUE (combination_id, side_food_key)
);
