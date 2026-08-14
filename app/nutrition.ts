// Nutrition goal calculator — deterministic, based on established formulas.
// BMR: Mifflin-St Jeor. TDEE: activity multiplier. Goal: calorie delta.

export type Gender = "male" | "female" | "other";
export type Goal = "lose" | "maintain" | "gain";
export type Activity = "sedentary" | "light" | "moderate" | "active" | "very_active";
export type Diet = "veg" | "nonveg" | "vegan" | "eggetarian" | "jain" | "sattvic";

// How fast the user wants to reach their goal. This is a REAL input to the
// calorie calculation (see computeGoal / projectPlan) -- not just a label:
// relaxed -> smaller daily deficit/surplus (slower), ambitious -> larger.
export type GoalPace = "relaxed" | "recommended" | "ambitious";

// The user-facing goal shown in onboarding. The nutrition engine only needs the
// 3-way `Goal` (lose/maintain/gain), but the UI offers four framings; muscle
// gain maps to `gain` (with a higher protein target) and general fitness maps to
// `maintain`. Kept optional on the profile and derivable from `goal` so older
// saved/synced profiles (which never stored it) still render sensibly.
export type GoalKind = "loss" | "muscle" | "maintain" | "fitness";

// Jain and Sattvic are both strict-vegetarian diets (plus extra rules this
// app can't fully verify from a dish name alone -- see foods.jain_status /
// sattvic_status on the backend, which are 'yes' / 'no' / 'depends', not a
// blanket guarantee). Useful anywhere existing veg-only logic needs to also
// cover these two, e.g. defaulting the Budget Protein Plan's veg toggle.
export function isVegetarianDiet(diet: Diet): boolean {
  return diet === "veg" || diet === "vegan" || diet === "eggetarian" || diet === "jain" || diet === "sattvic";
}

export type Profile = {
  name?: string;
  gender: Gender;
  age: number; // years
  heightCm: number;
  weightKg: number;
  targetWeightKg: number;
  goal: Goal;
  activity: Activity;
  diet: Diet;
  // Optional (added in the onboarding redesign). Both are safe to omit on older
  // profiles: goalPace defaults to "recommended" and goalKind is derived from
  // `goal` when absent (see resolveGoalPace / resolveGoalKind).
  goalPace?: GoalPace;
  goalKind?: GoalKind;
  createdAt: number;
  updatedAt?: number;
};

export type GoalTargets = {
  bmr: number;
  tdee: number;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
};

export const ACTIVITY_FACTORS: Record<Activity, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

export const ACTIVITY_LABELS: Record<Activity, string> = {
  sedentary: "Little/no exercise (desk job)",
  light: "Light exercise 1-3 days/week",
  moderate: "Moderate exercise 3-5 days/week",
  active: "Hard exercise 6-7 days/week",
  very_active: "Athlete / physical job",
};

// Mifflin-St Jeor Basal Metabolic Rate. The sex term is +5 (male) / −161
// (female); for "other"/unspecified we use the midpoint (−78) so the estimate
// is reasonable without assuming a binary.
export function bmr(p: Pick<Profile, "gender" | "age" | "heightCm" | "weightKg">): number {
  const base = 10 * p.weightKg + 6.25 * p.heightCm - 5 * p.age;
  const sexTerm = p.gender === "male" ? 5 : p.gender === "female" ? -161 : -78;
  return Math.round(base + sexTerm);
}

// Total Daily Energy Expenditure.
export function tdee(p: Pick<Profile, "gender" | "age" | "heightCm" | "weightKg" | "activity">): number {
  return Math.round(bmr(p) * ACTIVITY_FACTORS[p.activity]);
}

export type BmiCategory = "underweight" | "normal" | "overweight" | "obese";
export type Bmi = { value: number; category: BmiCategory };

export const BMI_CATEGORY_LABEL: Record<BmiCategory, string> = {
  underweight: "Underweight",
  normal: "Normal",
  overweight: "Overweight",
  obese: "Obese",
};

