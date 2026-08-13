// "Should I eat this?" — a pre-meal verdict.
//
// After a scan (photo / barcode / describe), before the user commits the meal
// to their day, we answer the far more human question than "how many calories":
// *should you eat this, given the day you've had and the day you've got?*
//
// It compares the scanned meal against what's LEFT in today's budget (the meal
// isn't logged yet, so `consumed` excludes it) and today's training context,
// then returns a simple traffic-light verdict, a few honest one-line reasons,
// and a practical piece of advice (often a portion suggestion). It's
// deterministic, on-device, needs no AI call or scan credit, and is guidance —
// not medical advice.

import type { GoalTargets } from "./nutrition";
import { trainingMeta, TrainingContext } from "./training";

export type VerdictState = "green" | "yellow" | "red";

export type VerdictLine = { state: VerdictState; text: string };

export type MealVerdict = {
  overall: VerdictState;
  headline: string;
  lines: VerdictLine[];
  advice: string;
  // What fraction of the plate fits the remaining calorie budget (0..1, capped
  // at 1). The UI can use this for the "have about half" nudge; null when the
  // day has no meaningful budget target.
  fitFraction: number | null;
};

type Macros = { kcal: number; protein_g: number; carbs_g: number; fat_g: number };

const RANK: Record<VerdictState, number> = { green: 0, yellow: 1, red: 2 };
const worse = (a: VerdictState, b: VerdictState): VerdictState => (RANK[a] >= RANK[b] ? a : b);

// Turn a "fits" fraction into a natural portion phrase.
function portionPhrase(frac: number): string {
  if (frac >= 0.7) return "about three-quarters of it";
  if (frac >= 0.58) return "about two-thirds of it";
  if (frac >= 0.42) return "about half of it";
  if (frac >= 0.28) return "about a third of it";
  return "a small portion";
}

/**
 * Verdict for a scanned meal against the day's remaining budget + context.
 * `consumed` is today's totals so far (NOT including this meal).
 */
export function mealVerdict(
  meal: Macros,
  consumed: Macros,
  goal: GoalTargets,
  training: TrainingContext | null,
): MealVerdict {
  // No usable calorie target -> we can't judge "fit". Stay honest and abstain.
  if (!goal || goal.kcal <= 0 || meal.kcal <= 0) {
    return {
      overall: "green",
      headline: "Log it when you're ready",
      lines: [],
      advice: "Set a daily goal to see whether a meal fits your day.",
      fitFraction: null,
    };
  }

  const remKcal = goal.kcal - consumed.kcal; // before this meal (may be <= 0)
  const afterKcal = consumed.kcal + meal.kcal;
  const kcalOver = afterKcal - goal.kcal; // > 0 means this meal pushes over
  const remP = goal.protein_g - consumed.protein_g;
  const remC = goal.carbs_g - consumed.carbs_g;
  const afterFat = consumed.fat_g + meal.fat_g;
  const fatOver = afterFat - goal.fat_g;
  const afterCarb = consumed.carbs_g + meal.carbs_g;

  const lines: VerdictLine[] = [];

  // --- Calories: the anchor line, always shown. ----------------------------
  const kcalSlack = Math.max(120, goal.kcal * 0.06); // small grace band
  if (kcalOver <= 0) {
    lines.push({
      state: "green",
      text: `Fits your calories — ${Math.round(goal.kcal - afterKcal)} kcal still to spare`,
    });
  } else if (kcalOver <= kcalSlack) {
    lines.push({ state: "yellow", text: `Just over — about ${Math.round(kcalOver)} kcal past today's target` });
  } else {
    lines.push({ state: "red", text: `Puts you ~${Math.round(kcalOver)} kcal over today` });
  }

  // --- Protein: reward a protein-rich meal, flag a protein-poor one. --------
  if (meal.protein_g >= 15) {
    lines.push({ state: "green", text: `Good protein — adds ${Math.round(meal.protein_g)}g` });
  } else if (remP >= 20 && meal.protein_g < 10) {
    lines.push({ state: "yellow", text: `Low protein — you still need ~${Math.round(remP)}g today` });
  }

  // --- Fat: the classic "you're already near your fat target" case. ---------
  const fatSlack = Math.max(15, goal.fat_g * 0.15);
  if (goal.fat_g > 0 && fatOver > fatSlack) {
    lines.push({ state: "red", text: `High fat — ~${Math.round(fatOver)}g over your fat target` });
  } else if (goal.fat_g > 0 && consumed.fat_g >= goal.fat_g * 0.8 && meal.fat_g >= 12) {
    lines.push({ state: "yellow", text: "High fat — you're already near your fat target" });
  } else if (goal.fat_g > 0 && meal.fat_g >= goal.fat_g * 0.6) {
    lines.push({ state: "yellow", text: "On the oily side for one meal" });
  }

  // --- Carbs: mostly training-aware. ---------------------------------------
  if (training === "endurance" && remC >= goal.carbs_g * 0.35 && meal.carbs_g >= 25) {
    lines.push({ state: "green", text: "Good carbs to fuel your endurance day" });
  } else if (training === "performance" && (meal.fat_g >= 18 || meal.kcal >= remKcal * 0.9)) {
    lines.push({ state: "yellow", text: "Heavy for right before a performance" });
  } else if (goal.carbs_g > 0 && afterCarb > goal.carbs_g * 1.2) {
    lines.push({ state: "yellow", text: "High carbs — over your carb target" });
  }

  const overall = lines.reduce<VerdictState>((acc, l) => worse(acc, l.state), "green");

  // --- Fit fraction + advice. ----------------------------------------------
  const fitFraction = remKcal <= 0 ? 0 : Math.min(1, remKcal / meal.kcal);

  const trainMeta = training ? trainingMeta(training) : null;
  let advice: string;
  if (remKcal <= 0) {
    advice =
      "You're already at today's target. If you really want it, keep it to a few bites and balance it out tomorrow.";
  } else if (fitFraction >= 0.95) {
    // The whole plate fits.
    if (training === "endurance" && remC >= goal.carbs_g * 0.35) {
      advice = "You're low on carbs and training today — go for it.";
    } else if (overall === "green") {
      advice = "This fits your day — enjoy it.";
    } else {
      advice = "It fits your calories; just mind the note above.";
    }
  } else {
    const phrase = portionPhrase(fitFraction);
    if (overall === "red") {
      advice = `It's a big one. If you want it, have ${phrase} and save the rest for later.`;
    } else {
      advice = `Have ${phrase} to stay on target, and keep the rest for later.`;
    }
    if (trainMeta && training === "strength" && meal.protein_g >= 15) {
      advice += " The protein is great for recovery.";
    }
  }

  const headline =
    overall === "green"
      ? "You can have this"
      : overall === "yellow"
        ? "Fits with a small tweak"
        : "Think twice on the portion";

  return { overall, headline, lines, advice, fitFraction };
}
