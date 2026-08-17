import { Platform } from "react-native";
import { API_BASE, API_KEY } from "./config";
import { Account, getToken } from "./auth";
import { Profile, Diet, normalizeProfile } from "./nutrition";
import { Meal, LogMap, WeightEntry } from "./storage";
import { dbFoodToCandidate, Candidate } from "./mealSuggest";

// Full vitamin/mineral panel, keyed by friendly name (e.g. "vitamin_c_mg",
// "saturated_fat_mg") -- see backend/build_db_v2.py for the exact field list.
export type MicroPanel = Record<string, number>;

export type FoodItem = {
  key?: string;
  id?: number;
  item: string;
  count: number;
  unit: string;
  kcal_per_unit: number;
  protein_g_per_unit: number;
  carbs_g_per_unit: number;
  fat_g_per_unit: number;
  fiber_g_per_unit?: number;
  sugar_g_per_unit?: number;
  sodium_mg_per_unit?: number;
  potassium_mg_per_unit?: number;
  calcium_mg_per_unit?: number;
  iron_mg_per_unit?: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  kcal_total: number;
  countable: boolean;
  source?: string;
  // v2: present when matched against the food DB (source === "db", verified
  // lab/curated data) OR when the vision model supplied its own best-guess
  // estimate for an unmatched item (source === "ai") -- always check
  // micros_source before displaying, since these two cases must be labeled
  // differently in the UI (verified vs "Estimated").
  fiber_g?: number;
  sugar_g?: number;
  sodium_mg?: number;
  potassium_mg?: number;
  calcium_mg?: number;
  iron_mg?: number;
  micros?: MicroPanel;
  // "db" = verified food-DB record; "ai_estimated" = the vision model's own
  // best-guess nutrition estimate for an item that didn't match the DB (a
  // photo can't show iron/vitamin C -- this is knowledge, not observation).
  micros_source?: "db" | "ai_estimated";
  // Per-unit micro panel (see backend/main.py's anchor_items) -- lets the
  // client recompute `micros` correctly when the user edits portion count
  // after the initial analyze response, instead of trusting a stale total.
  micros_per_unit?: MicroPanel;
  // App-computed (see backend/build_db_v2.py's health_score()) -- NOT an
  // official rating, NOT medical advice. Descriptive of the food itself, so
  // this does not change when you adjust the count/portion.
  health_score?: number;
  benefits?: string[];
  watch_outs?: string[];
};

export type Macros = { kcal: number; protein_g: number; carbs_g: number; fat_g: number };
// Meal-level totals, as returned by /analyze*: full Macros plus an optional
// summed micronutrient panel and a flag for whether ANY contributing item's
// micros came from an AI estimate rather than a verified DB match (see
// FoodItem.micros_source) -- the UI must surface this honestly.
export type Totals = Macros & { micros?: MicroPanel; micros_estimated?: boolean };

// A single clarifying question the photo couldn't resolve (thali flow). Each
// option's `factor` multiplies its target item's per-unit kcal AND macros; the
// baseline option (default_index) is always factor 1.0, so leaving a question
// unanswered keeps the model's original estimate.
export type PortionOption = { label: string; factor: number };
export type PortionQuestion = {
  id: string;
  prompt: string;
  target_item: number;
  options: PortionOption[];
  default_index: number;
};

export type Usage = {
  is_pro: boolean;
  scans_used: number;
  scans_limit: number;
  allowed: boolean;
};

export type AnalysisResult = {
  dish: string;
  cuisine: string;
  items: FoodItem[];
  calories_kcal: number;
  confidence: number;
  totals: Totals;
  questions?: PortionQuestion[];
  usage?: Usage;
  from_cache?: boolean;
  // Present only when the scan successfully uploaded to the private
  // meal-photos Storage bucket (backend/blob_storage.py) -- pass photo_path
  // straight through into addServerLog() so the logged meal keeps its photo.
  // photo_url is a short-lived signed URL, good for showing the photo right
  // now; it is NOT meant to be cached/persisted verbatim (it expires).
  photo_path?: string;
  photo_url?: string;
  scan_result_id?: number;
};

// Thrown by analyzeImage when the free-scan trial is exhausted (HTTP 402).
export class PaywallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaywallError";
  }
}

// Thrown when scanning requires a signed-in account (HTTP 401).
export class AuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthRequiredError";
  }
}

// Thrown by analyzeBarcode when the product isn't in the barcode database
// (HTTP 404) -- the caller uses this to offer a photo/text scan fallback.
export class BarcodeNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BarcodeNotFoundError";
  }
}

