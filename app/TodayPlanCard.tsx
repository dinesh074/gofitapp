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
  // What the user has logged so far today. When present, the meals still ahead
  // of them are re-portioned server-side to the budget they have left.
  consumed?: PlanMacros;
  fiberTarget?: number;
  training?: string | null;
};

const MACROS: { key: keyof PlanMacros; label: string; color: string; unit: string }[] = [
  { key: "kcal", label: "kcal", color: colors.green, unit: "" },
  { key: "protein_g", label: "Protein", color: colors.protein, unit: "g" },
  { key: "carbs_g", label: "Carbs", color: colors.carbs, unit: "g" },
  { key: "fat_g", label: "Fat", color: colors.fat, unit: "g" },
  { key: "fiber_g", label: "Fibre", color: colors.inkSoft, unit: "g" },
];

function fmtCount(n: number): string {
  return Number.isInteger(n) ? `${n}` : `${n}`;
}

function hasMetric(v: PlanMacros | undefined, key: keyof PlanMacros): boolean {
  return !!v && typeof v[key] === "number" && Number.isFinite(v[key] as number);
}

function statusLabel(s?: string): string {
  switch (s) {
    case "on_target":
      return "On target";
    case "slightly_below":
      return "Slightly below";
    case "slightly_above":
      return "Slightly above";
    case "significantly_below":
      return "Significantly below";
    case "significantly_above":
      return "Significantly above";
    default:
      return "";
  }
}

function projectedTrackLabel(status?: DayPlan["status"]): string {
  if (!status) return "";
  const kcal = status.kcal;
  const protein = status.protein_g;
  if (kcal === "on_target" && protein === "on_target") return "You're on track for today";
  if (
    kcal === "slightly_above" || kcal === "slightly_below" ||
    protein === "slightly_above" || protein === "slightly_below"
  ) {
    return "You're close to target for today";
  }
  return "Your plan still needs adjustment today";
}

