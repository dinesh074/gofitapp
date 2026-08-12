// Budget-protein planner — a curated dataset of everyday Indian foods (tiffins,
// rice/roti bases + cheap protein sides) plus a deterministic generator that
// builds a realistic day plan (or a single meal) hitting a protein target
// within a rupee budget, with enforced variety. India-first, offline, no AI.
// Prices are approximate 2026 retail (₹), per serving.

export type SlotKey = "breakfast" | "lunch" | "snack" | "dinner";
export type Category =
  | "legume" | "dairy" | "soy" | "whole" | "egg" | "meat" // protein sides
  | "tiffin" | "grain"; // meal bases

export type ProteinFood = {
  id: string;
  name: string;
  veg: boolean;
  serving: string; // human label, e.g. "3 pcs", "1 katori"
  protein_g: number; // per serving
  kcal: number; // per serving
  cost: number; // ₹ per serving
  maxServings: number; // realistic daily cap (across the whole day)
  tag: string; // short label for the UI chip
  category: Category; // variety + base/side classification
  slots: SlotKey[]; // meal slots this food realistically fits
};

// A "base" anchors a meal (tiffin or rice/roti); everything else is a protein
// side. Meals are built as base + sides, like a real Indian plate.
export function isBase(f: ProteinFood): boolean {
  return f.category === "tiffin" || f.category === "grain";
}
function isAnimal(f: ProteinFood): boolean {
  return f.category === "egg" || f.category === "meat";
}

