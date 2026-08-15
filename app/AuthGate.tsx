import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import {
  GoogleSignin,
  isSuccessResponse,
  isErrorWithCode,
  statusCodes,
} from "@react-native-google-signin/google-signin";
import Svg, { Path } from "react-native-svg";
import { googleLogin, devLogin, requestOtp, verifyOtp } from "./api";
import { AuthState } from "./auth";
import { colors, radius, gradients, elevation } from "./theme";
import { APP_NAME, GOOGLE_CLIENT_IDS, GOOGLE_CONFIGURED, AUTH_BYPASS } from "./config";
import Icon, { IconName } from "./Icon";
import Logo from "./Logo";
import { initGoogleWeb, renderGoogleButton } from "./googleWeb";
import { openLegal, privacyUrl, termsUrl } from "./legalLinks";

type Props = {
  onAuthed: (state: AuthState) => void;
};

// Google "G" mark drawn with SVG (official four-colour logo).
function GoogleG() {
  return (
    <Svg width={20} height={20} viewBox="0 0 48 48">
      <Path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z" />
      <Path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <Path fill="#4CAF50" d="M24 44c5.5 0 10.5-2.1 14.3-5.6l-6.6-5.6C29.6 34.5 26.9 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.6 39.6 16.2 44 24 44z" />
      <Path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.6 5.6C41.4 36.2 44 30.6 44 24c0-1.3-.1-2.3-.4-3.5z" />
    </Svg>
  );
}

function Perk({ icon, text }: { icon: IconName; text: string }) {
  return (
    <View style={styles.perkRow}>
      <View style={styles.perkIcon}>
        <Icon name={icon} size={16} color="#fff" />
      </View>
      <Text style={styles.perkText}>{text}</Text>
    </View>
  );
}

