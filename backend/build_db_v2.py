"""
One-off script: builds indian_food_db.json (schema v2) by enriching the 24
hand-curated dishes with real micronutrient data from INDB, and converting the
rest of INDB into the same schema. Run once, review the output, re-run safely
(it always starts from indian_food_db.backup_before_v2.json, never from its
own prior output). Requires INDB.xlsx at INDB_XLSX_PATH below.

Health score & benefits/watch_outs are COMPUTED by this app with a disclosed
formula (see health_score() below) -- not an official rating, not medical
advice. Base 50, then per 100g: +up to 20 for protein density, +up to 15 for
fiber, -up to 20 for saturated fat, -up to 20 for free sugar, -up to 15 for
sodium above a 400mg/100g baseline. Clamped to [0, 100].
"""
import json
import re
import os
import pandas as pd

BACKEND = os.path.dirname(os.path.abspath(__file__))
INDB_XLSX_PATH = r"C:\Users\BMANIK~1\AppData\Local\Temp\indb\INDB.xlsx"

df = pd.read_excel(INDB_XLSX_PATH, sheet_name="Nutrient Data")


def norm(s):
    return re.sub(r"[^a-z ]", "", str(s).lower()).strip()


df["_norm_name"] = df["food_name"].apply(lambda n: norm(str(n).split("(")[0]))


def find_indb_match(aliases):
    for a in aliases:
        na = norm(a)
        exact = df[df["_norm_name"] == na]
        if len(exact):
            return exact.iloc[0]
    for a in aliases:
        na = norm(a)
        if not na:
            continue
        sub = df[df["_norm_name"].str.contains(r"\b" + re.escape(na) + r"\b", regex=True, na=False)]
        if len(sub):
            return sub.iloc[0]
    return None


def health_score(kcal100, protein100, fibre100, sfa_mg100, sugar100, sodium_mg100):
    if not kcal100 or kcal100 <= 0:
        return None
    score = 50.0
    score += min(20.0, (protein100 / kcal100 * 100.0) * 1.0)
    if fibre100 is not None:
        score += min(15.0, fibre100 * 2.0)
    if sfa_mg100 is not None:
        score -= min(20.0, (sfa_mg100 / 1000.0) * 1.5)
    if sugar100 is not None:
        score -= min(20.0, sugar100 * 1.0)
    if sodium_mg100 is not None:
        score -= min(15.0, max(0.0, (sodium_mg100 - 400.0) / 100.0))
    return round(max(0.0, min(100.0, score)), 1)


def benefits_watchouts(protein, fibre, iron, calcium, fat, sfa_mg, sugar, sodium_mg, kcal):
    b, w = [], []
    if protein is not None:
        if protein >= 15:
            b.append("High protein")
        elif protein >= 8:
            b.append("Good source of protein")
    if fibre is not None:
        if fibre >= 5:
            b.append("High in fiber")
        elif fibre >= 3:
            b.append("Good source of fiber")
    if iron is not None and iron >= 3:
        b.append("Good source of iron")
    if calcium is not None and calcium >= 200:
        b.append("Good source of calcium")
    if fat is not None and fat <= 3 and (kcal or 0) < 300:
        b.append("Low fat")
    if sfa_mg is not None and sfa_mg >= 5000:
        w.append("High in saturated fat")
    if sugar is not None and sugar >= 15:
        w.append("High in added sugar")
    if sodium_mg is not None and sodium_mg >= 600:
        w.append("High in sodium")
    if fat is not None and fat >= 20:
        w.append("High in fat")
    if kcal is not None and kcal >= 500:
        w.append("Calorie-dense - mind your portion")
    return b, w


def g(row, col):
    if row is None:
        return None
    v = row.get(col)
    return None if (v is None or pd.isna(v)) else float(v)


# Full micronutrient panel -- "all the minute details" beyond the headline
# macros. Kept in a nested `micros` object so the top-level schema stays
# simple for the app's main display. (col_in_INDB, friendly_key, decimals)
MICRO_COLS = [
    ("sfa_mg", "saturated_fat_mg", 0), ("mufa_mg", "monounsaturated_fat_mg", 0),
    ("pufa_mg", "polyunsaturated_fat_mg", 0), ("cholesterol_mg", "cholesterol_mg", 1),
    ("calcium_mg", "calcium_mg", 1), ("phosphorus_mg", "phosphorus_mg", 1),
    ("magnesium_mg", "magnesium_mg", 1), ("sodium_mg", "sodium_mg", 1),
    ("potassium_mg", "potassium_mg", 1), ("iron_mg", "iron_mg", 2),
    ("copper_mg", "copper_mg", 3), ("selenium_ug", "selenium_ug", 2),
    ("chromium_mg", "chromium_mg", 4), ("manganese_mg", "manganese_mg", 3),
    ("molybdenum_mg", "molybdenum_mg", 4), ("zinc_mg", "zinc_mg", 2),
    ("vita_ug", "vitamin_a_ug", 1), ("vite_mg", "vitamin_e_mg", 2),
    ("vitd2_ug", "vitamin_d2_ug", 2), ("vitd3_ug", "vitamin_d3_ug", 2),
    ("vitk1_ug", "vitamin_k1_ug", 2), ("vitk2_ug", "vitamin_k2_ug", 2),
    ("folate_ug", "folate_ug", 1), ("vitb1_mg", "vitamin_b1_thiamine_mg", 2),
    ("vitb2_mg", "vitamin_b2_riboflavin_mg", 2), ("vitb3_mg", "vitamin_b3_niacin_mg", 2),
    ("vitb5_mg", "vitamin_b5_pantothenic_mg", 2), ("vitb6_mg", "vitamin_b6_mg", 2),
    ("vitb7_ug", "vitamin_b7_biotin_ug", 2), ("vitb9_ug", "vitamin_b9_ug", 1),
    ("vitc_mg", "vitamin_c_mg", 1), ("carotenoids_ug", "carotenoids_ug", 1),
]


