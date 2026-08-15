import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, BackHandler, Platform, StyleSheet, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { NavigationContainer, createNavigationContainerRef } from "@react-navigation/native";
import * as Notifications from "expo-notifications";
import Onboarding from "./Onboarding";
import Settings from "./Settings";
import { RootNavigator } from "./RootTabs";
import { AppProvider } from "./AppContext";
import AuthGate from "./AuthGate";
import CookieBanner from "./CookieBanner";
import { computeGoal, isCompleteProfile, normalizeProfile, Profile } from "./nutrition";
import { colors } from "./theme";
import {
  AuthState,
  clearAuth,
  loadAuth,
  saveAuth,
} from "./auth";
import {
  logout,
  getMe,
  getProfile,
  putProfile,
  getServerLogs,
  addServerLog,
  getServerStreak,
  AuthRequiredError,
} from "./api";
import { initNotifications } from "./push";
import { signOutGoogleWeb } from "./googleWeb";
import {
  clearCacheOwner,
  clearExtras,
  clearLogs,
  clearProfile,
  computeStreak,
  inferMealType,
  loadCacheOwner,
  loadLogs,
  loadProfile,
  LogMap,
  Meal,
  recordRecentMeal,
  saveCacheOwner,
  saveLogs,
  saveProfile,
  todayKey,
} from "./storage";

const navRef = createNavigationContainerRef();

function activeLeafRouteName(state: any): string {
  let cursor = state;
  while (cursor && cursor.routes && typeof cursor.index === "number") {
    const route = cursor.routes[cursor.index];
    if (!route) break;
    if (!route.state) return String(route.name ?? "");
    cursor = route.state;
  }
  return "";
}

