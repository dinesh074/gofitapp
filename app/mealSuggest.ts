// "What should I eat next?" — a deterministic, on-device suggester.
//
// It looks at what's left in the user's daily budget (calories + each macro),
// the time of day, their diet, and their goal, then recommends a single
// India-first next meal plus the macro "focus" behind it. No AI call, no scan
// credit, works offline. This is guidance, not medical advice.

import type { Diet, Goal, GoalTargets, Profile } from "./nutrition";
import { biasFor, trainingMeta, TrainingBias, TrainingContext } from "./training";

export type MealSlot = "breakfast" | "snack" | "lunch" | "dinner";

// What a dish is allowed to contain, so we can respect the user's diet.
//  - "veg": no egg/meat/fish (safe for veg/vegan/jain/sattvic in this v1)
//  - "egg": vegetarian + egg (eggetarian and non-veg)
//  - "nonveg": contains meat/fish (non-veg only)
type Contains = "veg" | "egg" | "nonveg";

type Idea = {
  name: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  slots: MealSlot[];
  contains: Contains;
};

// A compact, India-first idea set spread across meal slots and macro profiles.
// Numbers are rough home-portion estimates -- enough to rank ideas, not to log.
const IDEAS: Idea[] = [
  // --- High-protein anchors ---
  { name: "Egg bhurji + 2 rotis + curd", kcal: 520, protein: 30, carbs: 48, fat: 22, slots: ["breakfast", "lunch", "dinner"], contains: "egg" },
  { name: "3 boiled eggs + fruit", kcal: 300, protein: 20, carbs: 20, fat: 15, slots: ["breakfast", "snack"], contains: "egg" },
  { name: "Grilled chicken + salad", kcal: 380, protein: 42, carbs: 12, fat: 16, slots: ["lunch", "dinner"], contains: "nonveg" },
  { name: "Chicken curry + 1 roti", kcal: 480, protein: 38, carbs: 32, fat: 22, slots: ["lunch", "dinner"], contains: "nonveg" },
  { name: "Fish curry + rice", kcal: 500, protein: 34, carbs: 55, fat: 14, slots: ["lunch", "dinner"], contains: "nonveg" },
  { name: "Paneer bhurji + 2 rotis", kcal: 520, protein: 26, carbs: 46, fat: 26, slots: ["lunch", "dinner"], contains: "veg" },
  { name: "Moong dal chilla + curd", kcal: 360, protein: 22, carbs: 44, fat: 10, slots: ["breakfast", "lunch"], contains: "veg" },
  { name: "Rajma + small rice", kcal: 460, protein: 20, carbs: 70, fat: 10, slots: ["lunch", "dinner"], contains: "veg" },
  { name: "Chana chaat", kcal: 300, protein: 15, carbs: 42, fat: 8, slots: ["snack", "lunch"], contains: "veg" },
  { name: "Sprouts salad", kcal: 220, protein: 14, carbs: 32, fat: 4, slots: ["snack", "breakfast"], contains: "veg" },
  { name: "Greek curd + peanuts", kcal: 260, protein: 18, carbs: 14, fat: 14, slots: ["snack", "breakfast"], contains: "veg" },
  { name: "Tofu bhurji + 2 rotis", kcal: 480, protein: 24, carbs: 46, fat: 20, slots: ["lunch", "dinner"], contains: "veg" },

  // --- Balanced plates ---
  { name: "Dal + rice + sabzi", kcal: 520, protein: 18, carbs: 82, fat: 12, slots: ["lunch", "dinner"], contains: "veg" },
  { name: "2 rotis + dal + curd", kcal: 450, protein: 20, carbs: 62, fat: 12, slots: ["lunch", "dinner"], contains: "veg" },
  { name: "Veg pulao + raita", kcal: 480, protein: 12, carbs: 74, fat: 14, slots: ["lunch", "dinner"], contains: "veg" },
  { name: "Idli (3) + sambar", kcal: 320, protein: 12, carbs: 58, fat: 5, slots: ["breakfast", "snack"], contains: "veg" },
  { name: "Poha + peanuts", kcal: 350, protein: 8, carbs: 58, fat: 10, slots: ["breakfast", "snack"], contains: "veg" },
  { name: "Vegetable oats", kcal: 300, protein: 10, carbs: 48, fat: 8, slots: ["breakfast"], contains: "veg" },

  // --- Carb-forward (good pre-training / gaining) ---
  { name: "Banana + peanut butter toast", kcal: 380, protein: 12, carbs: 52, fat: 14, slots: ["breakfast", "snack"], contains: "veg" },
  { name: "Aloo paratha + curd", kcal: 520, protein: 12, carbs: 66, fat: 22, slots: ["breakfast", "lunch"], contains: "veg" },

  // --- Light / low-calorie fillers ---
  { name: "Cucumber + chaas", kcal: 90, protein: 5, carbs: 10, fat: 3, slots: ["snack"], contains: "veg" },
  { name: "Fruit bowl", kcal: 120, protein: 2, carbs: 28, fat: 1, slots: ["snack", "breakfast"], contains: "veg" },
  { name: "Roasted chana", kcal: 180, protein: 10, carbs: 26, fat: 4, slots: ["snack"], contains: "veg" },
  { name: "Vegetable soup", kcal: 130, protein: 6, carbs: 18, fat: 4, slots: ["snack", "dinner"], contains: "veg" },
];

