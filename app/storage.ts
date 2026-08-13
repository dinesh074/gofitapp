import AsyncStorage from "@react-native-async-storage/async-storage";
import { Profile } from "./nutrition";

export type Meal = {
  dish: string;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  at: number;
  // Present once this meal has been synced to the server (backend/progress.py);
  // absent for a meal that only exists locally so far (e.g. offline, or the
  // sync call hasn't resolved yet).
  id?: number;
};
export type DayLog = { date: string; meals: Meal[] };
export type LogMap = Record<string, DayLog>;

const KEY = "calai.logs.v1";
const PROFILE_KEY = "calai.profile.v1";
const WEIGHTS_KEY = "calai.weights.v1";
const WATER_KEY = "calai.water.v1";
const HABITS_KEY = "calai.habits.v1";
const COMMUNITY_KEY = "calai.community.v1";
const DEVICE_KEY = "calai.device.v1";
const RECENTS_KEY = "calai.recents.v1";
const REMINDERS_KEY = "calai.reminders.v1";
// The account id that the locally-cached profile/logs/extras currently belong
// to. Local storage keys are global (not namespaced per account), so on a shared
// device we must be able to tell WHOSE data is sitting in the cache. This gates
// the local->server "backup" upload in App.tsx so one account's leftover local
// data can never be written into a different account's server rows.
const OWNER_KEY = "calai.owner.v1";

// Returns the account id that owns the current local cache, or null if unknown
// (fresh install, just-cleared cache, or legacy data from before this stamp).
export async function loadCacheOwner(): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(OWNER_KEY);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function saveCacheOwner(accountId: number): Promise<void> {
  try {
    await AsyncStorage.setItem(OWNER_KEY, String(accountId));
  } catch {
    // ignore
  }
}

export async function clearCacheOwner(): Promise<void> {
  try {
    await AsyncStorage.removeItem(OWNER_KEY);
  } catch {
    // ignore
  }
}

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

// --- Quick re-log: recent + favorite meals -------------------------------- //
// A snapshot of a logged meal so the user can re-add it in one tap without
// re-scanning. `fav` pins it to the top; `at` is last-used for recency order.
export type SavedMeal = {
  dish: string;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fav: boolean;
  at: number;
};

const RECENTS_CAP = 24; // keep the list small; favorites are never dropped

export async function loadRecents(): Promise<SavedMeal[]> {
  try {
    const raw = await AsyncStorage.getItem(RECENTS_KEY);
    return raw ? (JSON.parse(raw) as SavedMeal[]) : [];
  } catch {
    return [];
  }
}

async function saveRecents(list: SavedMeal[]): Promise<void> {
  try {
    await AsyncStorage.setItem(RECENTS_KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
}

// Order: favorites first, then most-recently used.
function sortRecents(list: SavedMeal[]): SavedMeal[] {
  return [...list].sort((a, b) => {
    if (a.fav !== b.fav) return a.fav ? -1 : 1;
    return b.at - a.at;
  });
}

// Record a meal into the quick-add list. De-dupes on dish name (case-insensitive):
// re-logging an existing meal just refreshes its numbers + recency and keeps
// any favorite flag. Trims to RECENTS_CAP but never drops favorites.
export async function recordRecentMeal(meal: Meal): Promise<SavedMeal[]> {
  const list = await loadRecents();
  const key = meal.dish.trim().toLowerCase();
  const existing = list.find((m) => m.dish.trim().toLowerCase() === key);
  const rest = list.filter((m) => m.dish.trim().toLowerCase() !== key);
  const entry: SavedMeal = {
    dish: meal.dish,
    kcal: meal.kcal,
    protein_g: meal.protein_g,
    carbs_g: meal.carbs_g,
    fat_g: meal.fat_g,
    fav: existing?.fav ?? false,
    at: Date.now(),
  };
  let next = sortRecents([entry, ...rest]);
  if (next.length > RECENTS_CAP) {
    const favs = next.filter((m) => m.fav);
    const others = next.filter((m) => !m.fav).slice(0, Math.max(0, RECENTS_CAP - favs.length));
    next = sortRecents([...favs, ...others]);
  }
  await saveRecents(next);
  return next;
}

export async function toggleFavoriteMeal(dish: string): Promise<SavedMeal[]> {
  const list = await loadRecents();
  const key = dish.trim().toLowerCase();
  const next = list.map((m) =>
    m.dish.trim().toLowerCase() === key ? { ...m, fav: !m.fav } : m
  );
  const sorted = sortRecents(next);
  await saveRecents(sorted);
  return sorted;
}

export async function removeRecentMeal(dish: string): Promise<SavedMeal[]> {
  const list = await loadRecents();
  const key = dish.trim().toLowerCase();
  const next = list.filter((m) => m.dish.trim().toLowerCase() !== key);
  await saveRecents(next);
  return next;
}

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

// --- Water + habit tracking (local cache) --------------------------------- //
// Keyed by day ("YYYY-MM-DD"), mirroring the server tables in wellness.py so
// the dashboard renders instantly on boot and stays correct once the server
// reads resolve. No AI, no scan credit involved anywhere in this data.

export const WATER_GLASS_ML = 250; // one "glass" tap = 250 ml
// The daily water/step *goal* used to live here as a flat constant shown to
// every account. It's personalized now -- see nutrition.ts's
// computeWaterGoalMl / computeStepGoal, derived from the profile's
// weightKg/activity instead of one-size-fits-all.

export type WaterMap = Record<string, number>; // date -> ml total
export type HabitKind = "steps" | "workout_min" | "sleep_hr";
export type HabitMap = Record<string, Partial<Record<HabitKind, number>>>;

export async function loadWater(): Promise<WaterMap> {
  try {
    const raw = await AsyncStorage.getItem(WATER_KEY);
    return raw ? (JSON.parse(raw) as WaterMap) : {};
  } catch {
    return {};
  }
}

export async function saveWater(map: WaterMap): Promise<void> {
  try {
    await AsyncStorage.setItem(WATER_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

export async function loadHabits(): Promise<HabitMap> {
  try {
    const raw = await AsyncStorage.getItem(HABITS_KEY);
    return raw ? (JSON.parse(raw) as HabitMap) : {};
  } catch {
    return {};
  }
}

export async function saveHabits(map: HabitMap): Promise<void> {
  try {
    await AsyncStorage.setItem(HABITS_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
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
    await AsyncStorage.multiRemove([WEIGHTS_KEY, COMMUNITY_KEY, WATER_KEY, HABITS_KEY, RECENTS_KEY]);
  } catch {
    // ignore
  }
}

// --- Reminder preference -------------------------------------------------- //
// Whether local meal + water reminders are enabled. Defaults to ON (true) so
// users get nudges out of the box; the Settings toggle flips this and the app
// re-schedules or cancels via push.ts accordingly.
export async function loadRemindersEnabled(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(REMINDERS_KEY);
    return raw === null ? true : raw === "1";
  } catch {
    return true;
  }
}

export async function saveRemindersEnabled(on: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(REMINDERS_KEY, on ? "1" : "0");
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