function AppInner() {
  const [logs, setLogs] = useState<LogMap>({});
  const [profile, setProfile] = useState<Profile | null>(null);
  const [booted, setBooted] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // Server-computed streak (current + best), from a durable log_days table
  // that survives reinstalls and the 30-day log-retention purge -- see
  // backend/progress.py's compute_streaks(). Null until the fetch resolves;
  // the local computeStreak(logs)/bestStreak(logs) fallback covers that gap
  // and any offline/error case, matching the water/habits pattern elsewhere.
  const [serverStreak, setServerStreak] = useState<{ current: number; best: number } | null>(null);
  // Bumped every time the TabBar's center camera button is tapped -- lets
  // HomeScreen (which owns the actual scan flow) open the camera immediately
  // even when you're on a different tab, instead of just switching tabs and
  // leaving you to tap "Scan food" again once there.
  const [scanTrigger, setScanTrigger] = useState(0);
  const [auth, setAuth] = useState<AuthState | null>(null);
  // True only while we're pulling a freshly signed-in account's profile/logs
  // from the server. Prevents a returning user from briefly seeing the
  // onboarding screen (local data was just wiped) before their server profile
  // arrives.
  const [hydrating, setHydrating] = useState(false);
  const latestProfileRef = useRef<Profile | null>(null);

  useEffect(() => {
    latestProfileRef.current = profile;
  }, [profile]);

  useEffect(() => {
    Promise.all([loadLogs(), loadProfile(), loadAuth()]).then(([l, p, a]) => {
      const localProfile = normalizeProfile(p);
      setLogs(l);
      setProfile(localProfile);
      setAuth(a);
      setBooted(true);
      // Already signed in from a previous session → set up notifications now.
      if (a) {
        void initNotifications();
        // The cached account (name/avatar/Pro status/scan count) is shown
        // immediately above for a fast boot -- but a device-local cache is
        // not the same thing as truth. Refresh it against the real account
        // row right after, silently. If the backend no longer recognizes
        // this token (revoked, or the account itself no longer exists), drop
        // the dead session instead of continuing to show stale "signed in"
        // state from before.
        getMe()
          .then((res) => updateAccount(res.account))
          .catch((e) => {
            if (e instanceof AuthRequiredError) void requireAuth();
          });
        void syncProfileAndLogs(localProfile, l, a.account.id);
      }
    });
  }, []);

  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      const route = String((resp.notification.request.content.data as any)?.route ?? "");
      if (route !== "Plan") return;
      if (!navRef.isReady()) return;
      (navRef as any).navigate("Tabs", { screen: "Plan" });
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!navRef.isReady()) return false;
      if (navRef.canGoBack()) {
        (navRef as any).goBack();
        return true;
      }
      const active = activeLeafRouteName(navRef.getRootState());
      if (active && active !== "Home") {
        (navRef as any).navigate("Tabs", { screen: "Home" });
        return true;
      }
      // Keep the app in place at the root instead of closing immediately.
      return true;
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const keepInAppHistory = () => {
      try {
        window.history.pushState({ gofit: true }, "", window.location.href);
      } catch {}
    };
    keepInAppHistory();
    const onPopState = () => {
      if (!navRef.isReady()) {
        keepInAppHistory();
        return;
      }
      if (navRef.canGoBack()) {
        (navRef as any).goBack();
        keepInAppHistory();
        return;
      }
      const active = activeLeafRouteName(navRef.getRootState());
      if (active && active !== "Home") {
        (navRef as any).navigate("Tabs", { screen: "Home" });
      }
      keepInAppHistory();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // The tables this account's profile and meal history actually live in
  // (backend/progress.py) used to not exist at all -- everything below was
  // only ever in this device's local storage. On boot: prefer the server's
  // copy if it has one (this device might be new, or storage was cleared);
  // otherwise, this local data predates the server table existing at all --
  // back it up once so it isn't stuck local-only forever.
  async function syncProfileAndLogs(
    localProfile: Profile | null,
    localLogs: LogMap,
    accountId: number
  ) {
    // Whose data is actually sitting in this device's (global, non-namespaced)
    // local cache? This decides whether the local->server "backup" upload below
    // is safe. Three cases:
    //   owner === accountId : the cache is THIS account's own data -> trusted,
    //                         may upload local-only data to fill empty server rows.
    //   owner === null      : unknown/legacy (pre-dates this stamp, or fresh) ->
    //                         ambiguous, so never upload, but leave the cache as-is
    //                         (server data still wins when present).
    //   owner === other id  : the cache belongs to a DIFFERENT account (leftover
    //                         from a previous user on a shared device) -> never
    //                         upload it, and drop it so it can't leak into this
    //                         account's view or its server rows.
    const owner = await loadCacheOwner();
    const trusted = owner === accountId; // safe to upload local -> server
    const foreign = owner !== null && owner !== accountId; // another account's data

    try {
      const { profile: serverProfile } = await getProfile();
      if (isCompleteProfile(serverProfile)) {
        if (shouldApplyServerProfile(serverProfile, localProfile)) {
          cacheProfile(serverProfile);
        }
      } else if (localProfile && trusted) {
        const { profile: savedProfile } = await putProfile(localProfile);
        cacheProfile(savedProfile);
      } else if (foreign) {
        // Someone else's profile is cached and this account has none of its own.
        // Treat this account as un-onboarded rather than showing stale data.
        latestProfileRef.current = null;
        setProfile(null);
        void clearProfile();
      }
    } catch (e: any) {
      if (e instanceof AuthRequiredError) {
        void requireAuth();
        return;
      }
    }

    try {
      const { logs: serverLogs } = await getServerLogs();
      if (Object.keys(serverLogs).length > 0) {
        setLogs(serverLogs);
        void saveLogs(serverLogs);
      } else if (trusted) {
        for (const day of Object.values(localLogs)) {
          for (const meal of day.meals) {
            await addServerLog(day.date, meal).catch(() => {});
          }
        }
      } else if (foreign) {
        // Don't let a previous user's meals show up under this account.
        setLogs({});
        void clearLogs();
      }
    } catch (e: any) {
      if (e instanceof AuthRequiredError) void requireAuth();
    }

    try {
      const streak = await getServerStreak();
      setServerStreak(streak);
    } catch {
      // Offline/error: local computeStreak/bestStreak fallback covers this.
    }

    // The local cache now reflects THIS account (hydrated from its server rows,
    // or confirmed as its own local data). Stamp ownership so the next sync /
    // account switch can tell whose data this is.
    void saveCacheOwner(accountId);
  }

  const goal = useMemo(() => (profile ? computeGoal(profile) : null), [profile]);
  // Prefer the server-computed streak (durable, cross-device, not capped by
  // the 30-day log-retention window) once it's arrived; fall back to the
  // local computeStreak(logs) so the UI isn't blank before that fetch resolves.
  const localStreak = useMemo(() => computeStreak(logs), [logs]);
  const streak = serverStreak ? serverStreak.current : localStreak;
  const bestStreakValue = serverStreak ? serverStreak.best : null;

  function cacheProfile(next: Profile, optimistic = false) {
    const normalized = normalizeProfile(
      optimistic ? { ...next, updatedAt: Math.max(next.updatedAt ?? 0, Date.now() / 1000) } : next
    )!;
    latestProfileRef.current = normalized;
    setProfile(normalized);
    void saveProfile(normalized);
    return normalized;
  }

  function shouldApplyServerProfile(serverProfile: Profile, localProfile: Profile | null) {
    const currentLocal = latestProfileRef.current ?? localProfile;
    if (!currentLocal) return true;
    if (typeof serverProfile.updatedAt === "number" && typeof currentLocal.updatedAt === "number") {
      return serverProfile.updatedAt >= currentLocal.updatedAt;
    }
    return true;
  }

  function profileErrorMessage(e: unknown): string {
    return e instanceof Error ? e.message : "Please try again.";
  }

  async function persistProfile(
    next: Profile,
    title: string,
    options?: { closeSettings?: boolean; rollbackProfile?: Profile | null }
  ) {
    try {
      const { profile: savedProfile } = await putProfile(next);
      cacheProfile(savedProfile);
      if (auth) void saveCacheOwner(auth.account.id);
      if (options?.closeSettings) setShowSettings(false);
      return true;
    } catch (e) {
      if (options?.rollbackProfile) cacheProfile(options.rollbackProfile);
      if (e instanceof AuthRequiredError) {
        void requireAuth();
        return false;
      }
      Alert.alert(title, profileErrorMessage(e));
      return false;
    }
  }

  function completeOnboarding(p: Profile) {
    void persistProfile(p, "Couldn't save your profile");
  }

  function saveSettings(p: Profile) {
    void persistProfile(p, "Couldn't update your profile", { closeSettings: true });
  }

  async function resetAll() {
    await Promise.all([clearProfile(), clearLogs(), clearExtras(), clearAuth(), clearCacheOwner()]);
    setLogs({});
    setServerStreak(null);
    latestProfileRef.current = null;
    setProfile(null);
    setAuth(null);
    setShowSettings(false);
  }

  async function onAuthed(state: AuthState) {
    // This sign-in may be for a DIFFERENT account than the one whose data is
    // still cached on this device (e.g. the previous user signed out, or was
    // never signed out at all). Local profile/logs/extras use global keys --
    // they are NOT namespaced per account -- so we must wipe them before the
    // new session begins, otherwise account B sees account A's onboarding
    // (skipped) and meal history. The correct data for THIS account is then
    // pulled from its own server rows below; a brand-new account ends up with
    // no profile → the onboarding gate shows as intended.
    await Promise.all([clearProfile(), clearLogs(), clearExtras(), clearCacheOwner()]);
    latestProfileRef.current = null;
    setProfile(null);
    setLogs({});
    setServerStreak(null);
    setAuth(state);
    saveAuth(state);
    // Register for push + schedule local reminders right after sign-in.
    void initNotifications();
    // Hydrate this account's own profile + logs from the server (the boot-time
    // useEffect only runs once, so a login after boot wouldn't otherwise sync).
    // Hold the UI on a spinner until this resolves so a returning user doesn't
    // flash the onboarding screen before their profile loads.
    setHydrating(true);
    try {
      await syncProfileAndLogs(null, {}, state.account.id);
    } finally {
      setHydrating(false);
    }
  }

  function updateAccount(account: AuthState["account"]) {
    setAuth((prev) => {
      if (!prev) return prev;
      const next = { ...prev, account };
      saveAuth(next);
      return next;
    });
  }

  async function signOut() {
    await logout(); // best-effort server-side token revoke
    // Turn off Google auto-select so the next sign-in shows the account chooser
    // instead of silently re-issuing a credential for the account we just left.
    signOutGoogleWeb();
    // Clear this account's cached data too, not just the token -- otherwise the
    // next account to sign in on this device would inherit the previous user's
    // profile and logs (local storage keys are not per-account).
    await Promise.all([clearAuth(), clearProfile(), clearLogs(), clearExtras(), clearCacheOwner()]);
    setAuth(null);
    latestProfileRef.current = null;
    setProfile(null);
    setLogs({});
    setServerStreak(null);
    setShowSettings(false);
  }

  // Called when the backend rejects an authenticated request with 401 -- the
  // locally-cached token is stale (expired, or the account no longer exists
  // server-side) even though the app still thinks it's signed in. Drop the
  // dead session so AuthGate takes over and the user can sign in again,
  // rather than getting stuck on "Please sign in to continue" with no way
  // to recover short of finding Profile -> Sign Out themselves.
  async function requireAuth() {
    await clearAuth();
    setAuth(null);
  }

  function triggerScan() {
    setScanTrigger((n) => n + 1);
  }

  // Shared meal logger so screens beyond Home (e.g. the Food Selector) can add
  // to today's log. Mirrors HomeScreen.logMeal: optimistic local update + cache,
  // record as a recent, then persist to the server meal_logs table and stamp the
  // returned id back onto the local copy.
  function logMeal(meal: Meal) {
    const today = todayKey();
    // Auto-tag which eating occasion this is (breakfast/lunch/snack/dinner)
    // from local clock time if the caller didn't already set one -- every
    // screen that logs a meal (Home, FoodSelector, Scan) goes through here or
    // HomeScreen's own mirrored copy, so this is the one place that has to
    // guarantee mealType is always populated for the calendar/day view.
    const tagged: Meal = { ...meal, mealType: meal.mealType ?? inferMealType(meal.at) };
    setLogs((prev) => {
      const day = prev[today] ?? { date: today, meals: [] };
      const next: LogMap = { ...prev, [today]: { ...day, meals: [...day.meals, tagged] } };
      saveLogs(next);
      return next;
    });
    void recordRecentMeal(tagged);
    addServerLog(today, tagged)
      .then(({ id }) => {
        setLogs((prev) => {
          const day = prev[today];
          if (!day) return prev;
          const meals = day.meals.map((m) => (m.at === tagged.at ? { ...m, id } : m));
          const next: LogMap = { ...prev, [today]: { ...day, meals } };
          saveLogs(next);
          return next;
        });
        // The streak may have just changed (e.g. today's first meal extends
        // it) -- refresh from the server rather than waiting for next boot.
        getServerStreak().then(setServerStreak).catch(() => {});
      })
      .catch((e) => {
        if (e instanceof AuthRequiredError) void requireAuth();
      });
  }

  function onWeightLogged(kg: number) {
    const prev = latestProfileRef.current;
    if (!prev) return;
    const next = { ...prev, weightKg: kg };
    cacheProfile(next, true);
    // Persist the new current weight to the account's SERVER profile too.
    // Without this, BMR/TDEE/targets recompute now but silently REVERT on the
    // next reload: syncProfileAndLogs pulls getProfile(), which would still
    // return the old onboarding weight, overwriting this change. Logging a
    // weight must move the profile the metabolism is computed from.
    void persistProfile(next, "Couldn't update your weight", { rollbackProfile: prev });
  }

  if (!booted) {
    return (
      <View style={[styles.root, styles.center]}>
        <ActivityIndicator size="large" color={colors.green} />
      </View>
    );
  }

  // Google-only gate: no account means no access — you can't create or edit any
  // details until you sign in.
  if (!auth) {
    return (
      <>
        <AuthGate onAuthed={onAuthed} />
        <CookieBanner />
      </>
    );
  }

  // Signed in, but still fetching this account's profile from the server right
  // after login. Show a spinner rather than momentarily flashing onboarding.
  if (hydrating) {
    return (
      <View style={[styles.root, styles.center]}>
        <ActivityIndicator size="large" color={colors.green} />
      </View>
    );
  }

  // Onboarding gate: an account is "onboarded" only once it has a complete,
  // valid profile. Anyone signed in without one lands here and cannot reach the
  // app until they finish -- this is the single source of truth for that status.
  if (!isCompleteProfile(profile) || !goal) {
    return (
      <>
        <Onboarding onComplete={completeOnboarding} />
        <CookieBanner />
      </>
    );
  }

  if (showSettings) {
    return (
      <>
        <Settings
          profile={profile}
          onSave={saveSettings}
          onClose={() => setShowSettings(false)}
          onResetAll={resetAll}
        />
        <CookieBanner />
      </>
    );
  }

  return (
    <AppProvider
      value={{
        profile,
        goal,
        logs,
        setLogs,
        streak,
        bestStreak: bestStreakValue,
        account: auth.account,
        scanTrigger,
        triggerScan,
        requireAuth,
        updateAccount,
        onWeightLogged,
        signOut,
        openSettings: () => setShowSettings(true),
        logMeal,
      }}
    >
      <NavigationContainer ref={navRef}>
        <StatusBar style="light" />
        <RootNavigator />
        <CookieBanner />
      </NavigationContainer>
    </AppProvider>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppInner />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { alignItems: "center", justifyContent: "center" },
});
