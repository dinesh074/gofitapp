import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, elevation, radius } from "./theme";
import { LogMap, monthStreak, DayState } from "./storage";
import Icon from "./Icon";

const WD = ["S", "M", "T", "W", "T", "F", "S"];

function cellStyle(state: DayState) {
  switch (state) {
    case "hit":
      return { box: styles.hit, txt: styles.hitTxt };
    case "over":
      return { box: styles.over, txt: styles.overTxt };
    case "under":
      return { box: styles.under, txt: styles.underTxt };
    case "empty":
      return { box: styles.empty, txt: styles.emptyTxt };
    default: // future
      return { box: styles.future, txt: styles.futureTxt };
  }
}

export default function MonthStreak({
  logs,
  goalKcal,
  onDayPress,
}: {
  logs: LogMap;
  goalKcal: number;
  onDayPress?: (dateKey: string) => void;
}) {
  const m = monthStreak(logs, goalKcal);
  const todayK = new Date();
  const todayKey = `${todayK.getFullYear()}-${String(todayK.getMonth() + 1).padStart(2, "0")}-${String(todayK.getDate()).padStart(2, "0")}`;

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <View>
          <Text style={styles.title}>Last 30 days</Text>
          <Text style={styles.sub}>
            {m.hits} {m.hits === 1 ? "day" : "days"} on target · {m.logged} logged · {m.label}
          </Text>
        </View>
        <View style={styles.hitPill}>
          <Icon name="flame" size={14} color={colors.green} />
          <Text style={styles.hitPillTxt}>{m.hits}</Text>
        </View>
      </View>

      <View style={styles.weekRow}>
        {WD.map((w, i) => (
          <Text key={i} style={styles.weekLabel}>
            {w}
          </Text>
        ))}
      </View>

      <View style={styles.grid}>
        {Array.from({ length: m.leading }).map((_, i) => (
          <View key={`lead-${i}`} style={styles.cell} />
        ))}
        {m.cells.map((c) => {
          const s = cellStyle(c.state);
          const isToday = c.date === todayKey;
          const tappable = !!onDayPress && c.meals > 0;
          return (
            <View key={c.date} style={styles.cell}>
              {c.monthLabel && <Text style={styles.monthLabel}>{c.monthLabel}</Text>}
              <Pressable
                disabled={!tappable}
                onPress={() => onDayPress?.(c.date)}
                style={[styles.dot, s.box, isToday && styles.today]}
              >
                <Text style={[styles.dayTxt, s.txt]}>{c.day}</Text>
              </Pressable>
            </View>
          );
        })}
      </View>

      <View style={styles.legend}>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, styles.hit]} />
          <Text style={styles.legendTxt}>On target</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, styles.over]} />
          <Text style={styles.legendTxt}>Over</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, styles.empty]} />
          <Text style={styles.legendTxt}>Missed</Text>
        </View>
      </View>
    </View>
  );
}

const CELL = `${100 / 7}%`;

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: 22, padding: 18, marginBottom: 16, ...elevation.md },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  title: { color: colors.ink, fontSize: 16, fontWeight: "800", letterSpacing: -0.2 },
  sub: { color: colors.mute, fontSize: 12, fontWeight: "600", marginTop: 2 },
  hitPill: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: colors.greenTint, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  hitPillTxt: { color: colors.green, fontWeight: "800", fontSize: 14 },
  weekRow: { flexDirection: "row", marginBottom: 4 },
  weekLabel: { width: CELL as any, textAlign: "center", color: colors.faint, fontSize: 11, fontWeight: "700" },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: { width: CELL as any, minHeight: 44, alignItems: "center", justifyContent: "flex-end", paddingVertical: 3 },
  monthLabel: { fontSize: 9, fontWeight: "800", color: colors.faint, marginBottom: 1, textTransform: "uppercase" },
  dot: { width: 32, height: 32, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  dayTxt: { fontSize: 12, fontWeight: "700" },
  today: { borderWidth: 2, borderColor: colors.green },
  // states
  hit: { backgroundColor: colors.green },
  hitTxt: { color: "#fff" },
  over: { backgroundColor: colors.redTint, borderWidth: 1, borderColor: colors.orange },
  overTxt: { color: colors.orange },
  under: { backgroundColor: colors.greenTint },
  underTxt: { color: colors.green },
  empty: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.hairline },
  emptyTxt: { color: colors.faint },
  future: { backgroundColor: "transparent" },
  futureTxt: { color: colors.faint },
  legend: { flexDirection: "row", gap: 16, marginTop: 12, justifyContent: "center" },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  legendDot: { width: 12, height: 12, borderRadius: 4 },
  legendTxt: { color: colors.mute, fontSize: 11, fontWeight: "600" },
});