// Uploads an image (local uri) to the backend /analyze endpoint.
export async function analyzeImage(uri: string): Promise<AnalysisResult> {
  const form = new FormData();
  const name = uri.split("/").pop() || "photo.jpg";
  const match = /\.(\w+)$/.exec(name);
  const type = match ? `image/${match[1].toLowerCase()}` : "image/jpeg";

  if (Platform.OS === "web") {
    // On web the uri is a blob:/data: URL — turn it into a real Blob/File.
    const blob = await (await fetch(uri)).blob();
    form.append("file", blob, name);
  } else {
    // React Native native FormData file shape.
    form.append("file", { uri, name, type } as any);
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (API_KEY) headers["X-API-Key"] = API_KEY;
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/analyze`, {
      method: "POST",
      body: form,
      headers,
    });
  } catch {
    // Network-level failure (server down, wrong API_BASE, no connectivity).
    throw new Error(
      "Can't reach the server. Check your connection and that the backend is running."
    );
  }

  if (!res.ok) {
    const msg = await friendlyError(res);
    if (res.status === 402) throw new PaywallError(msg);
    if (res.status === 401) throw new AuthRequiredError(msg);
    throw new Error(msg);
  }
  return (await res.json()) as AnalysisResult;
}

// Text (or voice-transcribed) meal logging -- same free-scan gate and
// response shape as analyzeImage(), just describing the meal in words
// instead of a photo. Useful when a photo isn't practical, and doubles as
// the pipeline voice logging feeds into (speech -> text -> this call).
export async function analyzeText(description: string): Promise<AnalysisResult> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (API_KEY) headers["X-API-Key"] = API_KEY;
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/analyze/text`, {
      method: "POST",
      headers,
      body: JSON.stringify({ description }),
    });
  } catch {
    throw new Error(
      "Can't reach the server. Check your connection and that the backend is running."
    );
  }
  if (!res.ok) {
    const msg = await friendlyError(res);
    if (res.status === 402) throw new PaywallError(msg);
    if (res.status === 401) throw new AuthRequiredError(msg);
    throw new Error(msg);
  }
  return (await res.json()) as AnalysisResult;
}

export async function listScanResults(limit = 50): Promise<Array<{ id: number; confidence: number; status: string; created_at: number }>> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/scan/results?limit=${limit}`, { headers: authHeaders() });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const data = (await res.json()) as { results?: Array<{ id: number; confidence: number; status: string; created_at: number }> };
  return data.results ?? [];
}

export async function submitScanCorrection(input: {
  scan_result_id: number;
  item_name: string;
  from_food_name?: string;
  to_food_name?: string;
  note?: string;
}): Promise<boolean> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/scan/corrections`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify(input),
    });
  } catch {
    return false;
  }
  return res.ok;
}

