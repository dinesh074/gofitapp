import { IconName } from "./Icon";
import { HomeLayout } from "./api";

// Canonical set of Home dashboard modules, in their default order. The client
// owns this list so we can add modules later without breaking a saved layout:
// any key a user hasn't seen yet is merged back in at its default position.
export type HomeModuleKey =
  | "summary"
  | "todayPlan"
  | "training"
  | "nextMeal"
  | "streak"
  | "micros"
  | "wellness"
  | "exercise";

export type HomeModuleMeta = {
  key: HomeModuleKey;
  label: string;
  desc: string;
  icon: IconName;
  // Always-on modules can't be hidden (the calorie summary is the identity of
  // the screen) but can still be reordered.
  lockedVisible?: boolean;
  // Some modules only exist while the AI coach surfaces are enabled.
  requiresCoach?: boolean;
};

export const HOME_MODULES: HomeModuleMeta[] = [
  { key: "summary", label: "Calories & macros", desc: "Today's ring, protein / carbs / fat", icon: "flame", lockedVisible: true },
  { key: "todayPlan", label: "Today's plan", desc: "Your planned meals for the day", icon: "nutrition" },
  { key: "training", label: "Today's training", desc: "Tag your session to tune targets", icon: "pulse", requiresCoach: true },
  { key: "nextMeal", label: "Your next meal", desc: "AI meal suggestions", icon: "sparkles", requiresCoach: true },
  { key: "streak", label: "Monthly streak", desc: "Days you hit your goal", icon: "trophy" },
  { key: "micros", label: "Micronutrients", desc: "Fibre, iron, sodium and more", icon: "nutrition", requiresCoach: true },
  { key: "wellness", label: "Water & steps", desc: "Hydration and daily steps", icon: "water" },
  { key: "exercise", label: "Exercise", desc: "Log workouts & calories burned", icon: "dumbbell" },
];

export const DEFAULT_ORDER: HomeModuleKey[] = HOME_MODULES.map((m) => m.key);

const META_BY_KEY: Record<string, HomeModuleMeta> = Object.fromEntries(
  HOME_MODULES.map((m) => [m.key, m])
);

export function moduleMeta(key: string): HomeModuleMeta | undefined {
  return META_BY_KEY[key];
}

// Merge a possibly-stale saved layout with the canonical set: keep the user's
// order for keys they've seen, append any brand-new modules at their default
// spot, and drop keys we no longer ship. Locked-visible modules can never end
// up hidden even if a bad payload said so.
export function resolveLayout(saved: HomeLayout | null): {
  order: HomeModuleKey[];
  hidden: Set<HomeModuleKey>;
} {
  const known = new Set<string>(DEFAULT_ORDER);
  if (!saved) {
    return { order: [...DEFAULT_ORDER], hidden: new Set() };
  }
  const savedOrder = saved.order.filter((k): k is HomeModuleKey => known.has(k));
  const seen = new Set(savedOrder);
  // Build final order: keep the user's saved order, then append any canonical
  // keys they haven't seen yet at their default position.
  const finalOrder: HomeModuleKey[] = [...savedOrder];
  for (const key of DEFAULT_ORDER) {
    if (!seen.has(key)) finalOrder.push(key);
  }
  const hidden = new Set<HomeModuleKey>(
    saved.hidden.filter((k): k is HomeModuleKey => known.has(k))
  );
  for (const m of HOME_MODULES) {
    if (m.lockedVisible) hidden.delete(m.key);
  }
  return { order: finalOrder, hidden };
}