export default function TodayPlanCard({
  goal,
  diet,
  goalName,
  date,
  account,
  onRequireAuth,
  consumed,
  fiberTarget,
  training,
}: Props) {
  const [plan, setPlan] = useState<DayPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(true);
  // Refetch when the targets/diet/goal that the plan is BUILT from change, or
  // when what's been logged today moves enough to shift the remaining budget
  // (bucketed to ~40 kcal so we re-adapt without hammering the endpoint). The
  // base plan stays server-cached; only the lightweight adaptation recomputes.
  const consumedBucket = consumed ? Math.round(consumed.kcal / 40) : 0;
  const sig = `${date}|${diet}|${goalName}|${Math.round(goal.kcal)}|${Math.round(
    goal.protein_g,
  )}|${Math.round(goal.carbs_g)}|${Math.round(goal.fat_g)}|${consumedBucket}|${training ?? ""}`;
  const lastSig = useRef<string | null>(null);

  const targets: PlanMacros = {
    kcal: goal.kcal,
    protein_g: goal.protein_g,
    carbs_g: goal.carbs_g,
    fat_g: goal.fat_g,
    ...(typeof fiberTarget === "number" ? { fiber_g: fiberTarget } : {}),
  };

  const load = useCallback(
    async (regenerate: boolean) => {
      if (!account || goal.kcal <= 0) return;
      // Defense in depth: goal/consumed are computed client-side and a
      // transient NaN (e.g. mid-edit profile field) must never reach the
      // network as JSON `null`, which the server would reject outright.
      const finite = (n: number | undefined) => typeof n === "number" && Number.isFinite(n);
      if (![targets.kcal, targets.protein_g, targets.carbs_g, targets.fat_g].every(finite)) return;
      if (consumed && !Object.values(consumed).every(finite)) return;
      setLoading(true);
      setFailed(false);
      const p = await fetchTodayPlan({
        targets,
        diet,
        goal: goalName,
        date,
        regenerate,
        consumed,
        hour: new Date().getHours(),
        training: training ?? "",
      });
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
  const trackMsg = plan ? projectedTrackLabel(plan.status) : "";

  return (
    <View style={styles.card}>
      <View style={styles.headRow}>
        <View style={styles.headTitleRow}>
          <Icon name="sparkles" size={15} color={colors.green} />
          <Text style={styles.head}>Your plan for today</Text>
        </View>
        <View style={styles.headActions}>
          {plan && account && expanded && (
            <Pressable
              style={[styles.regenBtn, loading && styles.regenBtnBusy]}
              onPress={() => load(true)}
              hitSlop={8}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator size="small" color={colors.green} />
              ) : (
                <Icon name="refresh" size={13} color={colors.green} />
              )}
              <Text style={styles.regenText}>{loading ? "Building…" : "New plan"}</Text>
            </Pressable>
          )}
          <Pressable style={styles.toggleBtn} onPress={() => setExpanded((v) => !v)} hitSlop={8}>
            <Text style={styles.toggleText}>{expanded ? "Hide" : "Show"}</Text>
            <Icon name={expanded ? "chevronUp" : "chevronDown"} size={13} color={colors.green} />
          </Pressable>
        </View>
      </View>

      {!expanded ? (
        <Text style={styles.collapsedText}>
          {plan?.next_meal ? `Next meal: ${plan.next_meal}` : "Tap Show to view your full day plan."}
        </Text>
      ) : !account ? (
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

          {!!plan.next_meal && (
            <View style={styles.nextMealPill}>
              <Icon name="time" size={12} color={colors.green} />
              <Text style={styles.nextMealText}>Next meal: {plan.next_meal}</Text>
            </View>
          )}

          {!!plan.consumed && (
            <>
              <Text style={styles.sectionHead}>Today's progress</Text>
              <View style={styles.totalsRow}>
                {MACROS.filter((m) => hasMetric(plan.targets, m.key) && hasMetric(plan.consumed, m.key)).map((m) => (
                  <View key={`prog-${m.key}`} style={styles.totalChip}>
                    <Text style={[styles.totalVal, { color: m.color }]}>
                      {Math.round((plan.consumed?.[m.key] as number) || 0)}
                      {m.unit}
                    </Text>
                    <Text style={styles.totalLabel}>
                      {m.label} · {Math.round((plan.targets[m.key] as number) || 0)}
                      {m.unit}
                    </Text>
                  </View>
                ))}
              </View>
            </>
          )}

          {(plan.remaining || plan.over_target) && (
            <>
              <Text style={styles.sectionHead}>Remaining today</Text>
              <View style={styles.remainRow}>
                {MACROS.filter((m) => hasMetric(plan.targets, m.key)).map((m) => {
                  const left = plan.remaining?.[m.key];
                  const over = plan.over_target?.[m.key];
                  const isOver = typeof over === "number" && over > 0;
                  const value = isOver ? over : left;
                  if (typeof value !== "number") return null;
                  return (
                    <View key={m.key} style={styles.remainChip}>
                      <Text style={[styles.remainVal, { color: m.color }]}>
                        {Math.round(value)}
                        {m.unit}
                      </Text>
                      <Text style={styles.remainLabel}>{m.label} {isOver ? "over" : "left"}</Text>
                    </View>
                  );
                })}
              </View>
            </>
          )}

          <Text style={styles.sectionHead}>Your plan for today</Text>

          {plan.slots.map((s) => {
            const past = s.completed === true || (plan.adapted && s.upcoming === false);
            return (
              <View key={s.slot} style={[styles.slot, past && styles.slotPast]}>
                <View style={styles.slotHead}>
                  <Text style={[styles.slotLabel, past && styles.slotLabelPast]}>
                    {s.label} {past ? "✓" : "→"}
                  </Text>
                  <Text style={styles.slotKcal}>{s.kcal} kcal</Text>
                </View>
                {s.over_budget ? (
                  <Text style={styles.itemEmpty}>
                    You&apos;ve hit today&apos;s target — anything more is a bonus.
                  </Text>
                ) : s.items.length > 0 ? (
                  s.items.map((it, i) => (
                    <Text key={`${it.key}-${i}`} style={styles.item}>
                      <Text style={styles.itemDot}>· </Text>
                      {it.name}
                      <Text style={styles.itemMeta}>
                        {`  ×${fmtCount(it.count)}${it.unit ? " " + it.unit : ""} · ${it.kcal} kcal`}
                      </Text>
                    </Text>
                  ))
                ) : (
                  <Text style={styles.itemEmpty}>Something light — add your own here.</Text>
                )}
              </View>
            );
          })}

          {(plan.projected || plan.planned) && (
            <>
              <Text style={styles.sectionHead}>If you follow your plan</Text>
              <View style={styles.totalsRow}>
                {MACROS.filter((m) => hasMetric(plan.targets, m.key)).map((m) => {
                  const p = (plan.projected?.[m.key] ?? plan.planned?.[m.key]) as number | undefined;
                  if (typeof p !== "number") return null;
                  return (
                    <View key={`proj-${m.key}`} style={styles.totalChip}>
                      <Text style={[styles.totalVal, { color: m.color }]}>
                        {Math.round(p)}
                        {m.unit}
                      </Text>
                      <Text style={styles.totalLabel}>
                        {m.label} · {Math.round((plan.targets[m.key] as number) || 0)}
                        {m.unit}
                      </Text>
                      {!!plan.status?.[m.key] && <Text style={styles.statusText}>{statusLabel(plan.status[m.key])}</Text>}
                    </View>
                  );
                })}
              </View>
              {!!trackMsg && (
                <View style={styles.trackRow}>
                  <Icon
                    name={trackMsg === "You're on track for today" ? "check" : "info"}
                    size={12}
                    color={trackMsg === "You're on track for today" ? colors.green : colors.mute}
                  />
                  <Text style={styles.trackText}>{trackMsg}</Text>
                </View>
              )}
            </>
          )}
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
  headRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  headTitleRow: { flexDirection: "row", alignItems: "center", gap: 6, flex: 1 },
  headActions: { flexDirection: "row", alignItems: "center", gap: 6 },
  head: { color: colors.ink, fontSize: 14, fontWeight: "900" },
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
  regenBtnBusy: { opacity: 0.7 },
  toggleBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.cardMuted,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  toggleText: { color: colors.green, fontSize: 12, fontWeight: "800" },
  collapsedText: { color: colors.mute, fontSize: 12.5, fontWeight: "600" },
  note: { color: colors.inkSoft, fontSize: 13, fontWeight: "600", lineHeight: 18 },
  sectionHead: { color: colors.ink, fontSize: 12, fontWeight: "900", textTransform: "uppercase", letterSpacing: 0.3, marginTop: 2 },
  nextMealPill: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    backgroundColor: colors.greenTint,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  nextMealText: { color: colors.green, fontSize: 12, fontWeight: "800" },
  remainRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    backgroundColor: colors.greenTint,
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 6,
  },
  remainChip: { alignItems: "center", flex: 1 },
  remainVal: { fontSize: 15, fontWeight: "900" },
  remainLabel: { color: colors.mute, fontSize: 10, fontWeight: "700", marginTop: 1 },
  statusText: { color: colors.mute, fontSize: 10, fontWeight: "700", marginTop: 2 },
  loadingRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6 },
  loadingText: { color: colors.mute, fontSize: 13, fontWeight: "600" },
  empty: { color: colors.mute, fontSize: 12.5, fontWeight: "500", lineHeight: 17 },
  slot: { gap: 3, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8 },
  slotPast: { opacity: 0.5 },
  slotLabelPast: { color: colors.mute, fontWeight: "700" },
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
  trackRow: {
    marginTop: 8,
    marginBottom: 2,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    backgroundColor: colors.cardMuted,
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 10,
  },
  trackText: { color: colors.inkSoft, fontSize: 11.5, fontWeight: "700" },
  foot: { color: colors.mute, fontSize: 11, fontWeight: "500", lineHeight: 15, marginTop: 2 },
});