// Barcode (packaged-food) logging. Unlike analyzeImage/analyzeText this is a
// deterministic OpenFoodFacts lookup on the backend, NOT a Gemini call, so it
// does NOT consume a free-scan credit -- there's no PaywallError path here.
// A 404 means the product isn't in the database; the caller catches
// BarcodeNotFoundError and offers a photo/text scan instead.
export async function analyzeBarcode(code: string): Promise<AnalysisResult> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (API_KEY) headers["X-API-Key"] = API_KEY;
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/analyze/barcode`, {
      method: "POST",
      headers,
      body: JSON.stringify({ code }),
    });
  } catch {
    throw new Error(
      "Can't reach the server. Check your connection and that the backend is running."
    );
  }
  if (!res.ok) {
    const msg = await friendlyError(res);
    if (res.status === 401) throw new AuthRequiredError(msg);
    if (res.status === 404) throw new BarcodeNotFoundError(msg);
    throw new Error(msg);
  }
  return (await res.json()) as AnalysisResult;
}
// Ingredient swap: free, in-memory search over the food DB so a user can
// replace a mis-identified item with the right one. Like analyzeBarcode this
// is a plain lookup (no Gemini) and never consumes a free-scan credit.
export type FoodSuggestion = {
  key: string;
  name: string;
  unit: string;
  kcal_per_unit: number;
  protein_g_per_unit: number;
  carbs_g_per_unit: number;
  fat_g_per_unit: number;
  fiber_g?: number;
  sugar_g?: number;
  sodium_mg?: number;
  potassium_mg?: number;
  calcium_mg?: number;
  iron_mg?: number;
  micros?: MicroPanel;
  health_score?: number;
  benefits?: string[];
  watch_outs?: string[];
};

export async function searchFoods(q: string, limit = 20): Promise<FoodSuggestion[]> {
  const query = q.trim();
  if (!query) return [];
  let res: Response;
  try {
    res = await fetch(
      `${API_BASE}/foods/search?q=${encodeURIComponent(query)}&limit=${limit}`,
      { headers: authHeaders() }
    );
  } catch {
    throw new Error("Can't reach the server. Check your connection.");
  }
  if (!res.ok) {
    const msg = await friendlyError(res);
    if (res.status === 401) throw new AuthRequiredError(msg);
    throw new Error(msg);
  }
  const data = (await res.json()) as { results: FoodSuggestion[] };
  return data.results;
}

// Meal combinations: given the dishes on the plate, the typical accompaniments
// ("Goes well with"). Same free local lookup as searchFoods -- no AI, no scan
// credit. Pairings are a nice-to-have, so any failure resolves to an empty list
// rather than surfacing an error and blocking the result screen.
export type Pairing = FoodSuggestion & {
  count?: number;
  reason?: string;
  pairs_with?: string;
};

export type RecipeIngredientInput = {
  food_key: string;
  quantity: number;
  quantity_unit: string;
  notes?: string;
};

export type RecipeTemplateSummary = {
  id: number;
  recipe_code: string;
  name: string;
  servings: number;
  source: string;
};

export type RecipeTemplateDetail = {
  id: number;
  recipe_code: string;
  name: string;
  servings: number;
  source: string;
  notes?: string;
  ingredients: Array<{
    food_key: string;
    quantity: number;
    quantity_unit: string;
    notes?: string;
  }>;
};

export type RecipeTemplateEstimate = {
  items: Array<{
    food_key: string;
    name: string;
    unit: string;
    count: number;
    kcal: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
  }>;
  totals: { kcal: number; protein_g: number; carbs_g: number; fat_g: number };
};

export async function saveRecipeTemplate(input: {
  recipe_code: string;
  name: string;
  servings: number;
  ingredients: RecipeIngredientInput[];
  source?: string;
}): Promise<{ ok: boolean; id: number; recipe_code: string }> {
  return postAuth("/recipes", {
    recipe_code: input.recipe_code,
    name: input.name,
    servings: input.servings,
    ingredients: input.ingredients,
    source: input.source ?? "user",
  });
}

export async function searchRecipeTemplates(q: string, limit = 12): Promise<RecipeTemplateSummary[]> {
  const query = q.trim();
  if (!query) return [];
  let res: Response;
  try {
    res = await fetch(
      `${API_BASE}/recipes/search?q=${encodeURIComponent(query)}&limit=${limit}`,
      { headers: authHeaders() }
    );
  } catch {
    throw new Error("Can't reach the server. Check your connection.");
  }
  if (!res.ok) {
    const msg = await friendlyError(res);
    if (res.status === 401) throw new AuthRequiredError(msg);
    throw new Error(msg);
  }
  const data = (await res.json()) as { results?: RecipeTemplateSummary[] };
  return data.results ?? [];
}

export async function getRecipeTemplate(
  recipeId: number
): Promise<{ recipe: RecipeTemplateDetail; estimate: RecipeTemplateEstimate }> {
  return getJson<{ recipe: RecipeTemplateDetail; estimate: RecipeTemplateEstimate }>(`/recipes/${recipeId}`);
}

export async function getCombos(dishes: string[], limit = 6): Promise<Pairing[]> {
  const q = dishes.map((d) => d.trim()).filter(Boolean).join("|");
  if (!q) return [];
  let res: Response;
  try {
    res = await fetch(
      `${API_BASE}/foods/combos?dish=${encodeURIComponent(q)}&limit=${limit}`,
      { headers: authHeaders() }
    );
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const data = (await res.json()) as { pairings?: Pairing[] };
  return data.pairings ?? [];
}

// Real "what to eat next" over the WHOLE food DB, ranked server-side against the
// user's ACTUAL remaining macros and filtered to their diet (that's where the
// veg/non-veg data lives) -- plus an optional Gemini one-liner grounded in the
// ranked foods. This is a plain DB+ranking call (like search/barcode): it needs
// auth but consumes NO scan credit and never hits the vision model. Never throws
// -- on any failure it returns an empty pool so the caller falls back to the
// built-in ideas + the user's own recents.
export async function recommendMeals(
  remaining: { kcal: number; protein_g: number; carbs_g: number; fat_g: number },
  diet: Diet,
  goal: string,
  slot = "",
  options: {
    targets?: { kcal: number; protein_g: number; carbs_g: number; fat_g: number };
    consumed?: { kcal: number; protein_g: number; carbs_g: number; fat_g: number };
    date?: string;
    training?: string;
    aiMode?: boolean;
    profile?: PlannerProfileContext;
    hour?: number;
  } = {},
  limit = 12,
): Promise<{
  candidates: Candidate[];
  suggestion: string | null;
  slot?: string;
  nextMove?: {
    category: string;
    slot: string;
    reason: string;
    meal: {
      name: string;
      kcal: number;
      protein_g: number;
      carbs_g: number;
      fat_g: number;
      items: { name: string; count: number; unit: string; kcal: number; protein_g: number; carbs_g: number; fat_g: number }[];
    };
    alternatives: {
      name: string;
      kcal: number;
      protein_g: number;
      carbs_g: number;
      fat_g: number;
      items: { name: string; count: number; unit: string; kcal: number; protein_g: number; carbs_g: number; fat_g: number }[];
    }[];
  };
}> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/foods/recommend`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({
        remaining,
        diet,
        goal,
        slot,
        limit,
        phrase: true,
        ...(options.targets ? { targets: options.targets } : {}),
        ...(options.consumed ? { consumed: options.consumed } : {}),
        ...(options.date ? { date: options.date } : {}),
        ...(options.training ? { training: options.training } : {}),
        ...(options.aiMode ? { ai_mode: true } : {}),
        ...(options.profile ? { profile: options.profile } : {}),
        ...(options.hour !== undefined ? { hour: options.hour } : {}),
      }),
    });
  } catch {
    return { candidates: [], suggestion: null };
  }
  if (!res.ok) return { candidates: [], suggestion: null };
  let data: {
    results?: FoodSuggestion[];
    suggestion?: string;
    slot?: string;
    next_move?: {
      category: string;
      slot: string;
      reason: string;
      meal: {
        name: string;
        kcal: number;
        protein_g: number;
        carbs_g: number;
        fat_g: number;
        items: { name: string; count: number; unit: string; kcal: number; protein_g: number; carbs_g: number; fat_g: number }[];
      };
      alternatives: {
        name: string;
        kcal: number;
        protein_g: number;
        carbs_g: number;
        fat_g: number;
        items: { name: string; count: number; unit: string; kcal: number; protein_g: number; carbs_g: number; fat_g: number }[];
      }[];
    };
  };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    return { candidates: [], suggestion: null };
  }
  // The backend already diet-filtered for THIS user, so tag every candidate as
  // universally allowed ("veg") -- the client must not re-filter and drop a
  // valid pick (e.g. a chicken dish that a non-veg user should see).
  const candidates = (data.results ?? []).map((h) => dbFoodToCandidate(h, "veg"));
  return {
    candidates,
    suggestion: data.suggestion ?? null,
    slot: data.slot,
    nextMove: data.next_move
      ? {
          category: data.next_move.category,
          slot: data.next_move.slot,
          reason: data.next_move.reason,
          meal: data.next_move.meal,
          alternatives: data.next_move.alternatives ?? [],
        }
      : undefined,
  };
}

