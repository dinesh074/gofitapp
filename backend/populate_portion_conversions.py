"""
gofit.today — populate_portion_conversions.py

Month 2 fix: `nutri_portion_conversions` was created by the Month-1 schema
but left empty, so `nutrition_engine.calculate_recipe_nutrition` could only
sum ingredient rows already in g/ml -- 5,235 of 10,271 real INDB
recipe_ingredient rows (51%) use tsp/tbsp/C (cup) and were silently skipped
(tracked, not mis-summed, but still incomplete).

This populates GENERIC (food_id IS NULL) volume-unit conversions only --
tsp/tbsp/C -- using a water-basis (1 ml ~= 1 g) approximation, the same
approximation already used in portion_engine.generic_household_unit_to_grams
for consistency. Always confidence='low', source_id=NULL (no sourced
per-food density data exists yet).

Deliberately does NOT add conversions for count/size-dependent units seen in
the data (sprig, nos, unit, sheet) -- "1 sprig of curry leaves" and "1 sprig
of mint" have wildly different real weights, so inventing one generic value
for those would be a fabrication the master prompt explicitly forbids.
"pinch" and "drops" are also skipped for the same reason (ingredient-specific
density varies too much to generalize honestly). These remain in
`unconverted_ingredients` in calculate_recipe_nutrition's output.

Idempotent: safe to re-run (ON CONFLICT DO NOTHING on the natural
from_unit+food_id-is-null key via a partial unique index created here).
"""
from __future__ import annotations

import os
import psycopg
from psycopg.rows import dict_row

DATABASE_URL = os.environ["DATABASE_URL"]

# from_unit -> (from_quantity, to_grams) i.e. "1 tsp = 5 g" (water-basis).
GENERIC_VOLUME_CONVERSIONS = {
    "tsp": (1, 5),
    "tbsp": (1, 15),
    "c": (1, 240),   # "C" is the INDB shorthand for cup
    "cup": (1, 240),
    "ml": (1, 1),    # explicit identity row, useful for callers that always
                     # look up nutri_portion_conversions rather than special-
                     # casing "ml" themselves
}


def main():
    with psycopg.connect(DATABASE_URL, autocommit=False, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute("SET search_path TO gofit, public")
            # Partial unique index so generic (food_id IS NULL) rows for the
            # same unit can't be duplicated across re-runs.
            cur.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS nutri_portion_conversions_generic_unit_uq
                ON nutri_portion_conversions (from_unit)
                WHERE food_id IS NULL
                """
            )
            for unit, (qty, grams) in GENERIC_VOLUME_CONVERSIONS.items():
                cur.execute(
                    """
                    INSERT INTO nutri_portion_conversions
                        (food_id, from_unit, from_quantity, to_grams, source_id, confidence)
                    VALUES (NULL, %s, %s, %s, NULL, 'low')
                    ON CONFLICT (from_unit) WHERE food_id IS NULL DO UPDATE
                        SET from_quantity = EXCLUDED.from_quantity,
                            to_grams = EXCLUDED.to_grams,
                            confidence = EXCLUDED.confidence
                    """,
                    (unit, qty, grams),
                )
            cur.execute(
                "SELECT COUNT(*) AS c FROM nutri_portion_conversions WHERE food_id IS NULL"
            )
            print("generic conversions now stored:", cur.fetchone()["c"])
        conn.commit()


if __name__ == "__main__":
    main()