export default function AuthGate({ onAuthed }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const webBtnRef = useRef<View>(null);
  const isWeb = Platform.OS === "web";

  // Email one-time-code sign-in -- shown as a fallback under the Google
  // button for anyone who'd rather not use Google (or is on a device where
  // it isn't set up). "closed" -> "email" (enter address) -> "code" (enter
  // the 6-digit code just emailed).
  const [otpStage, setOtpStage] = useState<"closed" | "email" | "code">("closed");
  const [otpEmail, setOtpEmail] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [otpBusy, setOtpBusy] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [otpNotice, setOtpNotice] = useState<string | null>(null);

  async function sendOtp() {
    const email = otpEmail.trim().toLowerCase();
    if (!email.includes("@")) {
      setOtpError("Enter a valid email address");
      return;
    }
    setOtpBusy(true);
    setOtpError(null);
    try {
      const res = await requestOtp(email);
      setOtpStage("code");
      setOtpNotice(
        res.devCode
          ? `Dev mode: code is ${res.devCode} (email isn't configured yet)`
          : "We emailed you a 6-digit code."
      );
    } catch (e: any) {
      setOtpError(e?.message || "Couldn't send the code. Please try again.");
    } finally {
      setOtpBusy(false);
    }
  }

  async function confirmOtp() {
    const code = otpCode.trim();
    if (code.length < 4) {
      setOtpError("Enter the code from your email");
      return;
    }
    setOtpBusy(true);
    setOtpError(null);
    try {
      const res = await verifyOtp(otpEmail.trim().toLowerCase(), code);
      onAuthed({ token: res.token, account: res.account });
    } catch (e: any) {
      setOtpError(e?.message || "Incorrect or expired code. Please try again.");
    } finally {
      setOtpBusy(false);
    }
  }

  // Native only: Google's own Sign-In SDK (Play Services / Credential Manager on
  // Android) -- NOT a browser redirect. This replaced an expo-auth-session-based
  // flow that opened a system-browser popup and redirected back via the app's
  // custom URL scheme (gofit:///): Google has tightened restrictions on that
  // pattern for "Android"-type OAuth clients ("Custom scheme URI is not enabled
  // for the Android client" -- a real error hit in testing), and even once
  // that's worked around, the redirect intent can land in a fresh app instance
  // on some Android versions/OEMs, losing the in-memory hook state and leaving
  // the sign-in spinner stuck with no error. The native SDK has neither problem:
  // no browser, no redirect, no custom scheme -- it verifies via the app's
  // package name + signing certificate (the SAME Android OAuth client already
  // registered in Google Cloud Console), matching what "Android" client types
  // are actually designed for.
  useEffect(() => {
    if (Platform.OS === "web") return;
    GoogleSignin.configure({ webClientId: GOOGLE_CLIENT_IDS.web });
  }, []);

  async function nativeGoogleSignIn() {
    setError(null);
    if (!GOOGLE_CONFIGURED) {
      setError("Google login isn't set up yet — add your OAuth client ID in config.ts.");
      return;
    }
    setBusy(true);
    try {
      await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
      const response = await GoogleSignin.signIn();
      if (isSuccessResponse(response)) {
        const idToken = response.data.idToken;
        if (idToken) {
          await handleGoogle(idToken);
        } else {
          setError("Google didn't return a sign-in token. Please try again.");
          setBusy(false);
        }
      } else {
        // type === "cancelled" -- user backed out, no error to show.
        setBusy(false);
      }
    } catch (e: any) {
      if (isErrorWithCode(e) && e.code === statusCodes.SIGN_IN_CANCELLED) {
        setBusy(false);
        return;
      }
      if (isErrorWithCode(e) && e.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
        setError("Google Play Services isn't available on this device.");
      } else {
        setError(e?.message || "Google sign-in failed. Please try again.");
      }
      setBusy(false);
    }
  }

  // TEST MODE: skip Google entirely and sign in as the shared Tester account.
  useEffect(() => {
    if (!AUTH_BYPASS) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await devLogin();
        if (!cancelled) onAuthed({ token: res.token, account: res.account });
      } catch (e: any) {
        if (!cancelled)
          setError(
            e?.message ||
              "Sign-in failed. Please try again."
          );
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Web only: Google Identity Services (no popup, no COOP issue).
  useEffect(() => {
    if (AUTH_BYPASS) return;
    if (!isWeb) return;
    if (!GOOGLE_CONFIGURED) {
      setError("Google login isn't set up yet — add your OAuth client ID in config.ts.");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        await initGoogleWeb(GOOGLE_CLIENT_IDS.web, (idToken) => void handleGoogle(idToken));
        if (!cancelled && webBtnRef.current) {
          renderGoogleButton(webBtnRef.current as unknown as HTMLElement, 320);
        }
      } catch {
        setError("Couldn't load Google sign-in. Check your connection and reload.");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleGoogle(idToken: string) {
    setError(null);
    setBusy(true);
    try {
      const res = await googleLogin(idToken);
      onAuthed({ token: res.token, account: res.account });
    } catch (e: any) {
      setError(e?.message || "Google sign-in failed. Please try again.");
      setBusy(false);
    }
  }

  return (
    <LinearGradient colors={gradients.brandDeep} style={styles.root}>
      <View style={styles.hero}>
        <View style={styles.logoBadge}>
          <Logo size={60} tone="light" />
        </View>
        <Text style={styles.brand}>{APP_NAME}</Text>
        <Text style={styles.tagline}>Indian food tracking with a personalized daily plan.</Text>

        <View style={styles.perks}>
          <Perk icon="camera" text="Photo-based meal logging with calories and macros" />
          <Perk icon="sparkles" text="Next-meal guidance and day planning from your targets" />
          <Perk icon="target" text="Progress and goals synced across your devices" />
        </View>
      </View>

      {AUTH_BYPASS ? (
        <View style={[styles.card, { alignItems: "center" }]}>
          <ActivityIndicator color={colors.green} />
          <Text style={styles.testMode}>Signing you in…</Text>
          {error && <Text style={styles.error}>{error}</Text>}
        </View>
      ) : (
        <View style={styles.card}>
        <Text style={styles.cardTitle}>Sign in to get started</Text>
        <Text style={styles.cardSub}>Sign in once to keep your plan, logs, and progress synced securely.</Text>

        {isWeb ? (
          <View style={styles.webBtnWrap}>
            <View ref={webBtnRef} collapsable={false} />
            {busy && <ActivityIndicator color={colors.green} style={{ marginTop: 12 }} />}
          </View>
        ) : (
          <Pressable
            style={[styles.googleBtn, busy && styles.googleBtnBusy]}
            onPress={nativeGoogleSignIn}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator color={colors.ink} />
            ) : (
              <>
                <GoogleG />
                <Text style={styles.googleText}>Continue with Google</Text>
              </>
            )}
          </Pressable>
        )}

        {error && <Text style={styles.error}>{error}</Text>}

        {otpStage === "closed" ? (
          <Pressable style={styles.otpToggle} onPress={() => setOtpStage("email")} hitSlop={8}>
            <Text style={styles.otpToggleText}>Or sign in with an email code</Text>
          </Pressable>
        ) : (
          <View style={styles.otpBox}>
            {otpStage === "email" ? (
              <>
                <TextInput
                  style={styles.otpInput}
                  placeholder="you@example.com"
                  placeholderTextColor={colors.faint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  value={otpEmail}
                  onChangeText={setOtpEmail}
                  editable={!otpBusy}
                />
                <Pressable
                  style={[styles.otpBtn, otpBusy && styles.googleBtnBusy]}
                  onPress={sendOtp}
                  disabled={otpBusy}
                >
                  {otpBusy ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.otpBtnText}>Send code</Text>
                  )}
                </Pressable>
              </>
            ) : (
              <>
                {otpNotice && <Text style={styles.otpNotice}>{otpNotice}</Text>}
                <TextInput
                  style={styles.otpInput}
                  placeholder="6-digit code"
                  placeholderTextColor={colors.faint}
                  keyboardType="number-pad"
                  maxLength={6}
                  value={otpCode}
                  onChangeText={setOtpCode}
                  editable={!otpBusy}
                />
                <Pressable
                  style={[styles.otpBtn, otpBusy && styles.googleBtnBusy]}
                  onPress={confirmOtp}
                  disabled={otpBusy}
                >
                  {otpBusy ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.otpBtnText}>Verify & sign in</Text>
                  )}
                </Pressable>
                <Pressable onPress={() => setOtpStage("email")} hitSlop={8}>
                  <Text style={styles.otpToggleText}>Use a different email / resend</Text>
                </Pressable>
              </>
            )}
            {otpError && <Text style={styles.error}>{otpError}</Text>}
          </View>
        )}

        <Text style={styles.legal}>
          By continuing you agree to our{" "}
          <Text style={styles.legalLink} onPress={() => void openLegal(termsUrl())}>
            Terms
          </Text>{" "}
          and{" "}
          <Text style={styles.legalLink} onPress={() => void openLegal(privacyUrl())}>
            Privacy Policy
          </Text>
          . We never post without your permission.
        </Text>
        </View>
      )}
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  hero: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 28 },
  logoBadge: {
    width: 92,
    height: 92,
    borderRadius: 28,
    backgroundColor: "rgba(255,255,255,0.16)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 18,
  },
  brand: { fontSize: 34, fontWeight: "900", color: "#fff", letterSpacing: -0.5 },
  tagline: { fontSize: 15, color: "rgba(255,255,255,0.85)", marginTop: 8, textAlign: "center" },

  perks: { alignSelf: "stretch", gap: 14, marginTop: 34 },
  perkRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  perkIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  perkText: { color: "#fff", fontSize: 15, fontWeight: "600", flex: 1 },

  card: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 24,
    paddingTop: 26,
    paddingBottom: 40,
    ...elevation.lg,
  },
  cardTitle: { fontSize: 20, fontWeight: "900", color: colors.ink, textAlign: "center" },
  cardSub: {
    fontSize: 13,
    color: colors.mute,
    textAlign: "center",
    marginTop: 6,
    marginBottom: 20,
    lineHeight: 19,
  },
  googleBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    paddingVertical: 16,
    borderWidth: 1.5,
    borderColor: colors.hairline,
    ...elevation.sm,
  },
  googleBtnBusy: { opacity: 0.7 },
  googleText: { fontSize: 16, fontWeight: "800", color: colors.ink },
  webBtnWrap: { alignItems: "center", justifyContent: "center", minHeight: 44 },
  error: { color: colors.red, fontSize: 13, fontWeight: "700", marginTop: 14, textAlign: "center" },
  testMode: { color: colors.mute, fontSize: 13, fontWeight: "700", marginTop: 12, textAlign: "center" },
  legal: { color: colors.faint, fontSize: 11, textAlign: "center", marginTop: 18, lineHeight: 16 },
  legalLink: { color: colors.mute, fontWeight: "800", textDecorationLine: "underline" },
  otpToggle: { alignItems: "center", marginTop: 16, paddingVertical: 4 },
  otpToggleText: { color: colors.green, fontSize: 13, fontWeight: "800", marginTop: 10 },
  otpBox: { marginTop: 16, gap: 10 },
  otpInput: {
    borderWidth: 1.5,
    borderColor: colors.hairline,
    borderRadius: radius.md,
    paddingHorizontal: 16,
    paddingVertical: 13,
    fontSize: 15,
    color: colors.ink,
    backgroundColor: colors.card,
  },
  otpBtn: {
    backgroundColor: colors.green,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  otpBtnText: { color: "#fff", fontSize: 15, fontWeight: "800" },
  otpNotice: { color: colors.mute, fontSize: 12, textAlign: "center", lineHeight: 17 },
});
