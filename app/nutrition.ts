// Nutrition goal calculator — deterministic, based on established formulas.
// BMR: Mifflin-St Jeor. TDEE: activity multiplier. Goal: calorie delta.

export type Gender = "male" | "female";
export type Goal = "lose" | "maintain" | "gain";
export type Activity = "sedentary" | "light" | "moderate" | "active" | "very_active";
export type Diet = "veg" | "nonveg" | "vegan" | "eggetarian" | "jain" | "sattvic";

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
  createdAt: number;
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

// Mifflin-St Jeor Basal Metabolic Rate.
export function bmr(p: Pick<Profile, "gender" | "age" | "heightCm" | "weightKg">): number {
  const base = 10 * p.weightKg + 6.25 * p.heightCm - 5 * p.age;
  return Math.round(p.gender === "male" ? base + 5 : base - 161);
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

// Full calorie + macro targets for the user's goal.
// - lose: -500 kcal/day (~0.45 kg/week), floored at BMR for safety.
// - gain: +400 kcal/day.
// Macro split: protein 30%, carbs 40%, fat 30% of calories.
export function computeGoal(p: Profile): GoalTargets {
  const base = bmr(p);
  const maintenance = tdee(p);
  let kcal = maintenance;
  if (p.goal === "lose") kcal = Math.max(base, maintenance - 500);
  else if (p.goal === "gain") kcal = maintenance + 400;

  kcal = Math.round(kcal);
  const protein_g = Math.round((kcal * 0.3) / 4);
  const carbs_g = Math.round((kcal * 0.4) / 4);
  const fat_g = Math.round((kcal * 0.3) / 9);

  return { bmr: base, tdee: maintenance, kcal, protein_g, carbs_g, fat_g };
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
