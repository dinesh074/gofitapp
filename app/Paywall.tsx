import React, { useState } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { upgradeToPro, AuthRequiredError } from "./api";
import { purchasePro, isPaymentsConfigured, PaymentCancelledError } from "./payments";
import { AUTH_BYPASS } from "./config";
import { Account } from "./auth";
import { colors, radius, gradients, elevation } from "./theme";
import Icon, { IconName } from "./Icon";
import PressableScale from "./PressableScale";

type Props = {
  visible: boolean;
  onClose: () => void;
  onUpgraded: (account: Account) => void;
  // Called when the backend rejects the request because the session is no
  // longer valid (expired token, or the account was removed server-side) --
  // the caller should drop back to sign-in instead of leaving a dead-end error.
  onRequireAuth: () => void;
};

const PERKS: { icon: IconName; text: string }[] = [
  { icon: "scan", text: "Unlimited food scans" },
  { icon: "protein", text: "Full macro breakdown on every meal" },
  { icon: "progress", text: "Progress history & weight trends" },
  { icon: "community", text: "Post & compete in the community" },
];

// Shown when the free-scan trial is used up. Runs the real Razorpay checkout;
// if the backend has no Razorpay keys yet, it falls back to the test-mode
// instant upgrade (only while AUTH_BYPASS is on).
export default function Paywall({ visible, onClose, onUpgraded, onRequireAuth }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upgrade() {
    setError(null);
    setBusy(true);
    try {
      if (await isPaymentsConfigured()) {
        const account = await purchasePro();
        onUpgraded(account);
      } else if (AUTH_BYPASS) {
        // Payments not wired yet — let testers unlock Pro instantly.
        const res = await upgradeToPro();
        onUpgraded(res.account);
      } else {
        setError("Payments aren't available right now. Please try again later.");
      }
    } catch (e: any) {
      if (e instanceof PaymentCancelledError) return; // user backed out; no error
      if (e instanceof AuthRequiredError) {
        onClose();
        onRequireAuth();
        return;
      }
      setError(e?.message || "Couldn't complete the upgrade. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.backdropTap} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.grabber} />
          <LinearGradient colors={gradients.brand} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.hero}>
            <View style={styles.crown}>
              <Icon name="star" size={26} color="#FFD8A8" />
            </View>
            <Text style={styles.heroTitle}>Go Pro</Text>
            <Text style={styles.heroSub}>You've used all your free scans</Text>
          </LinearGradient>

          <View style={styles.perks}>
            {PERKS.map((p) => (
              <View key={p.text} style={styles.perkRow}>
                <View style={styles.perkIcon}>
                  <Icon name={p.icon} size={16} color={colors.green} />
                </View>
                <Text style={styles.perkText}>{p.text}</Text>
                <Icon name="check" size={18} color={colors.green} />
              </View>
            ))}
          </View>

          <View style={styles.priceCard}>
            <Text style={styles.price}>₹299<Text style={styles.priceUnit}> / month</Text></Text>
            <Text style={styles.priceNote}>Cancel anytime</Text>
          </View>

          {error && <Text style={styles.error}>{error}</Text>}

          <PressableScale style={[styles.cta, busy && styles.ctaBusy]} onPress={upgrade} disabled={busy}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.ctaText}>Upgrade to Pro</Text>}
          </PressableScale>
          <Pressable style={styles.later} onPress={onClose}>
            <Text style={styles.laterText}>Maybe later</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" },
  backdropTap: { flex: 1 },
  sheet: { backgroundColor: colors.bg, borderTopLeftRadius: 26, borderTopRightRadius: 26, paddingHorizontal: 20, paddingBottom: 26, maxHeight: "92%" },
  grabber: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: "#CBD5D0", marginTop: 10, marginBottom: 12 },

  hero: { borderRadius: radius.xl, alignItems: "center", paddingVertical: 22, ...elevation.md },
  crown: { width: 56, height: 56, borderRadius: 28, backgroundColor: "rgba(255,255,255,0.18)", alignItems: "center", justifyContent: "center" },
  heroTitle: { color: "#fff", fontSize: 26, fontWeight: "900", marginTop: 10, letterSpacing: -0.3 },
  heroSub: { color: "#CDEBD9", fontSize: 13, marginTop: 2 },

  perks: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 8, marginTop: 16, ...elevation.sm },
  perkRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 8 },
  perkIcon: { width: 34, height: 34, borderRadius: 10, backgroundColor: colors.greenTint, alignItems: "center", justifyContent: "center" },
  perkText: { flex: 1, fontSize: 14.5, fontWeight: "700", color: colors.ink },

  priceCard: { alignItems: "center", marginTop: 18 },
  price: { fontSize: 30, fontWeight: "900", color: colors.ink },
  priceUnit: { fontSize: 15, fontWeight: "700", color: colors.mute },
  priceNote: { fontSize: 12, color: colors.mute, marginTop: 2, fontWeight: "600" },

  error: { color: colors.red, fontSize: 13, fontWeight: "700", marginTop: 12, textAlign: "center" },

  cta: { backgroundColor: colors.green, borderRadius: radius.md, paddingVertical: 16, alignItems: "center", marginTop: 18, ...elevation.sm },
  ctaBusy: { opacity: 0.8 },
  ctaText: { color: "#fff", fontWeight: "900", fontSize: 16 },
  later: { alignItems: "center", paddingVertical: 14 },
  laterText: { color: colors.mute, fontWeight: "700", fontSize: 14 },
});
