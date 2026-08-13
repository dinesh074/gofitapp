// Deep micronutrient tracking (v1).
//
// Cal AI-style trackers are widely criticised for shallow or missing
// micronutrient data. gofit already pulls a full vitamin/mineral panel for any
// food matched to our database (see NutritionDetails.tsx); this module rolls
// that up to a *daily* view -- fibre, iron, calcium, potassium, vitamin C, plus
// the two you want to keep DOWN (sodium, sugar) -- and compares it against
// India-first reference intakes.
//
// Honesty matters here: micronutrients are only known for foods matched to our
// database (barcode / DB swaps). A plate the AI estimated from a photo has
// calories + macros but no reliable micro panel, so the daily totals are a
// *floor* ("at least this much from tracked foods"), not a full accounting. The
// UI says so rather than pretending otherwise.

import type { FoodItem } from "./api";
import type { LogMap } from "./storage";

export type MicroKind = "reach" | "limit";

export type MicroRef = {
  key: string;
  label: string;
  unit: string;
  target: number; // daily reference intake (reach) or ceiling (limit)
  kind: MicroKind;
  note?: string;
};

// Reference daily intakes. Reach targets follow ICMR-NIN 2020 RDA / EAR
// midpoints for an adult; limits follow WHO guidance. These are population
// references for a healthy adult, NOT personal medical targets.
export const MICRO_REFS: MicroRef[] = [
  { key: "fiber_g", label: "Fibre", unit: "g", target: 30, kind: "reach" },
  { key: "iron_mg", label: "Iron", unit: "mg", target: 17, kind: "reach" },
  { key: "calcium_mg", label: "Calcium", unit: "mg", target: 1000, kind: "reach" },
  { key: "potassium_mg", label: "Potassium", unit: "mg", target: 3500, kind: "reach" },
  { key: "vitamin_c_mg", label: "Vitamin C", unit: "mg", target: 80, kind: "reach" },
  { key: "sodium_mg", label: "Sodium", unit: "mg", target: 2000, kind: "limit", note: "keep under" },
  { key: "sugar_g", label: "Sugar", unit: "g", target: 30, kind: "limit", note: "keep under" },
];

// Serving-level value of one tracked nutrient for one item. Prefer the explicit
// top-level field (canonical, always serving-scaled) and fall back to the fuller
// `micros` panel so we never double-count a nutrient that lives in both.
function itemNutrient(item: FoodItem, key: string): number | undefined {
  const top = (item as unknown as Record<string, number | undefined>)[key];
  if (typeof top === "number" && Number.isFinite(top)) return top;
  const m = item.micros?.[key];
  if (typeof m === "number" && Number.isFinite(m)) return m;
  return undefined;
}

// Sum the tracked micronutrients across a scanned meal's items. Returns a flat
// map (only keys that at least one item actually reported) that can be stored on
// the logged Meal and re-summed per day later. `hasData` is false when NONE of
// the items carried any micro data (a pure-AI photo estimate).
export function sumMealMicros(items: FoodItem[]): { micros: Record<string, number>; hasData: boolean } {
  const out: Record<string, number> = {};
  let hasData = false;
  for (const ref of MICRO_REFS) {
    let total = 0;
    let seen = false;
    for (const it of items) {
      const v = itemNutrient(it, ref.key);
      if (v !== undefined) {
        total += v;
        seen = true;
      }
    }
    if (seen) {
      out[ref.key] = Math.round(total * 100) / 100;
      hasData = true;
    }
  }
  return { micros: out, hasData };
}

export type MicroRow = {
  key: string;
  label: string;
  unit: string;
  have: number;
  target: number;
  kind: MicroKind;
  pct: number; // 0..100+ (of target)
  state: "low" | "ok" | "high"; // color state (semantics depend on kind)
  note?: string;
};

function displayValue(v: number): number {
  return v >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
}

// Roll up a day's logged meals into per-nutrient rows vs reference targets.
// `tracked` = meals that carried micro data; `total` = all meals that day, so
// the UI can be honest about coverage ("from 2 of 4 logged meals").
export function dayMicros(
  logs: LogMap,
  date: string,
): { rows: MicroRow[]; trackedMeals: number; totalMeals: number } {
  const meals = logs[date]?.meals ?? [];
  const totals: Record<string, number> = {};
  let trackedMeals = 0;
  for (const m of meals) {
    if (m.micros && Object.keys(m.micros).length) {
      trackedMeals += 1;
      for (const [k, v] of Object.entries(m.micros)) {
        if (typeof v === "number" && Number.isFinite(v)) totals[k] = (totals[k] ?? 0) + v;
      }
    }
  }

  const rows: MicroRow[] = MICRO_REFS.map((ref) => {
    const have = totals[ref.key] ?? 0;
    const pct = ref.target > 0 ? (have / ref.target) * 100 : 0;
    let state: MicroRow["state"];
    if (ref.kind === "limit") {
      // For sodium/sugar: under is good, near/over the ceiling is bad.
      state = pct >= 100 ? "high" : pct >= 75 ? "ok" : "low";
    } else {
      // For reach nutrients: hitting the target is good, well short is a gap.
      state = pct >= 90 ? "ok" : pct >= 50 ? "low" : "high";
    }
    return {
      key: ref.key,
      label: ref.label,
      unit: ref.unit,
      have: displayValue(have),
      target: ref.target,
      kind: ref.kind,
      pct: Math.round(pct),
      state,
      note: ref.note,
    };
  });

  return { rows, trackedMeals, totalMeals: meals.length };
}
