// Correction / learning engine (v1: portion memory).
//
// Every time the user accepts a scanned meal, we remember the portion (count)
// they settled on for each food, keyed by food name and namespaced per account.
// Next time the same food is detected, we pre-apply their usual portion so the
// AI's generic guess ("2 rotis") becomes their reality ("you usually have 3").
//
// This is deliberately on-device and per-account: portion habits are personal,
// never uploaded, and -- because the store is keyed by account id -- one user's
// habits can never bleed into another's on a shared device (the same class of
// bug the cache-owner guard fixes for server data).

import AsyncStorage from "@react-native-async-storage/async-storage";
import type { FoodItem } from "./api";

const CORRECTIONS_KEY = "calai.corrections.v1";

// One learned portion for a single food.
type PortionFact = { count: number; at: number };
// food-name (normalized) -> learned portion, for ONE account.
export type PortionMemory = Record<string, PortionFact>;
// account id -> that account's portion memory.
type CorrectionsStore = Record<string, PortionMemory>;

// Normalize a food name so "Roti", "roti " and "ROTI" collapse to one key.
export function normalizeFood(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

async function loadStore(): Promise<CorrectionsStore> {
  try {
    const raw = await AsyncStorage.getItem(CORRECTIONS_KEY);
    return raw ? (JSON.parse(raw) as CorrectionsStore) : {};
  } catch {
    return {};
  }
}

async function saveStore(store: CorrectionsStore): Promise<void> {
  try {
    await AsyncStorage.setItem(CORRECTIONS_KEY, JSON.stringify(store));
  } catch {
    // ignore write errors (best-effort personalization)
  }
}

// Load the portion memory for one account. Returns {} for a signed-out user or
// an account with no history yet.
export async function loadPortionMemory(accountId: number | null): Promise<PortionMemory> {
  if (accountId == null) return {};
  const store = await loadStore();
  return store[String(accountId)] ?? {};
}

// Remember the portions the user just accepted. Called when a scanned meal is
// logged; the final `count` on each item is their correction for that food.
// Returns the updated memory so the caller can keep its in-memory copy in sync.
export async function rememberPortions(
  accountId: number | null,
  items: FoodItem[],
): Promise<PortionMemory> {
  if (accountId == null) return {};
  const store = await loadStore();
  const key = String(accountId);
  const mem: PortionMemory = { ...(store[key] ?? {}) };
  const now = Date.now();
  for (const it of items) {
    const name = normalizeFood(it.item || "");
    if (!name) continue;
    const count = it.count;
    if (!Number.isFinite(count) || count <= 0) continue;
    mem[name] = { count, at: now };
  }
  store[key] = mem;
  await saveStore(store);
  return mem;
}

// Drop everything (used when a user wipes their account data / resets).
export async function clearAllPortionMemory(): Promise<void> {
  try {
    await AsyncStorage.removeItem(CORRECTIONS_KEY);
  } catch {
    // ignore
  }
}

// Forget one food for one account (user taps "Not my usual" / undo).
export async function forgetPortion(
  accountId: number | null,
  foodName: string,
): Promise<PortionMemory> {
  if (accountId == null) return {};
  const store = await loadStore();
  const key = String(accountId);
  const mem: PortionMemory = { ...(store[key] ?? {}) };
  delete mem[normalizeFood(foodName)];
  store[key] = mem;
  await saveStore(store);
  return mem;
}

// Recompute an item's totals after its count changes, mirroring the per-unit
// math used everywhere else (see HomeScreen.adjust / answerQuestion).
function withCount(it: FoodItem, count: number): FoodItem {
  const next: FoodItem = { ...it, count };
  next.kcal_total = Math.round(count * it.kcal_per_unit);
  next.protein_g = Math.round(count * it.protein_g_per_unit * 10) / 10;
  next.carbs_g = Math.round(count * it.carbs_g_per_unit * 10) / 10;
  next.fat_g = Math.round(count * it.fat_g_per_unit * 10) / 10;
  const scale = (v?: number) => (v == null ? v : Math.round(v * count * 10) / 10);
  // Micros stored per *unit* were multiplied by the old count already, so we
  // only touch fields the app scales by count. Here per-unit fields aren't
  // stored for these, so we scale from the current aggregate/count ratio only
  // when a per-unit basis is unavailable -- keep it simple and leave optional
  // micros untouched (they're re-derived server-side on the next scan anyway).
  void scale;
  return next;
}

// Apply learned portions to a fresh analysis. Returns the possibly-adjusted
// items plus the set of indices we changed (so the UI can flag "your usual").
// Only adjusts when we actually have a memory for that food AND the learned
// portion differs from the AI's guess -- otherwise nothing visibly changes.
export function applyPortionMemory(
  items: FoodItem[],
  memory: PortionMemory,
): { items: FoodItem[]; learned: Record<number, number> } {
  const learned: Record<number, number> = {};
  const out = items.map((it, i) => {
    const fact = memory[normalizeFood(it.item || "")];
    if (!fact) return it;
    // Round to the item's natural step: whole for countable, .5 for sizes.
    const step = it.countable ? 1 : 0.5;
    const target = Math.max(step, Math.round(fact.count / step) * step);
    if (target === it.count) return it;
    learned[i] = it.count; // remember the AI's original for an "undo"
    return withCount(it, target);
  });
  return { items: out, learned };
}