// "Should I eat this?" — server-side verdict for a scanned meal vs. the day's
// remaining budget + training context, with a grounded Gemini advice line. Like
// recommendMeals this needs auth but consumes NO scan credit and never hits the
// vision model. Never throws — returns null on any failure so the caller falls
// back to the on-device deterministic verdict (app/mealVerdict.ts).
export type ApiVerdictLine = { state: "green" | "yellow" | "red"; text: string };
export type ApiVerdict = {
  overall: "green" | "yellow" | "red";
  headline: string;
  lines: ApiVerdictLine[];
  advice: string;
  fitFraction: number | null;
  source: "ai" | "rule";
};

export async function fetchMealVerdict(input: {
  meal: { kcal: number; protein_g: number; carbs_g: number; fat_g: number };
  consumed: { kcal: number; protein_g: number; carbs_g: number; fat_g: number };
  goal: { kcal: number; protein_g: number; carbs_g: number; fat_g: number };
  goalName?: string;
  training?: string;
  dish?: string;
}): Promise<ApiVerdict | null> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/meals/verdict`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({
        meal: input.meal,
        consumed: input.consumed,
        goal: input.goal,
        goal_name: input.goalName ?? "maintain",
        training: input.training ?? "",
        dish: input.dish ?? "",
        phrase: true,
      }),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const data = (await res.json()) as ApiVerdict;
    if (!data || !Array.isArray(data.lines) || !data.overall) return null;
    return data;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------- //
//  AI daily meal plan (see backend/plan.py) -- persisted server-side per
//  account/day, generated from the user's real targets + the food DB, stable
//  until the profile/goal/pace (hence targets) change. Needs auth, consumes NO
//  scan credit, never hits the vision model. Never throws -- returns null on any
//  failure so the caller can fall back gracefully.
// --------------------------------------------------------------------------- //
export type PlanMacros = { kcal: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g?: number };

export type PlanItem = {
  key: string;
  name: string;
  unit: string;
  count: number;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g?: number;
};

export type PlanSlot = {
  slot: string;
  label: string;
  target_kcal: number;
  items: PlanItem[];
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g?: number;
  // Present only when the plan is adapted to what's been logged today: whether
  // this meal is still ahead of the user (re-portioned to the remaining budget)
  // or already behind them (left as-is), and whether the day's budget is spent.
  upcoming?: boolean;
  over_budget?: boolean;
  actionable?: boolean;
  completed?: boolean;
};

export type DayPlan = {
  date: string;
  signature: string;
  targets: PlanMacros;
  totals: PlanMacros;
  slots: PlanSlot[];
  coach_note?: string;
  generated_at: number;
  // Present when `consumed` was sent: the live adaptation layer.
  adapted?: boolean;
  consumed?: PlanMacros;
  remaining?: PlanMacros;
  over_target?: PlanMacros;
  completed_slots?: string[];
  planned_slots?: string[];
  next_slot?: string | null;
  next_meal?: string | null;
  planned?: PlanMacros;
  projected?: PlanMacros;
  status?: Record<string, "on_target" | "slightly_below" | "slightly_above" | "significantly_below" | "significantly_above">;
};

export type PlannerProfileContext = {
  age?: number;
  gender?: string;
  height_cm?: number;
  weight_kg?: number;
  target_weight_kg?: number;
  activity?: string;
  goal_pace?: string;
  goal_kind?: string;
  diet?: string;
  goal?: string;
  on_glp1?: boolean;
};

export async function fetchTodayPlan(input: {
  targets: PlanMacros;
  diet: Diet;
  goal: string; // "lose" | "maintain" | "gain"
  date: string; // "YYYY-MM-DD" (the user's local day)
  regenerate?: boolean;
  // When provided, the meals still ahead of the user are re-portioned to the
  // budget they have left; `hour` is the user's local clock hour (0-23).
  consumed?: PlanMacros;
  hour?: number;
  training?: string;
  aiMode?: boolean;
  profile?: PlannerProfileContext;
}): Promise<DayPlan | null> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/plan/today`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({
        targets: input.targets,
        diet: input.diet,
        goal: input.goal,
        date: input.date,
        regenerate: input.regenerate ?? false,
        ...(input.consumed ? { consumed: input.consumed } : {}),
        ...(typeof input.hour === "number" ? { hour: input.hour } : {}),
        ...(input.training ? { training: input.training } : {}),
        ...(input.aiMode ? { ai_mode: true } : {}),
        ...(input.profile ? { profile: input.profile } : {}),
      }),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const data = (await res.json()) as { plan?: DayPlan };
    return data.plan ?? null;
  } catch {
    return null;
  }
}

async function friendlyError(res: Response): Promise<string> {
  let detail = "";
  try {
    const body = await res.json();
    detail = typeof body?.detail === "string" ? body.detail : "";
  } catch {
    detail = (await res.text().catch(() => "")) || "";
  }
  switch (res.status) {
    case 401:
      return detail || "Please sign in to continue.";
    case 402:
      return detail || "You've used all your free scans. Upgrade to keep scanning.";
    case 413:
      return "That image is too large. Try a smaller photo.";
    case 415:
      return "That file isn't an image. Please pick a food photo.";
    case 429:
      return detail || "You're going too fast. Please wait a moment and try again.";
    case 502:
      return detail || "Couldn't read that plate. Try a clearer photo.";
    default:
      return detail || `Something went wrong (${res.status}). Please try again.`;
  }
}

/* ----------------------------- Community API ----------------------------- */

export type ApiGroup = {
  id: string;
  emoji: string;
  name: string;
  desc: string;
  members: number;
  joined: boolean;
};

export type ApiLeader = {
  device_id: string;
  name: string;
  kcal: number;
  streak: number;
  avatar: string;
  isMe: boolean;
};

