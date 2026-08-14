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

