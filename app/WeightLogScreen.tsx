import React, { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import Screen from "./Screen";
import Icon from "./Icon";
import NumberStepper from "./NumberStepper";
import { colors, elevation, radius } from "./theme";
import { LIMITS, clamp } from "./nutrition";
import { addWeight } from "./storage";
import { addServerWeight, AuthRequiredError } from "./api";
import { goBackOrTabs } from "./nav";
import { useApp } from "./AppContext";

export default function WeightLogScreen() {
  const navigation = useNavigation<any>();
  const { profile, onWeightLogged, requireAuth } = useApp();
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const clampWeight = (n: number) => round1(clamp(n, LIMITS.weightKg.min, LIMITS.weightKg.max));
  const [entry, setEntry] = useState<number>(clampWeight(profile.weightKg));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await addWeight(entry);
      await addServerWeight(entry);
      onWeightLogged(entry);
      goBackOrTabs(navigation);
    } catch (e) {
      if (e instanceof AuthRequiredError) {
        requireAuth();
        goBackOrTabs(navigation);
        return;
      }
      setError("Couldn't save weight. Please try again.");
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
        <Text style={styles.headerTitle}>Weight</Text>
        <View style={styles.iconBtn} />
      </View>

      <View style={styles.body}>
        <View style={styles.card}>
          <Text style={styles.title}>Log today's weight</Text>
          <Text style={styles.sub}>Updates your profile and target calculations.</Text>

          <View style={styles.stepperWrap}>
            <NumberStepper
              value={entry}
              min={LIMITS.weightKg.min}
              max={LIMITS.weightKg.max}
              step={0.1}
              decimals={1}
              unit="kg"
              compact
              onChange={(v) => setEntry(clampWeight(v))}
            />
          </View>

          <Pressable style={[styles.saveBtn, busy && styles.btnDisabled]} onPress={save} disabled={busy}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>Save weight</Text>}
          </Pressable>
        </View>
        {error && <Text style={styles.error}>{error}</Text>}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingTop: 8 },
  iconBtn: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  headerTitle: { color: colors.ink, fontSize: 20, fontWeight: "900" },
  body: { padding: 16 },
  card: { backgroundColor: colors.card, borderRadius: 18, padding: 16, ...elevation.sm },
  title: { color: colors.ink, fontSize: 18, fontWeight: "900" },
  sub: { color: colors.mute, fontSize: 12.5, fontWeight: "600", marginTop: 4 },
  stepperWrap: { alignItems: "center", marginTop: 16, marginBottom: 6 },
  saveBtn: { marginTop: 12, backgroundColor: colors.green, borderRadius: radius.md, minHeight: 46, alignItems: "center", justifyContent: "center" },
  saveText: { color: "#fff", fontSize: 15, fontWeight: "800" },
  btnDisabled: { opacity: 0.6 },
  error: { color: colors.red, fontSize: 12.5, fontWeight: "700", textAlign: "center", marginTop: 12 },
});