export type MealSuggestion = {
  headline: string;
  focus: string[];
  idea: string | null;
  rationale: string;
  kcal: number;
  // Where the winning idea came from, so the UI can add a personal touch
  // ("From your favourites") and we can tell real data apart from the fallback.
  source?: MealSource;
  detail?: string; // optional serving note for a single DB food, e.g. "1 katori"
};

// A single thing we could suggest eating next. Static ideas, the user's own
// recent/favourite meals, and real food-DB rows are all normalised to this
// shape so one scorer ranks them together.
export type MealSource = "idea" | "recent" | "favorite" | "db";
export type Candidate = {
  name: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  slots: MealSlot[];
  contains: Contains;
  source: MealSource;
  boost?: number; // personalization nudge (favourites/recency)
  detail?: string;
};

const ALL_SLOTS: MealSlot[] = ["breakfast", "snack", "lunch", "dinner"];

// Static ideas as candidates -- the always-available offline fallback pool.
export const BASE_CANDIDATES: Candidate[] = IDEAS.map((i) => ({
  name: i.name,
  kcal: i.kcal,
  protein: i.protein,
  carbs: i.carbs,
  fat: i.fat,
  slots: i.slots,
  contains: i.contains,
  source: "idea",
}));

function slotForHour(hour: number): MealSlot {
  if (hour >= 5 && hour < 10) return "breakfast";
  if (hour >= 12 && hour < 15) return "lunch";
  if (hour >= 18 && hour < 23) return "dinner";
  return "snack";
}

// The one-word focus label for today's training context (e.g. "Carb-load"),
// surfaced first in the meal card's focus chips when a context is set.
function trainingMetaFocus(ctx: TrainingContext): string {
  return trainingMeta(ctx).bias.focus;
}

function dietAllows(diet: Diet, contains: Contains): boolean {
  if (contains === "nonveg") return diet === "nonveg";
  if (contains === "egg") return diet === "nonveg" || diet === "eggetarian";
  // veg dishes are fine for everyone (vegan/jain/sattvic treated as veg in v1)
  return true;
}

// Turn a "remaining / goal" ratio into a human focus label for one macro.
// Protein and carbs can be encouraged ("High"); fat is never encouraged -- we
// only ever flag it as "Low added fat" once most of the day's fat is used up.
function macroFocus(kind: "protein" | "carbs" | "fat", remaining: number, goal: number): string | null {
  if (goal <= 0) return null;
  const share = remaining / goal;
  if (kind === "fat") {
    return share < 0.2 ? "Low added fat" : null;
  }
  if (share >= 0.45) return `High ${kind}`;
  if (share >= 0.15) return `Moderate ${kind}`;
  return `Low ${kind}`;
}

// Is this candidate allowed for the user's diet? The user's own recent/favourite
// meals are always allowed (they logged them); everything else is gated on its
// `contains` tag.
function allowedForDiet(diet: Diet, c: Candidate): boolean {
  if (c.source === "recent" || c.source === "favorite") return true;
  return dietAllows(diet, c.contains);
}

