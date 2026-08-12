import { Platform } from "react-native";
import { API_BASE, API_KEY } from "./config";
import { Account, getToken } from "./auth";

// Full vitamin/mineral panel, keyed by friendly name (e.g. "vitamin_c_mg",
// "saturated_fat_mg") -- see backend/build_db_v2.py for the exact field list.
export type MicroPanel = Record<string, number>;

export type FoodItem = {
  item: string;
  count: number;
  unit: string;
  kcal_per_unit: number;
  protein_g_per_unit: number;
  carbs_g_per_unit: number;
  fat_g_per_unit: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  kcal_total: number;
  countable: boolean;
  source?: string;
  // v2: present only when matched against the food DB (source === "db") and
  // the underlying record has the data -- never guessed for an "ai"-sourced
  // item, so always check for presence before displaying.
  fiber_g?: number;
  sugar_g?: number;
  sodium_mg?: number;
  potassium_mg?: number;
  calcium_mg?: number;
  iron_mg?: number;
  micros?: MicroPanel;
  // App-computed (see backend/build_db_v2.py's health_score()) -- NOT an
  // official rating, NOT medical advice. Descriptive of the food itself, so
  // this does not change when you adjust the count/portion.
  health_score?: number;
  benefits?: string[];
  watch_outs?: string[];
};

export type Macros = { kcal: number; protein_g: number; carbs_g: number; fat_g: number };

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
  totals: Macros;
  usage?: Usage;
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

// Maps backend status codes to short, user-readable messages.
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

async function postAuth<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
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

/* ------------------------------- Feed API -------------------------------- */

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