def full_micros_per100(row):
    """Raw per-100g values for every micronutrient column INDB has, as a dict
    keyed by friendly name. None values are omitted rather than zero-filled."""
    out = {}
    for col, key, dec in MICRO_COLS:
        v = g(row, col)
        if v is not None:
            out[key] = round(v, dec)
    return out


_MICRO_DECIMALS = {key: dec for _, key, dec in MICRO_COLS}


def scale_micros(micros100, ratio):
    return {k: round(v * ratio, _MICRO_DECIMALS.get(k, 2)) for k, v in micros100.items()}


def full_micros_per_serving(row):
    """Same panel, but read directly from INDB's own unit_serving_* columns
    (used for the 815 INDB-derived entries, which already have a defined
    serving -- no cross-dish ratio scaling needed, unlike the curated 24)."""
    out = {}
    for col, key, dec in MICRO_COLS:
        v = g(row, "unit_serving_" + col)
        if v is not None:
            out[key] = round(v, dec)
    return out


# ---- 1) Enrich the curated 24 ----
with open(os.path.join(BACKEND, "indian_food_db.backup_before_v2.json"), encoding="utf-8") as f:
    curated = json.load(f)["foods"]

enriched_curated = []
matched_ct = 0
for food in curated:
    row = find_indb_match(food["aliases"] + [food["key"].replace("_", " ")])
    out = dict(food)
    if row is not None:
        matched_ct += 1
        k100, p100, f100 = g(row, "energy_kcal"), g(row, "protein_g"), g(row, "fibre_g")
        sfa100, sug100, sod100 = g(row, "sfa_mg"), g(row, "freesugar_g"), g(row, "sodium_mg")
        pot100, cal100, iron100 = g(row, "potassium_mg"), g(row, "calcium_mg"), g(row, "iron_mg")
        ratio = (food["kcal_per_unit"] / k100) if k100 else 0
        fiber_s = round(f100 * ratio, 1) if f100 is not None else None
        sugar_s = round(sug100 * ratio, 1) if sug100 is not None else None
        sodium_s = round(sod100 * ratio, 1) if sod100 is not None else None
        potassium_s = round(pot100 * ratio, 1) if pot100 is not None else None
        calcium_s = round(cal100 * ratio, 1) if cal100 is not None else None
        iron_s = round(iron100 * ratio, 2) if iron100 is not None else None
        sfa_s = round(sfa100 * ratio, 0) if sfa100 is not None else None
        out.update({
            "fiber_g": fiber_s, "sugar_g": sugar_s, "sodium_mg": sodium_s,
            "potassium_mg": potassium_s, "calcium_mg": calcium_s, "iron_mg": iron_s,
        })
        micros100 = full_micros_per100(row)
        if micros100:
            out["micros"] = scale_micros(micros100, ratio)
        hs = health_score(k100, p100, f100, sfa100, sug100, sod100)
        if hs is not None:
            out["health_score"] = hs
        bw = benefits_watchouts(food["protein_g"], fiber_s, iron_s, calcium_s, food["fat_g"], sfa_s, sugar_s, sodium_s, food["kcal_per_unit"])
        if bw[0]:
            out["benefits"] = bw[0]
        if bw[1]:
            out["watch_outs"] = bw[1]
        out["_micro_source"] = "INDB (matched: " + str(row["food_name"]) + ")"
    enriched_curated.append(out)

print("Curated 24: matched {}/{} against INDB for micronutrient enrichment".format(matched_ct, len(curated)))

# ---- 2) Build the INDB-derived entries with the same extra fields ----
BAD_UNITS = {None, "gm", "g", "ml", "nan"}


def slugify(name):
    base = re.sub(r"\([^)]*\)", "", name)
    base = re.sub(r"[^a-z0-9]+", "_", base.lower()).strip("_")
    return base[:40]


def extract_alias(name):
    m = re.search(r"\(([^)]*)\)", name)
    return m.group(1).strip() if m else None


curated_alias_set = {a.lower() for food in curated for a in food["aliases"]}