export type ApiChallenge = {
  id: string;
  emoji: string;
  title: string;
  desc: string;
  progress: number;
  daysLeft: number;
};

function authHeaders(json = false): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  if (json) h["Content-Type"] = "application/json";
  if (API_KEY) h["X-API-Key"] = API_KEY;
  const token = getToken();
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: authHeaders() });
  if (!res.ok) {
    // A stale/invalid session (expired token, or the account was removed
    // server-side) surfaces as 401 here too -- this was silently swallowed
    // as a generic Error before, which meant getMe()'s boot-time session
    // check never actually detected a dead session (found live: /auth/me
    // correctly returned 401 for a stale token, but the app kept showing
    // "signed in" because this threw the wrong error type to notice it).
    const msg = await authError(res);
    if (res.status === 401) throw new AuthRequiredError(msg);
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export async function syncStats(input: {
  device_id: string;
  name: string;
  kcal: number;
  streak: number;
  avatar?: string;
}): Promise<void> {
  const res = await fetch(`${API_BASE}/community/sync`, {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`sync failed (${res.status})`);
}

export async function getGroups(deviceId: string): Promise<ApiGroup[]> {
  const data = await getJson<{ groups: ApiGroup[] }>(
    `/community/groups?device_id=${encodeURIComponent(deviceId)}`
  );
  return data.groups;
}

export async function setGroupMembership(
  gid: string,
  deviceId: string,
  join: boolean
): Promise<void> {
  const action = join ? "join" : "leave";
  const res = await fetch(
    `${API_BASE}/community/groups/${encodeURIComponent(gid)}/${action}?device_id=${encodeURIComponent(
      deviceId
    )}`,
    { method: "POST", headers: authHeaders() }
  );
  if (!res.ok) throw new Error(`${action} failed (${res.status})`);
}

export async function getLeaderboard(deviceId: string): Promise<ApiLeader[]> {
  const data = await getJson<{ leaderboard: ApiLeader[] }>(
    `/community/leaderboard?device_id=${encodeURIComponent(deviceId)}`
  );
  return data.leaderboard;
}

export async function getChallenges(): Promise<ApiChallenge[]> {
  const data = await getJson<{ challenges: ApiChallenge[] }>(`/community/challenges`);
  return data.challenges;
}

/* ------------------------------- Auth API -------------------------------- */

// Turns a backend error body into a short, user-readable message.
async function authError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body?.detail === "string") return body.detail;
    // FastAPI validation errors arrive as an array under `detail`.
    if (Array.isArray(body?.detail) && body.detail[0]?.msg) {
      return String(body.detail[0].msg).replace(/^Value error, /, "");
    }
  } catch {
    // ignore
  }
  return `Something went wrong (${res.status}). Please try again.`;
}

