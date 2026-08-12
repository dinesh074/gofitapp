import AsyncStorage from "@react-native-async-storage/async-storage";
import { Profile } from "./nutrition";

export type Meal = {
  dish: string;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  at: number;
};
export type DayLog = { date: string; meals: Meal[] };
export type LogMap = Record<string, DayLog>;

const KEY = "calai.logs.v1";
const PROFILE_KEY = "calai.profile.v1";
const WEIGHTS_KEY = "calai.weights.v1";
const COMMUNITY_KEY = "calai.community.v1";
const DEVICE_KEY = "calai.device.v1";

// Stable per-install identity for the community backend (no accounts/passwords).
export async function getDeviceId(): Promise<string> {
  try {
    let id = await AsyncStorage.getItem(DEVICE_KEY);
    if (!id) {
      id =
        "dev-" +
        Date.now().toString(36) +
        "-" +
        Math.random().toString(36).slice(2, 10);
      await AsyncStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return "dev-anon";
  }
}

export type WeightEntry = { kg: number; at: number };

export async function loadWeights(): Promise<WeightEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(WEIGHTS_KEY);
    return raw ? (JSON.parse(raw) as WeightEntry[]) : [];
  } catch {
    return [];
  }
}

export async function addWeight(kg: number): Promise<WeightEntry[]> {
  const list = await loadWeights();
  const next = [...list, { kg, at: Date.now() }];
  try {
    await AsyncStorage.setItem(WEIGHTS_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  return next;
}

// Community joined-group ids (local, no backend accounts yet).
export async function loadJoinedGroups(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(COMMUNITY_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export async function saveJoinedGroups(ids: string[]): Promise<void> {
  try {
    await AsyncStorage.setItem(COMMUNITY_KEY, JSON.stringify(ids));
  } catch {
    // ignore
  }
}

export async function loadProfile(): Promise<Profile | null> {
  try {
    const raw = await AsyncStorage.getItem(PROFILE_KEY);
    return raw ? (JSON.parse(raw) as Profile) : null;
  } catch {
    return null;
  }
}

export async function saveProfile(profile: Profile): Promise<void> {
  try {
    await AsyncStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    // ignore write errors in MVP
  }
}

export async function clearProfile(): Promise<void> {
  try {
    await AsyncStorage.removeItem(PROFILE_KEY);
  } catch {
    // ignore
  }
}

export async function clearLogs(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

export async function clearExtras(): Promise<void> {
  try {
    await AsyncStorage.multiRemove([WEIGHTS_KEY, COMMUNITY_KEY]);
  } catch {
    // ignore
  }
}

export function todayKey(d = new Date()): string {
  // local YYYY-MM-DD
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

export async function loadLogs(): Promise<LogMap> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as LogMap) : {};
  } catch {
    return {};
  }
}

export async function saveLogs(logs: LogMap): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(logs));
  } catch {
    // ignore write errors in MVP
  }
}

// Removes one meal from a day (by index) and persists. Returns the new map.
export function deleteMeal(logs: LogMap, date: string, index: number): LogMap {
  const day = logs[date];
  if (!day) return logs;
  const meals = day.meals.filter((_, i) => i !== index);
  const next: LogMap = { ...logs };
  if (meals.length === 0) delete next[date];
  else next[date] = { ...day, meals };
  saveLogs(next);
  return next;
}

export function dayTotal(logs: LogMap, date = todayKey()): number {
  const d = logs[date];
  return d ? d.meals.reduce((s, m) => s + m.kcal, 0) : 0;
}

export function dayMacros(logs: LogMap, date = todayKey()) {
  const meals = logs[date]?.meals ?? [];
  return {
    protein_g: Math.round(meals.reduce((s, m) => s + (m.protein_g || 0), 0)),
    carbs_g: Math.round(meals.reduce((s, m) => s + (m.carbs_g || 0), 0)),
    fat_g: Math.round(meals.reduce((s, m) => s + (m.fat_g || 0), 0)),
  };
}

export function mealCount(logs: LogMap, date = todayKey()): number {
  return logs[date]?.meals.length ?? 0;
}

