// Rule-based weekly insights — a lightweight "coach" computed entirely on the
// device from the last 7 days of logged macros. NO AI / LLM call is involved
// (so it costs nothing to run and works offline); it just turns numbers the
// app already has into a plain-language summary. Only macros + calories are
// stored per day (see storage.ts's Meal), so insights are limited to those +
// logging consistency — we never invent micronutrient claims we can't back.

import { GoalTargets } from "./nutrition";
import { LogMap, lastNDays } from "./storage";
import { IconName } from "./Icon";

export type InsightTone = "good" | "warn" | "info";

export type Insight = {
  id: string;
  tone: InsightTone;
  icon: IconName;
  title: string;
  detail: string;
};

export type WeeklySummary = {
  headline: string;
  loggedDays: number;
  avgKcal: number;
  avgProtein: number;
  insights: Insight[];
};

// Averages are over *logged* days only, so a couple of un-logged days don't
// drag the numbers down and misrepresent how the user actually ate.
export function weeklyInsights(logs: LogMap, goal: GoalTargets): WeeklySummary {
  const week = lastNDays(logs, 7);
  const logged = week.filter((d) => d.meals > 0);
  const n = logged.length;

  const avg = (pick: (d: (typeof week)[number]) => number) =>
    n ? Math.round(logged.reduce((s, d) => s + pick(d), 0) / n) : 0;

  const avgKcal = avg((d) => d.kcal);
  const avgProtein = avg((d) => d.protein_g);

  const insights: Insight[] = [];

  // Not enough data yet — encourage logging instead of showing empty stats.
  if (n === 0) {
    return {
      headline: "Log a few meals to unlock your weekly insights.",
      loggedDays: 0,
      avgKcal: 0,
      avgProtein: 0,
      insights: [
        {
          id: "empty",
          tone: "info",
          icon: "info",
          title: "No data this week yet",
          detail: "Scan or log meals for a few days and a personalized summary shows up here.",
        },
      ],
    };
  }

  // 1) Logging consistency.
  if (n >= 6) {
    insights.push({
      id: "consistency",
      tone: "good",
      icon: "flame",
      title: `Logged ${n} of the last 7 days`,
      detail: "Great consistency — this is what makes the numbers trustworthy.",
    });
  } else if (n <= 3) {
    insights.push({
      id: "consistency",
      tone: "warn",
      icon: "target",
      title: `Only ${n} day${n === 1 ? "" : "s"} logged this week`,
      detail: "Try logging every meal for a week — even rough entries make the trends useful.",
    });
  } else {
    insights.push({
      id: "consistency",
      tone: "info",
      icon: "target",
      title: `Logged ${n} of the last 7 days`,
      detail: "A couple more logged days and your averages will be much more reliable.",
    });
  }

  // 2) Protein vs target.
  if (goal.protein_g > 0) {
    const pct = Math.round((avgProtein / goal.protein_g) * 100);
    if (pct < 80) {
      insights.push({
        id: "protein",
        tone: "warn",
        icon: "protein",
        title: `Protein is low: ${avgProtein}g/day avg`,
        detail: `You're at ${pct}% of your ${goal.protein_g}g target. Add dal, curd, eggs, paneer, soya or a scoop of whey.`,
      });
    } else if (pct >= 100) {
      insights.push({
        id: "protein",
        tone: "good",
        icon: "protein",
        title: `Protein on point: ${avgProtein}g/day avg`,
        detail: `You're hitting ${pct}% of your ${goal.protein_g}g target. Nicely done.`,
      });
    } else {
      insights.push({
        id: "protein",
        tone: "info",
        icon: "protein",
        title: `Protein close: ${avgProtein}g/day avg`,
        detail: `You're at ${pct}% of your ${goal.protein_g}g target — a small top-up gets you there.`,
      });
    }
  }

  // 3) Calories vs goal.
  if (goal.kcal > 0) {
    const pct = Math.round((avgKcal / goal.kcal) * 100);
    if (pct > 110) {
      insights.push({
        id: "calories",
        tone: "warn",
        icon: "flame",
        title: `Calories running high: ${avgKcal}/day avg`,
        detail: `That's ${pct}% of your ${goal.kcal} kcal target. Watch portion sizes on your biggest meal.`,
      });
    } else if (pct < 70) {
      insights.push({
        id: "calories",
        tone: "warn",
        icon: "info",
        title: `Calories look low: ${avgKcal}/day avg`,
        detail: `Only ${pct}% of your ${goal.kcal} kcal target. Under-eating can stall progress — make sure you're logging everything.`,
      });
    } else {
      insights.push({
        id: "calories",
        tone: "good",
        icon: "check",
        title: `Calories in range: ${avgKcal}/day avg`,
        detail: `You're at ${pct}% of your ${goal.kcal} kcal target. Steady and sustainable.`,
      });
    }
  }

  // Headline: pick the most actionable message.
  const warn = insights.find((i) => i.tone === "warn");
  const headline = warn
    ? warn.title
    : n >= 6
    ? "Strong week — consistent logging and macros on target."
    : "Looking good — keep logging to sharpen your trends.";

  return { headline, loggedDays: n, avgKcal, avgProtein, insights };
}
