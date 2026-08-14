import AsyncStorage from "@react-native-async-storage/async-storage";
import { Profile } from "./nutrition";

// The six real-world eating occasions (not just "meal"/"snack") the user
// actually wants to see distinguished on the calendar/day view -- inferred
// automatically from local clock time at log time (see inferMealType), but
// always overridable per-meal later if the guess is wrong.
export const MEAL_TYPES = [
  "breakfast",
  "morning_snack",
  "lunch",
  "afternoon_snack",
  "evening_snack",
  "dinner",
] as const;
export type MealType = (typeof MEAL_TYPES)[number];

export const MEAL_TYPE_LABEL: Record<MealType, string> = {
  breakfast: "Breakfast",
  morning_snack: "Morning snack",
  lunch: "Lunch",
  afternoon_snack: "Afternoon snack",
  evening_snack: "Evening snack",
  dinner: "Dinner",
};

// Buckets by *local* clock hour -- deliberately client-side (not inferred on
// the server) because the server has no idea what timezone the user is
// actually in; this is computed once, at log time, from `new Date()`.
export function inferMealType(atMs: number): MealType {
  const h = new Date(atMs).getHours();
  if (h >= 5 && h < 10) return "breakfast";
  if (h >= 10 && h < 12) return "morning_snack";
  if (h >= 12 && h < 15) return "lunch";
  if (h >= 15 && h < 18) return "afternoon_snack";
  if (h >= 18 && h < 20) return "evening_snack";
  return "dinner";
}

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
  // Summed micronutrients for this meal (fibre, iron, sodium, etc.), captured
  // at log time. Comes from verified DB-matched items when available; when an
  // item couldn't be matched to the food DB, the vision model's own best-guess
  // estimate is used instead (see microsEstimated below) -- either way this is
  // now synced to the server (meal_logs.micros, JSON) so it survives reloads/
  // other devices -- powers the daily + per-meal micronutrient views (see
  // micros.ts).
  micros?: Record<string, number>;
  // True when ANY item contributing to `micros` came from the AI's own
  // estimate rather than a verified food-DB record (backend/main.py's
  // `micros_source`/`totals.micros_estimated`). The UI MUST show this
  // distinctly ("Estimated" badge/note) rather than presenting AI guesses as
  // if they were verified lab data -- honesty matters here (see micros.ts).
  microsEstimated?: boolean;
  // Which eating occasion this was -- see inferMealType(). Always set for
  // meals logged after this feature shipped; older synced rows fall back to
  // the server's own best-effort guess (backend/progress.py's _infer_meal_type).
  mealType?: MealType;
  // Storage object path for the scanned photo (backend/blob_storage.py's
  // private meal-photos bucket) -- only present for photo-scanned meals, and
  // only until the server's 7-day photo-retention window clears it.
  photoPath?: string;
  // Short-lived signed URL to actually load the photo, refreshed every time
  // the server returns this meal (see /logs) -- never persisted verbatim
  // since Supabase signed URLs expire.
  photoUrl?: string;
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
  return d ? d.meals.reduce((s, m) => s + (m.kcal || 0), 0) : 0;
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
  monthLabel?: string; // "Aug" -- set on the 1st of each month a window spans,
  // so a rolling window crossing a month boundary can still label itself.
};

export type MonthStreak = {
  label: string; // e.g. "Last 30 days" (or "Jul 16 - Aug 14" style range)
  leading: number; // blank cells before the first cell (weekday of day 1 of window)
  cells: MonthCell[];
  hits: number; // days on target within the window
  logged: number; // days with any meal within the window
};

