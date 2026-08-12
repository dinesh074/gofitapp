import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { registerPushToken } from "./api";

// Foreground behaviour: still show the banner + play sound when the app is open.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const REMINDER_IDENTIFIER = "gofit-meal-reminders";

// Daily meal-logging reminders (local — work offline, no server involved).
const MEAL_REMINDERS: { hour: number; minute: number; title: string; body: string }[] = [
  { hour: 9, minute: 0, title: "Breakfast time 🍳", body: "Snap your breakfast to stay on track." },
  { hour: 13, minute: 30, title: "Lunch check-in 🍛", body: "Log your lunch in a tap." },
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
 * Schedule (or re-schedule) the daily local meal reminders. Cancels any existing
 * gofit reminders first so we never stack duplicates.
 */
export async function scheduleMealReminders(): Promise<void> {
  try {
    if (Platform.OS === "web") return; // scheduled local notifs aren't reliable on web.
    await ensureAndroidChannel();
    const granted = await requestNotificationPermission();
    if (!granted) return;

    // Clear our previously-scheduled reminders (identified by data.tag).
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    await Promise.all(
      scheduled
        .filter((s) => (s.content?.data as any)?.tag === REMINDER_IDENTIFIER)
        .map((s) => Notifications.cancelScheduledNotificationAsync(s.identifier))
    );

    for (const r of MEAL_REMINDERS) {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: r.title,
          body: r.body,
          data: { tag: REMINDER_IDENTIFIER },
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
 * Call once the user is signed in: register for remote push AND set up the
 * local daily reminders.
 */
export async function initNotifications(): Promise<void> {
  await registerForRemotePush();
  await scheduleMealReminders();
}