// Standard BMI (kg / m^2) + WHO category bands. Mirrors backend/progress.py's
// _bmi() exactly, so the app can show this instantly from local profile state
// without waiting on a network round-trip, and always agrees with what the
// server would compute from the same height/weight.
export function computeBmi(heightCm: number, weightKg: number): Bmi | null {
  if (!heightCm || heightCm <= 0) return null;
  const m = heightCm / 100;
  const value = Math.round((weightKg / (m * m)) * 10) / 10;
  let category: BmiCategory;
  if (value < 18.5) category = "underweight";
  else if (value < 25) category = "normal";
  else if (value < 30) category = "overweight";
  else category = "obese";
  return { value, category };
}

// Full calorie + macro targets for the user's goal and chosen pace.
//
// One source of truth: the daily calorie delta is DERIVED from how fast the user
// wants to change weight (goal pace), not a fixed number -- so Relaxed ->
// Recommended -> Ambitious genuinely change the calorie target and the projected
// timeline (see projectPlan). ~7700 kcal ≈ 1 kg of body mass, so a target rate
// of R kg/week is a daily delta of R * 7700 / 7 kcal.
//
// A deficit is floored at BMR (never recommend eating below resting needs); a
// surplus is capped for sanity. Protein is set per kg of body weight (higher for
// muscle gain), fat at 25% of calories, carbs fill the remainder.
export const RATE_KG_PER_WEEK: Record<"lose" | "gain", Record<GoalPace, number>> = {
  // Weight loss: 0.25 / 0.5 / 0.75 kg per week.
  lose: { relaxed: 0.25, recommended: 0.5, ambitious: 0.75 },
  // Muscle/weight gain is necessarily slower to limit fat gain.
  gain: { relaxed: 0.125, recommended: 0.25, ambitious: 0.4 },
};

const KCAL_PER_KG = 7700;

// Protein grams per kg of body weight by goal. Muscle gain and fat loss both
// benefit from a higher intake (muscle growth / muscle retention in a deficit).
const PROTEIN_G_PER_KG: Record<Goal, number> = { lose: 1.8, maintain: 1.6, gain: 2.0 };

const GOAL_PACE_ALIASES: Record<string, GoalPace> = {
  relaxed: "relaxed",
  recommended: "recommended",
  ambitious: "ambitious",
  moderate: "recommended",
};

const GOAL_KIND_ALIASES: Record<string, GoalKind> = {
  loss: "loss",
  lose_weight: "loss",
  muscle: "muscle",
  gain_weight: "muscle",
  maintain: "maintain",
  maintain_weight: "maintain",
  fitness: "fitness",
  general_fitness: "fitness",
};

export function normalizeGoalPace(value: unknown): GoalPace | undefined {
  return typeof value === "string" ? GOAL_PACE_ALIASES[value] : undefined;
}

export function normalizeGoalKind(value: unknown): GoalKind | undefined {
  return typeof value === "string" ? GOAL_KIND_ALIASES[value] : undefined;
}

export function resolveGoalPace(p: Pick<Profile, "goalPace">): GoalPace {
  return normalizeGoalPace(p.goalPace) ?? "recommended";
}

// Derive the 4-way UI goal framing from the stored profile. If goalKind was
// saved use it; otherwise infer from the 3-way engine goal.
export function resolveGoalKind(p: Pick<Profile, "goal" | "goalKind">): GoalKind {
  const goalKind = normalizeGoalKind(p.goalKind);
  if (goalKind) return goalKind;
  return p.goal === "lose" ? "loss" : p.goal === "gain" ? "muscle" : "maintain";
}

export function normalizeProfile(p: Profile | null | undefined): Profile | null {
  if (!p) return null;
  return {
    ...p,
    goalPace: resolveGoalPace(p),
    goalKind: resolveGoalKind(p),
  };
}