export const FOODS: ProteinFood[] = [
  // ---- Bases: tiffins (breakfast) ----
  { id: "idli", name: "Idli (3)", veg: true, serving: "3 pcs + sambar", protein_g: 6, kcal: 210, cost: 25, maxServings: 1, tag: "Tiffin", category: "tiffin", slots: ["breakfast", "dinner"] },
  { id: "dosa", name: "Masala dosa", veg: true, serving: "1 dosa", protein_g: 7, kcal: 330, cost: 45, maxServings: 1, tag: "Tiffin", category: "tiffin", slots: ["breakfast", "dinner"] },
  { id: "poha", name: "Poha", veg: true, serving: "1 plate", protein_g: 5, kcal: 250, cost: 20, maxServings: 1, tag: "Tiffin", category: "tiffin", slots: ["breakfast"] },
  { id: "upma", name: "Upma", veg: true, serving: "1 plate", protein_g: 6, kcal: 250, cost: 20, maxServings: 1, tag: "Tiffin", category: "tiffin", slots: ["breakfast"] },
  { id: "aloo_paratha", name: "Aloo paratha (2)", veg: true, serving: "2 parathas", protein_g: 8, kcal: 360, cost: 30, maxServings: 1, tag: "Tiffin", category: "tiffin", slots: ["breakfast", "dinner"] },
  // ---- Bases: grains (lunch/dinner) ----
  { id: "rice", name: "Steamed rice", veg: true, serving: "1 katori", protein_g: 4, kcal: 200, cost: 12, maxServings: 2, tag: "Base", category: "grain", slots: ["lunch", "dinner"] },
  { id: "roti", name: "Roti / chapati (2)", veg: true, serving: "2 rotis", protein_g: 6, kcal: 160, cost: 12, maxServings: 2, tag: "Base", category: "grain", slots: ["breakfast", "lunch", "dinner"] },
  { id: "curd_rice", name: "Curd rice", veg: true, serving: "1 bowl", protein_g: 7, kcal: 280, cost: 30, maxServings: 1, tag: "Comfort", category: "grain", slots: ["lunch", "snack", "dinner"] },
  { id: "khichdi", name: "Moong khichdi", veg: true, serving: "1 bowl", protein_g: 10, kcal: 300, cost: 30, maxServings: 1, tag: "Comfort", category: "grain", slots: ["lunch", "dinner"] },
  { id: "rajma_chawal", name: "Rajma chawal", veg: true, serving: "1 plate", protein_g: 14, kcal: 400, cost: 50, maxServings: 1, tag: "Combo", category: "grain", slots: ["lunch", "dinner"] },
  // ---- Protein sides: vegetarian ----
  { id: "soya", name: "Soya chunks", veg: true, serving: "30g dry", protein_g: 15, kcal: 105, cost: 8, maxServings: 2, tag: "Best value", category: "soy", slots: ["lunch", "dinner"] },
  { id: "dal", name: "Toor / moong dal", veg: true, serving: "1 katori", protein_g: 9, kcal: 150, cost: 10, maxServings: 2, tag: "Staple", category: "legume", slots: ["lunch", "dinner"] },
  { id: "chana", name: "Kala chana (boiled)", veg: true, serving: "1 katori", protein_g: 10, kcal: 180, cost: 12, maxServings: 2, tag: "Staple", category: "legume", slots: ["lunch", "snack", "dinner"] },
  { id: "paneer", name: "Paneer sabzi", veg: true, serving: "50g", protein_g: 9, kcal: 145, cost: 22, maxServings: 2, tag: "Dairy", category: "dairy", slots: ["breakfast", "lunch", "dinner"] },
  { id: "curd", name: "Curd (dahi)", veg: true, serving: "1 katori", protein_g: 6, kcal: 90, cost: 10, maxServings: 2, tag: "Dairy", category: "dairy", slots: ["breakfast", "lunch", "snack", "dinner"] },
  { id: "milk", name: "Toned milk", veg: true, serving: "1 glass", protein_g: 8, kcal: 120, cost: 14, maxServings: 2, tag: "Dairy", category: "dairy", slots: ["breakfast", "snack"] },
  { id: "peanut", name: "Peanuts / moongphali", veg: true, serving: "30g", protein_g: 8, kcal: 170, cost: 6, maxServings: 1, tag: "Best value", category: "whole", slots: ["snack"] },
  { id: "roasted_chana", name: "Roasted chana", veg: true, serving: "30g", protein_g: 6, kcal: 120, cost: 8, maxServings: 1, tag: "Snack", category: "legume", slots: ["snack"] },
  { id: "sattu", name: "Sattu drink", veg: true, serving: "30g", protein_g: 7, kcal: 110, cost: 7, maxServings: 1, tag: "Best value", category: "legume", slots: ["breakfast", "snack"] },
  { id: "tofu", name: "Tofu bhurji", veg: true, serving: "80g", protein_g: 10, kcal: 120, cost: 20, maxServings: 2, tag: "Dairy-free", category: "soy", slots: ["breakfast", "lunch", "dinner"] },
  { id: "sprouts", name: "Moong sprouts", veg: true, serving: "1 katori", protein_g: 7, kcal: 100, cost: 9, maxServings: 1, tag: "Staple", category: "legume", slots: ["breakfast", "snack"] },
  { id: "besan", name: "Besan chilla (2)", veg: true, serving: "2 chillas", protein_g: 9, kcal: 200, cost: 15, maxServings: 1, tag: "Tiffin", category: "legume", slots: ["breakfast", "dinner"] },
  // ---- Protein sides: non-veg ----
  { id: "egg", name: "Boiled eggs", veg: false, serving: "2 eggs", protein_g: 12, kcal: 155, cost: 14, maxServings: 3, tag: "Best value", category: "egg", slots: ["breakfast", "snack", "dinner"] },
  { id: "eggwhite", name: "Egg whites", veg: false, serving: "3 whites", protein_g: 11, kcal: 51, cost: 21, maxServings: 2, tag: "Lean", category: "egg", slots: ["breakfast", "snack"] },
  { id: "egg_curry", name: "Egg bhurji", veg: false, serving: "2 eggs", protein_g: 13, kcal: 220, cost: 22, maxServings: 1, tag: "Meal", category: "egg", slots: ["breakfast", "dinner"] },
  { id: "chicken", name: "Chicken breast", veg: false, serving: "100g", protein_g: 27, kcal: 165, cost: 45, maxServings: 2, tag: "High protein", category: "meat", slots: ["lunch", "dinner"] },
  { id: "chicken_curry", name: "Chicken curry", veg: false, serving: "2 pieces", protein_g: 20, kcal: 240, cost: 50, maxServings: 1, tag: "Meal", category: "meat", slots: ["lunch", "dinner"] },
  { id: "fish", name: "Fish (rohu)", veg: false, serving: "100g", protein_g: 20, kcal: 140, cost: 40, maxServings: 1, tag: "High protein", category: "meat", slots: ["lunch", "dinner"] },
];

export type PlanItem = { food: ProteinFood; servings: number };

export type MealSlot = {
  key: SlotKey;
  label: string;
  emoji: string;
  items: PlanItem[];
  protein_g: number;
  kcal: number;
  cost: number;
};

export type Plan = {
  slots: MealSlot[];
  items: PlanItem[]; // flattened + aggregated (share card / logging)
  protein_g: number;
  kcal: number;
  cost: number;
  targetProtein: number;
  budget: number;
  metTarget: boolean;
  withinBudget: boolean;
  scope: "day" | SlotKey; // what was planned
};

export type PlanInput = {
  budget: number; // ₹
  targetProtein: number; // g
  veg: boolean; // true = veg only; false = animal protein preferred
  seed?: number; // different seeds → different valid plans
  slot?: SlotKey; // omitted = full day; set = plan only that one meal
};

