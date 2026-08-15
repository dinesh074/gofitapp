import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { registerPushToken } from "./api";
import { loadRemindersEnabled, saveRemindersEnabled } from "./storage";

// Foreground behaviour: still show the banner + play sound when the app is open.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const REMINDER_IDENTIFIER = "gofit-meal-reminders";
const PLAN_ALERT_IDENTIFIER = "gofit-plan-update";

// Daily local reminders (work offline, no server involved). Meal-logging
// nudges plus two water check-ins spread across the day.
const MEAL_REMINDERS: { hour: number; minute: number; title: string; body: string }[] = [
  { hour: 9, minute: 0, title: "Breakfast time 🍳", body: "Snap your breakfast to stay on track." },
  { hour: 11, minute: 30, title: "Water break 💧", body: "Had some water? Log a glass in a tap." },
  { hour: 13, minute: 30, title: "Lunch check-in 🍛", body: "Log your lunch in a tap." },
  { hour: 16, minute: 30, title: "Hydration check 💧", body: "Top up your water and log it." },
  { hour: 20, minute: 30, title: "Dinner log 🌙", body: "Don't forget to log dinner and keep your streak." },
];

/**
 * On Android, notifications need a channel to show with sound/importance.
 */
async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync("default", {
    name: "General",
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: "#0B7A4B",
  });
}

/**
 * Ask for permission (idempotent). Returns true if granted.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  try {
    const { status: existing } = await Notifications.getPermissionsAsync();
    let status = existing;
    if (existing !== "granted") {
      const req = await Notifications.requestPermissionsAsync();
      status = req.status;
    }
    return status === "granted";
  } catch {
    return false;
  }
}

/**
 * Register this device for remote push and send the Expo token to the backend.
 * No-op on web / simulators (no real push there) — swallows all errors so it
 * never blocks sign-in.
 */
export async function registerForRemotePush(): Promise<void> {
  try {
    if (Platform.OS === "web") return; // Expo push needs a physical device.
    if (!Device.isDevice) return; // Simulators can't get a push token.
    await ensureAndroidChannel();
    const granted = await requestNotificationPermission();
    if (!granted) return;

    const projectId =
      (Constants.expoConfig as any)?.extra?.eas?.projectId ??
      (Constants as any)?.easConfig?.projectId;

    const tokenResp = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined
    );
    const token = tokenResp.data;
    if (token) await registerPushToken(token, Platform.OS);
  } catch {
    // Best-effort: remote push simply won't be available on this device.
  }
}

/**
 * Cancel any gofit reminders we previously scheduled (identified by data.tag).
 */
async function cancelScheduledReminders(): Promise<void> {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  await Promise.all(
    scheduled
      .filter((s) => (s.content?.data as any)?.tag === REMINDER_IDENTIFIER)
      .map((s) => Notifications.cancelScheduledNotificationAsync(s.identifier))
  );
}

/**
 * Schedule (or re-schedule) the daily local meal + water reminders. Cancels any
 * existing gofit reminders first so we never stack duplicates. Respects the
 * user's reminder preference (loadRemindersEnabled) -- a no-op when disabled.
 */
export async function scheduleMealReminders(): Promise<void> {
  try {
    if (Platform.OS === "web") return; // scheduled local notifs aren't reliable on web.
    const enabled = await loadRemindersEnabled();
    if (!enabled) {
      await cancelScheduledReminders();
      return;
    }
    await ensureAndroidChannel();
    const granted = await requestNotificationPermission();
    if (!granted) return;

    // Clear our previously-scheduled reminders before re-adding them.
    await cancelScheduledReminders();

    for (const r of MEAL_REMINDERS) {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: r.title,
          body: r.body,
          data: { tag: REMINDER_IDENTIFIER, route: "Plan" },
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DAILY,
          hour: r.hour,
          minute: r.minute,
        },
      });
    }
  } catch {
    // Non-fatal — reminders just won't be scheduled.
  }
}

/**
 * Flip the reminder preference and immediately (re)schedule or cancel. Returns
 * the value actually applied (may differ if permission was denied when turning
 * on). Used by the Settings toggle.
 */
export async function setRemindersEnabled(on: boolean): Promise<boolean> {
  await saveRemindersEnabled(on);
  try {
    if (!on) {
      await cancelScheduledReminders();
      return false;
    }
    if (Platform.OS === "web") return true;
    const granted = await requestNotificationPermission();
    if (!granted) {
      // Permission refused -- keep the pref on, but nothing gets scheduled.
      return true;
    }
    await scheduleMealReminders();
    return true;
  } catch {
    return on;
  }
}

/**
 * Call once the user is signed in: register for remote push AND set up the
 * local daily reminders.
 */
export async function initNotifications(): Promise<void> {
  await registerForRemotePush();
  await scheduleMealReminders();
}

type PlannedMeal = {
  name: string;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
};

async function canSendLocalNotification(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  const enabled = await loadRemindersEnabled();
  if (!enabled) return false;
  await ensureAndroidChannel();
  const granted = await requestNotificationPermission();
  return granted;
}

export async function notifyPlanUpdate(meal: PlannedMeal): Promise<void> {
  try {
    const ok = await canSendLocalNotification();
    if (!ok) return;
    await Notifications.scheduleNotificationAsync({
      content: {
        title: "Plan updated",
        body: `${meal.name} · ~${Math.round(meal.kcal)} kcal · P ${Math.round(meal.protein_g)}g · C ${Math.round(meal.carbs_g)}g · F ${Math.round(meal.fat_g)}g`,
        data: { tag: PLAN_ALERT_IDENTIFIER, route: "Plan" },
      },
      trigger: null,
    });
  } catch {
    // non-fatal
  }
}

export async function notifyNextMealRecommendation(meal: PlannedMeal): Promise<void> {
  try {
    const ok = await canSendLocalNotification();
    if (!ok) return;
    await Notifications.scheduleNotificationAsync({
      content: {
        title: "Your next best move",
        body: `${meal.name} · ~${Math.round(meal.kcal)} kcal · P ${Math.round(meal.protein_g)}g · C ${Math.round(meal.carbs_g)}g · F ${Math.round(meal.fat_g)}g`,
        data: { tag: PLAN_ALERT_IDENTIFIER, route: "Plan" },
      },
      trigger: null,
    });
  } catch {
    // non-fatal
  }
}
