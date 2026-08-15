// Points at the live Render deployment -- required for the web build (a public
// web app can't reach a LAN IP) and works for native builds too. If you need to
// test against your own machine's local backend on a real phone, temporarily
// swap this to "http://<your-LAN-IP>:8000" (127.0.0.1/localhost only works for
// web/simulator, not a physical device) -- but always revert to the Render URL
// below before committing/building for real users.
export const API_BASE = "https://gofit-backend-xnik.onrender.com";

// Optional shared secret. Must match the backend's APP_API_KEY when auth is
// enabled. Leave empty for local dev where the backend has no APP_API_KEY set.
export const API_KEY = "u1sNU73PeytYfQ1DqkPMkiaAxjMy304LE0OeYjDSrvg";

// Product branding — change once, applies everywhere.
export const APP_NAME = "gofit.today";
export const APP_TAGLINE = "Snap your Indian food. Know what to eat next.";
export const APP_SUBTAGLINE = "Your food, fitness & progress — connected.";

// --- Google Sign-In ----------------------------------------------------------
// Web OAuth client ID is filled in (public — safe to ship). Create iOS/Android
// OAuth client IDs at https://console.cloud.google.com/apis/credentials and
// paste them below when you build for a real device. Never put the OAuth client
// SECRET here — mobile/web sign-in doesn't use it.
export const GOOGLE_CLIENT_IDS = {
  expo: "688551717833-uk0n3or0b09d797pvinrqbf5jch2g4d6.apps.googleusercontent.com",
  web: "688551717833-uk0n3or0b09d797pvinrqbf5jch2g4d6.apps.googleusercontent.com",
  ios: "REPLACE_WITH_IOS_CLIENT_ID.apps.googleusercontent.com",
  android: "688551717833-42f2o96676l3e3gkh8bi7t2be7o4v35m.apps.googleusercontent.com",
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