export function proteinPerRupee(f: ProteinFood): number {
  return f.cost > 0 ? f.protein_g / f.cost : 0;
}

// Small, fast seeded PRNG (mulberry32): reproducible per seed, varied across.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SLOTS: { key: SlotKey; label: string; emoji: string; frac: number; maxItems: number; base: boolean }[] = [
  { key: "breakfast", label: "Breakfast", emoji: "🌅", frac: 0.25, maxItems: 3, base: true },
  { key: "lunch", label: "Lunch", emoji: "🍛", frac: 0.32, maxItems: 3, base: true },
  { key: "snack", label: "Snack", emoji: "🥜", frac: 0.13, maxItems: 2, base: false },
  { key: "dinner", label: "Dinner", emoji: "🍽️", frac: 0.3, maxItems: 3, base: true },
];

type Track = {
  used: Record<string, number>;
  cat: Record<string, number>;
  spent: number;
  animal: number;
  budgetTotal: number;
};

// Scores a candidate. Base scoring is variety/jitter driven; protein sides use
// protein-per-rupee with a strong non-veg boost for animal protein. A large
// jitter (0.5–1.5) makes "Surprise me" produce genuinely different plans.
function pickBest(
  slot: SlotKey,
  t: Track,
  budgetLeft: number,
  nonVeg: boolean,
  rand: () => number,
  kind: "base" | "side"
): ProteinFood | null {
  let best: ProteinFood | null = null;
  let bestScore = -1;
  for (const f of FOODS) {
    if (nonVeg ? false : !f.veg) continue; // veg mode excludes non-veg
    if (!f.slots.includes(slot)) continue;
    if (kind === "base" ? !isBase(f) : isBase(f)) continue;
    if ((t.used[f.id] ?? 0) >= f.maxServings) continue;
    if (f.cost > budgetLeft) continue;

    let score = kind === "base" ? 1 : proteinPerRupee(f);
    if (kind === "side" && nonVeg) {
      if (isAnimal(f)) score *= 3;
      else score *= t.animal >= 2 ? 0.9 : 0.35;
    }
    if (t.used[f.id]) score *= 0.3; // discourage repeating the same food
    score *= Math.pow(0.7, t.cat[f.category] ?? 0); // spread categories
    score *= 0.5 + rand(); // shuffle jitter (0.5–1.5)
    if (score > bestScore) {
      bestScore = score;
      best = f;
    }
  }
  return best;
}

function addServing(counts: Record<string, number>, t: Track, f: ProteinFood) {
  counts[f.id] = (counts[f.id] ?? 0) + 1;
  t.used[f.id] = (t.used[f.id] ?? 0) + 1;
  t.cat[f.category] = (t.cat[f.category] ?? 0) + 1;
  if (isAnimal(f)) t.animal += 1;
  t.spent += f.cost;
}

// Fills one meal: one base (if the slot uses bases) + protein sides toward the
// slot's protein target, within its budget and item cap.
function fillSlot(
  cfg: { key: SlotKey; label: string; emoji: string; maxItems: number; base: boolean },
  target: number,
  slotBudget: number,
  t: Track,
  nonVeg: boolean,
  rand: () => number
): { counts: Record<string, number>; protein: number; cost: number } {
  const counts: Record<string, number> = {};
  let protein = 0, cost = 0, items = 0;
  const globalLeft = () => t.budgetTotal - t.spent;

  if (cfg.base) {
    const bf = pickBest(cfg.key, t, Math.min(slotBudget, globalLeft()), nonVeg, rand, "base");
    if (bf) {
      addServing(counts, t, bf);
      protein += bf.protein_g;
      cost += bf.cost;
      items += 1;
    }
  }

  while (protein < target && items < cfg.maxItems) {
    const left = Math.min(slotBudget - cost, globalLeft());
    const f = pickBest(cfg.key, t, left, nonVeg, rand, "side");
    if (!f) break;
    addServing(counts, t, f);
    protein += f.protein_g;
    cost += f.cost;
    items += 1;
  }

  return { counts, protein, cost };
}

