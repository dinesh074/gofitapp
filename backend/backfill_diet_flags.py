"""
gofit.today — backfill_diet_flags.py

Month 2 fix: nutri_foods.vegetarian / vegan / eggetarian were 100% NULL after
the Month-1 load (INDB didn't ship these as booleans) -- meaning any query
that wanted "all vegetarian foods" needed to classify all 1,347 rows live on
every request. dietary_rules.is_vegetarian/is_vegan/is_eggetarian already
have a real word-list fallback (mirrors main.py's existing recommender
rules) that also cross-references real recipe-ingredient names (see
dietary_rules._get_classification_text) -- catching composite dishes whose
own name/alias doesn't reveal what's inside (e.g. "Hot tea (Garam Chai)"
doesn't say "milk"). This script runs that classification once per food and
stores the result back onto nutri_foods so the columns become real,
queryable data instead of staying NULL forever.


This is a snapshot, not a live source of truth: dietary_rules.py's is_*
functions still prefer the stored column but keep the same live fallback for
any food not yet backfilled (e.g. future foods added by Month 4+ ingestion).
Re-run this script any time the word lists in main.py change, or after a
bulk food import, to refresh the snapshot -- it is fully idempotent
(UPDATE ... only, no INSERT, so it can't create duplicate/orphaned rows).

Deliberately does NOT set jain/sattvic columns: those are documented in
GOFIT_MASTER_ARCHITECTURE_PROMPT.txt as "configurable rulesets", not fixed
per-food booleans, and dietary_rules.is_jain/is_sattvic already compute them
live correctly (3-way yes/no/depends, not a boolean) -- forcing them into a
boolean column here would be a regression, not an improvement.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

import psycopg
from psycopg.rows import dict_row

import main as _main  # noqa: E402  (imported after sys.path fix for local run)

DATABASE_URL = os.environ["DATABASE_URL"]


def _classify(canonical_name: str, aliases: list[str]) -> tuple[bool, bool, bool]:
    text = _main._norm(" ".join([canonical_name] + list(aliases)))
    nonveg = _main._word_in(_main._NON_VEG_WORDS, text)
    dairy = _main._word_in(_main._DAIRY_WORDS, text)
    meat_fish = _main._word_in(_main._MEAT_FISH_WORDS, text)
    vegetarian = not nonveg
    vegan = not nonveg and not dairy
    eggetarian = not meat_fish
    return vegetarian, vegan, eggetarian


def main():
    with psycopg.connect(DATABASE_URL, autocommit=False, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute("SET search_path TO gofit, public")
            cur.execute("SELECT food_id, canonical_name FROM nutri_foods")
            foods = cur.fetchall()

            cur.execute("SELECT food_id, alias FROM nutri_food_aliases")
            aliases_by_food: dict[str, list[str]] = {}
            for r in cur.fetchall():
                aliases_by_food.setdefault(r["food_id"], []).append(r["alias"])

            # Recipe -> ingredient canonical names, keyed by the recipe's own
            # food_id (nutri_recipes.food_id) -- lets a dish classify based on
            # what's actually inside it, not just its own name/aliases. Real
            # INDB data the original main.py classifier never had.
            cur.execute(
                """
                SELECT r.food_id AS dish_food_id, f.canonical_name
                FROM nutri_recipe_ingredients ri
                JOIN nutri_recipes r ON r.recipe_id = ri.recipe_id
                JOIN nutri_foods f ON f.food_id = ri.ingredient_food_id
                WHERE r.food_id IS NOT NULL
                """
            )
            ingredient_names_by_dish: dict[str, list[str]] = {}
            for r in cur.fetchall():
                ingredient_names_by_dish.setdefault(r["dish_food_id"], []).append(r["canonical_name"])

            updated = 0
            for f in foods:
                aliases = (
                    aliases_by_food.get(f["food_id"], [])
                    + ingredient_names_by_dish.get(f["food_id"], [])
                )
                vegetarian, vegan, eggetarian = _classify(f["canonical_name"], aliases)
                cur.execute(
                    "UPDATE nutri_foods SET vegetarian=%s, vegan=%s, eggetarian=%s WHERE food_id=%s",
                    (vegetarian, vegan, eggetarian, f["food_id"]),
                )
                updated += 1
            conn.commit()
            print(f"backfilled diet flags for {updated} foods")

            cur.execute(
                "SELECT COUNT(*) AS c FROM nutri_foods WHERE vegetarian IS NOT NULL"
            )
            print("vegetarian now non-null:", cur.fetchone()["c"])
            cur.execute("SELECT COUNT(*) AS c FROM nutri_foods WHERE vegan = false")
            print("non-vegan foods:", cur.fetchone()["c"])
            cur.execute("SELECT COUNT(*) AS c FROM nutri_foods WHERE vegetarian = false")
            print("non-vegetarian foods:", cur.fetchone()["c"])


if __name__ == "__main__":
    main()
