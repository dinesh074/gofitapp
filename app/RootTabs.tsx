// React Navigation root for the signed-in, onboarded app. Replaces the old
// hand-rolled `tab` state switch in App.tsx with a real bottom-tab navigator so
// we get proper screen transitions, back handling and a per-screen stack we can
// grow (Food Selector, Scan Result, etc.) without more ad-hoc modal state.
//
// The existing polished TabBar component is reused as the tab bar UI (custom
// tabBar), including its center Scan button. Screens read their data from
// AppContext, so their existing prop-shaped inputs are preserved.
import React from "react";
import {
  createBottomTabNavigator,
  BottomTabBarProps,
} from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";

import TabBar, { TabKey } from "./TabBar";
import Screen from "./Screen";
import { useApp } from "./AppContext";

import HomeScreen from "./HomeScreen";
import ProgressScreen from "./ProgressScreen";
import CommunityScreen from "./CommunityScreen";
import ProfileScreen from "./ProfileScreen";
import FoodSelectorScreen from "./FoodSelectorScreen";
import ScanScreen from "./ScanScreen";
import DayLogScreen from "./DayLogScreen";
import MealDetailScreen from "./MealDetailScreen";

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

// Route names match the TabBar's TabKey values so the two stay in lockstep.
const ROUTE_TO_TAB: Record<string, TabKey> = {
  Home: "home",
  Progress: "progress",
  Community: "community",
  Profile: "profile",
};
const TAB_TO_ROUTE: Record<TabKey, string> = {
  home: "Home",
  progress: "Progress",
  community: "Community",
  profile: "Profile",
};

function AppTabBar({ state, navigation }: BottomTabBarProps) {
  const activeRoute = state.routes[state.index]?.name ?? "Home";
  const active = ROUTE_TO_TAB[activeRoute] ?? "home";
  const { triggerScan } = useApp();
  return (
    <TabBar
      active={active}
      onChange={(t) => navigation.navigate(TAB_TO_ROUTE[t])}
      onScanPress={() => {
        // Jump to the Home tab first (in case a modal-covering sheet were to
        // open on top of a non-Home tab it would still work since Modal
        // renders above everything, but landing on Home makes the newly
        // logged meal immediately visible without an extra tab tap).
        if (activeRoute !== "Home") navigation.navigate("Home");
        // Same single entry point as Home's own "Add food" button -- bumps
        // scanTrigger, which HomeScreen is listening on to open the full
        // AddFoodSheet (camera, search database, gallery, barcode, manual
        // log, voice, exercise, water, weight). Previously this navigated
        // straight to the camera, silently skipping every other option.
        triggerScan();
      }}
    />
  );
}

function HomeTab() {
  const {
    profile,
    goal,
    logs,
    setLogs,
    streak,
    account,
    scanTrigger,
    requireAuth,
    updateAccount,
    onWeightLogged,
  } = useApp();
  return (
    <Screen edgeTop>
      <HomeScreen
        profile={profile}
        goal={goal}
        logs={logs}
        setLogs={setLogs}
        streak={streak}
        account={account}
        onRequireAuth={requireAuth}
        onAccountUpdate={updateAccount}
        scanTrigger={scanTrigger}
        onWeightLogged={onWeightLogged}
      />
    </Screen>
  );
}

function ProgressTab() {
  const { profile, goal, logs, setLogs, onWeightLogged, requireAuth, account, streak, bestStreak } =
    useApp();
  return (
    <Screen>
      <ProgressScreen
        profile={profile}
        goal={goal}
        logs={logs}
        setLogs={setLogs}
        onWeightLogged={onWeightLogged}
        onRequireAuth={requireAuth}
        accountId={account.id}
        streak={streak}
        bestStreak={bestStreak}
      />
    </Screen>
  );
}

function CommunityTab() {
  const { profile, logs, account, requireAuth, streak } = useApp();
  return (
    <Screen edgeTop>
      <CommunityScreen
        profile={profile}
        logs={logs}
        account={account}
        streak={streak}
        onRequireAuth={requireAuth}
      />
    </Screen>
  );
}

function ProfileTab() {
  const { profile, goal, logs, account, openSettings, requireAuth, signOut, streak, bestStreak } =
    useApp();
  return (
    <Screen edgeTop>
      <ProfileScreen
        profile={profile}
        goal={goal}
        logs={logs}
        account={account}
        streak={streak}
        bestStreak={bestStreak}
        onEditProfile={openSettings}
        onSignIn={requireAuth}
        onSignOut={signOut}
        onRequireAuth={requireAuth}
      />
    </Screen>
  );
}

export default function RootTabs() {
  return (
    <Tab.Navigator
      tabBar={(props) => <AppTabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tab.Screen name="Home" component={HomeTab} />
      <Tab.Screen name="Progress" component={ProgressTab} />
      <Tab.Screen name="Community" component={CommunityTab} />
      <Tab.Screen name="Profile" component={ProfileTab} />
    </Tab.Navigator>
  );
}

// Root native-stack: the tab shell plus screens pushed over it (Food Selector,
// and more to come — Scan Result, etc.). Keeping the tabs as one stack entry
// means pushed screens cover the tab bar, giving real full-screen flows.
export function RootNavigator() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Tabs" component={RootTabs} />
      <Stack.Screen
        name="FoodSelector"
        component={FoodSelectorScreen}
        options={{ presentation: "card", animation: "slide_from_right" }}
      />
      <Stack.Screen
        name="Scan"
        component={ScanScreen}
        options={{ presentation: "card", animation: "slide_from_bottom" }}
      />
      <Stack.Screen
        name="DayLog"
        component={DayLogScreen}
        options={{ presentation: "card", animation: "slide_from_right" }}
      />
      <Stack.Screen
        name="MealDetail"
        component={MealDetailScreen}
        options={{ presentation: "card", animation: "slide_from_right" }}
      />
    </Stack.Navigator>
  );
}