/**
 * Core scorer: rank a candidate pool against what's left in the day's budget,
 * the time of day, diet, goal and today's training context, and return the best
 * suggestion. `suggestNextMeal` and the DB/recents-enriched path both funnel
 * through here so ranking is always identical.
 */
export function computeSuggestion(
  consumed: { kcal: number; protein_g: number; carbs_g: number; fat_g: number },
  goal: GoalTargets,
  profile: Pick<Profile, "diet" | "goal">,
  now: Date,
  training: TrainingContext | null,
  candidates: Candidate[],
): MealSuggestion {
  const bias: TrainingBias = biasFor(training);
  const remKcal = goal.kcal - consumed.kcal;
  const remP = Math.max(0, goal.protein_g - consumed.protein_g);
  const remC = Math.max(0, goal.carbs_g - consumed.carbs_g);
  const remF = Math.max(0, goal.fat_g - consumed.fat_g);
  const slot = slotForHour(now.getHours());

  // Already over the day's calories: don't push more food.
  if (remKcal <= 0) {
    return {
      headline: "You're over today's target",
      focus: remP > 15 ? ["High protein", "Low added fat"] : ["Keep it light"],
      idea: remP > 15 ? "If you're genuinely hungry: curd, sprouts or a few eggs" : "A glass of chaas or some cucumber",
      rationale: `You're ${Math.round(consumed.kcal - goal.kcal)} kcal over. A light, protein-y bite beats more carbs or fat.`,
      kcal: 0,
    };
  }

  // Budget essentially met -- nudge gently rather than recommend a full meal.
  if (remKcal <= 150) {
    return {
      headline: "You're on track",
      focus: ["Keep it light"],
      idea: remP > 12 ? "A little curd or a boiled egg to top up protein" : "Just water or chaas if you're peckish",
      rationale: `Only ${Math.round(remKcal)} kcal left today — you've nailed it.`,
      kcal: 0,
    };
  }

  const focus = [
    training ? trainingMetaFocus(training) : null,
    macroFocus("protein", remP, goal.protein_g),
    macroFocus("fat", remF, goal.fat_g),
    macroFocus("carbs", remC, goal.carbs_g),
  ].filter((f): f is string => f !== null).slice(0, 2);

  // Score candidates. Protein is the priority macro; reward filling the protein
  // gap, gently penalise blowing past the remaining calorie or fat budget, and
  // nudge by goal (losing -> leaner picks, gaining -> heartier picks). Today's
  // training context layers on top: endurance rewards carbs, strength doubles
  // down on protein, performance/rest keep it lighter (see training.ts). A
  // per-candidate `boost` lets the user's own favourites/recents float up.
  const proteinPriority = goal.protein_g > 0 && remP / goal.protein_g >= 0.3;
  const goalKcalBias = (g: Goal): number => (g === "lose" ? -0.15 : g === "gain" ? 0.1 : 0);

  const scored = candidates
    .filter((c) => allowedForDiet(profile.diet, c) && c.slots.includes(slot) && c.kcal <= remKcal * 1.2)
    .map((c) => {
      const proteinFill = Math.min(c.protein, remP); // useful protein toward the gap
      const carbFill = Math.min(c.carbs, remC); // useful carbs toward the gap
      const kcalOver = Math.max(0, c.kcal - remKcal); // penalise overshoot
      const fatOver = Math.max(0, c.fat - remF);
      // Training context has to visibly move the pick, not just tint the macros.
      // Carbs get real weight on endurance days (carbBoost up to 0.9); "lighter"
      // days (rest/performance, negative kcalBias) actively prefer leaner,
      // lower-calorie foods via an absolute-fat penalty + a calorie tilt, so a
      // fatty high-protein dish stops winning every mode. Strength keeps winning
      // on protein because its proteinBoost (1.6) outweighs the fat penalty.
      const carbWeight = 0.15 + bias.carbBoost * 0.75;
      const leanPenalty = 0.7 * bias.fatPenalty * c.fat;
      const heartiness = 0.02 + bias.kcalBias * 0.65;
      let score =
        (proteinPriority ? 2.2 : 1.0) * bias.proteinBoost * proteinFill +
        carbWeight * carbFill -
        0.06 * kcalOver -
        (0.4 + bias.fatPenalty * 0.3) * fatOver +
        (goalKcalBias(profile.goal) + bias.kcalBias) * (c.kcal / 100) -
        leanPenalty +
        (c.boost ?? 0);
      // Prefer ideas that roughly fit the calorie budget over tiny snacks when a
      // real meal is due (breakfast/lunch/dinner). On lighter days `heartiness`
      // goes slightly negative, nudging toward smaller plates.
      if (slot !== "snack") score += Math.min(c.kcal, remKcal) * heartiness;
      return { c, score };
    });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0]?.c ?? null;

  const gapBits: string[] = [];
  if (remP >= 15) gapBits.push(`~${Math.round(remP)}g protein`);
  if (remKcal >= 150) gapBits.push(`${Math.round(remKcal)} kcal`);
  const gapLine = gapBits.length
    ? `You have ${gapBits.join(" and ")} left${proteinPriority ? " — protein first" : ""}.`
    : `You have ${Math.round(remKcal)} kcal left today.`;
  // Add a personal note when the winner is the user's own meal or a real DB food.
  const sourceNote =
    best?.source === "favorite"
      ? " From your favourites."
      : best?.source === "recent"
        ? " One of your recent meals."
        : best?.source === "db"
          ? " Real nutrition from our food database."
          : "";

  return {
    headline: "Your next meal",
    focus: focus.length ? focus : ["Balanced"],
    idea: best ? best.name : "A balanced plate — dal, a roti and some sabzi",
    rationale: gapLine + sourceNote,
    kcal: best ? best.kcal : 0,
    source: best?.source,
    detail: best?.detail,
  };
}

