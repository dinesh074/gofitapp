import { Platform, Linking } from "react-native";

// Native apps have no "current origin" of their own to build a relative link
// from, so they open the real hosted pages directly. Web just uses a
// same-origin relative path -- works whether that's localhost, a Vercel
// preview, or the production domain, with no hardcoded URL to go stale.
const PROD_ORIGIN = "https://www.gofit.today";

export function privacyUrl(): string {
  return Platform.OS === "web" ? "/privacy.html" : `${PROD_ORIGIN}/privacy.html`;
}

export function termsUrl(): string {
  return Platform.OS === "web" ? "/terms.html" : `${PROD_ORIGIN}/terms.html`;
}

export function downloadUrl(): string {
  return Platform.OS === "web" ? "/download.html" : `${PROD_ORIGIN}/download.html`;
}

export async function openLegal(url: string): Promise<void> {
  if (Platform.OS === "web") {
    // Same tab is fine -- these are simple static pages, not a lost-work risk.
    window.open(url, "_blank");
    return;
  }
  try {
    await Linking.openURL(url);
  } catch {
    // Best-effort -- no in-app fallback viewer for these static pages yet.
  }
}
