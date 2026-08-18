"""
One-time (re-runnable) import of the `gofit_nutrition_db_final_v4` dataset
(738 IFCT2017/USDA/UK-FCT ingredients + 1,014 INDB recipes, ~9.3k regional
aliases, ~19k per-100g nutrient facts, ~1.6k named portions, ~10.3k recipe
ingredient lines) into the live canonical food graph
(gofit_food_entities / gofit_food_nutrients / gofit_food_aliases /
gofit_food_portions / gofit_recipes / gofit_recipe_ingredients).

Source folder: app/gofit_nutrition_db_final_v4/tables/
  foods.csv, food_nutrients_core.csv, food_aliases.csv, food_portions.csv,
  recipes.csv, recipe_ingredients.csv

Dedup policy (per product owner sign-off):
  - A new food is SKIPPED (no new gofit_food_entities row created) if its
    canonical_name normalizes to match an existing entity's display_name,
    food_key, or any existing alias.
  - For a skipped/matched food, we still ENRICH the existing entity: add any
    new regional aliases, add any named portions the existing entity is
    missing, and fill in any nutrient columns that are currently NULL/0 on
    the existing gofit_food_nutrients row (never overwrite a populated
    value -- existing curated data always wins).
  - All nutrient values in food_nutrients_core.csv are per_100g, which maps
    1:1 onto our `default_unit='100g'` convention (kcal_per_unit already
    used by ~200 existing legacy foods) -- no unit conversion needed.
  - Per this dataset's own README: never fabricate a plate/bowl/cup -> grams
    conversion. food_portions.csv rows have no gram weight (only a
    descriptive unit like "tea cup"/"tall glass"), so they are stored with
    grams=NULL (informational label only). The one gram-accurate portion we
    do add ourselves is "100g" (100 grams, by definition -- not fabricated).
  - Recipe ingredient lines whose `ingredient_food_id` doesn't resolve to a
    canonical ingredient (~52% of lines -- often generic UK-FCT/USDA items
    like "Sugar, white"/"Water, distilled" that aren't in our 738-ingredient
    canonical set) are skipped individually; the recipe itself still gets a
    fully-nutrient-complete gofit_food_entities row from foods.csv, since
    that data comes from the recipe's own per-100g nutrient facts, not from
    summing ingredient lines.

Performance note: this writes ~1,752 foods + ~19k nutrient facts + ~9.3k
aliases + ~1.6k portions + ~1k recipes + ~5k recipe-ingredient lines. Doing
this one row/call at a time (as the first version of this script did) took
>1.5 hours over a high-latency network path and was killed mid-run. This
version batches every insert into large multi-row `INSERT ... VALUES
(...),(...),(...)` statements (chunked to stay well under any statement-size
limit) so the whole import is a few dozen round trips instead of tens of
thousands, and writes recipes/ingredients through the SAME transaction as
everything else (previously `recipe_combo_engine.save_recipe()` used its own
separate connection/transaction, so recipes could commit even when the rest
of the import rolled back -- fixed here by writing recipes directly with raw
SQL inside this script's single transaction).

Safe to re-run: every insert is either an explicit existing-row lookup (for
merges) or an INSERT OR IGNORE / ON CONFLICT DO UPDATE against a UNIQUE
constraint, and food_key/recipe_code generation is deterministic.

Usage:
    python import_nutrition_db_v4.py            # apply
    python import_nutrition_db_v4.py --dry-run   # report only, no writes
"""
from __future__ import annotations

import csv
import json
import os
import sys
import time
from collections import defaultdict

import db
import food_graph
from food_graph import _norm

DATA_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "app", "gofit_nutrition_db_final_v4", "tables",
)

BATCH_SIZE = 500

# nutrient_code (food_nutrients_core.csv) -> gofit_food_nutrients column
DIRECT_NUTRIENT_MAP = {
    "energy_kcal": "kcal_per_unit",
    "protein_g": "protein_g_per_unit",
    "carb_g": "carbs_g_per_unit",
    "fat_g": "fat_g_per_unit",
    "fibre_g": "fiber_g",
    "sodium_mg": "sodium_mg",
    "potassium_mg": "potassium_mg",
    "calcium_mg": "calcium_mg",
    "iron_mg": "iron_mg",
}
# nutrient codes with no dedicated column -> folded into micros_json
MICRO_NUTRIENT_MAP = {
    "zinc_mg": "zinc_mg",
    "cholesterol_mg": "cholesterol_mg",
}

IMPORT_SOURCE_TAG = "gofit_nutrition_db_v4"