async function postAuth<T>(path: string, body: unknown, method: "POST" | "PUT" = "POST"): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: authHeaders(true),
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Can't reach the server. Check your connection and try again.");
  }
  if (!res.ok) {
    const msg = await authError(res);
    // A stale/invalid session (expired token, or an account wiped server-side)
    // surfaces as 401 here too -- treat it the same as analyzeImage() does so
    // callers can force a fresh sign-in instead of showing a dead-end error.
    if (res.status === 401) throw new AuthRequiredError(msg);
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export async function googleLogin(idToken: string): Promise<{ token: string; account: Account }> {
  return postAuth("/auth/google", { id_token: idToken });
}

// Email one-time-code sign-in -- an alternative to Google for anyone who'd
// rather not use it. requestOtp() emails a 6-digit code (via the backend's
// Resend integration); verifyOtp() exchanges the code for the same
// {token, account} shape googleLogin()/devLogin() return.
export async function requestOtp(email: string): Promise<{ ok: boolean; sent: boolean; devCode?: string }> {
  return postAuth("/auth/otp/request", { email });
}

export async function verifyOtp(
  email: string,
  code: string
): Promise<{ token: string; account: Account }> {
  return postAuth("/auth/otp/verify", { email, code });
}

// TEST MODE sign-in: gets a token for the shared Tester account (backend
// /auth/dev, enabled via ALLOW_DEV_LOGIN). No Google needed.
export async function devLogin(): Promise<{ token: string; account: Account }> {
  return postAuth("/auth/dev", {});
}

export async function registerPushToken(token: string, platform: string): Promise<void> {
  try {
    await postAuth("/auth/push-token", { token, platform });
  } catch {
    // Best-effort: a failed registration just means no remote push on this device.
  }
}

export async function upgradeToPro(): Promise<{ account: Account }> {
  return postAuth("/auth/upgrade", {});
}

/* --------------------------- Entitlements -------------------------------- */
// Free / Pro feature entitlements, resolved server-side (product-level, not
// hidden UI). The client uses this to show correct Pro badges + an honest
// paywall; genuine enforcement is on the server (see backend/entitlements.py).

export type FeatureKey =
  | "food_logging" | "calorie_tracking" | "basic_progress" | "water_tracking"
  | "weight_tracking" | "exercise_logging" | "barcode"
  | "unlimited_scan" | "ai_recommendations" | "meal_planning"
  | "advanced_insights" | "grocery_lists" | "adaptive_targets";

export type EntitlementCatalogItem = {
  key: FeatureKey;
  tier: "free" | "pro";
  label: string;
  desc: string;
};

export type Entitlements = {
  isPro: boolean;
  enforced: boolean;
  features: Record<FeatureKey, boolean>;
  catalog: EntitlementCatalogItem[];
  scans: { used: number; limit: number; left: number | null };
};

export async function getEntitlements(): Promise<Entitlements> {
  return getJson<Entitlements>("/entitlements");
}

/* ------------------------------ Feedback --------------------------------- */

export type FeedbackCategory = "bug" | "feature" | "general";

// Sends one piece of feedback tied to the signed-in account (the app is
// Google-only, so there's no anonymous path -- every submission is
// attributable, which makes following up on it possible).
export async function submitFeedback(
  category: FeedbackCategory,
  message: string
): Promise<{ ok: boolean; id: number }> {
  return postAuth("/feedback", { category, message });
}

/* ------------------------------ Payments -------------------------------- */

export type PayConfig = {
  configured: boolean;
  keyId: string;
  amount: number;
  currency: string;
  name: string;
};

export type ProOrder = {
  keyId: string;
  orderId: string;
  amount: number;
  currency: string;
  name: string;
  prefill: { name: string; email: string };
};

export type RazorpayResult = {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
};

export async function getPayConfig(): Promise<PayConfig> {
  return getJson<PayConfig>("/pay/config");
}

// Create a Razorpay order for the signed-in account (amount fixed server-side).
export async function createProOrder(): Promise<ProOrder> {
  return postAuth("/pay/order", {});
}

// Verify a completed Razorpay payment; backend flips the account to Pro.
export async function verifyProPayment(
  result: RazorpayResult
): Promise<{ ok: boolean; account: Account }> {
  return postAuth("/pay/verify", result);
}

// Absolute URL of the backend-hosted checkout page (native in-app-browser flow).
export function checkoutUrl(order: ProOrder, redirect: string): string {
  const q = new URLSearchParams({
    order_id: order.orderId,
    key: order.keyId,
    amount: String(order.amount),
    currency: order.currency,
    name: order.name,
    email: order.prefill.email || "",
    contact_name: order.prefill.name || "",
    redirect,
  });
  return `${API_BASE}/pay/checkout?${q.toString()}`;
}

export async function getMe(): Promise<{ account: Account }> {
  return getJson<{ account: Account }>("/auth/me");
}

export async function logout(): Promise<void> {
  try {
    await fetch(`${API_BASE}/auth/logout`, { method: "POST", headers: authHeaders() });
  } catch {
    // best-effort; local sign-out happens regardless
  }
}

/* ------------------------- Profile / logs / weights ----------------------- */
// backend/progress.py -- the tables that used to not exist at all. Local
// storage (storage.ts) remains a fast cache for instant boot; these calls are
// what makes that cache eventually consistent with the real account record
// instead of being the only copy of the data that exists anywhere.

export async function getProfile(): Promise<{ profile: Profile | null }> {
  const data = await getJson<{ profile: Profile | null }>("/profile");
  return { profile: normalizeProfile(data.profile) };
}

export async function putProfile(profile: Profile): Promise<{ profile: Profile }> {
  const data = await postAuth<{ profile: Profile }>("/profile", profile, "PUT");
  return { profile: normalizeProfile(data.profile)! };
}

// --- GLP-1 dose log --------------------------------------------------------- //
// Lightweight "I took my dose today" log -- date only, no dosage/drug detail.
// Used for a simple dose-history strip and future symptom/appetite correlation.

export async function logGlp1Dose(date: string): Promise<void> {
  await postAuth<{ ok: boolean }>("/glp1/doses", { date }, "POST");
}

export async function deleteGlp1Dose(date: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/glp1/doses/${date}`, { method: "DELETE", headers: authHeaders(true) });
  } catch {
    throw new Error("Can't reach the server. Check your connection and try again.");
  }
  if (!res.ok) throw new Error(await authError(res));
}

export async function getGlp1Doses(days = 60): Promise<string[]> {
  const data = await getJson<{ dates?: string[] }>(`/glp1/doses?days=${days}`);
  return data.dates || [];
}

// --- GLP-1 symptom check-in -------------------------------------------------- //

export type Glp1Symptom = "nausea" | "fullness" | "constipation" | "fatigue" | "low_appetite";

export async function setGlp1Symptoms(date: string, symptoms: Glp1Symptom[]): Promise<void> {
  await postAuth<{ ok: boolean }>("/glp1/symptoms", { date, symptoms }, "PUT");
}

export async function getGlp1Symptoms(days = 14): Promise<{ date: string; symptoms: Glp1Symptom[] }[]> {
  const data = await getJson<{ days?: { date: string; symptoms: Glp1Symptom[] }[] }>(`/glp1/symptoms?days=${days}`);
  return data.days || [];
}

export async function getServerLogs(): Promise<{ logs: LogMap }> {
  return getJson<{ logs: LogMap }>("/logs");
}

export async function addServerLog(
  date: string,
  meal: Meal
): Promise<{ ok: boolean; id: number; at: number; mealType?: string }> {
  return postAuth("/logs", {
    date,
    dish: meal.dish,
    kcal: meal.kcal,
    protein_g: meal.protein_g,
    carbs_g: meal.carbs_g,
    fat_g: meal.fat_g,
    meal_type: meal.mealType,
    photo_path: meal.photoPath,
    micros: meal.micros,
    micros_estimated: meal.microsEstimated,
    food_items: meal.foodItems,
  });
}

export async function deleteServerLog(id: number): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/logs/${id}`, { method: "DELETE", headers: authHeaders() });
  if (!res.ok) {
    const msg = await authError(res);
    if (res.status === 401) throw new AuthRequiredError(msg);
    throw new Error(msg);
  }
  return (await res.json()) as { ok: boolean };
}

