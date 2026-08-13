// Goal-aware / training-context nutrition (v1).
//
// Two people can eat the exact same plate and one is under-fuelled while the
// other is over-eating -- it depends on what their body is doing that day. This
// module lets the user tag *today's* context (long run, strength session, rest
// day, a performance tonight) and turns that into:
//   1. a short, non-medical fuelling tip shown on the dashboard, and
//   2. a scoring bias fed into the "what to eat next" suggester so the ideas it
//      surfaces actually match the day (carbs before a long ride, protein around
//      lifting, something light before you go on stage).
//
// It's deterministic, on-device, and namespaced per account + per date so one
// login's "leg day" never sticks to another account on a shared phone, and a
// context set today doesn't silently carry into tomorrow.

import AsyncStorage from "@react-native-async-storage/async-storage";
import type { GoalTargets, Profile } from "./nutrition";

export type TrainingContext = "rest" | "endurance" | "strength" | "performance";

// How a context nudges the meal suggester. All fields are gentle multipliers /
// additive biases layered on top of the base protein-first scoring so nothing
// here can override the user's remaining calorie budget -- it only re-orders
// which sensible idea floats to the top.
export type TrainingBias = {
  proteinBoost: number; // extra weight on protein fill (×)
  carbBoost: number; // reward carbs toward the remaining carb gap
  fatPenalty: number; // extra penalty on fat overshoot
  kcalBias: number; // per-100kcal lean/hearty tilt (like goalKcalBias)
  focus: string; // one-word focus hint surfaced in the UI
};

export type TrainingMeta = {
  key: TrainingContext;
  label: string; // chip label
  icon: "pulse" | "dumbbell" | "moon" | "music";
  bias: TrainingBias;
};

// Order matters: this is the left-to-right chip order on the dashboard.
export const TRAINING_META: TrainingMeta[] = [
  {
    key: "endurance",
    label: "Endurance",
    icon: "pulse",
    // Long run / ride: prioritise carbs to top up glycogen, keep fat modest.
    bias: { proteinBoost: 1.0, carbBoost: 0.9, fatPenalty: 0.5, kcalBias: 0.12, focus: "Carb-load" },
  },
  {
    key: "strength",
    label: "Strength",
    icon: "dumbbell",
    // Lifting: protein is king for recovery; a solid meal is fine.
    bias: { proteinBoost: 1.6, carbBoost: 0.3, fatPenalty: 0.3, kcalBias: 0.08, focus: "Protein" },
  },
  {
    key: "rest",
    label: "Rest day",
    icon: "moon",
    // No training: slightly leaner, protein maintained, don't over-carb.
    bias: { proteinBoost: 1.1, carbBoost: 0.0, fatPenalty: 0.5, kcalBias: -0.12, focus: "Lighter" },
  },
  {
    key: "performance",
    label: "Performance",
    icon: "music",
    // Gig / stage / big meeting: something light that won't sit heavy; avoid a
    // fat- and carb-heavy plate right before performing.
    bias: { proteinBoost: 0.9, carbBoost: 0.2, fatPenalty: 1.0, kcalBias: -0.2, focus: "Light & easy" },
  },
];

export function trainingMeta(ctx: TrainingContext): TrainingMeta {
  return TRAINING_META.find((m) => m.key === ctx) ?? TRAINING_META[0];
}

// A neutral bias used when no context is selected -- identical to the suggester's
// original behaviour, so an un-tagged day is unchanged.
export const NEUTRAL_BIAS: TrainingBias = {
  proteinBoost: 1,
  carbBoost: 0,
  fatPenalty: 0,
  kcalBias: 0,
  focus: "",
};

export function biasFor(ctx: TrainingContext | null): TrainingBias {
  return ctx ? trainingMeta(ctx).bias : NEUTRAL_BIAS;
}

// A short, honest fuelling tip for the dashboard. Reads the remaining budget so
// it can point out a real gap (e.g. low carbs before an endurance day). This is
// guidance, not medical or coaching advice.
export function trainingTip(
  ctx: TrainingContext,
  remaining: { kcal: number; protein_g: number; carbs_g: number; fat_g: number },
  goal: GoalTargets,
  profile: Pick<Profile, "goal">,
): string {
  const carbShare = goal.carbs_g > 0 ? remaining.carbs_g / goal.carbs_g : 0;
  const protShare = goal.protein_g > 0 ? remaining.protein_g / goal.protein_g : 0;

  switch (ctx) {
    case "endurance":
      if (remaining.carbs_g > 0 && carbShare >= 0.4)
        return `Training endurance today — you still have ~${Math.round(remaining.carbs_g)}g carbs to fuel with. Good.`;
      if (carbShare < 0.15)
        return `Endurance day but carbs are nearly used up — a rice/roti-based meal will help you fuel the effort.`;
      return `Endurance day — keep carbs topped up around your session and hydrate well.`;
    case "strength":
      if (remaining.protein_g > 20)
        return `Strength day — ~${Math.round(remaining.protein_g)}g protein left to support recovery. Aim to hit it.`;
      return `Strength day — protein target is nearly met, nice work on recovery fuel.`;
    case "rest":
      return protShare > 0.3
        ? `Rest day — keep it a touch lighter, but still land your protein (~${Math.round(remaining.protein_g)}g to go).`
        : `Rest day — keep it lighter today; you're doing well on protein.`;
    case "performance":
      return `Performance later — favour a lighter, lower-fat meal now so you don't feel heavy on stage.`;
  }
}

// --- Persistence (per account + per date) --------------------------------- //

const TRAINING_KEY = "calai.training.v1";
// account id -> date (YYYY-MM-DD) -> context
type TrainingStore = Record<string, Record<string, TrainingContext>>;

async function loadStore(): Promise<TrainingStore> {
  try {
    const raw = await AsyncStorage.getItem(TRAINING_KEY);
    return raw ? (JSON.parse(raw) as TrainingStore) : {};
  } catch {
    return {};
  }
}

async function saveStore(store: TrainingStore): Promise<void> {
  try {
    await AsyncStorage.setItem(TRAINING_KEY, JSON.stringify(store));
  } catch {
    // ignore (best-effort personalization)
  }
}

// Read today's context for an account, or null if none set / signed out.
export async function loadTrainingContext(
  accountId: number | null,
  date: string,
): Promise<TrainingContext | null> {
  if (accountId == null) return null;
  const store = await loadStore();
  return store[String(accountId)]?.[date] ?? null;
}

// Set (or clear, when ctx === null) today's context for an account. Also prunes
// entries older than ~14 days so the store can't grow forever.
export async function saveTrainingContext(
  accountId: number | null,
  date: string,
  ctx: TrainingContext | null,
): Promise<void> {
  if (accountId == null) return;
  const store = await loadStore();
  const key = String(accountId);
  const byDate: Record<string, TrainingContext> = { ...(store[key] ?? {}) };
  if (ctx === null) delete byDate[date];
  else byDate[date] = ctx;

  // prune old days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 14);
  const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(
    cutoff.getDate(),
  ).padStart(2, "0")}`;
  for (const d of Object.keys(byDate)) {
    if (d < cutoffKey) delete byDate[d];
  }

  store[key] = byDate;
  await saveStore(store);
}

export async function clearAllTraining(): Promise<void> {
  try {
    await AsyncStorage.removeItem(TRAINING_KEY);
  } catch {
    // ignore
  }
}