def _read_csv(name: str) -> list[dict]:
    path = os.path.join(DATA_DIR, name)
    with open(path, "r", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def _to_float(v) -> float | None:
    v = (v or "").strip()
    if not v:
        return None
    try:
        return float(v)
    except ValueError:
        return None


def _slugify(name: str) -> str:
    return _norm(name).replace(" ", "_")


def _chunked(seq: list, size: int = BATCH_SIZE):
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


def _bulk_insert(c, prefix_sql: str, rows: list[tuple], stats: dict, stat_key: str) -> None:
    """prefix_sql looks like: 'INSERT OR IGNORE INTO t (a,b,c)' -- VALUES(...) is appended here."""
    if not rows:
        return
    n_cols = len(rows[0])
    row_ph = "(" + ",".join(["?"] * n_cols) + ")"
    for chunk in _chunked(rows):
        values_sql = ",".join([row_ph] * len(chunk))
        flat = [v for row in chunk for v in row]
        c.execute(f"{prefix_sql} VALUES {values_sql}", flat)
        stats[stat_key] += len(chunk)


class Importer:
    def __init__(self, dry_run: bool):
        self.dry_run = dry_run
        self.now = time.time()
        self.stats = defaultdict(int)
        self.food_key_by_csv_id: dict[str, str] = {}
        self.existing_food_keys: set[str] = set()
        self.norm_to_food_id: dict[str, int] = {}
        self.used_keys_this_run: set[str] = set()

    def _load_existing_index(self, c) -> None:
        for row in c.execute("SELECT id, food_key, display_name FROM gofit_food_entities").fetchall():
            self.existing_food_keys.add(row["food_key"])
            self.norm_to_food_id.setdefault(_norm(row["food_key"].replace("_", " ")), row["id"])
            self.norm_to_food_id.setdefault(_norm(row["display_name"]), row["id"])
        for row in c.execute("SELECT food_id, alias_norm FROM gofit_food_aliases").fetchall():
            self.norm_to_food_id.setdefault(row["alias_norm"], row["food_id"])

    def _unique_key(self, canonical_name: str, csv_food_id: str) -> str:
        base = _slugify(canonical_name) or _slugify(csv_food_id)
        key = base
        if key in self.existing_food_keys or key in self.used_keys_this_run:
            key = f"{base}_{csv_food_id.lower().replace('-', '_')}"
        self.used_keys_this_run.add(key)
        return key

    def run(self) -> None:
        foods = _read_csv("foods.csv")
        nutrients = _read_csv("food_nutrients_core.csv")
        aliases = _read_csv("food_aliases.csv")
        portions = _read_csv("food_portions.csv")
        recipes = _read_csv("recipes.csv")
        recipe_ingredients = _read_csv("recipe_ingredients.csv")

        nutrients_by_food: dict[str, dict] = defaultdict(dict)
        for row in nutrients:
            nutrients_by_food[row["food_id"]][row["nutrient_code"]] = _to_float(row["amount"])

        aliases_by_food: dict[str, list[dict]] = defaultdict(list)
        for row in aliases:
            aliases_by_food[row["food_id"]].append(row)

        portions_by_food: dict[str, list[dict]] = defaultdict(list)
        for row in portions:
            portions_by_food[row["food_id"]].append(row)

        ingredients_by_recipe: dict[str, list[dict]] = defaultdict(list)
        for row in recipe_ingredients:
            ingredients_by_recipe[row["recipe_food_id"]].append(row)

        with db.write_lock(), db.connect() as c:
            self._load_existing_index(c)

            new_food_rows = []
            new_food_csv_ids = []
            matched_csv_ids = []

            for food in foods:
                csv_id = food["food_id"]
                canonical_name = (food.get("canonical_name") or "").strip()
                if not canonical_name:
                    self.stats["foods_skipped_blank_name"] += 1
                    continue
                norm = _norm(canonical_name)
                existing_id = self.norm_to_food_id.get(norm)
                if existing_id is not None:
                    self.stats["foods_matched_existing"] += 1
                    matched_csv_ids.append(csv_id)
                    continue
                key = self._unique_key(canonical_name, csv_id)
                self.existing_food_keys.add(key)
                self.norm_to_food_id[norm] = -1
                self.food_key_by_csv_id[csv_id] = key
                new_food_rows.append((key, canonical_name, "100g", canonical_name, food.get("primary_source_id"), self.now))
                new_food_csv_ids.append(csv_id)
                self.stats["foods_new"] += 1

            if self.dry_run:
                self._dry_run_recipe_stats(recipes, ingredients_by_recipe, matched_csv_ids, new_food_csv_ids)
                self._print_report(len(foods), len(recipes))
                return

            _bulk_insert(c, "INSERT OR IGNORE INTO gofit_food_entities "
                            "(food_key, display_name, default_unit, source_name, source_code, created_at)",
                         new_food_rows, self.stats, "food_entity_rows_inserted")

            id_by_key: dict[str, int] = {}
            for row in c.execute("SELECT id, food_key FROM gofit_food_entities").fetchall():
                id_by_key[row["food_key"]] = row["id"]
            key_by_id = {v: k for k, v in id_by_key.items()}
            for food in foods:
                csv_id = food["food_id"]
                if csv_id in self.food_key_by_csv_id:
                    continue
                canonical_name = (food.get("canonical_name") or "").strip()
                if not canonical_name:
                    continue
                fid = self.norm_to_food_id.get(_norm(canonical_name))
                if fid and fid in key_by_id:
                    self.food_key_by_csv_id[csv_id] = key_by_id[fid]

            nutrient_rows = []
            for csv_id in new_food_csv_ids:
                fk = self.food_key_by_csv_id.get(csv_id)
                fid = id_by_key.get(fk)
                if not fid:
                    continue
                nut = nutrients_by_food.get(csv_id, {})
                micros = {v: nut[k] for k, v in MICRO_NUTRIENT_MAP.items() if nut.get(k) is not None}
                nutrient_rows.append((
                    fid,
                    nut.get("energy_kcal") or 0,
                    nut.get("protein_g") or 0,
                    nut.get("carb_g") or 0,
                    nut.get("fat_g") or 0,
                    nut.get("fibre_g"),
                    None,
                    nut.get("sodium_mg"),
                    nut.get("potassium_mg"),
                    nut.get("calcium_mg"),
                    nut.get("iron_mg"),
                    json.dumps(micros) if micros else None,
                    self.now,
                ))
            _bulk_insert(c, "INSERT INTO gofit_food_nutrients "
                            "(food_id, kcal_per_unit, protein_g_per_unit, carbs_g_per_unit, fat_g_per_unit, "
                            "fiber_g, sugar_g, sodium_mg, potassium_mg, calcium_mg, iron_mg, micros_json, updated_at)",
                         nutrient_rows, self.stats, "nutrient_rows_inserted")

            for csv_id in matched_csv_ids:
                fk = self.food_key_by_csv_id.get(csv_id)
                fid = id_by_key.get(fk)
                if not fid:
                    continue
                self._enrich_existing(c, fid, nutrients_by_food.get(csv_id, {}))

            alias_rows = []
            portion_rows = []
            for food in foods:
                csv_id = food["food_id"]
                fk = self.food_key_by_csv_id.get(csv_id)
                fid = id_by_key.get(fk)
                if not fid:
                    continue
                canonical_name = (food.get("canonical_name") or "").strip()
                names = [canonical_name] + [r["alias"] for r in aliases_by_food.get(csv_id, [])]
                seen_norms = set()
                for a in names:
                    a = (a or "").strip()
                    n = _norm(a)
                    if not n or n in seen_norms:
                        continue
                    seen_norms.add(n)
                    alias_rows.append((fid, a, n, self.now))

                portion_rows.append((fid, "100g", 100, 1.0))
                for r in portions_by_food.get(csv_id, []):
                    name = (r.get("portion_unit") or r.get("portion_name") or "").strip()
                    if not name or name == "100g":
                        continue
                    mult = _to_float(r.get("portion_value")) or 1.0
                    portion_rows.append((fid, name, None, mult))

            _bulk_insert(c, "INSERT OR IGNORE INTO gofit_food_aliases (food_id, alias_text, alias_norm, created_at)",
                         alias_rows, self.stats, "alias_rows_inserted")
            _bulk_insert(c, "INSERT OR IGNORE INTO gofit_food_portions (food_id, portion_name, grams, unit_multiplier)",
                         portion_rows, self.stats, "portion_rows_inserted")

            self._import_recipes(c, recipes, ingredients_by_recipe)

        self._print_report(len(foods), len(recipes))

    def _enrich_existing(self, c, food_id: int, nut: dict) -> None:
        row = c.execute("SELECT * FROM gofit_food_nutrients WHERE food_id=?", (food_id,)).fetchone()
        if row is None:
            return
        updates = {}
        for code, col in DIRECT_NUTRIENT_MAP.items():
            new_val = nut.get(code)
            if new_val is None:
                continue
            cur_val = row[col] if col in row.keys() else None
            if cur_val is None or cur_val == 0:
                updates[col] = new_val
        if not updates:
            return
        self.stats["foods_enriched_nutrients"] += 1
        set_clause = ", ".join(f"{col}=?" for col in updates)
        c.execute(
            f"UPDATE gofit_food_nutrients SET {set_clause}, updated_at=? WHERE food_id=?",
            (*updates.values(), self.now, food_id),
        )

    def _import_recipes(self, c, recipes: list[dict], ingredients_by_recipe) -> None:
        recipe_rows = []
        recipe_codes = []
        recipe_code_by_csv_id = {}
        for recipe in recipes:
            csv_id = recipe["food_id"]
            food_key = self.food_key_by_csv_id.get(csv_id)
            name = (recipe.get("recipe_name") or "").strip()
            if not food_key:
                self.stats["recipes_skipped_no_food_key"] += 1
                continue
            if not name:
                self.stats["recipes_skipped_blank_name"] += 1
                continue
            recipe_code = (recipe.get("recipe_code") or csv_id).strip()
            recipe_rows.append((recipe_code, name, 1.0, IMPORT_SOURCE_TAG, None, self.now, self.now))
            recipe_codes.append(recipe_code)
            recipe_code_by_csv_id[csv_id] = recipe_code
            self.stats["recipes_imported"] += 1

        for chunk in _chunked(recipe_rows):
            row_ph = "(?,?,?,?,?,?,?)"
            values_sql = ",".join([row_ph] * len(chunk))
            flat = [v for row in chunk for v in row]
            c.execute(
                f"""
                INSERT INTO gofit_recipes (recipe_code, name, servings, source, notes, created_at, updated_at)
                VALUES {values_sql}
                ON CONFLICT(recipe_code) DO UPDATE SET
                    name=excluded.name,
                    servings=excluded.servings,
                    source=excluded.source,
                    updated_at=excluded.updated_at
                """,
                flat,
            )

        if not recipe_codes:
            return
        recipe_id_by_code: dict[str, int] = {}
        for chunk in _chunked(recipe_codes):
            ph = ",".join(["?"] * len(chunk))
            for row in c.execute(
                f"SELECT id, recipe_code FROM gofit_recipes WHERE recipe_code IN ({ph})", chunk
            ).fetchall():
                recipe_id_by_code[row["recipe_code"]] = row["id"]

        recipe_ids = list(recipe_id_by_code.values())
        for chunk in _chunked(recipe_ids):
            ph = ",".join(["?"] * len(chunk))
            c.execute(f"DELETE FROM gofit_recipe_ingredients WHERE recipe_id IN ({ph})", chunk)

        ingredient_rows = []
        for csv_id, recipe_code in recipe_code_by_csv_id.items():
            recipe_id = recipe_id_by_code.get(recipe_code)
            if not recipe_id:
                continue
            position = 0
            for ing in ingredients_by_recipe.get(csv_id, []):
                ing_food_key = self.food_key_by_csv_id.get(ing.get("ingredient_food_id", ""))
                if not ing_food_key:
                    self.stats["recipe_ingredient_lines_skipped"] += 1
                    continue
                qty = _to_float(ing.get("quantity")) or 0
                unit = (ing.get("quantity_unit") or "serving").strip() or "serving"
                ingredient_rows.append((recipe_id, ing_food_key, qty, unit, position, None))
                position += 1
                self.stats["recipe_ingredient_lines_kept"] += 1

        _bulk_insert(c, "INSERT INTO gofit_recipe_ingredients "
                        "(recipe_id, food_key, quantity, quantity_unit, position, notes)",
                     ingredient_rows, self.stats, "recipe_ingredient_rows_inserted")

    def _dry_run_recipe_stats(self, recipes, ingredients_by_recipe, matched_csv_ids, new_food_csv_ids) -> None:
        known_csv_ids = set(matched_csv_ids) | set(new_food_csv_ids)
        for recipe in recipes:
            csv_id = recipe["food_id"]
            name = (recipe.get("recipe_name") or "").strip()
            if csv_id not in known_csv_ids:
                self.stats["recipes_skipped_no_food_key"] += 1
                continue
            if not name:
                self.stats["recipes_skipped_blank_name"] += 1
                continue
            self.stats["recipes_imported"] += 1
            for ing in ingredients_by_recipe.get(csv_id, []):
                ing_csv_id = ing.get("ingredient_food_id", "")
                if ing_csv_id and ing_csv_id in known_csv_ids:
                    self.stats["recipe_ingredient_lines_kept"] += 1
                else:
                    self.stats["recipe_ingredient_lines_skipped"] += 1

    def _print_report(self, n_foods: int, n_recipes: int) -> None:
        mode = "DRY RUN" if self.dry_run else "APPLIED"
        print(f"[{mode}] foods.csv rows: {n_foods}, recipes.csv rows: {n_recipes}")
        for k in sorted(self.stats):
            print(f"  {k}: {self.stats[k]}")


def main() -> None:
    dry_run = "--dry-run" in sys.argv
    food_graph.init_db()
    Importer(dry_run).run()
    if dry_run:
        print("Dry run only -- no writes made. Re-run without --dry-run to apply.")


if __name__ == "__main__":
    main()
