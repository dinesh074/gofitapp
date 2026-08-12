import React from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { DayStat, LogMap, Meal, prettyDate } from "./storage";
import { GoalTargets } from "./nutrition";
import { colors, radius } from "./theme";
import Icon from "./Icon";

type Props = {
  visible: boolean;
  dateKey: string | null;
  logs: LogMap;
  goal: GoalTargets;
  onClose: () => void;
  onDelete: (dateKey: string, index: number) => void;
};

function mealTime(at: number): string {
  const d = new Date(at);
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}

export default function DayDetail({ visible, dateKey, logs, goal, onClose, onDelete }: Props) {
  const day = dateKey ? logs[dateKey] : null;
  const meals: Meal[] = day?.meals ?? [];
  const kcal = meals.reduce((s, m) => s + m.kcal, 0);
  const p = Math.round(meals.reduce((s, m) => s + (m.protein_g || 0), 0));
  const cbs = Math.round(meals.reduce((s, m) => s + (m.carbs_g || 0), 0));
  const f = Math.round(meals.reduce((s, m) => s + (m.fat_g || 0), 0));
  const pct = goal.kcal > 0 ? Math.min(100, Math.round((kcal / goal.kcal) * 100)) : 0;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.backdropTap} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.grabber} />
          <View style={styles.head}>
            <View>
              <Text style={styles.title}>{dateKey ? prettyDate(dateKey) : ""}</Text>
              <Text style={styles.sub}>
                {meals.length} {meals.length === 1 ? "meal" : "meals"}
              </Text>
            </View>
            <Pressable style={styles.closeBtn} onPress={onClose} hitSlop={8}>
              <Icon name="close" size={18} color={colors.mute} />
            </Pressable>
          </View>

          {/* Day totals */}
          <View style={styles.totalCard}>
            <View style={styles.totalTop}>
              <Text style={styles.totalKcal}>{kcal}</Text>
              <Text style={styles.totalTarget}>/ {goal.kcal} kcal</Text>
            </View>
            <View style={styles.track}>
              <View
                style={[styles.fill, { width: `${pct}%` }, kcal > goal.kcal && styles.fillOver]}
              />
            </View>
            <View style={styles.macroRow}>
              <Text style={styles.macroChip}>P {p}g</Text>
              <Text style={styles.macroChip}>C {cbs}g</Text>
              <Text style={styles.macroChip}>F {f}g</Text>
            </View>
          </View>

          <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 12 }}>
            {meals.length === 0 && <Text style={styles.empty}>No meals logged this day.</Text>}
            {meals.map((m, i) => (
              <View key={i} style={styles.mealRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.mealDish}>{m.dish}</Text>
                  <Text style={styles.mealSub}>
                    {mealTime(m.at)} · P {Math.round(m.protein_g || 0)}g · C{" "}
                    {Math.round(m.carbs_g || 0)}g · F {Math.round(m.fat_g || 0)}g
                  </Text>
                </View>
                <Text style={styles.mealKcal}>{m.kcal}</Text>
                <Pressable
                  style={styles.delBtn}
                  onPress={() => dateKey && onDelete(dateKey, i)}
                  hitSlop={8}
                >
                  <Icon name="trash" size={16} color={colors.red} />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  backdropTap: { flex: 1 },
  sheet: { backgroundColor: colors.bg, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 16, paddingBottom: 28, maxHeight: "82%" },
  grabber: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: "#CBD5D0", marginTop: 10, marginBottom: 8 },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  title: { fontSize: 20, fontWeight: "900", color: colors.ink },
  sub: { fontSize: 13, color: colors.mute, marginTop: 1 },
  closeBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.card, alignItems: "center", justifyContent: "center" },
  closeText: { fontSize: 16, fontWeight: "800", color: colors.ink },

  totalCard: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, marginBottom: 12 },
  totalTop: { flexDirection: "row", alignItems: "baseline", gap: 6 },
  totalKcal: { fontSize: 30, fontWeight: "900", color: colors.green },
  totalTarget: { fontSize: 14, fontWeight: "700", color: colors.mute },
  track: { height: 8, borderRadius: 4, backgroundColor: colors.track, overflow: "hidden", marginTop: 8 },
  fill: { height: 8, borderRadius: 4, backgroundColor: colors.green },
  fillOver: { backgroundColor: colors.orange },
  macroRow: { flexDirection: "row", gap: 8, marginTop: 12 },
  macroChip: { backgroundColor: colors.bg, color: colors.ink, fontWeight: "700", fontSize: 12, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, overflow: "hidden" },

  list: { flexGrow: 0 },
  empty: { color: colors.mute, textAlign: "center", paddingVertical: 24 },
  mealRow: { flexDirection: "row", alignItems: "center", backgroundColor: colors.card, borderRadius: radius.md, padding: 14, marginBottom: 10, gap: 10 },
  mealDish: { fontSize: 15, fontWeight: "700", color: colors.ink },
  mealSub: { fontSize: 12, color: colors.mute, marginTop: 2 },
  mealKcal: { fontSize: 16, fontWeight: "900", color: colors.ink },
  delBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.redTint, alignItems: "center", justifyContent: "center" },
  delText: { fontSize: 15 },
});
