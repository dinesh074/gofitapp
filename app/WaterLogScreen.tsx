import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import Screen from "./Screen";
import Icon from "./Icon";
import { colors, elevation, radius } from "./theme";
import PressableScale from "./PressableScale";
import { addWater, AuthRequiredError, getWater } from "./api";
import { WATER_GLASS_ML, todayKey } from "./storage";
import { goBackOrTabs } from "./nav";
import { useApp } from "./AppContext";

export default function WaterLogScreen() {
  const navigation = useNavigation<any>();
  const { requireAuth } = useApp();
  const [ml, setMl] = useState(0);
  const [goalMl, setGoalMl] = useState(2500);
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const date = todayKey();

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await getWater(date);
        if (!alive) return;
        setMl(res.ml);
        setGoalMl(res.goalMl);
        setError(null);
      } catch (e: any) {
        if (e instanceof AuthRequiredError) {
          requireAuth();
          goBackOrTabs(navigation);
          return;
        }
        if (alive) setError("Couldn't load water data right now.");
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [date, navigation, requireAuth]);

  async function adjust(delta: number) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await addWater(date, delta);
      setMl(res.ml);
      setGoalMl(res.goalMl);
    } catch (e: any) {
      if (e instanceof AuthRequiredError) {
        requireAuth();
        goBackOrTabs(navigation);
        return;
      }
      setError("Couldn't update water. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const pct = goalMl > 0 ? Math.min(100, Math.round((ml / goalMl) * 100)) : 0;

  return (
    <Screen edgeTop background={colors.bg}>
      <View style={styles.header}>
        <Pressable style={styles.iconBtn} onPress={() => goBackOrTabs(navigation)} hitSlop={8}>
          <Icon name="chevronLeft" size={22} color={colors.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>Water</Text>
        <View style={styles.iconBtn} />
      </View>

      <View style={styles.body}>
        {busy ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.green} />
          </View>
        ) : (
          <View style={styles.card}>
            <Text style={styles.topLabel}>Today's hydration</Text>
            <Text style={styles.value}>{ml} ml</Text>
            <Text style={styles.goal}>Goal: {goalMl} ml</Text>
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${pct}%` }]} />
            </View>
            <Text style={styles.pct}>{pct}% complete</Text>

            <View style={styles.row}>
              <PressableScale style={[styles.btn, saving && styles.btnDisabled]} onPress={() => void adjust(-WATER_GLASS_ML)}>
                <Icon name="minus" size={16} color={colors.green} />
                <Text style={styles.btnText}>-1 glass</Text>
              </PressableScale>
              <PressableScale style={[styles.btnPrimary, saving && styles.btnDisabled]} onPress={() => void adjust(WATER_GLASS_ML)}>
                <Icon name="plus" size={16} color="#fff" />
                <Text style={styles.btnPrimaryText}>+1 glass</Text>
              </PressableScale>
            </View>
          </View>
        )}
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
  center: { paddingTop: 80, alignItems: "center" },
  card: { backgroundColor: colors.card, borderRadius: 18, padding: 16, ...elevation.sm },
  topLabel: { color: colors.mute, fontSize: 12.5, fontWeight: "700" },
  value: { color: colors.ink, fontSize: 34, fontWeight: "900", marginTop: 2 },
  goal: { color: colors.mute, fontSize: 13, fontWeight: "600" },
  track: { height: 10, borderRadius: 999, backgroundColor: colors.cardMuted, overflow: "hidden", marginTop: 14 },
  fill: { height: "100%", backgroundColor: colors.green },
  pct: { color: colors.green, fontSize: 12, fontWeight: "800", marginTop: 8 },
  row: { flexDirection: "row", gap: 10, marginTop: 14 },
  btn: { flex: 1, minHeight: 44, borderRadius: radius.md, backgroundColor: colors.greenTint, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
  btnText: { color: colors.green, fontSize: 13, fontWeight: "800" },
  btnPrimary: { flex: 1, minHeight: 44, borderRadius: radius.md, backgroundColor: colors.green, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
  btnPrimaryText: { color: "#fff", fontSize: 13, fontWeight: "800" },
  btnDisabled: { opacity: 0.5 },
  error: { color: colors.red, fontSize: 12.5, fontWeight: "700", textAlign: "center", marginTop: 12 },
});

