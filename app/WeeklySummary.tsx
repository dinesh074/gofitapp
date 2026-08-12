import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { GoalTargets } from "./nutrition";
import { LogMap } from "./storage";
import { weeklyInsights, Insight, InsightTone } from "./insights";
import { colors, radius, shadow } from "./theme";
import Icon from "./Icon";

// Renders the rule-based weekly summary (see insights.ts). Purely local — no
// AI, no network — so it's instant and free.
export default function WeeklySummary({ logs, goal }: { logs: LogMap; goal: GoalTargets }) {
  const summary = useMemo(() => weeklyInsights(logs, goal), [logs, goal]);

  return (
    <View style={styles.card}>
      <View style={styles.headRow}>
        <View style={styles.badge}>
          <Icon name="progress" size={16} color={colors.green} />
        </View>
        <Text style={styles.headline}>{summary.headline}</Text>
      </View>

      <View style={styles.list}>
        {summary.insights.map((it) => (
          <InsightRow key={it.id} insight={it} />
        ))}
      </View>

      <Text style={styles.footnote}>
        Computed on your device from this week's logs · not medical advice
      </Text>
    </View>
  );
}

function toneColor(tone: InsightTone): string {
  if (tone === "good") return colors.green;
  if (tone === "warn") return colors.orange;
  return colors.mute;
}

function InsightRow({ insight }: { insight: Insight }) {
  const c = toneColor(insight.tone);
  return (
    <View style={styles.row}>
      <View style={[styles.rowIcon, { backgroundColor: c + "1A" }]}>
        <Icon name={insight.icon} size={16} color={c} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle}>{insight.title}</Text>
        <Text style={styles.rowDetail}>{insight.detail}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, ...shadow.card },
  headRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 6 },
  badge: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: colors.greenTint,
    alignItems: "center",
    justifyContent: "center",
  },
  headline: { flex: 1, color: colors.ink, fontSize: 14.5, fontWeight: "800", lineHeight: 20 },
  list: { marginTop: 8, gap: 4 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingVertical: 8 },
  rowIcon: { width: 30, height: 30, borderRadius: 9, alignItems: "center", justifyContent: "center", marginTop: 1 },
  rowTitle: { color: colors.ink, fontSize: 13.5, fontWeight: "800" },
  rowDetail: { color: colors.mute, fontSize: 12.5, fontWeight: "600", marginTop: 2, lineHeight: 17 },
  footnote: { color: colors.faint, fontSize: 11, fontWeight: "600", marginTop: 10, textAlign: "center" },
});
