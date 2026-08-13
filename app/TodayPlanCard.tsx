import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, elevation } from "./theme";
import Icon from "./Icon";
import { fetchTodayPlan, DayPlan, PlanMacros } from "./api";
import { Diet, GoalTargets } from "./nutrition";
import { Account } from "./auth";

type Props = {
  // The single source of truth: the user's real daily targets (computed by the
  // nutrition engine), their diet, and their 3-way goal. The plan is generated
  // from exactly these, server-side, and persisted -- so it stays stable across
  // reloads and only changes when these change (or the user regenerates).
  goal: GoalTargets;
  diet: Diet;
  goalName: string; // "lose" | "maintain" | "gain"
  date: string; // YYYY-MM-DD (the user's local day)
  account: Account | null;
  onRequireAuth: () => void;
};

const MACROS: { key: keyof PlanMacros; label: string; color: string; unit: string }[] = [
  { key: "kcal", label: "kcal", color: colors.green, unit: "" },
  { key: "protein_g", label: "Protein", color: colors.protein, unit: "g" },
  { key: "carbs_g", label: "Carbs", color: colors.carbs, unit: "g" },
  { key: "fat_g", label: "Fat", color: colors.fat, unit: "g" },
];

function fmtCount(n: number): string {
  return Number.isInteger(n) ? `${n}` : `${n}`;
}

export default function TodayPlanCard({ goal, diet, goalName, date, account, onRequireAuth }: Props) {
  const [plan, setPlan] = useState<DayPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  // Only refetch when the targets/diet/goal that the plan is built from actually
  // change -- not on every render. The server also de-dupes via its signature.
  const sig = `${date}|${diet}|${goalName}|${Math.round(goal.kcal)}|${Math.round(
    goal.protein_g,
  )}|${Math.round(goal.carbs_g)}|${Math.round(goal.fat_g)}`;
  const lastSig = useRef<string | null>(null);

  const targets: PlanMacros = {
    kcal: goal.kcal,
    protein_g: goal.protein_g,
    carbs_g: goal.carbs_g,
    fat_g: goal.fat_g,
  };

  const load = useCallback(
    async (regenerate: boolean) => {
      if (!account || goal.kcal <= 0) return;
      setLoading(true);
      setFailed(false);
      const p = await fetchTodayPlan({ targets, diet, goal: goalName, date, regenerate });
      setLoading(false);
      if (p) {
        setPlan(p);
        lastSig.current = sig;
      } else {
        setFailed(true);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [account?.id, sig],
  );

  useEffect(() => {
    if (!account || goal.kcal <= 0) return;
    if (sig === lastSig.current) return;
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, account?.id]);

  return (
    <View style={styles.card}>
      <View style={styles.headRow}>
        <Icon name="sparkles" size={15} color={colors.green} />
        <Text style={styles.head}>Your plan for today</Text>
        {plan && account && (
          <Pressable
            style={styles.regenBtn}
            onPress={() => load(true)}
            hitSlop={8}
            disabled={loading}
          >
            <Icon name="refresh" size={13} color={colors.green} />
            <Text style={styles.regenText}>New plan</Text>
          </Pressable>
        )}
      </View>

      {!account ? (
        <Pressable onPress={onRequireAuth}>
          <Text style={styles.empty}>
            Sign in to get a personalised daily meal plan built from your goal and targets.
          </Text>
        </Pressable>
      ) : loading && !plan ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={colors.green} />
          <Text style={styles.loadingText}>Building your plan…</Text>
        </View>
      ) : failed && !plan ? (
        <Pressable onPress={() => load(false)}>
          <Text style={styles.empty}>Couldn&apos;t build your plan just now. Tap to try again.</Text>
        </Pressable>
      ) : plan ? (
        <>
          {!!plan.coach_note && <Text style={styles.note}>{plan.coach_note}</Text>}

          {plan.slots.map((s) => (
            <View key={s.slot} style={styles.slot}>
              <View style={styles.slotHead}>
                <Text style={styles.slotLabel}>{s.label}</Text>
                <Text style={styles.slotKcal}>{s.kcal} kcal</Text>
              </View>
              {s.items.length > 0 ? (
                s.items.map((it, i) => (
                  <Text key={`${it.key}-${i}`} style={styles.item}>
                    <Text style={styles.itemDot}>· </Text>
                    {it.name}
                    <Text style={styles.itemMeta}>{`  ×${fmtCount(it.count)} · ${it.kcal} kcal`}</Text>
                  </Text>
                ))
              ) : (
                <Text style={styles.itemEmpty}>Something light — add your own here.</Text>
              )}
            </View>
          ))}

          <View style={styles.totalsRow}>
            {MACROS.map((m) => (
              <View key={m.key} style={styles.totalChip}>
                <Text style={[styles.totalVal, { color: m.color }]}>
                  {Math.round(plan.totals[m.key])}
                  {m.unit}
                </Text>
                <Text style={styles.totalLabel}>
                  {m.label} · {Math.round(plan.targets[m.key])}
                  {m.unit}
                </Text>
              </View>
            ))}
          </View>
          <Text style={styles.foot}>
            A starting plan from your food database, tuned to your targets. Log meals as you go —
            swap anything that doesn&apos;t suit you.
          </Text>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: 18, padding: 16, marginBottom: 16, gap: 10, ...elevation.sm },
  headRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  head: { color: colors.ink, fontSize: 14, fontWeight: "900", flex: 1 },
  regenBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.greenTint,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  regenText: { color: colors.green, fontSize: 12, fontWeight: "800" },
  note: { color: colors.inkSoft, fontSize: 13, fontWeight: "600", lineHeight: 18 },
  loadingRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6 },
  loadingText: { color: colors.mute, fontSize: 13, fontWeight: "600" },
  empty: { color: colors.mute, fontSize: 12.5, fontWeight: "500", lineHeight: 17 },
  slot: { gap: 3, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8 },
  slotHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  slotLabel: { color: colors.ink, fontSize: 13, fontWeight: "800" },
  slotKcal: { color: colors.mute, fontSize: 12, fontWeight: "700" },
  item: { color: colors.inkSoft, fontSize: 13, fontWeight: "600", lineHeight: 19 },
  itemDot: { color: colors.green, fontWeight: "900" },
  itemMeta: { color: colors.mute, fontSize: 12, fontWeight: "600" },
  itemEmpty: { color: colors.mute, fontSize: 12, fontWeight: "500", fontStyle: "italic" },
  totalsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingTop: 10,
  },
  totalChip: { alignItems: "center", flex: 1 },
  totalVal: { fontSize: 15, fontWeight: "900" },
  totalLabel: { color: colors.mute, fontSize: 10.5, fontWeight: "600", marginTop: 1 },
  foot: { color: colors.mute, fontSize: 11, fontWeight: "500", lineHeight: 15, marginTop: 2 },
});
