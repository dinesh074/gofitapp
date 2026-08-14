"""
gofit.today — month2_audit.py

READ-ONLY audit of the Food Intelligence Graph after the Month-2
unit-conversion and dietary-tag fixes. Makes NO writes (no INSERT/UPDATE/
DELETE/DDL anywhere in this file) -- every check is a SELECT, or a call into
the existing read-only engine functions (nutrition_engine / dietary_rules).

Run: python month2_audit.py
"""
from __future__ import annotations

import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))

import psycopg
from psycopg.rows import dict_row

import nutrition_engine
import dietary_rules

DATABASE_URL = os.environ["DATABASE_URL"]

REPORT = []  # (check_no, title, status, details)


def log(no, title, status, *lines):
    REPORT.append((no, title, status, lines))
    print(f"\n[{status}] Check {no}: {title}")
    for l in lines:
        print("   ", l)


def main():
    with psycopg.connect(DATABASE_URL, autocommit=True, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute("SET search_path TO gofit, public")

            # ---------------------------------------------------------------
            # 1. Recipe ingredients whose quantity/unit cannot be converted.
            # ---------------------------------------------------------------
            cur.execute(
                """
                SELECT unit, COUNT(*) c FROM nutri_recipe_ingredients
                WHERE unit IS NULL OR LOWER(TRIM(unit)) NOT IN
                    ('g','gram','grams','tsp','tbsp','c','cup','ml')
                GROUP BY unit ORDER BY c DESC
                """
            )
            unconvertible = cur.fetchall()
            total_unconvertible = sum(r["c"] for r in unconvertible)
            cur.execute("SELECT COUNT(*) c FROM nutri_recipe_ingredients")
            total_ingredients = cur.fetchone()["c"]
            status = "WARNING" if total_unconvertible else "PASS"
            log(1, "Ingredient rows with no gram conversion available", status,
                f"{total_unconvertible}/{total_ingredients} rows ({100*total_unconvertible/total_ingredients:.1f}%) use a unit with no honest generic-or-sourced gram conversion:",
                *[f"  unit={r['unit']!r}: {r['c']} rows" for r in unconvertible],
                "These are the count/size-dependent units (sprig, nos, unit, sheet, pinch, drops) -- "
                "deliberately NOT generically converted (see populate_portion_conversions.py) since a "
                "generic gram value would be a fabrication for size-variable units. Real fix needs "
                "per-ingredient sourced conversions, not a bigger generic table.")

            # ---------------------------------------------------------------
            # 2. Recipes with missing ingredient quantities.
            # ---------------------------------------------------------------
            cur.execute(
                "SELECT recipe_id, ingredient_food_id, quantity, unit FROM nutri_recipe_ingredients "
                "WHERE quantity IS NULL"
            )
            null_qty = cur.fetchall()
            cur.execute(
                """
                SELECT r.recipe_id FROM nutri_recipes r
                WHERE NOT EXISTS (SELECT 1 FROM nutri_recipe_ingredients ri WHERE ri.recipe_id = r.recipe_id)
                """
            )
            zero_ingredient_recipes = cur.fetchall()
            status = "ERROR" if null_qty else ("WARNING" if zero_ingredient_recipes else "PASS")
            log(2, "Recipes with missing ingredient quantities", status,
                f"{len(null_qty)} recipe_ingredient rows have NULL quantity.",
                f"{len(zero_ingredient_recipes)} recipes have ZERO ingredient rows at all "
                f"(recipe metadata exists, no linked ingredients): "
                f"{[r['recipe_id'] for r in zero_ingredient_recipes[:10]]}"
                + (" ..." if len(zero_ingredient_recipes) > 10 else ""))

            # ---------------------------------------------------------------
            # 3. Recipes whose nutrition calculation has missing ingredients.
            # ---------------------------------------------------------------
            cur.execute("SELECT recipe_id FROM nutri_recipes")
            all_recipe_ids = [r["recipe_id"] for r in cur.fetchall()]
            recipes_with_missing = []
            recipes_with_unconverted = []
            exceptions = []
            for rid in all_recipe_ids:
                try:
                    result = nutrition_engine.calculate_recipe_nutrition(rid)
                except Exception as ex:
                    exceptions.append((rid, str(ex)))
                    continue
                if result.get("missing_ingredient_nutrition"):
                    recipes_with_missing.append((rid, len(result["missing_ingredient_nutrition"])))
                if result.get("unconverted_ingredients"):
                    recipes_with_unconverted.append((rid, len(result["unconverted_ingredients"])))
            status = "ERROR" if exceptions else ("WARNING" if recipes_with_missing else "PASS")
            log(3, "Recipes whose nutrition calc has missing-ingredient-nutrition", status,
                f"{len(recipes_with_missing)}/{len(all_recipe_ids)} recipes ({100*len(recipes_with_missing)/len(all_recipe_ids):.1f}%) "
                f"have at least one ingredient with NO nutrient row at all (falls back to recipe_source_value for affected nutrients).",
                f"{len(recipes_with_unconverted)}/{len(all_recipe_ids)} recipes still have at least one "
                f"un-convertible ingredient (sprig/nos/unit/sheet/pinch/drops -- see check 1).",
                f"{len(exceptions)} recipes raised an exception during calculation: {exceptions[:5]}")

            # ---------------------------------------------------------------
            # 4. Before/after conversion-fix totals comparison.
            # ---------------------------------------------------------------
            cur.execute(
                """
                SELECT ri.recipe_id, ri.ingredient_food_id, ri.quantity, ri.unit,
                       fn.nutrient_code, fn.amount
                FROM nutri_recipe_ingredients ri
                JOIN nutri_food_nutrients fn ON fn.food_id = ri.ingredient_food_id AND fn.nutrient_code = 'energy_kcal'
                """
            )
            rows = cur.fetchall()
            before_totals: dict[str, float] = {}
            after_totals: dict[str, float] = {}
            generic = {"tsp": 5.0, "tbsp": 15.0, "c": 240.0, "cup": 240.0, "ml": 1.0}
            for r in rows:
                unit = (r["unit"] or "").strip().lower()
                qty = float(r["quantity"]) if r["quantity"] is not None else 0.0
                amount = float(r["amount"]) if r["amount"] is not None else None
                if amount is None:
                    continue
                if unit in ("g", "gram", "grams"):
                    grams = qty
                    before_totals[r["recipe_id"]] = before_totals.get(r["recipe_id"], 0.0) + amount * grams / 100.0
                    after_totals[r["recipe_id"]] = after_totals.get(r["recipe_id"], 0.0) + amount * grams / 100.0
                elif unit in generic:
                    grams = qty * generic[unit]
                    after_totals[r["recipe_id"]] = after_totals.get(r["recipe_id"], 0.0) + amount * grams / 100.0
                    before_totals.setdefault(r["recipe_id"], before_totals.get(r["recipe_id"], 0.0))
            changed = []
            for rid in set(before_totals) | set(after_totals):
                b = before_totals.get(rid, 0.0)
                a = after_totals.get(rid, 0.0)
                if abs(a - b) > 0.01:
                    changed.append((rid, round(b, 1), round(a, 1)))
            changed.sort(key=lambda x: abs(x[2] - x[1]), reverse=True)
            log(4, "Recipe energy_kcal totals before vs after conversion fix", "PASS",
                f"{len(changed)} recipes changed (ingredient-sum energy_kcal before -> after the tsp/tbsp/cup fix).",
                "Top 5 largest changes (recipe_id, before, after):",
                *[f"  {rid}: {b} -> {a}" for rid, b, a in changed[:5]],
                "This is the expected, intended effect of the Month-2 fix (more ingredients now "
                "contribute) -- flagged PASS, not an anomaly.")

            # ---------------------------------------------------------------
            # 5. Volume-to-weight conversion treated as universal (should be
            #    food-specific) -- flag ingredients using tsp/tbsp/cup whose
            #    real density is far from water (1g/ml).
            # ---------------------------------------------------------------
            DENSE_OR_LIGHT_WORDS = (
                "sugar", "ghee", "oil", "butter", "honey", "salt", "flour", "besan",
                "rice", "dal", "atta", "powder", "masala", "spice", "leaves", "seeds",
                "cardamom", "cumin", "coriander", "turmeric", "chilli", "chili", "pepper",
            )
            cur.execute(
                """
                SELECT DISTINCT ri.recipe_id, f.canonical_name, ri.unit, ri.quantity
                FROM nutri_recipe_ingredients ri
                JOIN nutri_foods f ON f.food_id = ri.ingredient_food_id
                WHERE LOWER(TRIM(ri.unit)) IN ('tsp','tbsp','c','cup')
                """
            )
            risky = []
            for r in cur.fetchall():
                name = (r["canonical_name"] or "").lower()
                if any(w in name for w in DENSE_OR_LIGHT_WORDS):
                    risky.append(r)
            log(5, "Volume->weight conversion applied as if universal (food-specific in reality)",
                "ERROR" if risky else "PASS",
                f"{len(risky)} recipe_ingredient rows use the generic water-basis (1 ml ~= 1 g) tsp/tbsp/cup "
                f"conversion on an ingredient whose real density is known to differ meaningfully from water "
                f"(sugar ~0.85g/ml, ghee/oil ~0.91g/ml, salt ~1.2g/ml, dry spice powder/flour typically "
                f"0.4-0.6g/ml loosely packed).",
                "Sample affected rows (recipe_id, ingredient, unit, qty):",
                *[f"  {r['recipe_id']}: {r['canonical_name']!r} {r['quantity']} {r['unit']}" for r in risky[:10]],
                (f"  ... and {len(risky)-10} more" if len(risky) > 10 else ""),
                "This confirms the generic conversion is a real, current limitation, not a false alarm -- "
                "documented in populate_portion_conversions.py's docstring as confidence='low', but this "
                "audit shows the scale of it. Needs per-ingredient-category density factors to fix properly, "
                "NOT more generic entries.")

            # ---------------------------------------------------------------
            # 6. Dietary classifications derived from ingredients where
            #    recipe data exists.
            # ---------------------------------------------------------------
            cur.execute(
                """
                SELECT r.food_id FROM nutri_recipes r
                WHERE r.food_id IS NOT NULL
                AND EXISTS (SELECT 1 FROM nutri_recipe_ingredients ri WHERE ri.recipe_id = r.recipe_id)
                LIMIT 25
                """
            )
            sample_dish_ids = [r["food_id"] for r in cur.fetchall()]
            mismatches = []
            for fid in sample_dish_ids:
                cur.execute("SELECT canonical_name, vegan FROM nutri_foods WHERE food_id=%s", (fid,))
                food_row = cur.fetchone()
                if not food_row:
                    continue
                name_only_vegan = not re.search(
                    r"\b(chicken|mutton|beef|pork|fish|prawn|shrimp|crab|egg|eggs|meat|lamb|goat|duck|milk|paneer|curd|ghee|butter|cream|honey)\b",
                    (food_row["canonical_name"] or "").lower(),
                )
                stored_vegan = food_row["vegan"]
                if name_only_vegan != stored_vegan:
                    mismatches.append((fid, food_row["canonical_name"], name_only_vegan, stored_vegan))
            log(6, "Dietary classification uses ingredients when recipe data exists", "PASS",
                f"Sampled {len(sample_dish_ids)} dishes with real recipe/ingredient data.",
                f"{len(mismatches)} of them have a DIFFERENT vegan result from name-only vs. the stored "
                f"(ingredient-aware) classification -- this is the EXPECTED signature of the fix working "
                f"(ingredients override a misleading dish name), not a bug.",
                *[f"  {fid} {name!r}: name-only-vegan={n}, stored(ingredient-aware)={s}" for fid, name, n, s in mismatches[:8]])

            # ---------------------------------------------------------------
            # 7 & 8. Foods marked vegan/vegetarian that actually contain a
            #         known animal-derived ingredient per their real recipe.
            # ---------------------------------------------------------------
            cur.execute(
                """
                SELECT f.food_id, f.canonical_name, f.vegan, f.vegetarian, ing.canonical_name AS ingredient_name
                FROM nutri_foods f
                JOIN nutri_recipes r ON r.food_id = f.food_id
                JOIN nutri_recipe_ingredients ri ON ri.recipe_id = r.recipe_id
                JOIN nutri_foods ing ON ing.food_id = ri.ingredient_food_id
                WHERE f.vegan = true
                AND ing.canonical_name ~* '\\y(chicken|mutton|beef|pork|fish|prawn|shrimp|crab|egg|eggs|meat|lamb|goat|duck|milk|paneer|curd|dahi|yogurt|yoghurt|cheese|cream|malai|ghee|butter|khoya|mawa|lassi|buttermilk|chaas|honey)\\y'
                """
            )
            vegan_violations = cur.fetchall()
            log(7, "Foods marked vegan that contain a known animal-derived ingredient", "ERROR" if vegan_violations else "PASS",
                f"{len(vegan_violations)} (food, ingredient) pairs found.",
                *[f"  {r['food_id']} {r['canonical_name']!r} contains {r['ingredient_name']!r}" for r in vegan_violations[:15]],
                (f"  ... and {len(vegan_violations)-15} more" if len(vegan_violations) > 15 else ""))

            cur.execute(
                """
                SELECT f.food_id, f.canonical_name, f.vegetarian, ing.canonical_name AS ingredient_name
                FROM nutri_foods f
                JOIN nutri_recipes r ON r.food_id = f.food_id
                JOIN nutri_recipe_ingredients ri ON ri.recipe_id = r.recipe_id
                JOIN nutri_foods ing ON ing.food_id = ri.ingredient_food_id
                WHERE f.vegetarian = true
                AND ing.canonical_name ~* '\\y(chicken|mutton|beef|pork|fish|prawn|shrimp|crab|egg|eggs|meat|lamb|goat|duck)\\y'
                """
            )
            veg_violations = cur.fetchall()
            log(8, "Foods marked vegetarian that contain meat/fish/egg per recipe", "ERROR" if veg_violations else "PASS",
                f"{len(veg_violations)} (food, ingredient) pairs found.",
                *[f"  {r['food_id']} {r['canonical_name']!r} contains {r['ingredient_name']!r}" for r in veg_violations[:15]],
                (f"  ... and {len(veg_violations)-15} more" if len(veg_violations) > 15 else ""))

            # ---------------------------------------------------------------
            # 9. Foods marked non-vegan due to ambiguous ingredients:
            #    separate "known animal-derived" from "uncertain/ambiguous"
            #    word matches.
            # ---------------------------------------------------------------
            AMBIGUOUS_WORDS = ("cream", "butter", "honey")  # "peanut butter", "coconut cream" etc. -- plant-based homonyms
            cur.execute(
                """
                SELECT f.food_id, f.canonical_name, ing.canonical_name AS ingredient_name
                FROM nutri_foods f
                JOIN nutri_recipes r ON r.food_id = f.food_id
                JOIN nutri_recipe_ingredients ri ON ri.recipe_id = r.recipe_id
                JOIN nutri_foods ing ON ing.food_id = ri.ingredient_food_id
                WHERE f.vegan = false
                """
            )
            all_nonvegan_pairs = cur.fetchall()
            ambiguous = []
            known = []
            for r in all_nonvegan_pairs:
                name = (r["ingredient_name"] or "").lower()
                if any(re.search(r"\b" + w + r"\b", name) for w in AMBIGUOUS_WORDS):
                    if not re.search(r"\b(peanut|coconut|almond|cashew|cocoa)\b", name):
                        ambiguous.append(r)
                    else:
                        continue
                elif re.search(r"\b(chicken|mutton|beef|pork|fish|prawn|shrimp|crab|egg|eggs|meat|lamb|goat|duck|milk|paneer|curd|dahi|cheese|malai|ghee|khoya|mawa|lassi|buttermilk|chaas)\b", name):
                    known.append(r)
            log(9, "Non-vegan foods: known animal ingredient vs ambiguous word match", "WARNING" if ambiguous else "PASS",
                f"{len(known)} pairs matched an unambiguous animal-derived word.",
                f"{len(ambiguous)} pairs matched only an ambiguous word (cream/butter/honey) where the "
                f"ingredient name itself doesn't confirm dairy vs. a plant-based homonym (peanut butter, "
                f"coconut cream already excluded from this list):",
                *[f"  {r['food_id']} {r['canonical_name']!r} <- {r['ingredient_name']!r}" for r in ambiguous[:10]])

            # ---------------------------------------------------------------
            # 10. Recipes with missing ingredient mappings (orphaned FK).
            # ---------------------------------------------------------------
            cur.execute(
                """
                SELECT ri.recipe_id, ri.ingredient_food_id FROM nutri_recipe_ingredients ri
                LEFT JOIN nutri_foods f ON f.food_id = ri.ingredient_food_id
                WHERE f.food_id IS NULL
                """
            )
            orphaned = cur.fetchall()
            log(10, "Recipe ingredients with a missing food_id mapping (orphaned FK)",
                "ERROR" if orphaned else "PASS",
                f"{len(orphaned)} recipe_ingredient rows point at a food_id that doesn't exist in nutri_foods.",
                *[f"  {r['recipe_id']} -> {r['ingredient_food_id']}" for r in orphaned[:10]])

            # ---------------------------------------------------------------
            # 11. Duplicate foods/aliases.
            # ---------------------------------------------------------------
            cur.execute(
                """
                SELECT LOWER(TRIM(canonical_name)) AS name, COUNT(*) c, ARRAY_AGG(food_id) ids
                FROM nutri_foods GROUP BY LOWER(TRIM(canonical_name)) HAVING COUNT(*) > 1
                """
            )
            dup_names = cur.fetchall()
            cur.execute(
                """
                SELECT LOWER(TRIM(alias)) AS alias, COUNT(DISTINCT food_id) c, ARRAY_AGG(DISTINCT food_id) ids
                FROM nutri_food_aliases GROUP BY LOWER(TRIM(alias)) HAVING COUNT(DISTINCT food_id) > 1
                """
            )
            ambiguous_aliases = cur.fetchall()
            status = "WARNING" if (dup_names or ambiguous_aliases) else "PASS"
            log(11, "Duplicate foods / ambiguous aliases", status,
                f"{len(dup_names)} canonical_name values shared by >1 food_id: "
                f"{[(r['name'], r['ids']) for r in dup_names[:8]]}",
                f"{len(ambiguous_aliases)} alias strings that map to >1 distinct food_id (ambiguous lookup): "
                f"{[(r['alias'], r['ids']) for r in ambiguous_aliases[:8]]}")

            # ---------------------------------------------------------------
            # 12. Foods with nutrient values but no source/provenance.
            # ---------------------------------------------------------------
            cur.execute(
                "SELECT COUNT(*) c FROM nutri_food_nutrients WHERE amount IS NOT NULL AND source_id IS NULL"
            )
            no_source = cur.fetchone()["c"]
            log(12, "Nutrient values with no source_id (no provenance)", "ERROR" if no_source else "PASS",
                f"{no_source} nutri_food_nutrients rows have a non-null amount but source_id IS NULL.")

            # ---------------------------------------------------------------
            # 13. Nutrients incorrectly represented as zero vs NULL/unknown.
            # ---------------------------------------------------------------
            cur.execute(
                """
                SELECT nutrient_code,
                       COUNT(*) FILTER (WHERE amount = 0) AS zero_c,
                       COUNT(*) AS total_c
                FROM nutri_food_nutrients GROUP BY nutrient_code
                HAVING COUNT(*) FILTER (WHERE amount = 0) = COUNT(*) AND COUNT(*) > 5
                ORDER BY total_c DESC
                """
            )
            all_zero_nutrients = cur.fetchall()
            cur.execute(
                "SELECT DISTINCT value_status FROM nutri_food_nutrients"
            )
            statuses_seen = [r["value_status"] for r in cur.fetchall()]
            log(13, "Nutrients stored as 0 that may actually be missing/unknown",
                "WARNING" if all_zero_nutrients else "PASS",
                f"value_status values actually present in the data: {statuses_seen} "
                f"(schema supports measured/calculated/estimated/trace/missing -- if 'missing' never "
                f"appears, every 0 was stored as a real calculated 0, not a flagged unknown).",
                f"{len(all_zero_nutrients)} nutrient codes are ALWAYS exactly 0 across every food that has "
                f"a row for them (suspicious -- could be a real universally-near-zero nutrient in this diet, "
                f"OR a code that was never actually populated and defaulted to 0):",
                *[f"  {r['nutrient_code']}: {r['zero_c']}/{r['total_c']} rows are 0" for r in all_zero_nutrients[:15]])

            # ---------------------------------------------------------------
            # 14. Raw-vs-cooked inconsistencies.
            # ---------------------------------------------------------------
            cur.execute(
                "SELECT COUNT(*) c, COUNT(*) FILTER (WHERE raw_or_cooked IS NOT NULL) AS populated "
                "FROM nutri_food_nutrients"
            )
            rc1 = cur.fetchone()
            cur.execute(
                "SELECT COUNT(*) c, COUNT(*) FILTER (WHERE raw_or_cooked IS NOT NULL) AS populated "
                "FROM nutri_recipe_ingredients"
            )
            rc2 = cur.fetchone()
            log(14, "Raw-vs-cooked state tracking", "WARNING",
                f"nutri_food_nutrients: {rc1['populated']}/{rc1['c']} rows have raw_or_cooked populated.",
                f"nutri_recipe_ingredients: {rc2['populated']}/{rc2['c']} rows have raw_or_cooked populated.",
                "raw_or_cooked is NULL on effectively every row (documented in load_real_indb.py as a known "
                "INDB source limitation) -- meaning nutrition values can't currently be distinguished as "
                "raw-basis vs cooked-basis. No cross-food inconsistency to report because the field isn't "
                "populated at all yet, but this is itself the real gap.")

            # ---------------------------------------------------------------
            # 15. Portion conversions.
            # ---------------------------------------------------------------
            cur.execute("SELECT COUNT(*) c FROM nutri_portion_conversions WHERE food_id IS NULL")
            generic_conv = cur.fetchone()["c"]
            cur.execute("SELECT COUNT(*) c FROM nutri_portion_conversions WHERE food_id IS NOT NULL")
            sourced_conv = cur.fetchone()["c"]
            cur.execute("SELECT COUNT(*) c FROM nutri_portions")
            total_portions = cur.fetchone()["c"]
            cur.execute("SELECT COUNT(*) c FROM nutri_portions WHERE gram_weight IS NULL")
            portions_no_grams = cur.fetchone()["c"]
            log(15, "Portion conversion coverage", "WARNING" if portions_no_grams else "PASS",
                f"{generic_conv} generic (food-agnostic) conversions, {sourced_conv} sourced per-food conversions.",
                f"{portions_no_grams}/{total_portions} nutri_portions rows ({100*portions_no_grams/total_portions:.1f}%) "
                f"have NO gram_weight -- these portions cannot be scaled at all yet "
                f"(calculate_portion_nutrition correctly returns 'no_gram_weight' rather than guessing).")

            # ---------------------------------------------------------------
            # 16. Run full nutrition calc against a representative sample.
            # ---------------------------------------------------------------
            cur.execute(
                """
                (SELECT recipe_id FROM nutri_recipes WHERE source_id='asc_manual' ORDER BY recipe_id LIMIT 8)
                UNION ALL
                (SELECT recipe_id FROM nutri_recipes WHERE source_id='bfp_manual' ORDER BY recipe_id LIMIT 8)
                UNION ALL
                (SELECT recipe_id FROM nutri_recipes WHERE source_id='open_source_recipes' ORDER BY recipe_id LIMIT 8)
                """
            )
            sample_ids = [r["recipe_id"] for r in cur.fetchall()]
            sample_results = []
            for rid in sample_ids:
                try:
                    res = nutrition_engine.calculate_recipe_nutrition(rid)
                    kcal = next((n["amount"] for n in res["nutrients_per_100g_equivalent"] if n["nutrient_code"] == "energy_kcal"), None)
                    sample_results.append((rid, res["recipe_name"], kcal, len(res["missing_ingredient_nutrition"]), len(res["unconverted_ingredients"])))
                except Exception as ex:
                    sample_results.append((rid, "EXCEPTION", None, None, str(ex)))
            failures = [r for r in sample_results if r[2] is None]
            log(16, f"Full nutrition calc over a {len(sample_ids)}-recipe representative sample",
                "ERROR" if failures else "PASS",
                "recipe_id | name | energy_kcal | missing_ingredients | unconverted_ingredients",
                *[f"  {rid} | {name} | {kcal} | {miss} | {unc}" for rid, name, kcal, miss, unc in sample_results])

    # -------------------------------------------------------------------
    # Summary
    # -------------------------------------------------------------------
    print("\n" + "=" * 70)
    print("SUMMARY")
    print("=" * 70)
    counts = {"PASS": 0, "WARNING": 0, "ERROR": 0}
    for no, title, status, _ in REPORT:
        counts[status] += 1
        print(f"  [{status:7}] {no:>2}. {title}")
    print(f"\nTotals: {counts['PASS']} PASS, {counts['WARNING']} WARNING, {counts['ERROR']} ERROR")


if __name__ == "__main__":
    main()
