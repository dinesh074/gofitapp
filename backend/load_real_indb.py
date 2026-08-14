"""
Loads the REAL INDB nutrition data package (backend/GOFIT_REAL_INDB_DATABASE)
into the gofit.nutri_* tables created by gofit_today_nutrition_db_v1's
schema_postgres.sql.

This REPLACES the placeholder 20k catalog blueprint with real, sourced data:
1,347 real foods (1,014 INDB recipes + 333 ingredient components), 41,064
real nutrient observations, 1,014 real recipes with 10,271 ingredient
mappings, 1,014 portions, 1,892 aliases. Source: INDB (Indian Nutrient
Databank), CC BY 4.0. No fabricated values -- every nutrient row already
carries its own source_id/value_status from the package.

Steps:
  1. Empties nutri_food_catalog_plan (the 20k *blueprint* -- just planned
     slot names with no real data -- superseded by this real dataset).
  2. Upserts nutri_data_sources with the 6 real primary sources referenced
     by foods.csv (asc_manual, bfp_manual, open_source_recipes, ifct_nin,
     ukfct, usda) plus the SRC_INDB registry row already in data_sources.csv.
  3. Upserts any of the package's 39 nutrient codes into nutri_nutrient_dictionary
     that aren't already covered by the v1 dictionary (62 codes) -- most already
     match; a handful of naming differences (carb_g, fibre_g, freesugar_g, ...)
     get added as their own codes rather than force-mapped, so provenance stays
     exact to the source file.
  4. Bulk-loads foods, food_nutrients, recipes, recipe_ingredients, portions,
     food_aliases via executemany inside ONE transaction (fast -- the earlier
     attempt at this used one round-trip per row in autocommit mode, which is
     why it was still running after several minutes for far fewer rows).

Safe to re-run: every insert is an upsert (ON CONFLICT DO UPDATE/NOTHING).

Usage (from backend/):
    python load_real_indb.py
"""
import csv
import os

import psycopg
from dotenv import load_dotenv

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.join(HERE, "GOFIT_REAL_INDB_DATABASE")
load_dotenv(os.path.join(HERE, ".env"))

DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
if not DATABASE_URL.lower().startswith(("postgres://", "postgresql://")):
    raise SystemExit("DATABASE_URL is not set to a Postgres URL -- refusing to run.")

URL = "postgresql://" + DATABASE_URL.split("://", 1)[1]

# Primary-source codes seen in foods.csv that aren't already registered in
# GOFIT_REAL_INDB_DATABASE/data_sources.csv (which only has SRC_INDB itself).
_EXTRA_SOURCES = {
    "asc_manual": ("ASC manual entry", "manual curation", None, None,
                   "Manually curated recipe entered as part of the INDB project (ASC-prefixed recipe codes)."),
    "bfp_manual": ("BFP manual entry", "manual curation", None, None,
                   "Manually curated recipe entered as part of the INDB project (BFP-prefixed recipe codes)."),
    "open_source_recipes": ("Open-source recipe sites", "web recipe aggregation", None, None,
                             "Recipes sourced from public recipe websites, see recipe_links.csv for original URLs."),
    "ifct_nin": ("IFCT / ICMR-NIN", "official food composition table", "ICMR-NIN",
                 "https://www.nin.res.in/ebooks/IFCT2017.pdf",
                 "Indian Food Composition Tables values referenced via INDB. PERMISSION_REQUIRED_FOR_REPRODUCTION -- "
                 "verify NIN redistribution terms before commercial use."),
    "ukfct": ("UK Food Composition Table (McCance & Widdowson)", "official food composition table", "PHE/UK Gov", None,
              "UK reference nutrient values used where an ingredient had no Indian-source equivalent in the uploaded repo."),
    "usda": ("USDA FoodData Central", "official food composition table", "USDA", "https://fdc.nal.usda.gov/",
             "US reference nutrient values used where an ingredient had no Indian-source equivalent in the uploaded repo."),
}


def read_csv(name, root=PKG):
    path = os.path.join(root, name)
    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def nb(v):
    """None if blank."""
    return v if v not in (None, "") else None


def to_bool(v):
    return str(v).strip().lower() in ("true", "1", "yes")


