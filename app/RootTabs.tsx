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
import { useNavigation } from "@react-navigation/native";

import TabBar, { TabKey } from "./TabBar";
import Screen from "./Screen";
import { useApp } from "./AppContext";

import HomeScreen from "./HomeScreen";
import PlanScreen from "./PlanScreen";
import ScanHubScreen from "./ScanHubScreen";
import ProgressScreen from "./ProgressScreen";
import CommunityScreen from "./CommunityScreen";
import ProfileScreen from "./ProfileScreen";
import FoodSelectorScreen from "./FoodSelectorScreen";
import ScanScreen from "./ScanScreen";
import DayLogScreen from "./DayLogScreen";
import MealDetailScreen from "./MealDetailScreen";
import NextMoveScreen from "./NextMoveScreen";
import ExerciseLogScreen from "./ExerciseLogScreen";
import BarcodeLookupScreen from "./BarcodeLookupScreen";
import DescribeMealScreen from "./DescribeMealScreen";
import WaterLogScreen from "./WaterLogScreen";
import WeightLogScreen from "./WeightLogScreen";
import PaymentScreen from "./PaymentScreen";

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

// Route names match the TabBar's TabKey values so the two stay in lockstep.
const ROUTE_TO_TAB: Record<string, TabKey> = {
  Home: "home",
  Plan: "plan",
  ScanHub: "scan",
  Progress: "progress",
  Profile: "profile",
};
const TAB_TO_ROUTE: Record<TabKey, string> = {
  home: "Home",
  plan: "Plan",
  scan: "ScanHub",
  progress: "Progress",
  profile: "Profile",
};

function AppTabBar({ state, navigation }: BottomTabBarProps) {
  const activeRoute = state.routes[state.index]?.name ?? "Home";
  const active = ROUTE_TO_TAB[activeRoute] ?? "home";
  return (
    <TabBar
      active={active}
      onChange={(t) => {
        if (t === "scan") {
          const parent = navigation.getParent();
          if (parent) {
            parent.navigate("Scan", { mode: "camera" });
            return;
          }
          (navigation as any).navigate("Scan", { mode: "camera" });
          return;
        }
        navigation.navigate(TAB_TO_ROUTE[t]);
      }}
      onScanPress={() => {
        const parent = navigation.getParent();
        if (parent) parent.navigate("Scan", { mode: "camera" });
        else (navigation as any).navigate("Scan", { mode: "camera" });
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
        accountId={account?.id ?? null}
        streak={streak}
        bestStreak={bestStreak}
      />
    </Screen>
  );
}

function PlanTab() {
  return <PlanScreen />;
}

function ScanHubTab() {
  return <ScanHubScreen />;
}

function ProfileTab() {
  const navigation = useNavigation<any>();
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
        onOpenCommunity={() => navigation.navigate("Community")}
        onOpenSubscription={() => {
          const parent = navigation.getParent();
          if (parent) parent.navigate("Payment");
          else (navigation as any).navigate("Payment");
        }}
      />
    </Screen>
  );
}

function CommunityPage() {
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

export default function RootTabs() {
  return (
    <Tab.Navigator
      tabBar={(props) => <AppTabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tab.Screen name="Home" component={HomeTab} />
      <Tab.Screen name="Plan" component={PlanTab} />
      <Tab.Screen name="ScanHub" component={ScanHubTab} />
      <Tab.Screen name="Progress" component={ProgressTab} />
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
        name="ManualSearch"
        component={FoodSelectorScreen}
        options={{ presentation: "card", animation: "slide_from_right" }}
      />
      <Stack.Screen
        name="TemplateMeals"
        component={FoodSelectorScreen}
        initialParams={{ mode: "template" }}
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
      <Stack.Screen
        name="NextMove"
        component={NextMoveScreen}
        options={{ presentation: "card", animation: "slide_from_right" }}
      />
      <Stack.Screen
        name="Community"
        component={CommunityPage}
        options={{ presentation: "card", animation: "slide_from_right" }}
      />
      <Stack.Screen
        name="ExerciseLog"
        component={ExerciseLogScreen}
        options={{ presentation: "card", animation: "slide_from_right" }}
      />
      <Stack.Screen
        name="BarcodeLookup"
        component={BarcodeLookupScreen}
        options={{ presentation: "card", animation: "slide_from_right" }}
      />
      <Stack.Screen
        name="DescribeMeal"
        component={DescribeMealScreen}
        options={{ presentation: "card", animation: "slide_from_right" }}
      />
      <Stack.Screen
        name="WaterLog"
        component={WaterLogScreen}
        options={{ presentation: "card", animation: "slide_from_right" }}
      />
      <Stack.Screen
        name="WeightLog"
        component={WeightLogScreen}
        options={{ presentation: "card", animation: "slide_from_right" }}
      />
      <Stack.Screen
        name="Payment"
        component={PaymentScreen}
        options={{ presentation: "card", animation: "slide_from_right" }}
      />
    </Stack.Navigator>
  );
}
