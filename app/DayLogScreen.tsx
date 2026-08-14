import React, { useMemo } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import Screen from "./Screen";
import Icon from "./Icon";
import { colors, radius, elevation } from "./theme";
import { useApp } from "./AppContext";
import { deleteServerLog, AuthRequiredError } from "./api";
import { deleteMeal, LogMap, Meal, MEAL_TYPE_LABEL, MealType, prettyDate } from "./storage";
import { dayMicros } from "./micros";

function mealTime(at: number): string {
  const d = new Date(at);
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}

// Groups meals for the day into the six real eating occasions (see
// storage.ts's MEAL_TYPES) in a fixed, sensible order -- so "what did I have
// for breakfast vs lunch vs dinner" is answerable at a glance instead of just
// a flat chronological list.
const SLOT_ORDER: MealType[] = [
  "breakfast",
  "morning_snack",
  "lunch",
  "afternoon_snack",
  "evening_snack",
  "dinner",
];

export default function DayLogScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const dateKey: string = route.params?.dateKey;
  const { logs, setLogs, goal, requireAuth } = useApp();

  const day = logs[dateKey];
  const rawMeals: (Meal & { _idx: number })[] = (day?.meals ?? []).map((m, i) => ({ ...m, _idx: i }));

  const kcal = rawMeals.reduce((s, m) => s + m.kcal, 0);
  const p = Math.round(rawMeals.reduce((s, m) => s + (m.protein_g || 0), 0));
  const c = Math.round(rawMeals.reduce((s, m) => s + (m.carbs_g || 0), 0));
  const f = Math.round(rawMeals.reduce((s, m) => s + (m.fat_g || 0), 0));
  const pct = goal.kcal > 0 ? Math.min(100, Math.round((kcal / goal.kcal) * 100)) : 0;

  const micro = useMemo(() => dayMicros(logs, dateKey), [logs, dateKey]);

  const bySlot = useMemo(() => {
    const groups: Record<string, (Meal & { _idx: number })[]> = {};
    for (const m of rawMeals) {
      const slot = m.mealType || "evening_snack";
      (groups[slot] ??= []).push(m);
    }
    for (const slot of Object.keys(groups)) {
      groups[slot].sort((a, b) => a.at - b.at);
    }
    return groups;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateKey, day]);

  function handleDelete(index: number) {
    setLogs((prev: LogMap) => {
      const next = deleteMeal(prev, dateKey, index);
      return next;
    });
    const removed = day?.meals[index];
    if (removed?.id) {
      deleteServerLog(removed.id).catch((e) => {
        if (e instanceof AuthRequiredError) requireAuth();
      });
    }
  }

  return (
    <Screen>
      <View style={styles.head}>
        <Pressable style={styles.backBtn} onPress={() => navigation.goBack()} hitSlop={10}>
          <Icon name="chevronLeft" size={20} color={colors.ink} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{dateKey ? prettyDate(dateKey) : ""}</Text>
          <Text style={styles.sub}>
            {rawMeals.length} {rawMeals.length === 1 ? "meal" : "meals"} logged
          </Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {/* Day totals -- real sums of this date's actual server-synced meal_logs rows */}
        <View style={styles.totalCard}>
          <View style={styles.totalTop}>
            <Text style={styles.totalKcal}>{kcal}</Text>
            <Text style={styles.totalTarget}>/ {goal.kcal} kcal</Text>
          </View>
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${pct}%` }, kcal > goal.kcal && styles.fillOver]} />
          </View>
          <View style={styles.macroRow}>
            <MacroChip label="Protein" value={p} goalV={goal.protein_g} color={colors.green} />
            <MacroChip label="Carbs" value={c} goalV={goal.carbs_g} color={colors.gold} />
            <MacroChip label="Fat" value={f} goalV={goal.fat_g} color={colors.orange} />
          </View>
        </View>

        {/* Micronutrients -- rolled up from whatever DB-matched items this day's
            meals actually carried (see micros.ts); honest about partial coverage. */}
        {micro.trackedMeals > 0 && (
          <View style={styles.microCard}>
            <View style={styles.microHeadRow}>
              <Icon name="nutrition" size={15} color={colors.green} />
              <Text style={styles.microHead}>Nutrients this day</Text>
            </View>
            <Text style={styles.microCoverage}>
              From {micro.trackedMeals} of {micro.totalMeals} logged {micro.totalMeals === 1 ? "meal" : "meals"}
              {micro.estimatedMeals > 0
                ? ` · ${micro.estimatedMeals} AI-estimated`
                : ""}
            </Text>
            <View style={styles.microGrid}>
              {micro.rows.map((r) => (
                <View key={r.key} style={styles.microRow}>
                  <Text style={styles.microLabel}>{r.label}</Text>
                  <Text style={[styles.microValue, r.state === "high" && styles.microValueWarn]}>
                    {r.have}
                    {r.unit} <Text style={styles.microTarget}>/ {r.target}{r.unit}</Text>
                  </Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {rawMeals.length === 0 && (
          <View style={styles.emptyCard}>
            <Icon name="camera" size={22} color={colors.faint} />
            <Text style={styles.emptyText}>No meals logged this day.</Text>
          </View>
        )}

        {SLOT_ORDER.filter((slot) => bySlot[slot]?.length).map((slot) => (
          <View key={slot}>
            <Text style={styles.section}>{MEAL_TYPE_LABEL[slot]}</Text>
            <View style={styles.card}>
              {bySlot[slot].map((m, i) => (
                <Pressable
                  key={m._idx}
                  style={[styles.mealRow, i > 0 && styles.mealDivider]}
                  onPress={() => navigation.navigate("MealDetail", { dateKey, idx: m._idx })}
                >
                  {m.photoUrl ? (
                    <Image source={{ uri: m.photoUrl }} style={styles.mealPhoto} />
                  ) : (
                    <View style={styles.mealPhotoPlaceholder}>
                      <Icon name="camera" size={16} color={colors.faint} />
                    </View>
                  )}
                  <View style={{ flex: 1 }}>
                    <View style={styles.mealTopRow}>
                      <Text style={styles.mealDish}>{m.dish}</Text>
                      <Text style={styles.mealTime}>{mealTime(m.at)}</Text>
                    </View>
                    <Text style={styles.mealSub}>
                      P {Math.round(m.protein_g || 0)}g · C {Math.round(m.carbs_g || 0)}g · F{" "}
                      {Math.round(m.fat_g || 0)}g
                    </Text>
                  </View>
                  <Text style={styles.mealKcal}>{m.kcal}</Text>
                  <Pressable style={styles.delBtn} onPress={() => handleDelete(m._idx)} hitSlop={8}>
                    <Icon name="trash" size={16} color={colors.red} />
                  </Pressable>
                </Pressable>
              ))}
            </View>
          </View>
        ))}

        <View style={{ height: 24 }} />
      </ScrollView>
    </Screen>
  );
}

function MacroChip({ label, value, goalV, color }: { label: string; value: number; goalV: number; color: string }) {
  return (
    <View style={styles.macroChip}>
      <Text style={[styles.macroChipValue, { color }]}>{value}g</Text>
      <Text style={styles.macroChipLabel}>
        {label} {goalV > 0 ? `· ${Math.round((value / goalV) * 100)}%` : ""}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 14 },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.card, alignItems: "center", justifyContent: "center", ...elevation.sm },
  title: { fontSize: 20, fontWeight: "900", color: colors.ink },
  sub: { fontSize: 13, color: colors.mute, marginTop: 1 },
  body: { paddingHorizontal: 16, paddingBottom: 12 },

  totalCard: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, marginBottom: 14, ...elevation.sm },
  totalTop: { flexDirection: "row", alignItems: "baseline", gap: 6 },
  totalKcal: { fontSize: 30, fontWeight: "900", color: colors.ink },
  totalTarget: { fontSize: 14, color: colors.mute, fontWeight: "600" },
  track: { height: 8, borderRadius: 4, backgroundColor: colors.bg, marginTop: 10, overflow: "hidden" },
  fill: { height: "100%", backgroundColor: colors.green, borderRadius: 4 },
  fillOver: { backgroundColor: colors.orange },
  macroRow: { flexDirection: "row", gap: 10, marginTop: 14 },
  macroChip: { flex: 1, backgroundColor: colors.bg, borderRadius: 12, padding: 10, alignItems: "center" },
  macroChipValue: { fontSize: 16, fontWeight: "900" },
  macroChipLabel: { fontSize: 11, color: colors.mute, fontWeight: "600", marginTop: 2 },

  microCard: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, marginBottom: 14, ...elevation.sm },
  microHeadRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  microHead: { fontSize: 15, fontWeight: "800", color: colors.ink },
  microCoverage: { fontSize: 11, color: colors.faint, marginTop: 2, marginBottom: 10 },
  microGrid: { gap: 8 },
  microRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  microLabel: { fontSize: 13, color: colors.mute, fontWeight: "600" },
  microValue: { fontSize: 13, color: colors.ink, fontWeight: "800" },
  microValueWarn: { color: colors.orange },
  microTarget: { fontSize: 11, color: colors.faint, fontWeight: "600" },

  emptyCard: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 28, alignItems: "center", gap: 8 },
  emptyText: { color: colors.mute, fontSize: 13, fontWeight: "600" },

  section: { fontSize: 13, fontWeight: "800", color: colors.mute, marginBottom: 8, marginTop: 4, textTransform: "uppercase", letterSpacing: 0.3 },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, marginBottom: 14, ...elevation.sm },
  mealRow: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12 },
  mealDivider: { borderTopWidth: 1, borderTopColor: colors.hairline },
  mealPhoto: { width: 48, height: 48, borderRadius: 10, backgroundColor: colors.bg },
  mealPhotoPlaceholder: { width: 48, height: 48, borderRadius: 10, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" },
  mealTopRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  mealDish: { fontSize: 14, fontWeight: "800", color: colors.ink, flexShrink: 1 },
  mealTime: { fontSize: 11, color: colors.faint, fontWeight: "600" },
  mealSub: { fontSize: 12, color: colors.mute, marginTop: 2 },
  mealKcal: { fontSize: 15, fontWeight: "900", color: colors.green },
  delBtn: { padding: 6 },
});
