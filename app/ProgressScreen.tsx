import React, { useEffect, useMemo, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { GoalTargets, LIMITS, Profile, clamp } from "./nutrition";
import DayDetail from "./DayDetail";
import {
  addWeight,
  bestStreak,
  computeStreak,
  deleteMeal,
  lastNDays,
  loadCacheOwner,
  loadWeights,
  loggedDaysDesc,
  LogMap,
  prettyDate,
  WeightEntry,
} from "./storage";
import { colors, radius, shadow, gradients } from "./theme";
import { LinearGradient } from "expo-linear-gradient";
import Icon, { IconName } from "./Icon";
import WeeklySummary from "./WeeklySummary";
import { getServerWeights, addServerWeight, deleteServerLog, getExerciseSummary, ExerciseSummary, AuthRequiredError } from "./api";

type Props = {
  profile: Profile;
  goal: GoalTargets;
  logs: LogMap;
  setLogs: React.Dispatch<React.SetStateAction<LogMap>>;
  onWeightLogged: (kg: number) => void;
  onRequireAuth: () => void;
  accountId: number | null;
};

const RANGES = [
  { key: 7, label: "7 days" },
  { key: 30, label: "30 days" },
  { key: 90, label: "90 days" },
] as const;

export default function ProgressScreen({ profile, goal, logs, setLogs, onWeightLogged, onRequireAuth, accountId }: Props) {
  const [weights, setWeights] = useState<WeightEntry[]>([]);
  const [entry, setEntry] = useState<number>(Math.round(profile.weightKg));
  const [detailDay, setDetailDay] = useState<string | null>(null);
  const [range, setRange] = useState<number>(7);
  const [exSummary, setExSummary] = useState<ExerciseSummary | null>(null);

  useEffect(() => {
    loadWeights().then(setWeights);
    // weight_logs (backend/progress.py) is the real table -- prefer its copy
    // if it has one; otherwise this is pre-existing local-only history, so
    // back it up once.
    getServerWeights()
      .then(async ({ weights: serverWeights }) => {
        if (serverWeights.length > 0) {
          setWeights(serverWeights);
        } else {
          // Only back up local-only weight history if this device's cache
          // provably belongs to the signed-in account -- otherwise a previous
          // user's leftover weights would be written into this account's rows.
          const owner = await loadCacheOwner();
          if (accountId !== null && owner === accountId) {
            const local = await loadWeights();
            for (const w of local) {
              await addServerWeight(w.kg).catch(() => {});
            }
          }
        }
      })
      .catch((e) => {
        if (e instanceof AuthRequiredError) onRequireAuth();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Training data for the selected range comes from the server (exercise_logs),
  // reloaded whenever the range changes. Best-effort: if it fails the training
  // card just shows nothing rather than a fake value.
  useEffect(() => {
    let alive = true;
    getExerciseSummary(range)
      .then((s) => {
        if (alive) setExSummary(s);
      })
      .catch((e) => {
        if (e instanceof AuthRequiredError) onRequireAuth();
      });
    return () => {
      alive = false;
    };
  }, [range]);

  const series = useMemo(() => lastNDays(logs, range), [logs, range]);
  const streak = useMemo(() => computeStreak(logs), [logs]);
  const best = useMemo(() => bestStreak(logs), [logs]);
  const history = useMemo(() => loggedDaysDesc(logs), [logs]);

  // --- range report (real logged data) ------------------------------------ #
  const report = useMemo(() => {
    const logged = series.filter((d) => d.meals > 0);
    const n = logged.length;
    const avg = (sel: (d: (typeof logged)[number]) => number) =>
      n ? Math.round(logged.reduce((s, d) => s + sel(d), 0) / n) : 0;
    // "On target" = a logged day whose calories land within ±10% of the goal
    // (neither well under nor over). Real adherence, not just "did they log".
    const lo = goal.kcal * 0.9;
    const hi = goal.kcal * 1.1;
    const onTarget = logged.filter((d) => d.kcal >= lo && d.kcal <= hi).length;
    return {
      loggedDays: n,
      consistencyPct: Math.round((n / range) * 100),
      onTarget,
      avgKcal: avg((d) => d.kcal),
      avgP: avg((d) => d.protein_g),
      avgC: avg((d) => d.carbs_g),
      avgF: avg((d) => d.fat_g),
      proteinPct: goal.protein_g > 0 ? Math.round((avg((d) => d.protein_g) / goal.protein_g) * 100) : 0,
    };
  }, [series, range, goal]);

  // Bucket the calorie series into <= 14 bars: daily for short ranges, weekly
  // averages (of logged days) for 30/90 so the chart stays readable.
  const chartBars = useMemo(() => {
    if (series.length <= 14) {
      return series.map((d) => ({ kcal: d.kcal, label: d.label, meals: d.meals, date: d.date }));
    }
    const size = 7;
    const out: { kcal: number; label: string; meals: number; date: string }[] = [];
    for (let i = 0; i < series.length; i += size) {
      const chunk = series.slice(i, i + size);
      const logged = chunk.filter((d) => d.meals > 0);
      const avgKcal = logged.length ? Math.round(logged.reduce((s, d) => s + d.kcal, 0) / logged.length) : 0;
      out.push({
        kcal: avgKcal,
        label: `W${Math.floor(i / size) + 1}`,
        meals: logged.length,
        date: chunk[0].date,
      });
    }
    return out;
  }, [series]);

  const trainingActive = exSummary?.activeDays ?? 0;
  const trainingPct = Math.round((trainingActive / range) * 100);

  function openDay(dateKey: string) {
    setDetailDay(dateKey);
  }

  function handleDelete(dateKey: string, index: number) {
    const removed = logs[dateKey]?.meals[index];
    setLogs((prev) => {
      const next = deleteMeal(prev, dateKey, index);
      if (!next[dateKey]) setDetailDay(null); // day emptied — close sheet
      return next;
    });
    // Best-effort: if this meal had already synced (has a server id), remove
    // it there too. If it hadn't synced yet, there's nothing server-side to
    // remove -- it just never existed there.
    if (removed?.id) {
      deleteServerLog(removed.id).catch((e) => {
        if (e instanceof AuthRequiredError) onRequireAuth();
      });
    }
  }

  const totalMeals = Object.values(logs).reduce((s, d) => s + d.meals.length, 0);

  const maxKcal = Math.max(goal.kcal, ...chartBars.map((d) => d.kcal), 1);

  // weight trend
  const startWeight = weights.length ? weights[0].kg : profile.weightKg;
  const curWeight = weights.length ? weights[weights.length - 1].kg : profile.weightKg;
  const target = profile.targetWeightKg;
  const totalDelta = Math.abs(target - startWeight) || 1;
  const doneDelta = Math.abs(curWeight - startWeight);
  const weightPct = Math.min(100, Math.round((doneDelta / totalDelta) * 100));
  const weightMax = Math.max(startWeight, curWeight, target, ...weights.map((w) => w.kg), 1);
  const weightMin = Math.min(startWeight, curWeight, target, ...weights.map((w) => w.kg), weightMax);

  async function logWeight() {
    const next = await addWeight(entry);
    setWeights(next);
    onWeightLogged(entry);
    addServerWeight(entry).catch((e) => {
      if (e instanceof AuthRequiredError) onRequireAuth();
    });
  }

  return (
    <View style={styles.root}>
      <LinearGradient colors={gradients.brand} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.header}>
        <Text style={styles.hTitle}>Progress</Text>
        <Text style={styles.hSub}>Your trends over the last {range} days</Text>
      </LinearGradient>

      <ScrollView contentContainerStyle={styles.body}>
        {/* Streak row */}
        <View style={styles.statRow}>
          <StatCard icon="flame" color={colors.orange} value={`${streak}`} label="Day streak" />
          <StatCard icon="trophy" color={colors.gold} value={`${best}`} label="Best streak" />
          <StatCard icon="meal" color={colors.green} value={`${totalMeals}`} label="Meals logged" />
        </View>

        {/* Range selector — every report below reflects the chosen window */}
        <View style={styles.rangeRow}>
          {RANGES.map((r) => {
            const active = range === r.key;
            return (
              <Pressable
                key={r.key}
                style={[styles.rangeChip, active && styles.rangeChipActive]}
                onPress={() => setRange(r.key)}
              >
                <Text style={[styles.rangeText, active && styles.rangeTextActive]}>{r.label}</Text>
              </Pressable>
            );
          })}
        </View>

        {/* Reports: real adherence metrics over the selected range */}
        <Text style={styles.section}>Report · last {range} days</Text>
        <View style={styles.reportGrid}>
          <ReportCard
            icon="check"
            color={colors.green}
            value={`${report.onTarget}`}
            unit={`/ ${report.loggedDays} days`}
            label="Days on target"
          />
          <ReportCard
            icon="progress"
            color={colors.gold}
            value={`${report.consistencyPct}%`}
            unit={`${report.loggedDays}/${range} logged`}
            label="Logging consistency"
          />
          <ReportCard
            icon="protein"
            color={colors.green}
            value={`${report.proteinPct}%`}
            unit={`${report.avgP}g avg`}
            label="Protein adherence"
          />
          <ReportCard
            icon="dumbbell"
            color={colors.orange}
            value={`${trainingActive}`}
            unit={exSummary ? `${trainingPct}% · ${Math.round(exSummary.totalKcal)} kcal` : "—"}
            label="Training days"
          />
        </View>

        {/* Rule-based weekly coach (local, no AI) — always a 7-day snapshot */}
        <Text style={styles.section}>This week</Text>
        <WeeklySummary logs={logs} goal={goal} />

        {/* Calories chart — daily bars for 7 days, weekly averages for 30/90 */}
        <Text style={styles.section}>Calories · last {range} days</Text>
        <View style={styles.card}>
          <View style={styles.chart}>
            {chartBars.map((d, i) => {
              const h = Math.max(4, Math.round((d.kcal / maxKcal) * 120));
              const over = d.kcal > goal.kcal;
              const isLast = i === chartBars.length - 1;
              const dailyChart = range <= 14;
              return (
                <Pressable
                  key={d.date + i}
                  style={styles.barCol}
                  onPress={() => dailyChart && d.meals > 0 && openDay(d.date)}
                >
                  <Text style={styles.barVal}>{d.kcal > 0 ? d.kcal : ""}</Text>
                  <View style={styles.barTrack}>
                    <View
                      style={[
                        styles.bar,
                        { height: h },
                        over ? styles.barOver : null,
                        d.kcal === 0 ? styles.barEmpty : null,
                      ]}
                    />
                  </View>
                  <Text style={[styles.barLabel, isLast && styles.barLabelToday]}>{d.label}</Text>
                </Pressable>
              );
            })}
          </View>
          <View style={styles.goalLineRow}>
            <View style={styles.goalDot} />
            <Text style={styles.goalLineText}>
              Daily target {goal.kcal} kcal{range <= 14 ? " · tap a bar for details" : " · weekly averages"}
            </Text>
          </View>
        </View>

        {/* Averages over the selected range */}
        <Text style={styles.section}>Daily averages · logged days</Text>
        <View style={styles.card}>
          <View style={styles.avgTop}>
            <Text style={styles.avgKcal}>{report.avgKcal}</Text>
            <Text style={styles.avgKcalUnit}>kcal / day</Text>
          </View>
          <View style={styles.avgMacros}>
            <AvgMacro label="Protein" value={report.avgP} goalV={goal.protein_g} color={colors.green} />
            <AvgMacro label="Carbs" value={report.avgC} goalV={goal.carbs_g} color={colors.gold} />
            <AvgMacro label="Fat" value={report.avgF} goalV={goal.fat_g} color={colors.orange} />
          </View>
        </View>

        {/* Weight tracking */}
        <Text style={styles.section}>Weight</Text>
        <View style={styles.card}>
          <View style={styles.weightTop}>
            <View>
              <Text style={styles.weightCur}>{curWeight} kg</Text>
              <Text style={styles.weightSub}>
                {startWeight} kg start · {target} kg target
              </Text>
            </View>
            <View style={styles.weightBadge}>
              <Text style={styles.weightBadgeText}>{weightPct}%</Text>
            </View>
          </View>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${weightPct}%` }]} />
          </View>

          {weights.length > 1 && (
            <View style={styles.spark}>
              {weights.slice(-12).map((w, i) => {
                const range = weightMax - weightMin || 1;
                const h = 8 + Math.round(((w.kg - weightMin) / range) * 40);
                return <View key={i} style={[styles.sparkBar, { height: h }]} />;
              })}
            </View>
          )}

          <View style={styles.weightInputRow}>
            <Pressable style={styles.wBtn} onPress={() => setEntry((v) => clamp(v - 1, LIMITS.weightKg.min, LIMITS.weightKg.max))}>
              <Text style={styles.wBtnText}>−</Text>
            </Pressable>
            <View style={styles.wCenter}>
              <TextInput
                style={styles.wInput}
                keyboardType="numeric"
                value={String(entry)}
                onChangeText={(t) => {
                  const n = parseInt(t.replace(/[^0-9]/g, ""), 10);
                  if (!isNaN(n)) setEntry(clamp(n, LIMITS.weightKg.min, LIMITS.weightKg.max));
                  else if (t === "") setEntry(LIMITS.weightKg.min);
                }}
              />
              <Text style={styles.wUnit}>kg</Text>
            </View>
            <Pressable style={styles.wBtn} onPress={() => setEntry((v) => clamp(v + 1, LIMITS.weightKg.min, LIMITS.weightKg.max))}>
              <Text style={styles.wBtnText}>+</Text>
            </Pressable>
          </View>
          <Pressable style={styles.logBtn} onPress={logWeight}>
            <Text style={styles.logBtnText}>Log today's weight</Text>
          </Pressable>
        </View>

        {/* Meal history */}
        <Text style={styles.section}>Meal history</Text>
        {history.length === 0 ? (
          <View style={styles.card}>
            <Text style={styles.historyEmpty}>
              No meals logged yet. Scan a meal on Home to start your history.
            </Text>
          </View>
        ) : (
          <View style={styles.card}>
            {history.map((d, i) => (
              <Pressable
                key={d.date}
                style={[styles.histRow, i < history.length - 1 && styles.histDivider]}
                onPress={() => openDay(d.date)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.histDate}>{prettyDate(d.date)}</Text>
                  <Text style={styles.histSub}>
                    {d.meals} {d.meals === 1 ? "meal" : "meals"} · P {d.protein_g}g · C {d.carbs_g}g · F {d.fat_g}g
                  </Text>
                </View>
                <Text style={styles.histKcal}>{d.kcal}</Text>
                <Text style={styles.histChevron}>›</Text>
              </Pressable>
            ))}
          </View>
        )}

        <View style={{ height: 12 }} />
      </ScrollView>

      <DayDetail
        visible={detailDay !== null}
        dateKey={detailDay}
        logs={logs}
        goal={goal}
        onClose={() => setDetailDay(null)}
        onDelete={handleDelete}
      />
    </View>
  );
}

function StatCard({ icon, color, value, label }: { icon: IconName; color: string; value: string; label: string }) {
  return (
    <View style={styles.stat}>
      <View style={[styles.statIcon, { backgroundColor: color + "1A" }]}>
        <Icon name={icon} size={18} color={color} />
      </View>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function ReportCard({ icon, color, value, unit, label }: { icon: IconName; color: string; value: string; unit: string; label: string }) {
  return (
    <View style={styles.reportCard}>
      <View style={styles.reportHead}>
        <View style={[styles.reportIcon, { backgroundColor: color + "1A" }]}>
          <Icon name={icon} size={15} color={color} />
        </View>
        <Text style={styles.reportLabel}>{label}</Text>
      </View>
      <View style={styles.reportValRow}>
        <Text style={styles.reportValue}>{value}</Text>
        <Text style={styles.reportUnit}>{unit}</Text>
      </View>
    </View>
  );
}

function AvgMacro({ label, value, goalV, color }: { label: string; value: number; goalV: number; color: string }) {
  const pct = goalV > 0 ? Math.min(100, Math.round((value / goalV) * 100)) : 0;
  return (
    <View style={styles.avgMacro}>
      <Text style={styles.avgMacroVal}>{value}g</Text>
      <View style={styles.avgTrack}>
        <View style={[styles.avgFill, { width: `${pct}%`, backgroundColor: color }]} />
      </View>
      <Text style={styles.avgMacroLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { paddingTop: 56, paddingBottom: 24, paddingHorizontal: 20, borderBottomLeftRadius: 24, borderBottomRightRadius: 24 },
  hTitle: { color: "#fff", fontSize: 26, fontWeight: "800", letterSpacing: -0.3 },
  hSub: { color: "#CDEBD9", fontSize: 13, marginTop: 2 },
  body: { padding: 16, paddingBottom: 24, marginTop: -12 },

  statRow: { flexDirection: "row", gap: 10, marginBottom: 4 },
  stat: { flex: 1, backgroundColor: colors.card, borderRadius: radius.md, paddingVertical: 16, alignItems: "center", ...shadow.card },
  statIcon: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  statValue: { fontSize: 22, fontWeight: "900", color: colors.ink, marginTop: 8 },
  statLabel: { fontSize: 11, color: colors.mute, marginTop: 2 },

  rangeRow: { flexDirection: "row", gap: 8, marginTop: 14 },
  rangeChip: { flex: 1, alignItems: "center", paddingVertical: 10, borderRadius: radius.md, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, ...shadow.card },
  rangeChipActive: { backgroundColor: colors.green, borderColor: colors.green },
  rangeText: { fontSize: 13, fontWeight: "800", color: colors.mute },
  rangeTextActive: { color: "#fff" },

  reportGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  reportCard: { width: "47.8%", flexGrow: 1, backgroundColor: colors.card, borderRadius: radius.md, padding: 14, ...shadow.card },
  reportHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  reportIcon: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  reportLabel: { flex: 1, fontSize: 11.5, color: colors.mute, fontWeight: "700" },
  reportValRow: { flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: 10 },
  reportValue: { fontSize: 24, fontWeight: "900", color: colors.ink },
  reportUnit: { fontSize: 11.5, color: colors.mute, fontWeight: "700" },

  section: { fontSize: 13, fontWeight: "800", color: colors.mute, letterSpacing: 0.5, textTransform: "uppercase", marginTop: 20, marginBottom: 10 },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, ...shadow.card },

  chart: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", height: 160 },
  barCol: { flex: 1, alignItems: "center" },
  barVal: { fontSize: 9, color: colors.mute, marginBottom: 4, fontWeight: "700" },
  barTrack: { justifyContent: "flex-end", height: 120 },
  bar: { width: 22, borderRadius: 6, backgroundColor: colors.green },
  barOver: { backgroundColor: colors.orange },
  barEmpty: { backgroundColor: colors.track },
  barLabel: { fontSize: 11, color: colors.mute, marginTop: 6 },
  barLabelToday: { color: colors.green, fontWeight: "800" },
  goalLineRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 12, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 10 },
  goalDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.green },
  goalLineText: { color: colors.mute, fontSize: 12, fontWeight: "600" },

  avgTop: { flexDirection: "row", alignItems: "baseline", gap: 6 },
  avgKcal: { fontSize: 32, fontWeight: "900", color: colors.green },
  avgKcalUnit: { color: colors.mute, fontSize: 14, fontWeight: "700" },
  avgMacros: { flexDirection: "row", gap: 12, marginTop: 14 },
  avgMacro: { flex: 1 },
  avgMacroVal: { fontSize: 15, fontWeight: "800", color: colors.ink },
  avgTrack: { height: 6, borderRadius: 3, backgroundColor: colors.track, overflow: "hidden", marginTop: 4 },
  avgFill: { height: 6, borderRadius: 3 },
  avgMacroLabel: { fontSize: 11, color: colors.mute, marginTop: 4 },

  weightTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  weightCur: { fontSize: 28, fontWeight: "900", color: colors.ink },
  weightSub: { color: colors.mute, fontSize: 12, marginTop: 2 },
  weightBadge: { backgroundColor: colors.greenTint, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 6 },
  weightBadgeText: { color: colors.green, fontWeight: "800" },
  progressTrack: { height: 10, borderRadius: 5, backgroundColor: colors.track, overflow: "hidden", marginTop: 12 },
  progressFill: { height: 10, borderRadius: 5, backgroundColor: colors.green },
  spark: { flexDirection: "row", alignItems: "flex-end", gap: 6, height: 52, marginTop: 14 },
  sparkBar: { width: 10, borderRadius: 4, backgroundColor: colors.greenTint2, borderWidth: 1, borderColor: colors.green },

  weightInputRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 16 },
  wBtn: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.greenTint, alignItems: "center", justifyContent: "center" },
  wBtnText: { fontSize: 24, fontWeight: "800", color: colors.green },
  wCenter: { alignItems: "center", flex: 1 },
  wInput: { fontSize: 30, fontWeight: "900", color: colors.ink, textAlign: "center", minWidth: 70, padding: 0 },
  wUnit: { fontSize: 12, color: colors.mute, marginTop: -2 },
  logBtn: { backgroundColor: colors.green, borderRadius: radius.md, paddingVertical: 14, alignItems: "center", marginTop: 16 },
  logBtnText: { color: "#fff", fontWeight: "800", fontSize: 15 },

  historyEmpty: { color: colors.mute, fontSize: 13, textAlign: "center", paddingVertical: 12, lineHeight: 19 },
  histRow: { flexDirection: "row", alignItems: "center", paddingVertical: 14, gap: 10 },
  histDivider: { borderBottomWidth: 1, borderBottomColor: colors.line },
  histDate: { fontSize: 15, fontWeight: "800", color: colors.ink },
  histSub: { fontSize: 12, color: colors.mute, marginTop: 2 },
  histKcal: { fontSize: 16, fontWeight: "900", color: colors.green },
  histChevron: { fontSize: 22, color: colors.mute, fontWeight: "700" },
});