// Consecutive days (ending today or yesterday) that have at least one meal.
export function computeStreak(logs: LogMap): number {
  let streak = 0;
  const d = new Date();
  // allow streak to hold if nothing logged yet *today* but yesterday had meals
  if (mealCount(logs, todayKey(d)) === 0) {
    d.setDate(d.getDate() - 1);
  }
  while (mealCount(logs, todayKey(d)) > 0) {
    streak += 1;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

// Longest run of consecutive logged days across all history.
export function bestStreak(logs: LogMap): number {
  const days = Object.keys(logs)
    .filter((k) => (logs[k]?.meals.length ?? 0) > 0)
    .sort();
  let best = 0;
  let run = 0;
  let prev: Date | null = null;
  for (const k of days) {
    const cur = new Date(k + "T00:00:00");
    if (prev) {
      const diff = Math.round((cur.getTime() - prev.getTime()) / 86400000);
      run = diff === 1 ? run + 1 : 1;
    } else {
      run = 1;
    }
    best = Math.max(best, run);
    prev = cur;
  }
  return best;
}

export type DayStat = {
  date: string;
  label: string; // e.g. "Mon"
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  meals: number;
};

// Returns stats for the last `n` days ending today (oldest first).
export function lastNDays(logs: LogMap, n = 7): DayStat[] {
  const out: DayStat[] = [];
  const d = new Date();
  d.setDate(d.getDate() - (n - 1));
  const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (let i = 0; i < n; i++) {
    const key = todayKey(d);
    const m = dayMacros(logs, key);
    out.push({
      date: key,
      label: WD[d.getDay()],
      kcal: dayTotal(logs, key),
      protein_g: m.protein_g,
      carbs_g: m.carbs_g,
      fat_g: m.fat_g,
      meals: mealCount(logs, key),
    });
    d.setDate(d.getDate() + 1);
  }
  return out;
}

// All days that have at least one meal, most recent first (for history list).
export function loggedDaysDesc(logs: LogMap): DayStat[] {
  const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return Object.keys(logs)
    .filter((k) => (logs[k]?.meals.length ?? 0) > 0)
    .sort()
    .reverse()
    .map((key) => {
      const m = dayMacros(logs, key);
      return {
        date: key,
        label: WD[new Date(key + "T00:00:00").getDay()],
        kcal: dayTotal(logs, key),
        protein_g: m.protein_g,
        carbs_g: m.carbs_g,
        fat_g: m.fat_g,
        meals: mealCount(logs, key),
      };
    });
}

export type DayState = "empty" | "future" | "hit" | "over" | "under";

export type MonthCell = {
  date: string;
  day: number; // 1..31
  weekday: number; // 0 Sun .. 6 Sat
  kcal: number;
  meals: number;
  state: DayState;
};

export type MonthStreak = {
  year: number;
  month: number; // 0..11
  label: string; // e.g. "August 2026"
  leading: number; // blank cells before day 1 (weekday of the 1st)
  cells: MonthCell[];
  hits: number; // days on target this month
  logged: number; // days with any meal this month
};

// Builds the current month's calendar with a per-day state relative to `goalKcal`.
// A day is "hit" when meals were logged and total kcal stayed within a healthy
// band of the goal (>= 55% and <= 105%). Logged-but-over is "over", logged-but
// well-under is "under", nothing logged (in the past/today) is "empty".
export function monthStreak(logs: LogMap, goalKcal: number, ref = new Date()): MonthStreak {
  const year = ref.getFullYear();
  const month = ref.getMonth();
  const MO = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayK = todayKey();

  const cells: MonthCell[] = [];
  let hits = 0;
  let logged = 0;
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(year, month, day);
    const key = todayKey(d);
    const kcal = dayTotal(logs, key);
    const meals = mealCount(logs, key);
    let state: DayState;
    if (key > todayK) {
      state = "future";
    } else if (meals === 0) {
      state = "empty";
    } else {
      logged += 1;
      const ratio = goalKcal > 0 ? kcal / goalKcal : 0;
      if (ratio > 1.05) state = "over";
      else if (ratio < 0.55) state = "under";
      else {
        state = "hit";
        hits += 1;
      }
    }
    cells.push({ date: key, day, weekday: d.getDay(), kcal, meals, state });
  }

  return {
    year,
    month,
    label: `${MO[month]} ${year}`,
    leading: first.getDay(),
    cells,
    hits,
    logged,
  };
}

// Human-friendly date label, e.g. "Today", "Yesterday" or "Mon, 11 Aug".
export function prettyDate(dateKey: string): string {
  if (dateKey === todayKey()) return "Today";
  const y = new Date();
  y.setDate(y.getDate() - 1);
  if (dateKey === todayKey(y)) return "Yesterday";
  const d = new Date(dateKey + "T00:00:00");
  const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${WD[d.getDay()]}, ${d.getDate()} ${MO[d.getMonth()]}`;
}