/**
 * Suggest the next meal from what's left in the daily budget, using only the
 * built-in idea list. Synchronous + offline -- the default first-render path and
 * the fallback when the food DB is unreachable. `now` is injectable for tests.
 */
export function suggestNextMeal(
  consumed: { kcal: number; protein_g: number; carbs_g: number; fat_g: number },
  goal: GoalTargets,
  profile: Pick<Profile, "diet" | "goal">,
  now: Date = new Date(),
  training: TrainingContext | null = null,
): MealSuggestion {
  return computeSuggestion(consumed, goal, profile, now, training, BASE_CANDIDATES);
}

// --- Building a richer candidate pool ------------------------------------- //

// The user's own saved meals become candidates so suggestions feel personal.
// Favourites get a strong boost and recents a recency-scaled one; both are
// diet-safe by construction (the user logged them). `now` scales recency.
export function recentsToCandidates(
  recents: { dish: string; kcal: number; protein_g: number; carbs_g: number; fat_g: number; fav: boolean; at: number }[],
  now = Date.now(),
): Candidate[] {
  const DAY = 86400000;
  return recents.map((r) => {
    const ageDays = Math.max(0, (now - r.at) / DAY);
    // recency: full boost today, decaying to ~0 after ~21 days.
    const recency = Math.max(0, 1 - ageDays / 21);
    const boost = r.fav ? 22 + 6 * recency : 8 * recency;
    return {
      name: r.dish,
      kcal: Math.round(r.kcal),
      protein: Math.round(r.protein_g),
      carbs: Math.round(r.carbs_g),
      fat: Math.round(r.fat_g),
      slots: ALL_SLOTS,
      contains: "veg" as Contains, // ignored -- recents bypass the diet gate
      source: r.fav ? "favorite" : "recent",
      boost,
    };
  });
}

// Map a food-DB record (per-unit macros) into a single-serving candidate.
// The backend now ranks + diet-filters the whole DB in /foods/recommend, so the
// client no longer needs its own seed-word searches.
export function dbFoodToCandidate(
  f: { name: string; unit: string; kcal_per_unit: number; protein_g_per_unit: number; carbs_g_per_unit: number; fat_g_per_unit: number },
  contains: Contains,
): Candidate {
  return {
    name: f.name,
    kcal: Math.round(f.kcal_per_unit),
    protein: Math.round(f.protein_g_per_unit),
    carbs: Math.round(f.carbs_g_per_unit),
    fat: Math.round(f.fat_g_per_unit),
    slots: ALL_SLOTS,
    contains,
    source: "db",
    detail: `1 ${f.unit}`,
  };
}