export function generatePlan({ budget, targetProtein, veg, seed, slot }: PlanInput): Plan {
  const nonVeg = !veg;
  const rand = seed == null ? () => 0.5 : mulberry32(seed);
  const t: Track = { used: {}, cat: {}, spent: 0, animal: 0, budgetTotal: budget };

  const cfgs = slot ? SLOTS.filter((s) => s.key === slot) : SLOTS;
  const slotCounts: Record<string, Record<string, number>> = {};

  if (slot) {
    // Single-meal mode: whole budget + target on one meal, a few more items.
    const cfg = { ...cfgs[0], maxItems: cfgs[0].key === "snack" ? 3 : 4 };
    const r = fillSlot(cfg, targetProtein, budget, t, nonVeg, rand);
    slotCounts[cfg.key] = r.counts;
  } else {
    let carry = 0;
    for (const cfg of SLOTS) {
      const r = fillSlot(cfg, targetProtein * cfg.frac, budget * cfg.frac + carry, t, nonVeg, rand);
      slotCounts[cfg.key] = r.counts;
      carry = Math.max(0, budget * cfg.frac + carry - r.cost);
    }
    // Top-up: close any remaining protein gap into the leanest eligible slot.
    const slotProtein = (k: SlotKey) =>
      Object.keys(slotCounts[k]).reduce((s, id) => s + food(id).protein_g * slotCounts[k][id], 0);
    const slotItems = (k: SlotKey) => Object.values(slotCounts[k]).reduce((s, n) => s + n, 0);
    let guard = 0;
    let total = SLOTS.reduce((s, c) => s + slotProtein(c.key), 0);
    while (total < targetProtein && guard < 100) {
      guard += 1;
      let bestF: ProteinFood | null = null, bestK: SlotKey | null = null, bestScore = -1;
      for (const cfg of SLOTS) {
        if (slotItems(cfg.key) >= cfg.maxItems + 1) continue;
        const f = pickBest(cfg.key, t, budget - t.spent, nonVeg, rand, "side");
        if (!f) continue;
        const score = proteinPerRupee(f) * (1 / (1 + slotProtein(cfg.key)));
        if (score > bestScore) { bestScore = score; bestF = f; bestK = cfg.key; }
      }
      if (!bestF || !bestK) break;
      addServing(slotCounts[bestK], t, bestF);
      total = SLOTS.reduce((s, c) => s + slotProtein(c.key), 0);
    }
  }

  const slots: MealSlot[] = cfgs
    .map((cfg) => buildSlot(cfg, slotCounts[cfg.key] ?? {}))
    .filter((s) => s.items.length > 0);

  const agg: Record<string, number> = {};
  for (const s of slots) for (const it of s.items) agg[it.food.id] = (agg[it.food.id] ?? 0) + it.servings;
  const items: PlanItem[] = Object.keys(agg)
    .map((id) => ({ food: food(id), servings: agg[id] }))
    .sort((a, b) => b.servings * b.food.protein_g - a.servings * a.food.protein_g);

  const protein_g = slots.reduce((s, x) => s + x.protein_g, 0);
  const kcal = slots.reduce((s, x) => s + x.kcal, 0);
  const cost = slots.reduce((s, x) => s + x.cost, 0);

  return {
    slots,
    items,
    protein_g,
    kcal,
    cost,
    targetProtein,
    budget,
    metTarget: protein_g >= targetProtein,
    withinBudget: cost <= budget,
    scope: slot ?? "day",
  };
}

function food(id: string): ProteinFood {
  return FOODS.find((f) => f.id === id)!;
}

function buildSlot(
  cfg: { key: SlotKey; label: string; emoji: string },
  counts: Record<string, number>
): MealSlot {
  let protein = 0, kcal = 0, cost = 0;
  const items: PlanItem[] = Object.keys(counts).map((id) => {
    const f = food(id);
    protein += f.protein_g * counts[id];
    kcal += f.kcal * counts[id];
    cost += f.cost * counts[id];
    return { food: f, servings: counts[id] };
  });
  // Show the base first, then protein sides.
  items.sort((a, b) => (isBase(b.food) ? 1 : 0) - (isBase(a.food) ? 1 : 0));
  return { key: cfg.key, label: cfg.label, emoji: cfg.emoji, items, protein_g: protein, kcal, cost };
}

export type Preset = { id: string; label: string; budget: number; veg: boolean; note: string };

export const PRESETS: Preset[] = [
  { id: "student-veg", label: "Student · Veg", budget: 120, veg: true, note: "₹120/day vegetarian" },
  { id: "student-nonveg", label: "Student · Non-veg", budget: 160, veg: false, note: "₹160/day with eggs" },
  { id: "max-veg", label: "Max protein · Veg", budget: 200, veg: true, note: "₹200/day, protein-first" },
  { id: "lean-nonveg", label: "Lean · Non-veg", budget: 260, veg: false, note: "₹260/day, chicken/fish" },
];

export const MEAL_MODES: { key: "day" | SlotKey; label: string }[] = [
  { key: "day", label: "Full day" },
  { key: "breakfast", label: "Breakfast" },
  { key: "lunch", label: "Lunch" },
  { key: "snack", label: "Snack" },
  { key: "dinner", label: "Dinner" },
];