converted = []
for _, r in df.iterrows():
    unit = r["servings_unit"]
    if pd.isna(unit) or str(unit).strip().lower() in BAD_UNITS:
        continue
    kcal = g(r, "unit_serving_energy_kcal")
    protein = g(r, "unit_serving_protein_g") or 0
    carb = g(r, "unit_serving_carb_g") or 0
    fat = g(r, "unit_serving_fat_g") or 0
    if kcal is None or kcal <= 0:
        continue
    macro_kcal = protein * 4 + carb * 4 + fat * 9
    ratio = (macro_kcal / kcal) if kcal else 0
    if kcal > 1500 or ratio > 3 or ratio < 0.3:
        continue
    name = str(r["food_name"]).strip()
    base_alias = name.split("(")[0].strip().lower()
    if base_alias in curated_alias_set:
        continue
    alias = extract_alias(name)
    aliases = [base_alias] + ([alias.lower()] if alias else [])

    fiber_s = g(r, "unit_serving_fibre_g")
    sugar_s = g(r, "unit_serving_freesugar_g")
    sodium_s = g(r, "unit_serving_sodium_mg")
    potassium_s = g(r, "unit_serving_potassium_mg")
    calcium_s = g(r, "unit_serving_calcium_mg")
    iron_s = g(r, "unit_serving_iron_mg")
    sfa_s = g(r, "unit_serving_sfa_mg")

    entry = {
        "key": slugify(name), "unit": str(unit).strip(),
        "kcal_per_unit": round(kcal), "protein_g": round(protein, 1),
        "carbs_g": round(carb, 1), "fat_g": round(fat, 1),
        "aliases": aliases,
    }
    if fiber_s is not None:
        entry["fiber_g"] = round(fiber_s, 1)
    if sugar_s is not None:
        entry["sugar_g"] = round(sugar_s, 1)
    if sodium_s is not None:
        entry["sodium_mg"] = round(sodium_s, 1)
    if potassium_s is not None:
        entry["potassium_mg"] = round(potassium_s, 1)
    if calcium_s is not None:
        entry["calcium_mg"] = round(calcium_s, 1)
    if iron_s is not None:
        entry["iron_mg"] = round(iron_s, 2)
    micros_s = full_micros_per_serving(r)
    if micros_s:
        entry["micros"] = micros_s

    hs = health_score(g(r, "energy_kcal"), g(r, "protein_g"), g(r, "fibre_g"), g(r, "sfa_mg"), g(r, "freesugar_g"), g(r, "sodium_mg"))
    if hs is not None:
        entry["health_score"] = hs
    bw = benefits_watchouts(protein, fiber_s, iron_s, calcium_s, fat, sfa_s, sugar_s, sodium_s, kcal)
    if bw[0]:
        entry["benefits"] = bw[0]
    if bw[1]:
        entry["watch_outs"] = bw[1]
    entry["_source_name"] = name
    entry["_source"] = "INDB"
    converted.append(entry)

from collections import Counter
keys = Counter(e["key"] for e in converted)
seen = Counter()
for e in converted:
    if keys[e["key"]] > 1:
        extra = e["_source_name"].split("(")[-1].replace(")", "") if "(" in e["_source_name"] else ""
        slug = re.sub(r"[^a-z0-9]+", "_", extra.lower()).strip("_")[:20]
        seen[e["key"]] += 1
        e["key"] = "{}_{}".format(e["key"], slug) if slug else "{}_{}".format(e["key"], seen[e["key"]])

print("INDB-derived entries after excluding curated overlaps + dedup: {}".format(len(converted)))

final = {
    "_note": (
        "v2 schema. Core fields (kcal_per_unit/protein_g/carbs_g/fat_g) for the "
        "original 24 dishes remain hand-curated & validated via test_food_v2.py "
        "count-correction testing -- unchanged from v1. All other fields "
        "(fiber_g/sugar_g/sodium_mg/potassium_mg/calcium_mg/iron_mg) are real "
        "values sourced from the Indian Nutrient Databank (INDB, Anuvaad "
        "Solutions, built from ICMR-NIN IFCT/USDA/UK PHE data) -- see "
        "indb_full_1014.json for full provenance and the complete micronutrient "
        "panel (vitamins, minerals) per dish. "
        "'health_score' (0-100) and 'benefits'/'watch_outs' are COMPUTED by this "
        "app using a simple disclosed formula (see build_db_v2.py) -- they are "
        "NOT an official rating and NOT medical advice. Formula: base 50, +up to "
        "20 for protein density, +up to 15 for fiber, -up to 20 for saturated "
        "fat, -up to 20 for free sugar, -up to 15 for sodium above 400mg/100g, "
        "all computed per 100g for fair comparison across dishes."
    ),
    "_schema_version": 2,
    "foods": enriched_curated + converted,
}

out_path = os.path.join(BACKEND, "indian_food_db.json")
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(final, f, ensure_ascii=False, indent=1)

print("\nWrote {}".format(out_path))
print("Total foods: {} ({} curated + {} INDB-derived)".format(len(final["foods"]), len(enriched_curated), len(converted)))