// Builds a ROLLING window ending today (NOT the calendar month) with a
// per-day state relative to `goalKcal`. Deliberately not "this calendar
// month" -- on day 1-27 of any month that would show mostly blank "future"
// cells for the rest of the month and completely omit real history from the
// previous month, which is exactly backwards for a habit-streak view. A day
// is "hit" when meals were logged and total kcal stayed within a healthy band
// of the goal (>= 55% and <= 105%). Logged-but-over is "over", logged-but
// well-under is "under", nothing logged (today or in the past) is "empty".
export function monthStreak(logs: LogMap, goalKcal: number, ref = new Date(), days = 30): MonthStreak {
  const todayK = todayKey(ref);
  const start = new Date(ref);
  start.setDate(start.getDate() - (days - 1));

  const cells: MonthCell[] = [];
  let hits = 0;
  let logged = 0;
  const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
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
    cells.push({
      date: key,
      day: d.getDate(),
      weekday: d.getDay(),
      kcal,
      meals,
      state,
      // Label the 1st of the month (and the very first cell, so a window
      // starting mid-month still shows what month it's in) with "Mon" so the
      // grid reads correctly across a month boundary at a glance.
      monthLabel: d.getDate() === 1 || i === 0 ? MO[d.getMonth()] : undefined,
    });
  }

  const startLabel = `${MO[start.getMonth()]} ${start.getDate()}`;
  const endLabel = `${MO[ref.getMonth()]} ${ref.getDate()}`;
  return {
    label: `${startLabel} – ${endLabel}`,
    leading: cells[0].weekday,
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

// --- Progress tab helpers ---------------------------------------------------
// Real weigh-ins (weight_logs, server-durable, never retention-purged) are
// noisy day to day -- water, food in the stomach, time of day. A trailing
// moving average is what actually shows the TREND rather than treating every
// bounce as real progress/regress. Returns one smoothed point per input entry
// (same length/order), so it can be overlaid on the same time axis as the
// actual points.
export function movingAverageWeights(sorted: WeightEntry[], window = 5): number[] {
  return sorted.map((_, i) => {
    const from = Math.max(0, i - window + 1);
    const slice = sorted.slice(from, i + 1);
    return slice.reduce((s, w) => s + w.kg, 0) / slice.length;
  });
}

export type GoalProjection = {
  slopeKgPerDay: number; // negative = losing, positive = gaining
  etaDate: string | null; // ISO date the trend reaches target, or null if flat/diverging
  daysToGo: number | null;
  onTrack: boolean; // slope direction actually points toward the target
};

// Linear fit (least squares) over the last `windowDays` of REAL weigh-ins to
// project an ETA to the profile's target weight -- "on track for 68kg by Oct
// 14" style. Returns null when there isn't enough real data (need >=2 entries
// spanning >=2 distinct days) to fit a trend from, rather than guessing.
export function projectGoalWeight(
  weights: WeightEntry[],
  targetKg: number,
  windowDays = 14,
): GoalProjection | null {
  const sorted = [...weights].sort((a, b) => a.at - b.at);
  const cutoff = Date.now() - windowDays * 86400000;
  const recent = sorted.filter((w) => w.at >= cutoff);
  const pts = recent.length >= 2 ? recent : sorted.slice(-Math.max(2, recent.length));
  if (pts.length < 2) return null;
  const t0 = pts[0].at;
  const days = pts.map((w) => (w.at - t0) / 86400000);
  const kgs = pts.map((w) => w.kg);
  const n = days.length;
  const sumX = days.reduce((s, x) => s + x, 0);
  const sumY = kgs.reduce((s, y) => s + y, 0);
  const sumXY = days.reduce((s, x, i) => s + x * kgs[i], 0);
  const sumXX = days.reduce((s, x) => s + x * x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return { slopeKgPerDay: 0, etaDate: null, daysToGo: null, onTrack: false };
  const slope = (n * sumXY - sumX * sumY) / denom; // kg per day
  const intercept = (sumY - slope * sumX) / n;
  const lastDay = days[days.length - 1];
  const currentTrendKg = intercept + slope * lastDay;
  const delta = targetKg - currentTrendKg;
  const onTrack = Math.abs(slope) > 1e-6 && Math.sign(slope) === Math.sign(delta);
  if (!onTrack) {
    return { slopeKgPerDay: Math.round(slope * 1000) / 1000, etaDate: null, daysToGo: null, onTrack: false };
  }
  const daysToGo = Math.round(delta / slope);
  const eta = new Date(t0 + (lastDay + daysToGo) * 86400000);
  return {
    slopeKgPerDay: Math.round(slope * 1000) / 1000,
    etaDate: eta.toISOString().slice(0, 10),
    daysToGo,
    onTrack: true,
  };
}

// Consistency score: % of calendar days in the window that have a durable
// log_days entry (see backend/progress.py) -- honest for 90-day/all-time
// windows the 30-day meal_logs retention would otherwise silently clip. If
// `windowDays` is null ("all time"), the denominator is the number of days
// since the account's first-ever logged day (not since install).
export function consistencyScore(
  loggedDates: string[],
  windowDays: number | null,
): { pct: number; loggedCount: number; totalDays: number } {
  if (loggedDates.length === 0) return { pct: 0, loggedCount: 0, totalDays: windowDays ?? 0 };
  const sorted = [...loggedDates].sort();
  const today = todayKey();
  let totalDays: number;
  if (windowDays !== null) {
    totalDays = windowDays;
  } else {
    const first = new Date(sorted[0] + "T00:00:00");
    const last = new Date(today + "T00:00:00");
    totalDays = Math.max(1, Math.round((last.getTime() - first.getTime()) / 86400000) + 1);
  }
  const loggedCount = sorted.length;
  return { pct: totalDays > 0 ? Math.round((loggedCount / totalDays) * 100) : 0, loggedCount, totalDays };
}

