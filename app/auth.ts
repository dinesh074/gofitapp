import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

// A signed-in account. `communityId` (e.g. "acct-7") is the identity used for
// the leaderboard/feed so it follows the account across devices.
export type Account = {
  id: number;
  username: string;
  name: string;
  avatar: string;
  communityId: string;
  // Free-trial / subscription state (from the backend).
  isPro?: boolean;
  scansUsed?: number;
  scansLimit?: number;
  scansLeft?: number | null;
};

export type AuthState = { token: string; account: Account };

const AUTH_KEY = "calai.auth.v1";

// The bearer token is the one piece of app state that lets someone act as the
// signed-in user (post, delete, comment, self-upgrade), so it belongs in the
// OS-encrypted keychain (SecureStore) rather than plain AsyncStorage, which is
// unencrypted on-device storage readable on a rooted/compromised device.
//
// SecureStore has no web implementation (there's no OS keychain in a browser),
// so on web we fall back to AsyncStorage — same trust model as before, and
// no worse than any other web app storing a session token in localStorage.
const isWeb = Platform.OS === "web";

async function secureGet(key: string): Promise<string | null> {
  return isWeb ? AsyncStorage.getItem(key) : SecureStore.getItemAsync(key);
}

async function secureSet(key: string, value: string): Promise<void> {
  if (isWeb) {
    await AsyncStorage.setItem(key, value);
  } else {
    await SecureStore.setItemAsync(key, value);
  }
}

async function secureDelete(key: string): Promise<void> {
  if (isWeb) {
    await AsyncStorage.removeItem(key);
  } else {
    await SecureStore.deleteItemAsync(key);
  }
}

// In-memory bearer token so api.ts can attach it to every request without a
// round-trip to secure storage. Kept in sync with persisted state.
let currentToken: string | null = null;

export function getToken(): string | null {
  return currentToken;
}

export function setToken(token: string | null): void {
  currentToken = token;
}

export async function loadAuth(): Promise<AuthState | null> {
  try {
    const raw = await secureGet(AUTH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthState;
    currentToken = parsed.token;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveAuth(state: AuthState): Promise<void> {
  currentToken = state.token;
  try {
    await secureSet(AUTH_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

export async function clearAuth(): Promise<void> {
  currentToken = null;
  try {
    await secureDelete(AUTH_KEY);
  } catch {
    // ignore
  }
}