export async function getServerStreak(): Promise<{ current: number; best: number }> {
  // Server-computed from a durable log_days table that survives both a
  // reinstall and the 30-day log-retention purge -- see backend/progress.py's
  // compute_streaks(). Preferred over the local computeStreak/bestStreak in
  // storage.ts, which only ever sees whatever's in the last-30-days GET /logs
  // response and would silently cap a longer real streak.
  return getJson<{ current: number; best: number }>("/streak");
}

export async function getLogDays(days = 90): Promise<{ days: string[] }> {
  // Durable logged-date list from log_days -- unlike GET /logs (capped at 30
  // days), this stays honest for the Progress tab's 90-day/all-time
  // consistency score and logging heatmap. Pass days<=0 for all-time.
  return getJson<{ days: string[] }>(`/log-days?days=${days}`);
}

export type DaySummary = {
  date: string;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  mealsCount: number;
};

export async function getSummary(days = 30): Promise<{ days: DaySummary[] }> {
  return getJson<{ days: DaySummary[] }>(`/summary?days=${days}`);
}

function normalizeWeightEntry(entry: WeightEntry): WeightEntry {
  // The backend stores Unix seconds; the app's local cache/history uses
  // JavaScript milliseconds. Normalize here so every chart/date formatter sees
  // one consistent unit regardless of where the row came from.
  return entry.at < 1_000_000_000_000 ? { ...entry, at: entry.at * 1000 } : entry;
}

export async function getServerWeights(): Promise<{ weights: WeightEntry[] }> {
  const data = await getJson<{ weights: WeightEntry[] }>("/weights");
  return { weights: data.weights.map(normalizeWeightEntry) };
}

export async function addServerWeight(kg: number): Promise<{ weights: WeightEntry[] }> {
  const data = await postAuth<{ weights: WeightEntry[] }>("/weights", { kg });
  return { weights: data.weights.map(normalizeWeightEntry) };
}

/* --------------------------- Water / habit tracking ----------------------- */
// Plain data entry -- no AI, no scan credit. Mirrors the logs/weights pattern:
// local storage is a fast cache, these calls make it durable server-side.

export type WaterState = { date: string; ml: number; goalMl: number };
export type HabitKind = "steps" | "workout_min" | "sleep_hr";
export type HabitState = { date: string; habits: Partial<Record<HabitKind, number>>; stepGoal: number };

export async function getWater(date: string): Promise<WaterState> {
  return getJson<WaterState>(`/water?date=${encodeURIComponent(date)}`);
}

// Adds `ml` to the day's running total (negative to undo). Returns the new total.
export async function addWater(date: string, ml: number): Promise<WaterState> {
  return postAuth<WaterState>("/water", { date, ml });
}

export async function getHabits(date: string): Promise<HabitState> {
  return getJson<HabitState>(`/habits?date=${encodeURIComponent(date)}`);
}

// Upserts one habit's absolute value for the day (e.g. steps = 8000).
export async function setHabit(
  date: string,
  kind: HabitKind,
  value: number
): Promise<HabitState> {
  return postAuth<HabitState>("/habits", { date, kind, value });
}

// Today's training context, persisted server-side so it's part of the one
// connected system and syncs across devices (see training.ts, which uses
// on-device storage as a fast offline cache in front of these).
export type TrainingContextValue = "rest" | "endurance" | "strength" | "performance";
export type TrainingState = { date: string; context: TrainingContextValue | null };

export async function getServerTraining(date: string): Promise<TrainingState> {
  return getJson<TrainingState>(`/training?date=${encodeURIComponent(date)}`);
}

// Set (or clear, when context is null) today's training context.
export async function putServerTraining(
  date: string,
  context: TrainingContextValue | null
): Promise<TrainingState> {
  return postAuth<TrainingState>("/training", { date, context }, "PUT");
}

/* ------------------------------ Exercise tracking ------------------------- */
// Curated open (Compendium of Physical Activities MET-based) exercise catalog +
// daily activity logging. Calories burned are computed server-side from the
// account's saved weight, so they recalculate when the profile weight changes.

export type ExerciseCatalogItem = { key: string; name: string; met: number };
export type ExerciseCategory = { key: string; label: string; items: ExerciseCatalogItem[] };
export type ExerciseCatalog = { categories: ExerciseCategory[] };
export type ExerciseEntry = {
  id: number;
  key: string;
  name: string;
  minutes: number;
  kcal: number;
  at: number;
};
export type ExerciseDay = {
  date: string;
  entries: ExerciseEntry[];
  totalKcal: number;
  totalMinutes: number;
};
export type ExerciseHistoryDay = {
  date: string;
  entries: ExerciseEntry[];
  totalKcal: number;
  totalMinutes: number;
};

export async function getExerciseCatalog(): Promise<ExerciseCatalog> {
  return getJson<ExerciseCatalog>("/exercise/catalog");
}

export async function getExerciseLogs(date: string): Promise<ExerciseDay> {
  return getJson<ExerciseDay>(`/exercise/logs?date=${encodeURIComponent(date)}`);
}

export type ExerciseDaySummary = { kcal: number; minutes: number; sessions: number };
export type ExerciseSummary = {
  days: number;
  activeDays: number;
  totalKcal: number;
  totalMinutes: number;
  byDate: Record<string, ExerciseDaySummary>;
};

// Range rollup (7/30/90 days) for the Progress/Reports section.
export async function getExerciseSummary(days: number): Promise<ExerciseSummary> {
  return getJson<ExerciseSummary>(`/exercise/summary?days=${days}`);
}

export async function getExerciseHistory(days: number): Promise<{ days: ExerciseHistoryDay[] }> {
  return getJson<{ days: ExerciseHistoryDay[] }>(`/exercise/history?days=${days}`);
}

