import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Platform,
  Pressable,
  ScrollView,
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
import {
  APP_NAME,
  APP_TAGLINE,
  APP_SUBTAGLINE,
  GOOGLE_CLIENT_IDS,
  GOOGLE_CONFIGURED,
  AUTH_BYPASS,
  ENABLE_OTP_LOGIN_UI,
} from "./config";
import Icon, { IconName } from "./Icon";
import Logo from "./Logo";
import { initGoogleWeb, renderGoogleButton } from "./googleWeb";
import { openLegal, privacyUrl, termsUrl } from "./legalLinks";

type Props = {
  onAuthed: (state: AuthState) => void;
};

const LANDING_SECTIONS: { icon: IconName; title: string; desc: string }[] = [
  {
    icon: "camera",
    title: "Snap any meal in seconds",
    desc: "Use camera, gallery, or manual add to log Indian meals with calories and macros quickly.",
  },
  {
    icon: "sparkles",
    title: "Get next-meal guidance",
    desc: "The app suggests what to eat next based on your target, what you already logged, and your daily plan.",
  },
  {
    icon: "nutrition",
    title: "Understand nutrition quality",
    desc: "Track protein, carbs, fats, and nutrients so you can improve balance, not just total calories.",
  },
  {
    icon: "dumbbell",
    title: "Connect food and activity",
    desc: "Exercise and food logs stay connected so your progress reflects your full day, not isolated entries.",
  },
  {
    icon: "progress",
    title: "See consistency trends",
    desc: "View daily consistency and progress summaries so new users can understand long-term improvement clearly.",
  },
];

const GOALS: string[] = [
  "Weight loss",
  "Muscle gain",
  "Better daily nutrition",
  "Exercise consistency",
  "Health-focused eating",
];

const FAQS: { q: string; a: string }[] = [
  {
    q: "How do I log meals?",
    a: "Use camera, gallery, voice, or manual search. The app estimates calories and macros and stores your logs for daily tracking.",
  },
  {
    q: "What makes this different from a simple calorie tracker?",
    a: "It does more than counting calories. It suggests what to eat next, shows nutrient balance, and connects food with exercise and consistency.",
  },
  {
    q: "Can beginners use this easily?",
    a: "Yes. Start with one meal, follow the next recommendation, and improve gradually day by day.",
  },
  {
    q: "Will my progress sync across devices?",
    a: "Yes, after sign-in your logs and profile sync so you can continue from any device.",
  },
];

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

// Gentle continuous up/down float — used on the hero logo badge to give the
// landing page a little life without being distracting.
function FloatingBadge({ children }: { children: React.ReactNode }) {
  const translateY = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(translateY, {
          toValue: -8,
          duration: 1600,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: 0,
          duration: 1600,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [translateY]);

  return <Animated.View style={{ transform: [{ translateY }] }}>{children}</Animated.View>;
}

// Fade + slide-up entrance, triggered once on mount. Used to bring each
// landing-page section in gently as the page first renders.
function FadeInUp({
  children,
  delay = 0,
  style,
}: {
  children: React.ReactNode;
  delay?: number;
  style?: any;
}) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(16)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 480,
        delay,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 480,
        delay,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [opacity, translateY, delay]);

  return <Animated.View style={[style, { opacity, transform: [{ translateY }] }]}>{children}</Animated.View>;
}

// Scale-down-on-press feedback for CTA buttons, so taps feel responsive.
function PressScale({
  onPress,
  style,
  children,
}: {
  onPress: () => void;
  style?: any;
  children: React.ReactNode;
}) {
  const scale = useRef(new Animated.Value(1)).current;

  function onPressIn() {
    Animated.spring(scale, { toValue: 0.96, useNativeDriver: true, speed: 40, bounciness: 0 }).start();
  }
  function onPressOut() {
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 40, bounciness: 6 }).start();
  }

  return (
    <Pressable onPress={onPress} onPressIn={onPressIn} onPressOut={onPressOut}>
      <Animated.View style={[style, { transform: [{ scale }] }]}>{children}</Animated.View>
    </Pressable>
  );
}

