-- Phase 1: meal template and role scaffolding for deterministic combination planning.
-- Additive only; reuses existing food/nutrient/recipe systems.

CREATE SCHEMA IF NOT EXISTS gofit;

CREATE TABLE IF NOT EXISTS gofit.gofit_meal_templates (
    id                BIGSERIAL PRIMARY KEY,
    template_key      TEXT NOT NULL UNIQUE,
    display_name      TEXT NOT NULL,
    meal_type         TEXT NOT NULL,
    cuisine           TEXT,
    training_context  TEXT,
    meal_size         TEXT NOT NULL DEFAULT 'regular',
    source            TEXT NOT NULL DEFAULT 'system',
    active            INTEGER NOT NULL DEFAULT 1,
    notes             TEXT,
    created_at        DOUBLE PRECISION NOT NULL,
    updated_at        DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS gofit.gofit_meal_template_roles (
    id            BIGSERIAL PRIMARY KEY,
    template_id   BIGINT NOT NULL REFERENCES gofit.gofit_meal_templates(id),
    role_key      TEXT NOT NULL,
    requirement   TEXT NOT NULL,
    min_items     INTEGER NOT NULL DEFAULT 0,
    max_items     INTEGER,
    position      INTEGER NOT NULL DEFAULT 0,
    UNIQUE (template_id, role_key, requirement)
);

CREATE INDEX IF NOT EXISTS idx_gofit_meal_templates_meal_type
    ON gofit.gofit_meal_templates(meal_type);

CREATE INDEX IF NOT EXISTS idx_gofit_meal_templates_training
    ON gofit.gofit_meal_templates(training_context);

CREATE TABLE IF NOT EXISTS gofit.gofit_food_role_map (
    id          BIGSERIAL PRIMARY KEY,
    food_key    TEXT NOT NULL,
    role_key    TEXT NOT NULL,
    weight      DOUBLE PRECISION NOT NULL DEFAULT 1,
    source      TEXT NOT NULL DEFAULT 'system',
    created_at  DOUBLE PRECISION NOT NULL,
    UNIQUE (food_key, role_key)
);

CREATE INDEX IF NOT EXISTS idx_gofit_food_role_map_food_key
    ON gofit.gofit_food_role_map(food_key);

CREATE INDEX IF NOT EXISTS idx_gofit_food_role_map_role_key
    ON gofit.gofit_food_role_map(role_key);
