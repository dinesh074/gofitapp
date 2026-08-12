// Change this to your computer's LAN IP when testing on a real phone via Expo Go,
// e.g. "http://192.168.1.20:8000". Use localhost only for web/simulator.
export const API_BASE = "http://192.168.0.103:8000";

// Optional shared secret. Must match the backend's APP_API_KEY when auth is
// enabled. Leave empty for local dev where the backend has no APP_API_KEY set.
export const API_KEY = "u1sNU73PeytYfQ1DqkPMkiaAxjMy304LE0OeYjDSrvg";

// Product branding — change once, applies everywhere.
export const APP_NAME = "gofit.today";
export const APP_TAGLINE = "Snap Indian food. Get calories.";

// --- Google Sign-In ----------------------------------------------------------
// Web OAuth client ID is filled in (public — safe to ship). Create iOS/Android
// OAuth client IDs at https://console.cloud.google.com/apis/credentials and
// paste them below when you build for a real device. Never put the OAuth client
// SECRET here — mobile/web sign-in doesn't use it.
export const GOOGLE_CLIENT_IDS = {
  expo: "688551717833-uk0n3or0b09d797pvinrqbf5jch2g4d6.apps.googleusercontent.com",
  web: "688551717833-uk0n3or0b09d797pvinrqbf5jch2g4d6.apps.googleusercontent.com",
  ios: "REPLACE_WITH_IOS_CLIENT_ID.apps.googleusercontent.com",
  android: "REPLACE_WITH_ANDROID_CLIENT_ID.apps.googleusercontent.com",
};

// Google login is considered configured once the web client ID is real (that's
// the one used on web and as the Expo fallback). iOS/Android IDs are only needed
// for native device builds.
export const GOOGLE_CONFIGURED = !GOOGLE_CLIENT_IDS.web.startsWith("REPLACE_WITH_");

// Free food scans per account before the paywall (mirror of backend FREE_SCANS).
export const FREE_SCANS = 3;

// TEST MODE: skip Google sign-in and enter the app as a shared "Tester" account
// (backend must have ALLOW_DEV_LOGIN=1). OFF for production — real Google
// sign-in is required. Flip to true only for local testing on your own machine.
export const AUTH_BYPASS = false;
