import React, { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useNavigation } from "@react-navigation/native";
import { upgradeToPro, AuthRequiredError } from "./api";
import { purchasePro, isPaymentsConfigured, PaymentCancelledError } from "./payments";
import { AUTH_BYPASS } from "./config";
import { colors, radius, gradients, elevation } from "./theme";
import Icon, { IconName } from "./Icon";
import PressableScale from "./PressableScale";
import Screen from "./Screen";
import { useApp } from "./AppContext";
import { goBackOrTabs } from "./nav";

const PERKS: { icon: IconName; text: string }[] = [
  { icon: "scan", text: "Unlimited AI meal scanning - no daily limit" },
  { icon: "protein", text: "AI nutrition recommendations and meal planning" },
  { icon: "progress", text: "Advanced insights, adaptive targets and grocery lists" },
  { icon: "community", text: "Full macro breakdown and community posting" },
];

export default function PaymentScreen() {
  const navigation = useNavigation<any>();
  const { requireAuth, updateAccount } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upgrade() {
    setError(null);
    setBusy(true);
    try {
      if (await isPaymentsConfigured()) {
        const account = await purchasePro();
        updateAccount(account);
        goBackOrTabs(navigation);
      } else if (AUTH_BYPASS) {
        const res = await upgradeToPro();
        updateAccount(res.account);
        goBackOrTabs(navigation);
      } else {
        setError("Payments are not configured yet. Add Razorpay keys and webhook secret on backend.");
      }
    } catch (e: any) {
      if (e instanceof PaymentCancelledError) {
        setBusy(false);
        return;
      }
      if (e instanceof AuthRequiredError) {
        requireAuth();
        goBackOrTabs(navigation);
        return;
      }
      setError(e?.message || "Couldn't complete the upgrade. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen edgeTop background={colors.bg}>
      <View style={styles.header}>
        <Pressable style={styles.iconBtn} onPress={() => goBackOrTabs(navigation)} hitSlop={8}>
          <Icon name="chevronLeft" size={22} color={colors.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>Go Pro</Text>
        <View style={styles.iconBtn} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <LinearGradient colors={gradients.brand} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.hero}>
          <View style={styles.crown}>
            <Icon name="star" size={26} color="#FFD8A8" />
          </View>
          <Text style={styles.heroTitle}>Go Pro</Text>
          <Text style={styles.heroSub}>Unlock the full gofit.today experience</Text>
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
          <Text style={styles.price}>
            ₹299<Text style={styles.priceUnit}> / month</Text>
          </Text>
          <Text style={styles.priceNote}>Auto-renews monthly at ₹299 - cancel anytime</Text>
        </View>

        <View style={styles.terms}>
          <Text style={styles.termLine}>• Billed ₹299/month via Razorpay. Renews automatically until cancelled.</Text>
          <Text style={styles.termLine}>• No free trial — your free plan stays free forever.</Text>
          <Text style={styles.termLine}>• Cancel anytime; Pro stays active until month-end.</Text>
        </View>

        {error && <Text style={styles.error}>{error}</Text>}

        <PressableScale style={[styles.cta, busy && styles.ctaBusy]} onPress={upgrade} disabled={busy}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.ctaText}>Upgrade to Pro - ₹299/mo</Text>}
        </PressableScale>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingTop: 8 },
  iconBtn: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  headerTitle: { color: colors.ink, fontSize: 20, fontWeight: "900" },
  body: { padding: 16, paddingBottom: 28 },
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
  terms: { marginTop: 14, gap: 4 },
  termLine: { fontSize: 11.5, color: colors.mute, lineHeight: 16, fontWeight: "500" },
  error: { color: colors.red, fontSize: 13, fontWeight: "700", marginTop: 12, textAlign: "center" },
  cta: { backgroundColor: colors.green, borderRadius: radius.md, paddingVertical: 16, alignItems: "center", marginTop: 18, ...elevation.sm },
  ctaBusy: { opacity: 0.8 },
  ctaText: { color: "#fff", fontWeight: "900", fontSize: 16 },
});