// The daily calorie delta (signed) implied by the goal + pace. 0 for maintain.
export function dailyCalorieDelta(goal: Goal, pace: GoalPace): number {
  if (goal === "maintain") return 0;
  const rate = RATE_KG_PER_WEEK[goal][pace];
  const perDay = Math.round((rate * KCAL_PER_KG) / 7);
  return goal === "lose" ? -perDay : perDay;
}

export function computeGoal(p: Profile): GoalTargets {
  const base = bmr(p);
  const maintenance = tdee(p);
  const pace = resolveGoalPace(p);
  const delta = dailyCalorieDelta(p.goal, pace);
  // Never recommend eating below resting metabolism, even on an ambitious cut.
  let kcal = Math.round(Math.max(base, maintenance + delta));

  // Protein anchored to body weight (clamped so it can't dominate a small
  // budget), fat at 25% of calories, carbs take whatever calories remain.
  const proteinRaw = Math.round(PROTEIN_G_PER_KG[p.goal] * p.weightKg);
  const proteinCap = Math.floor((kcal * 0.4) / 4); // protein never > 40% of kcal
  const protein_g = Math.max(0, Math.min(proteinRaw, proteinCap));
  const fat_g = Math.round((kcal * 0.25) / 9);
  const carbKcal = Math.max(0, kcal - protein_g * 4 - fat_g * 9);
  const carbs_g = Math.round(carbKcal / 4);

  return { bmr: base, tdee: maintenance, kcal, protein_g, carbs_g, fat_g };
}

// A projected plan toward the target weight: the weekly rate implied by the
// pace, how many weeks it should take, and the estimated date. Used by the
// onboarding pace screen + summary. Everything is computed from the live
// profile so changing weight, target, goal or pace updates all of it. Returns
// null when there's effectively nothing to project (maintain, or target already
// reached in the goal's direction).
export type GoalProjection = {
  direction: "lose" | "gain" | "maintain";
  deltaKg: number; // absolute kg between current and target
  ratePerWeekKg: number; // signed toward the goal (0 for maintain)
  weeks: number; // whole weeks, min 1 when there is a real delta
  targetDate: Date | null;
  kcal: number; // the daily calorie target for this plan
};

export function projectPlan(p: Profile, now: Date = new Date()): GoalProjection {
  const g = computeGoal(p);
  if (p.goal === "maintain") {
    return { direction: "maintain", deltaKg: 0, ratePerWeekKg: 0, weeks: 0, targetDate: null, kcal: g.kcal };
  }
  const deltaKg = Math.abs(p.weightKg - p.targetWeightKg);
  const rate = RATE_KG_PER_WEEK[p.goal][resolveGoalPace(p)];
  // If the target doesn't actually move in the goal's direction (e.g. "lose" but
  // target ≥ current), there's no meaningful timeline to show.
  const meaningful =
    deltaKg >= 0.1 &&
    ((p.goal === "lose" && p.targetWeightKg < p.weightKg) ||
      (p.goal === "gain" && p.targetWeightKg > p.weightKg));
  if (!meaningful || rate <= 0) {
    return { direction: p.goal, deltaKg, ratePerWeekKg: 0, weeks: 0, targetDate: null, kcal: g.kcal };
  }
  const weeks = Math.max(1, Math.ceil(deltaKg / rate));
  const targetDate = new Date(now.getTime() + weeks * 7 * 24 * 60 * 60 * 1000);
  return {
    direction: p.goal,
    deltaKg,
    ratePerWeekKg: p.goal === "lose" ? -rate : rate,
    weeks,
    targetDate,
    kcal: g.kcal,
  };
}

// Water + step goals -- both used to be flat constants (2500 ml / 10,000
// steps) shown to every account regardless of what onboarding actually
// collected. That's not "real data personalized to you", it's a guess with
// extra steps, so both are now derived from the same profile fields already
// captured in Onboarding (weightKg, activity). Mirrored byte-for-byte in
// backend/wellness.py so the server-computed goal (once a profile is synced)
// always agrees with what the client shows before that round-trip lands.

