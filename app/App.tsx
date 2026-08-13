import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import Onboarding from "./Onboarding";
import Settings from "./Settings";
import HomeScreen from "./HomeScreen";
import ProgressScreen from "./ProgressScreen";
import CommunityScreen from "./CommunityScreen";
import ProfileScreen from "./ProfileScreen";
import AuthGate from "./AuthGate";
import CookieBanner from "./CookieBanner";
import TabBar, { TabKey } from "./TabBar";
import { computeGoal, isCompleteProfile, Profile } from "./nutrition";
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
  AuthRequiredError,
} from "./api";
import { initNotifications } from "./push";
import {
  clearExtras,
  clearLogs,
  clearProfile,
  computeStreak,
  loadLogs,
  loadProfile,
  LogMap,
  saveLogs,
  saveProfile,
} from "./storage";

export default function App() {
  const [logs, setLogs] = useState<LogMap>({});
  const [profile, setProfile] = useState<Profile | null>(null);
  const [booted, setBooted] = useState(false);
  const [tab, setTab] = useState<TabKey>("home");
  const [showSettings, setShowSettings] = useState(false);
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

  useEffect(() => {
    Promise.all([loadLogs(), loadProfile(), loadAuth()]).then(([l, p, a]) => {
      setLogs(l);
      setProfile(p);
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
        void syncProfileAndLogs(p, l);
      }
    });
  }, []);

  // The tables this account's profile and meal history actually live in
  // (backend/progress.py) used to not exist at all -- everything below was
  // only ever in this device's local storage. On boot: prefer the server's
  // copy if it has one (this device might be new, or storage was cleared);
  // otherwise, this local data predates the server table existing at all --
  // back it up once so it isn't stuck local-only forever.
  async function syncProfileAndLogs(localProfile: Profile | null, localLogs: LogMap) {
    try {
      const { profile: serverProfile } = await getProfile();
      if (isCompleteProfile(serverProfile)) {
        setProfile(serverProfile);
        void saveProfile(serverProfile);
      } else if (localProfile) {
        await putProfile(localProfile).catch(() => {});
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
      } else {
        for (const day of Object.values(localLogs)) {
          for (const meal of day.meals) {
            await addServerLog(day.date, meal).catch(() => {});
          }
        }
      }
    } catch (e: any) {
      if (e instanceof AuthRequiredError) void requireAuth();
    }
  }

  const goal = useMemo(() => (profile ? computeGoal(profile) : null), [profile]);
  const streak = useMemo(() => computeStreak(logs), [logs]);

  function completeOnboarding(p: Profile) {
    setProfile(p);
    saveProfile(p);
    putProfile(p).catch((e) => {
      if (e instanceof AuthRequiredError) void requireAuth();
    });
  }

  function saveSettings(p: Profile) {
    setProfile(p);
    saveProfile(p);
    setShowSettings(false);
    putProfile(p).catch((e) => {
      if (e instanceof AuthRequiredError) void requireAuth();
    });
  }

  async function resetAll() {
    await Promise.all([clearProfile(), clearLogs(), clearExtras(), clearAuth()]);
    setLogs({});
    setProfile(null);
    setAuth(null);
    setShowSettings(false);
    setTab("home");
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
    await Promise.all([clearProfile(), clearLogs(), clearExtras()]);
    setProfile(null);
    setLogs({});
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
      await syncProfileAndLogs(null, {});
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
    // Clear this account's cached data too, not just the token -- otherwise the
    // next account to sign in on this device would inherit the previous user's
    // profile and logs (local storage keys are not per-account).
    await Promise.all([clearAuth(), clearProfile(), clearLogs(), clearExtras()]);
    setAuth(null);
    setProfile(null);
    setLogs({});
    setShowSettings(false);
    setTab("home");
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

  function onWeightLogged(kg: number) {
    setProfile((prev) => {
      if (!prev) return prev;
      const next = { ...prev, weightKg: kg };
      saveProfile(next);
      return next;
    });
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
    <View style={styles.root}>
      <StatusBar style="light" />
      <View style={styles.content}>
        {tab === "home" && (
          <HomeScreen
            profile={profile}
            goal={goal}
            logs={logs}
            setLogs={setLogs}
            streak={streak}
            account={auth.account}
            onRequireAuth={requireAuth}
            onAccountUpdate={updateAccount}
            scanTrigger={scanTrigger}
          />
        )}
        {tab === "progress" && (
          <ProgressScreen
            profile={profile}
            goal={goal}
            logs={logs}
            setLogs={setLogs}
            onWeightLogged={onWeightLogged}
            onRequireAuth={requireAuth}
          />
        )}
        {tab === "community" && (
          <CommunityScreen
            profile={profile}
            logs={logs}
            account={auth.account}
            onRequireAuth={requireAuth}
          />
        )}
        {tab === "profile" && (
          <ProfileScreen
            profile={profile}
            goal={goal}
            logs={logs}
            account={auth.account}
            onEditProfile={() => setShowSettings(true)}
            onSignIn={requireAuth}
            onSignOut={signOut}
            onRequireAuth={requireAuth}
          />
        )}
      </View>
      <TabBar
        active={tab}
        onChange={setTab}
        onScanPress={() => {
          setTab("home");
          setScanTrigger((n) => n + 1);
        }}
      />
      <CookieBanner />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { alignItems: "center", justifyContent: "center" },
  content: { flex: 1 },
});