// Logs one activity for the day; returns the updated day (with computed kcal).
// For guided-library exercises (not in the built-in MET catalog), pass the
// display name + a category MET so the backend can still compute calories.
export async function addExerciseLog(
  date: string,
  key: string,
  minutes: number,
  opts?: { name?: string; met?: number }
): Promise<ExerciseDay> {
  return postAuth<ExerciseDay>("/exercise/log", { date, key, minutes, ...opts });
}

export async function deleteExerciseLog(id: number): Promise<ExerciseDay> {
  const res = await fetch(`${API_BASE}/exercise/log/${id}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) {
    const msg = await authError(res);
    if (res.status === 401) throw new AuthRequiredError(msg);
    throw new Error(msg);
  }
  return (await res.json()) as ExerciseDay;
}

/* --------------------------- Home layout prefs --------------------------- */
// Per-account dashboard layout (which Home modules show + their order), synced
// across devices. `order` is a list of module keys top-to-bottom; `hidden` is
// the set the user chose to hide. Null means "never customized" -> client uses
// its own default order.

export type HomeLayout = { order: string[]; hidden: string[] };

export async function getHomeLayout(): Promise<HomeLayout | null> {
  const res = await getJson<{ layout: HomeLayout | null }>("/prefs/home");
  return res.layout;
}

export async function putHomeLayout(layout: HomeLayout): Promise<HomeLayout> {
  const res = await postAuth<{ layout: HomeLayout }>("/prefs/home", layout, "PUT");
  return res.layout;
}

export type FeedMeal = {
  dish: string;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
};

export type ApiPost = {
  id: number;
  author_id: string;
  author_name: string;
  author_avatar: string;
  text: string;
  meal: FeedMeal | null;
  image: string | null;
  likes: number;
  comments: number;
  liked: boolean;
  mine: boolean;
  created_at: number;
};

export type ApiComment = {
  id: number;
  author_name: string;
  author_avatar: string;
  text: string;
  created_at: number;
};

export type ApiUserProfile = {
  id: string;
  name: string;
  avatar: string;
  streak: number;
  kcal: number;
  posts: number;
  isMe: boolean;
};

export type ApiNotification = {
  id: number;
  actor_id: string;
  actor_name: string;
  actor_avatar: string;
  kind: "like" | "comment";
  post_id: number | null;
  preview: string;
  read: boolean;
  created_at: number;
};

// Turns a backend-relative media path ("/community/images/x.jpg") into an
// absolute URL the <Image> component can load.
export function mediaUrl(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  if (/^https?:\/\//.test(path)) return path;
  return `${API_BASE}${path}`;
}

export async function getFeed(deviceId: string): Promise<ApiPost[]> {
  const data = await getJson<{ feed: ApiPost[] }>(
    `/community/feed?device_id=${encodeURIComponent(deviceId)}`
  );
  return data.feed;
}

export async function createPost(input: {
  text: string;
  meal?: FeedMeal | null;
  imageUrl?: string | null;
}): Promise<ApiPost> {
  const data = await postAuth<{ post: ApiPost }>("/community/posts", {
    text: input.text,
    meal: input.meal ?? null,
    image_url: input.imageUrl ?? null,
  });
  return data.post;
}

// Uploads a photo (local uri) for use in a post; returns a backend-relative url.
export async function uploadPostImage(uri: string): Promise<string> {
  const form = new FormData();
  const name = uri.split("/").pop() || "photo.jpg";
  const match = /\.(\w+)$/.exec(name);
  const type = match ? `image/${match[1].toLowerCase()}` : "image/jpeg";
  if (Platform.OS === "web") {
    const blob = await (await fetch(uri)).blob();
    form.append("file", blob, name);
  } else {
    form.append("file", { uri, name, type } as any);
  }
  const headers = authHeaders();
  delete headers["Content-Type"]; // let fetch set the multipart boundary
  const res = await fetch(`${API_BASE}/community/upload`, {
    method: "POST",
    body: form,
    headers,
  });
  if (!res.ok) throw new Error(await authError(res));
  const data = (await res.json()) as { image_url: string };
  return data.image_url;
}

export async function deletePost(id: number): Promise<void> {
  const res = await fetch(`${API_BASE}/community/posts/${id}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(await authError(res));
}

export async function setPostLike(id: number, like: boolean): Promise<number> {
  const action = like ? "like" : "unlike";
  const res = await fetch(`${API_BASE}/community/posts/${id}/${action}`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(await authError(res));
  const data = (await res.json()) as { likes: number };
  return data.likes;
}

export async function getComments(id: number): Promise<ApiComment[]> {
  const data = await getJson<{ comments: ApiComment[] }>(
    `/community/posts/${id}/comments`
  );
  return data.comments;
}

export async function addComment(id: number, text: string): Promise<ApiComment> {
  const data = await postAuth<{ comment: ApiComment }>(
    `/community/posts/${id}/comments`,
    { text }
  );
  return data.comment;
}

export async function getUserProfile(
  authorId: string,
  deviceId: string
): Promise<{ profile: ApiUserProfile; feed: ApiPost[] }> {
  return getJson<{ profile: ApiUserProfile; feed: ApiPost[] }>(
    `/community/users/${encodeURIComponent(authorId)}?device_id=${encodeURIComponent(
      deviceId
    )}`
  );
}

export async function getNotifications(): Promise<{
  notifications: ApiNotification[];
  unread: number;
}> {
  return getJson<{ notifications: ApiNotification[]; unread: number }>(
    `/community/notifications`
  );
}

export async function markNotificationsRead(): Promise<void> {
  const res = await fetch(`${API_BASE}/community/notifications/read`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(await authError(res));
}