// Water: clinical guidance is commonly cited as ~30-35 ml per kg of body
// weight per day (EFSA/ESPEN); 33 ml/kg is the midpoint. Activity adds a
// fixed bump for extra sweat loss, tiered off the same Activity the user
// already chose in onboarding. Rounded to the nearest 50 ml and clamped to a
// sane range so an extreme height/weight can't produce a silly target.
const WATER_ACTIVITY_BUMP_ML: Record<Activity, number> = {
  sedentary: 0,
  light: 0,
  moderate: 250,
  active: 500,
  very_active: 750,
};

export function computeWaterGoalMl(p: Pick<Profile, "weightKg" | "activity">): number {
  const base = p.weightKg * 33 + WATER_ACTIVITY_BUMP_ML[p.activity];
  return Math.min(5000, Math.max(1500, Math.round(base / 50) * 50));
}

// Steps: the widely-cited Tudor-Locke & Bassett activity-band step counts
// (sedentary <5,000 / low active 5,000-7,499 / somewhat active 7,500-9,999 /
// active 10,000-12,499 / highly active 12,500+) give each onboarding activity
// level a concrete "next tier" daily target instead of everyone getting the
// same generic 10,000.
export const STEP_GOAL_BY_ACTIVITY: Record<Activity, number> = {
  sedentary: 6000,
  light: 7500,
  moderate: 9000,
  active: 10000,
  very_active: 12000,
};

export function computeStepGoal(p: Pick<Profile, "activity">): number {
  return STEP_GOAL_BY_ACTIVITY[p.activity];
}

// Reasonable input ranges for validation.
export const LIMITS = {
  age: { min: 13, max: 100 },
  heightCm: { min: 120, max: 230 },
  weightKg: { min: 30, max: 250 },
};

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

// --- Unit conversions (display only; the profile always stores metric) ------ //
// The onboarding wheel pickers can show cm/in and kg/lb, but height is always
// persisted as cm and weight as kg so every downstream calculation stays in one
// unit system. These are the exact round-trippable conversions used there.
export type HeightUnit = "cm" | "in";
export type WeightUnit = "kg" | "lb";

export const cmToIn = (cm: number): number => cm / 2.54;
export const inToCm = (inch: number): number => inch * 2.54;
export const kgToLb = (kg: number): number => kg * 2.2046226218;
export const lbToKg = (lb: number): number => lb / 2.2046226218;

// Format a metric value for display in the chosen unit, rounded sensibly.
export function formatHeight(cm: number, unit: HeightUnit): string {
  if (unit === "in") {
    const totalIn = Math.round(cmToIn(cm));
    const ft = Math.floor(totalIn / 12);
    const inch = totalIn % 12;
    return `${ft}'${inch}"`;
  }
  return `${Math.round(cm)} cm`;
}

export function formatWeight(kg: number, unit: WeightUnit): string {
  return unit === "lb" ? `${Math.round(kgToLb(kg))} lb` : `${Math.round(kg * 10) / 10} kg`;
}

// A profile counts as "onboarded" only when every field the app relies on is
// present and valid. We check this explicitly instead of just testing whether a
// profile object exists, so a partial/corrupt cached profile (or a stale one
// left over from an interrupted onboarding) can never skip the onboarding gate
// or feed NaNs into computeGoal.
export function isCompleteProfile(p: Profile | null | undefined): p is Profile {
  if (!p) return false;
  const genders: Gender[] = ["male", "female", "other"];
  const goals: Goal[] = ["lose", "maintain", "gain"];
  const activities: Activity[] = ["sedentary", "light", "moderate", "active", "very_active"];
  const diets: Diet[] = ["veg", "nonveg", "vegan", "eggetarian", "jain", "sattvic"];
  const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
  return (
    genders.includes(p.gender) &&
    goals.includes(p.goal) &&
    activities.includes(p.activity) &&
    diets.includes(p.diet) &&
    num(p.age) &&
    num(p.heightCm) &&
    num(p.weightKg) &&
    num(p.targetWeightKg)
  );
}