export default function AuthGate({ onAuthed }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSignIn, setShowSignIn] = useState(false);
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

  if (!AUTH_BYPASS && !showSignIn) {
    return (
      <View style={styles.landingRoot}>
        <ScrollView contentContainerStyle={styles.landingScrollFull} showsVerticalScrollIndicator={false}>
          <LinearGradient colors={gradients.brandDeep} style={styles.landingHero}>
            <FloatingBadge>
              <View style={styles.logoBadge}>
                <Logo size={56} tone="light" />
              </View>
            </FloatingBadge>
            <Text style={styles.heroKicker}>{APP_NAME}</Text>
            <Text style={styles.heroHeadline}>{APP_TAGLINE}</Text>
            <Text style={styles.heroSub}>{APP_SUBTAGLINE}</Text>

            <PressScale style={styles.heroCta} onPress={() => setShowSignIn(true)}>
              <Text style={styles.heroCtaText}>Get started — it's free</Text>
            </PressScale>
            <Text style={styles.heroFinePrint}>No credit card needed · Takes under a minute</Text>
          </LinearGradient>

          <FadeInUp style={styles.statsStrip} delay={80}>
            <>
              <View style={styles.statItem}>
                <Text style={styles.statNumber}>1000+</Text>
                <Text style={styles.statLabel}>Indian foods recognized</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.statItem}>
                <Text style={styles.statNumber}>AI</Text>
                <Text style={styles.statLabel}>Guided next meal, daily</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.statItem}>
                <Text style={styles.statNumber}>Free</Text>
                <Text style={styles.statLabel}>To get started</Text>
              </View>
            </>
          </FadeInUp>

          <FadeInUp style={styles.sectionWrap} delay={120}>
            <>
              <Text style={styles.sectionLabelCentered}>Core idea</Text>
              <Text style={styles.sectionHeading}>
                Track food the way you really eat, then get actionable guidance.
              </Text>
              <Text style={styles.sectionBody}>
                Instead of only showing calories, {APP_NAME} explains what to eat next, what to improve, and how
                your daily choices connect to progress.
              </Text>
            </>
          </FadeInUp>

          <View style={styles.sectionWrap}>
            <Text style={styles.sectionLabelCentered}>What you get</Text>
            <View style={styles.featureGrid}>
              {LANDING_SECTIONS.map((item, idx) => (
                <FadeInUp key={item.title} style={styles.featureCard} delay={160 + idx * 60}>
                  <>
                    <View style={styles.featureIconCircle}>
                      <Icon name={item.icon} size={18} color="#fff" />
                    </View>
                    <Text style={styles.featureTitle}>{item.title}</Text>
                    <Text style={styles.featureDesc}>{item.desc}</Text>
                  </>
                </FadeInUp>
              ))}
            </View>
          </View>

          <View style={styles.sectionWrap}>
            <Text style={styles.sectionLabelCentered}>How it works</Text>
            <View style={styles.stepsWrap}>
              {["Log your meal", "Understand nutrition", "Follow next move", "Stay consistent"].map((step, idx) => (
                <FadeInUp key={step} style={styles.stepRow} delay={idx * 70}>
                  <>
                    <View style={styles.stepDot}>
                      <Text style={styles.stepDotText}>{idx + 1}</Text>
                    </View>
                    <Text style={styles.stepText}>{step}</Text>
                  </>
                </FadeInUp>
              ))}
            </View>
          </View>

          <View style={styles.sectionWrap}>
            <Text style={styles.sectionLabelCentered}>Popular goals</Text>
            <View style={styles.goalWrap}>
              {GOALS.map((goal) => (
                <View key={goal} style={styles.goalChip}>
                  <Text style={styles.goalChipText}>{goal}</Text>
                </View>
              ))}
            </View>
          </View>

          <View style={styles.calloutBanner}>
            <Text style={styles.calloutTitle}>Best for new users</Text>
            <Text style={styles.calloutBody}>
              Start with one meal log, check your suggested next meal, and build daily consistency gradually.
              You do not need to be perfect on day one.
            </Text>
          </View>

          <View style={styles.sectionWrap}>
            <Text style={styles.sectionLabelCentered}>Frequently asked</Text>
            <View style={styles.faqWrap}>
              {FAQS.map((f, idx) => (
                <View key={f.q} style={[styles.faqItem, idx > 0 && styles.faqDivider]}>
                  <Text style={styles.faqQ}>{f.q}</Text>
                  <Text style={styles.faqA}>{f.a}</Text>
                </View>
              ))}
            </View>
          </View>

          <View style={styles.ctaBanner}>
            <LinearGradient colors={gradients.brandDeep} style={styles.ctaBannerInner}>
              <Text style={styles.ctaBannerTitle}>Ready to see what's next for you?</Text>
              <Text style={styles.ctaBannerSub}>Sign in once and your plan, logs, and progress stay synced.</Text>
              <PressScale style={styles.heroCta} onPress={() => setShowSignIn(true)}>
                <Text style={styles.heroCtaText}>Get started — it's free</Text>
              </PressScale>
            </LinearGradient>
          </View>

          <Text style={styles.legal}>
            By continuing you agree to our{" "}
            <Text style={styles.legalLink} onPress={() => void openLegal(termsUrl())}>
              Terms
            </Text>{" "}
            and{" "}
            <Text style={styles.legalLink} onPress={() => void openLegal(privacyUrl())}>
              Privacy Policy
            </Text>
            .
          </Text>
        </ScrollView>

        <View style={styles.stickyBar}>
          <PressScale style={styles.startBtn} onPress={() => setShowSignIn(true)}>
            <Text style={styles.startBtnText}>Continue to sign in</Text>
          </PressScale>
        </View>
      </View>
    );
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

        <Pressable style={styles.backToPreview} onPress={() => setShowSignIn(false)} hitSlop={8}>
          <Text style={styles.backToPreviewText}>Back to preview</Text>
        </Pressable>

        {ENABLE_OTP_LOGIN_UI && (otpStage === "closed" ? (
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
        ))}

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
  landingScroll: { paddingBottom: 8 },

  // Full-page marketing-style landing (Healthify/NutriScan-inspired).
  landingRoot: { flex: 1, backgroundColor: colors.bg },
  landingScrollFull: { paddingBottom: 28 },
  landingHero: {
    paddingTop: 64,
    paddingBottom: 44,
    paddingHorizontal: 28,
    alignItems: "center",
    borderBottomLeftRadius: radius.xl,
    borderBottomRightRadius: radius.xl,
  },
  heroKicker: {
    color: "rgba(255,255,255,0.75)",
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 1.2,
    marginTop: 14,
  },
  heroHeadline: {
    color: "#fff",
    fontSize: 28,
    fontWeight: "900",
    textAlign: "center",
    letterSpacing: -0.5,
    marginTop: 10,
    lineHeight: 34,
  },
  heroSub: {
    color: "rgba(255,255,255,0.85)",
    fontSize: 15,
    textAlign: "center",
    marginTop: 10,
    lineHeight: 21,
    maxWidth: 320,
  },
  heroCta: {
    backgroundColor: "#fff",
    borderRadius: radius.pill,
    paddingVertical: 15,
    paddingHorizontal: 30,
    marginTop: 26,
    ...elevation.md,
  },
  heroCtaText: { color: colors.green, fontSize: 15.5, fontWeight: "900" },
  heroFinePrint: { color: "rgba(255,255,255,0.7)", fontSize: 11.5, marginTop: 12 },

  statsStrip: {
    flexDirection: "row",
    marginTop: -26,
    marginHorizontal: 20,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    paddingVertical: 18,
    justifyContent: "space-around",
    ...elevation.md,
  },
  statItem: { alignItems: "center", flex: 1, paddingHorizontal: 4 },
  statNumber: { color: colors.green, fontSize: 18, fontWeight: "900" },
  statLabel: { color: colors.mute, fontSize: 10.5, fontWeight: "700", textAlign: "center", marginTop: 4 },
  statDivider: { width: 1, backgroundColor: colors.hairline },

  sectionWrap: { paddingHorizontal: 24, paddingTop: 36 },
  sectionLabelCentered: {
    color: colors.green,
    fontSize: 11,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 1,
    textAlign: "center",
  },
  sectionHeading: {
    color: colors.ink,
    fontSize: 21,
    fontWeight: "900",
    textAlign: "center",
    lineHeight: 27,
    marginTop: 8,
  },
  sectionBody: {
    color: colors.inkSoft,
    fontSize: 13.5,
    fontWeight: "600",
    textAlign: "center",
    lineHeight: 20,
    marginTop: 10,
  },

  featureGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 18 },
  featureCard: {
    flexBasis: "47%",
    flexGrow: 1,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: 16,
    ...elevation.sm,
  },
  featureIconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.green,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
  },
  featureTitle: { color: colors.ink, fontSize: 13.5, fontWeight: "800", lineHeight: 18 },
  featureDesc: { color: colors.mute, fontSize: 12, fontWeight: "600", marginTop: 4, lineHeight: 16 },

  calloutBanner: {
    marginHorizontal: 24,
    marginTop: 36,
    backgroundColor: colors.greenTint,
    borderRadius: radius.lg,
    padding: 18,
  },
  calloutTitle: { color: colors.green, fontSize: 13, fontWeight: "900", textTransform: "uppercase", letterSpacing: 0.5 },
  calloutBody: { color: colors.inkSoft, fontSize: 13, fontWeight: "600", lineHeight: 19, marginTop: 8 },

  ctaBanner: { marginHorizontal: 20, marginTop: 40, borderRadius: radius.xl, overflow: "hidden" },
  ctaBannerInner: { padding: 30, alignItems: "center" },
  ctaBannerTitle: { color: "#fff", fontSize: 19, fontWeight: "900", textAlign: "center" },
  ctaBannerSub: { color: "rgba(255,255,255,0.85)", fontSize: 13, textAlign: "center", marginTop: 8, lineHeight: 18 },

  stickyBar: {
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.hairline,
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 18,
  },
  sectionCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radius.md,
    padding: 12,
    marginBottom: 10,
    ...elevation.sm,
  },
  sectionLabel: {
    color: colors.mute,
    fontSize: 11,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  sectionTitle: { color: colors.ink, fontSize: 15, fontWeight: "900", lineHeight: 21 },
  sectionDesc: { color: colors.inkSoft, fontSize: 12.5, fontWeight: "600", lineHeight: 18, marginTop: 6 },
  stepsWrap: { gap: 7 },
  stepRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  stepDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.greenTint,
    alignItems: "center",
    justifyContent: "center",
  },
  stepDotText: { color: colors.green, fontSize: 11, fontWeight: "900" },
  stepText: { color: colors.ink, fontSize: 13, fontWeight: "700", flex: 1 },
  goalWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  goalChip: {
    backgroundColor: colors.greenTint,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  goalChipText: { color: colors.green, fontSize: 11.5, fontWeight: "800" },
  previewList: { gap: 10, marginBottom: 18 },
  previewRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radius.md,
    padding: 12,
  },
  previewIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.greenTint,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  previewTitle: { color: colors.ink, fontSize: 13.5, fontWeight: "800" },
  previewSub: { color: colors.mute, fontSize: 12, fontWeight: "600", marginTop: 2, lineHeight: 16 },
  faqWrap: { gap: 0 },
  faqItem: { paddingVertical: 8 },
  faqDivider: { borderTopWidth: 1, borderTopColor: colors.hairline },
  faqQ: { color: colors.ink, fontSize: 13, fontWeight: "800" },
  faqA: { color: colors.inkSoft, fontSize: 12, fontWeight: "600", marginTop: 3, lineHeight: 17 },
  startBtn: {
    backgroundColor: colors.green,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },
  startBtnText: { color: "#fff", fontSize: 15, fontWeight: "800" },
  error: { color: colors.red, fontSize: 13, fontWeight: "700", marginTop: 14, textAlign: "center" },
  testMode: { color: colors.mute, fontSize: 13, fontWeight: "700", marginTop: 12, textAlign: "center" },
  legal: { color: colors.faint, fontSize: 11, textAlign: "center", marginTop: 18, lineHeight: 16 },
  legalLink: { color: colors.mute, fontWeight: "800", textDecorationLine: "underline" },
  backToPreview: { alignItems: "center", marginTop: 12, paddingVertical: 2 },
  backToPreviewText: { color: colors.green, fontSize: 12.5, fontWeight: "800" },
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
