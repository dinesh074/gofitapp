// Shared app state for the navigator tree. App.tsx owns the real state and
// callbacks (auth, profile, logs, sync); it publishes them here so the screens
// mounted inside React Navigation can read what they need without every value
// being threaded through navigator params. This keeps the screens' existing
// prop-shaped data available while decoupling them from App's render tree.
import React, { createContext, useContext } from "react";
import type { GoalTargets, Profile } from "./nutrition";
import type { LogMap, Meal } from "./storage";
import type { AuthState } from "./auth";

export type AppContextValue = {
  profile: Profile;
  goal: GoalTargets;
  logs: LogMap;
  setLogs: React.Dispatch<React.SetStateAction<LogMap>>;
  streak: number;
  // Best-ever streak, server-computed (durable, not capped by the 30-day
  // log-retention window). Null until the server value has arrived; screens
  // should fall back to local bestStreak(logs) in that case.
  bestStreak: number | null;
  account: AuthState["account"];
  // Bumped each time the tab bar's center Scan button is pressed so Home can
  // open the capture flow immediately, from any tab.
  scanTrigger: number;
  triggerScan: () => void;
  // Callbacks bridged from App.
  requireAuth: () => void | Promise<void>;
  updateAccount: (account: AuthState["account"]) => void;
  onWeightLogged: (kg: number) => void;
  signOut: () => void | Promise<void>;
  openSettings: () => void;
  // Adds a meal to today's log (local + server), shared so screens outside Home
  // (e.g. the Food Selector) can log directly. Returns nothing; state updates
  // flow back through `logs`.
  logMeal: (meal: Meal) => void;
};

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({
  value,
  children,
}: {
  value: AppContextValue;
  children: React.ReactNode;
}) {
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error("useApp must be used within an AppProvider");
  }
  return ctx;
}
