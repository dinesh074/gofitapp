import AsyncStorage from "@react-native-async-storage/async-storage";

// Guided workout library sourced from the public-domain (Unlicense)
// free-exercise-db (https://github.com/yuhonas/free-exercise-db). Data +
// demonstration photos are served from the jsDelivr CDN. This is reference
// content -- like our food database -- not user data, so it's fetched once and
// cached on the device rather than proxied through our backend.

const DATA_URL = "https://cdn.jsdelivr.net/gh/yuhonas/free-exercise-db@main/dist/exercises.json";
const IMAGE_BASE = "https://cdn.jsdelivr.net/gh/yuhonas/free-exercise-db@main/exercises/";
const CACHE_KEY = "workout_library_v1";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // refresh weekly

export type WorkoutLevel = "beginner" | "intermediate" | "expert";

export type Workout = {
  id: string;
  name: string;
  force: string | null;
  level: WorkoutLevel;
  mechanic: string | null;
  equipment: string | null;
  primaryMuscles: string[];
  secondaryMuscles: string[];
  instructions: string[];
  category: string;
  images: string[]; // relative paths, e.g. "3_4_Sit-Up/0.jpg"
};

// Turn a relative image path from the dataset into a full CDN URL.
export function workoutImageUrl(relPath: string): string {
  return IMAGE_BASE + relPath;
}

// Approximate MET per category so a logged guided exercise still produces real
// calories-burned via the backend (kcal = MET * weight * hours). These are
// standard Compendium-of-Physical-Activities ballparks for the movement type;
// duration is what the user actually enters.
const CATEGORY_MET: Record<string, number> = {
  strength: 5.0,
  stretching: 2.5,
  plyometrics: 8.0,
  strongman: 6.0,
  powerlifting: 6.0,
  "olympic weightlifting": 6.0,
  cardio: 8.0,
  "cardio conditioning": 8.0,
};

export function metForCategory(category: string): number {
  return CATEGORY_MET[category?.toLowerCase()] ?? 5.0;
}

type CacheShape = { at: number; data: Workout[] };

let _memCache: Workout[] | null = null;

function coerce(raw: any): Workout | null {
  if (!raw || typeof raw.id !== "string" || typeof raw.name !== "string") return null;
  return {
    id: raw.id,
    name: raw.name,
    force: raw.force ?? null,
    level: (raw.level as WorkoutLevel) ?? "beginner",
    mechanic: raw.mechanic ?? null,
    equipment: raw.equipment ?? null,
    primaryMuscles: Array.isArray(raw.primaryMuscles) ? raw.primaryMuscles : [],
    secondaryMuscles: Array.isArray(raw.secondaryMuscles) ? raw.secondaryMuscles : [],
    instructions: Array.isArray(raw.instructions) ? raw.instructions : [],
    category: typeof raw.category === "string" ? raw.category : "strength",
    images: Array.isArray(raw.images) ? raw.images : [],
  };
}

// Returns the full library, preferring a fresh device cache and falling back to
// the network. Throws only when there's neither cache nor a reachable CDN.
export async function loadWorkouts(): Promise<Workout[]> {
  if (_memCache) return _memCache;

  // 1. Try a still-fresh cache.
  try {
    const rawCache = await AsyncStorage.getItem(CACHE_KEY);
    if (rawCache) {
      const parsed = JSON.parse(rawCache) as CacheShape;
      if (parsed?.data?.length && Date.now() - parsed.at < CACHE_TTL_MS) {
        _memCache = parsed.data;
        return parsed.data;
      }
    }
  } catch {
    // ignore malformed cache -- we'll refetch
  }

  // 2. Fetch from the CDN.
  try {
    const res = await fetch(DATA_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as any[];
    const data = json.map(coerce).filter((w): w is Workout => w !== null);
    _memCache = data;
    AsyncStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data })).catch(() => {});
    return data;
  } catch (e) {
    // 3. Stale cache is better than nothing if the network is down.
    try {
      const rawCache = await AsyncStorage.getItem(CACHE_KEY);
      if (rawCache) {
        const parsed = JSON.parse(rawCache) as CacheShape;
        if (parsed?.data?.length) {
          _memCache = parsed.data;
          return parsed.data;
        }
      }
    } catch {
      // fall through
    }
    throw new Error("Couldn't load the exercise library. Check your connection and try again.");
  }
}

export type WorkoutFilter = { category?: string; muscle?: string; equipment?: string; query?: string };

export function filterWorkouts(all: Workout[], f: WorkoutFilter): Workout[] {
  const q = f.query?.trim().toLowerCase();
  return all.filter((w) => {
    if (f.category && w.category !== f.category) return false;
    if (f.equipment && w.equipment !== f.equipment) return false;
    if (f.muscle && !w.primaryMuscles.includes(f.muscle) && !w.secondaryMuscles.includes(f.muscle)) return false;
    if (q && !w.name.toLowerCase().includes(q)) return false;
    return true;
  });
}

// Distinct, sorted facet values present in the loaded dataset (for filter chips).
export function facet(all: Workout[], key: "category" | "equipment"): string[] {
  const set = new Set<string>();
  for (const w of all) {
    const v = w[key];
    if (v) set.add(v);
  }
  return [...set].sort();
}

export function muscleFacet(all: Workout[]): string[] {
  const set = new Set<string>();
  for (const w of all) for (const m of w.primaryMuscles) set.add(m);
  return [...set].sort();
}