def main():
    print(f"Connecting to {DATABASE_URL.split('@')[-1]} ...")
    with psycopg.connect(URL) as conn:  # autocommit=False by default -> one transaction
        with conn.cursor() as cur:
            cur.execute("SET search_path TO gofit, public")

            # --- 1. clear the 20k placeholder blueprint ------------------------
            cur.execute("DELETE FROM nutri_food_catalog_plan")
            print(f"  Cleared nutri_food_catalog_plan (placeholder 20k blueprint superseded by real data).")

            # --- 2. data sources -------------------------------------------------
            rows = read_csv("data_sources.csv")
            for r in rows:
                cur.execute(
                    """INSERT INTO nutri_data_sources
                       (source_id, source_name, description, source_type, publisher_or_author, url, license_status, notes)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                       ON CONFLICT (source_id) DO UPDATE SET
                         source_name=EXCLUDED.source_name, source_type=EXCLUDED.source_type,
                         publisher_or_author=EXCLUDED.publisher_or_author, url=EXCLUDED.url,
                         license_status=EXCLUDED.license_status, notes=EXCLUDED.notes""",
                    (r["source_id"], r["name"], None, r.get("type"), r.get("publisher"),
                     nb(r.get("url")), r.get("license"), r.get("notes")),
                )
            for sid, (name, stype, pub, url, notes) in _EXTRA_SOURCES.items():
                cur.execute(
                    """INSERT INTO nutri_data_sources
                       (source_id, source_name, description, source_type, publisher_or_author, url, license_status, notes)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                       ON CONFLICT (source_id) DO NOTHING""",
                    (sid, name, None, stype, pub, url, "REVIEW_REQUIRED" if sid == "ifct_nin" else "SEE_NOTES", notes),
                )
            print(f"  nutri_data_sources: {len(rows) + len(_EXTRA_SOURCES)} sources registered.")

            # --- 3. nutrient dictionary (fill gaps only) -------------------------
            nutrients = read_csv("nutrients.csv")
            nid_to_code = {}
            added = 0
            for r in nutrients:
                nid_to_code[r["nutrient_id"]] = r["code"]
                cur.execute(
                    """INSERT INTO nutri_nutrient_dictionary (nutrient_code, nutrient_group, unit, default_basis)
                       VALUES (%s,%s,%s,%s)
                       ON CONFLICT (nutrient_code) DO NOTHING""",
                    (r["code"], r["name"], r["unit"], r.get("basis") or "per_100g"),
                )
                added += cur.rowcount
            print(f"  nutri_nutrient_dictionary: {added} new codes added ({len(nutrients)} referenced total).")

            # --- 4. foods (1,347 real records) -----------------------------------
            foods = read_csv("foods.csv")
            food_rows = []
            for r in foods:
                entity_type = "dish" if to_bool(r.get("is_recipe")) else "ingredient"
                food_rows.append((
                    r["id"], r["name"], entity_type, nb(r.get("region")), nb(r.get("cuisine")),
                    nb(r.get("primarysource")), nb(r.get("source_record_id")), "verified",
                ))
            cur.executemany(
                """INSERT INTO nutri_foods
                   (food_id, canonical_name, entity_type, region, cuisine, source_id, source_record_id, status)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (food_id) DO UPDATE SET
                     canonical_name=EXCLUDED.canonical_name, entity_type=EXCLUDED.entity_type,
                     region=EXCLUDED.region, cuisine=EXCLUDED.cuisine, source_id=EXCLUDED.source_id,
                     source_record_id=EXCLUDED.source_record_id, status=EXCLUDED.status,
                     updated_at=now()""",
                food_rows,
            )
            print(f"  nutri_foods: {len(food_rows)} rows upserted.")

            # --- 5. food_nutrients (41,064 real observations) --------------------
            # ON CONFLICT can't be relied on here (raw_or_cooked is NULL for every
            # INDB row, and Postgres treats each NULL as distinct for uniqueness
            # purposes), so re-running would duplicate rows via the unique
            # constraint alone. Delete-then-insert scoped to this source instead,
            # so re-running the script stays idempotent.
            cur.execute("DELETE FROM nutri_food_nutrients WHERE source_id = 'SRC_INDB'")
            fn = read_csv("food_nutrients.csv")
            fn_rows = []
            skipped = 0
            for r in fn:
                code = nid_to_code.get(r["nutrient_id"])
                if not code:
                    skipped += 1
                    continue
                fn_rows.append((
                    r["food_id"], code, nb(r.get("value")), r["unit"], r.get("basis") or "per_100g",
                    nb(r.get("source_id")), nb(r.get("source_record_id")), nb(r.get("confidence")),
                    r.get("value_status") or "measured",
                ))
            cur.executemany(
                """INSERT INTO nutri_food_nutrients
                   (food_id, nutrient_code, amount, unit, basis, source_id, source_record_id, confidence, value_status)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                fn_rows,
            )
            print(f"  nutri_food_nutrients: {len(fn_rows)} rows inserted ({skipped} skipped -- unknown nutrient_id).")

            # --- 6. recipes (1,014 real recipes) ----------------------------------
            recipes = read_csv("recipes.csv")
            recipe_rows = [
                (r["id"], nb(r.get("food_id")), r["name"], nb(r.get("source_type")), r["recipe_code"], "verified")
                for r in recipes
            ]
            cur.executemany(
                """INSERT INTO nutri_recipes (recipe_id, food_id, recipe_name, source_id, source_record_id, status)
                   VALUES (%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (recipe_id) DO UPDATE SET
                     food_id=EXCLUDED.food_id, recipe_name=EXCLUDED.recipe_name,
                     source_id=EXCLUDED.source_id, source_record_id=EXCLUDED.source_record_id, status=EXCLUDED.status""",
                recipe_rows,
            )
            print(f"  nutri_recipes: {len(recipe_rows)} rows upserted.")

            # --- 7. recipe_ingredients (10,271 real ingredient mappings) ----------
            # Plain inserts, no natural unique key in the source -- delete-then-
            # insert scoped to recipe_id LIKE 'RECIPE_%' (this package's only
            # recipe-id namespace) keeps re-runs idempotent.
            cur.execute("DELETE FROM nutri_recipe_ingredients WHERE recipe_id LIKE 'RECIPE_%'")
            ri = read_csv("recipe_ingredients.csv")
            ri_rows = []
            for i, r in enumerate(ri):
                ri_rows.append((
                    r["recipe_id"], r["ingredient_food_id"], nb(r.get("quantity")) or 0,
                    r.get("quantity_unit") or "unit", nb(r.get("ingredient_name_org")), i,
                ))
            cur.executemany(
                """INSERT INTO nutri_recipe_ingredients
                   (recipe_id, ingredient_food_id, quantity, unit, preparation, sequence)
                   VALUES (%s,%s,%s,%s,%s,%s)""",
                ri_rows,
            )
            print(f"  nutri_recipe_ingredients: {len(ri_rows)} rows inserted.")

            # --- 8. portions (1,014 real recipe servings) -------------------------
            portions = read_csv("portions.csv")
            portion_rows = [
                (r["id"], r["food_id"], r.get("portion_unit") or "serving", r.get("portion_unit"), True)
                for r in portions
            ]
            cur.executemany(
                """INSERT INTO nutri_portions (portion_id, food_id, portion_name, household_unit, is_typical)
                   VALUES (%s,%s,%s,%s,%s)
                   ON CONFLICT (portion_id) DO UPDATE SET
                     food_id=EXCLUDED.food_id, portion_name=EXCLUDED.portion_name,
                     household_unit=EXCLUDED.household_unit, is_typical=EXCLUDED.is_typical""",
                portion_rows,
            )
            print(f"  nutri_portions: {len(portion_rows)} rows upserted.")

            # --- 9. food_aliases (1,892 real aliases/source names) ----------------
            # Plain inserts -- delete-then-insert scoped to INDB food_id namespace
            # for idempotency (same reasoning as recipe_ingredients above).
            cur.execute("DELETE FROM nutri_food_aliases WHERE food_id LIKE 'INDB_%' OR food_id LIKE 'SRC_FOOD_%'")
            aliases = read_csv("food_aliases.csv")
            alias_rows = [
                (r["food_id"], r["alias"], nb(r.get("language")), nb(r.get("alias_type")))
                for r in aliases
            ]
            cur.executemany(
                """INSERT INTO nutri_food_aliases (food_id, alias, language, alias_type)
                   VALUES (%s,%s,%s,%s)""",
                alias_rows,
            )
            print(f"  nutri_food_aliases: {len(alias_rows)} rows inserted.")

        conn.commit()
        print("\nCommitted.")

        with conn.cursor() as cur:
            cur.execute("SET search_path TO gofit, public")
            cur.execute(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema='gofit' AND table_name LIKE 'nutri_%' ORDER BY table_name"
            )
            tables = [r[0] for r in cur.fetchall()]
            print(f"\ngofit schema nutri_* tables now:")
            for t in tables:
                cur.execute(f'SELECT COUNT(*) FROM gofit."{t}"')
                print(f"  - {t}: {cur.fetchone()[0]} rows")


if __name__ == "__main__":
    main()
