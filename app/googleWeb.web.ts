// Web-only Google sign-in via Google Identity Services (GIS).
//
// Why not expo-auth-session on web? Google now serves its OAuth pages with a
// Cross-Origin-Opener-Policy header that severs `window.opener`, so the popup
// can't post the token back to the app and sign-in hangs forever ("keeps
// loading"). GIS uses FedCM / a hidden iframe instead of a popup and returns
// the ID token straight to a callback — no popup, no COOP problem.
//
// Requires the app origin (e.g. http://localhost:8081) to be listed under
// "Authorized JavaScript origins" for the Web OAuth client. (No redirect URI
// is needed for GIS.)

const GSI_SRC = "https://accounts.google.com/gsi/client";

let scriptPromise: Promise<void> | null = null;
let initialized = false;
let currentCallback: ((idToken: string) => void) | null = null;

function loadGis(): Promise<void> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const w = window as any;
    if (w.google?.accounts?.id) return resolve();
    const existing = document.querySelector(`script[src="${GSI_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("gsi load failed")));
      return;
    }
    const s = document.createElement("script");
    s.src = GSI_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("gsi load failed"));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export async function initGoogleWeb(
  clientId: string,
  onCredential: (idToken: string) => void
): Promise<void> {
  await loadGis();
  currentCallback = onCredential;
  // Log the EXACT origin Google will check — register this verbatim under the
  // Web OAuth client's "Authorized JavaScript origins".
  try {
    // eslint-disable-next-line no-console
    console.log(
      "[gofit] Register this exact origin in Google Cloud → Authorized JavaScript origins:",
      window.location.origin,
      "| client_id:",
      clientId
    );
  } catch {
    /* ignore */
  }
  const google = (window as any).google;
  if (!initialized) {
    google.accounts.id.initialize({
      client_id: clientId,
      callback: (resp: any) => {
        if (resp?.credential && currentCallback) currentCallback(resp.credential);
      },
      auto_select: false,
      cancel_on_tap_outside: true,
    });
    initialized = true;
  }
}

// The exact origin Google validates against the client's allowed origins.
export function currentOrigin(): string {
  try {
    return window.location.origin;
  } catch {
    return "";
  }
}

export function renderGoogleButton(el: unknown, width?: number): void {
  const google = (window as any).google;
  if (!google?.accounts?.id || !el) return;
  google.accounts.id.renderButton(el as HTMLElement, {
    type: "standard",
    theme: "outline",
    size: "large",
    text: "continue_with",
    shape: "pill",
    logo_alignment: "left",
    width: width || 320,
  });
}

// One Tap prompt as a fallback trigger (used if the rendered button is absent).
export function promptGoogleWeb(): void {
  const google = (window as any).google;
  google?.accounts?.id?.prompt();
}

// Called on sign-out (web). Turns off Google Identity Services auto-select so the
// NEXT sign-in doesn't silently re-issue a credential for the same Google account
// that was just signed out -- the user gets the account chooser instead. This is
// what makes "switch account" actually switch, rather than logging straight back
// into the previous user. (It does not, and cannot, sign the browser out of
// Google itself -- only clears our app's auto-select preference.)
export function signOutGoogleWeb(): void {
  const google = (window as any).google;
  try {
    google?.accounts?.id?.disableAutoSelect();
  } catch {
    /* GIS not loaded yet -- nothing to disable */
  }
}
