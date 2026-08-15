import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from "react-native-svg";
import { useNavigation } from "@react-navigation/native";
import Screen from "./Screen";
import WeightSheet from "./WeightSheet";
import Icon, { IconName } from "./Icon";
import { GoalTargets, Profile } from "./nutrition";
import {
  AuthRequiredError,
  DayPlan,
  DaySummary,
  ExerciseSummary,
  fetchTodayPlan,
  getExerciseSummary,
  getLogDays,
  getServerWeights,
  getSummary,
} from "./api";
import { LogMap, WeightEntry, bestStreak as computeBestStreak, dayMacros, dayTotal, monthStreak, prettyDate } from "./storage";
import { AI_PLANNER_FULL_MODE } from "./config";
import { colors, elevation, gradients, radius, sp, type as T } from "./theme";

type Props = {
  profile: Profile;
  goal: GoalTargets;
  logs: LogMap;
  setLogs: React.Dispatch<React.SetStateAction<LogMap>>;
  onWeightLogged: (kg: number) => void;
  onRequireAuth: () => void;
  accountId: number | null;
  streak: number;
  bestStreak: number | null;
};

type RangeKey = 7 | 30 | 90 | "all";
type AdherenceState = "full" | "partial" | "miss";
type ProjectionState =
  | { kind: "enough"; eta: Date; slopeKgPerDay: number; projectedKg: number; targetKg: number }
  | { kind: "reached"; targetKg: number }
  | { kind: "stalled"; targetKg: number }
  | { kind: "insufficient" };

const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
  { key: 7, label: "7 Days" },
  { key: 30, label: "30 Days" },
  { key: 90, label: "90 Days" },
  { key: "all", label: "All Time" },
];

const CALORIE_HIT_MIN = 0.85;
const CALORIE_HIT_MAX = 1.15;
const PROTEIN_HIT_MIN = 0.85;
const ALL_TIME_CHART_DAYS = 365;
const WEIGHT_TREND_WINDOW = 5;
const RECENT_PROJECTION_DAYS = 14;

export default function ProgressScreen({
  profile,
  goal,
  logs,
  onWeightLogged,
  onRequireAuth,
  accountId,
  streak,
  bestStreak,
}: Props) {
  const navigation = useNavigation<any>();
  const { width } = useWindowDimensions();
  const [range, setRange] = useState<RangeKey>(30);
  const [weights, setWeights] = useState<WeightEntry[]>([]);
  const [summaryDays, setSummaryDays] = useState<DaySummary[]>([]);
  const [loggedDays, setLoggedDays] = useState<string[]>([]);
  const [exerciseSummary, setExerciseSummary] = useState<ExerciseSummary | null>(null);
  const [loadingWeights, setLoadingWeights] = useState(true);
  const [loadingRangeData, setLoadingRangeData] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showWeightSheet, setShowWeightSheet] = useState(false);
  const [previewDateKey, setPreviewDateKey] = useState<string | null>(null);
  const [previewPlan, setPreviewPlan] = useState<DayPlan | null>(null);
  const [previewPlanLoading, setPreviewPlanLoading] = useState(false);

  const chartWidth = Math.max(260, Math.round(width - sp(16)));
  const weightChartWidth = Math.max(240, chartWidth - sp(6));
  const macroChartWidth = Math.max(240, chartWidth - sp(6));
  const today = useMemo(() => startOfDay(new Date()), []);
  const best = bestStreak ?? computeBestStreak(logs);
  const plannerProfile = {
    age: profile.age,
    gender: profile.gender || undefined,
    height_cm: profile.heightCm,
    weight_kg: profile.weightKg,
    target_weight_kg: profile.targetWeightKg,
    activity: profile.activity,
    goal_pace: profile.goalPace,
    goal_kind: profile.goalKind,
    diet: profile.diet,
    goal: profile.goal,
  };
  const streakWindow = useMemo(() => monthStreak(logs, goal.kcal, new Date(), 30), [logs, goal.kcal]);

  const refreshWeights = useCallback(async () => {
    setLoadingWeights(true);
    try {
      const res = await getServerWeights();
      setWeights([...res.weights].sort((a, b) => a.at - b.at));
      setError(null);
    } catch (e) {
      if (e instanceof AuthRequiredError) {
        onRequireAuth();
        return;
      }
      setError("Couldn't load weight history right now.");
    } finally {
      setLoadingWeights(false);
    }
  }, [onRequireAuth]);

  useEffect(() => {
    void refreshWeights();
  }, [refreshWeights]);

  useEffect(() => {
    let alive = true;
    const summaryDaysArg = range === "all" ? ALL_TIME_CHART_DAYS : range;
    const logDaysArg = range === "all" ? 0 : range;
    const exerciseDaysArg = range === "all" ? ALL_TIME_CHART_DAYS : range;

    setLoadingRangeData(true);
    void Promise.all([getSummary(summaryDaysArg), getLogDays(logDaysArg), getExerciseSummary(exerciseDaysArg)])
      .then(([summaryRes, logDaysRes, exerciseRes]) => {
        if (!alive) return;
        setSummaryDays([...summaryRes.days].sort((a, b) => a.date.localeCompare(b.date)));
        setLoggedDays([...logDaysRes.days].sort((a, b) => a.localeCompare(b)));
        setExerciseSummary(exerciseRes);
        setError(null);
      })
      .catch((e) => {
        if (!alive) return;
        if (e instanceof AuthRequiredError) {
          onRequireAuth();
          return;
        }
        setError("Couldn't load your progress data right now.");
      })
      .finally(() => {
        if (alive) setLoadingRangeData(false);
      });

    return () => {
      alive = false;
    };
  }, [onRequireAuth, range]);

  const summaryByDate = useMemo(() => {
    const map = new Map<string, DaySummary>();
    for (const day of summaryDays) map.set(day.date, day);
    return map;
  }, [summaryDays]);

  const loggedDaySet = useMemo(() => new Set(loggedDays), [loggedDays]);

  const allTimeStart = useMemo(() => {
    const earliestDate = [summaryDays[0]?.date, loggedDays[0]]
      .filter((v): v is string => Boolean(v))
      .sort()[0];
    if (!earliestDate) return addDays(today, -(ALL_TIME_CHART_DAYS - 1));
    return maxDate(parseDateKey(earliestDate), addDays(today, -(ALL_TIME_CHART_DAYS - 1)));
  }, [loggedDays, summaryDays, today]);

  const selectedStart = useMemo(
    () => (range === "all" ? allTimeStart : addDays(today, -(range - 1))),
    [allTimeStart, range, today]
  );
  const selectedDates = useMemo(() => buildDateKeys(selectedStart, today), [selectedStart, today]);
  const displayWindowDays = selectedDates.length;

  const consistency = useMemo(() => {
    if (!summaryDays.length && !loggedDays.length) return { pct: 0, hits: 0, total: 0 };
    if (!selectedDates.length) return { pct: 0, hits: 0, total: 0 };
    let hits = 0;
    for (const date of selectedDates) {
      if (adherenceState(summaryByDate.get(date), goal) === "full") hits += 1;
    }
    return {
      pct: Math.round((hits / selectedDates.length) * 100),
      hits,
      total: selectedDates.length,
    };
  }, [goal, loggedDays.length, selectedDates, summaryByDate, summaryDays.length]);

  const recentSevenDays = useMemo(() => buildDateKeys(addDays(today, -6), today), [today]);

  const macroChartData = useMemo(
    () =>
      recentSevenDays.map((date) => {
        const day = summaryByDate.get(date);
        return {
          date,
          day,
          state: adherenceState(day, goal),
          kcalRatio: goal.kcal > 0 && day ? Math.min(1.3, day.kcal / goal.kcal) : 0,
          proteinRatio: goal.protein_g > 0 && day ? Math.min(1.3, day.protein_g / goal.protein_g) : 0,
        };
      }),
    [goal, recentSevenDays, summaryByDate]
  );

  const filteredWeights = useMemo(() => {
    if (range === "all") return weights;
    const startMs = selectedStart.getTime();
    return weights.filter((w) => w.at >= startMs);
  }, [range, selectedStart, weights]);
  const thirtyDayWeightDelta = useMemo(() => {
    const endAt = today.getTime();
    const startAt = endAt - 29 * DAY_MS;
    const window = weights.filter((w) => w.at >= startAt && w.at <= endAt).sort((a, b) => a.at - b.at);
    if (window.length < 2) return null;
    const delta = Math.round((window[window.length - 1].kg - window[0].kg) * 10) / 10;
    return {
      delta,
      label:
        delta > 0.05
          ? "rising"
          : delta < -0.05
            ? "falling"
            : "steady",
      days: Math.max(1, Math.round((window[window.length - 1].at - window[0].at) / DAY_MS)),
    };
  }, [today, weights]);

  const weightTrend = useMemo(() => buildWeightTrend(filteredWeights, weightChartWidth), [filteredWeights, weightChartWidth]);
  const projection = useMemo(() => buildProjection(weights, profile), [profile, weights]);

  const rangeLabel =
    range === "all"
      ? `All available history${displayWindowDays >= ALL_TIME_CHART_DAYS ? ` (last ${ALL_TIME_CHART_DAYS} days for macro charts)` : ""}`
      : `Last ${range} days`;

  const loggedCount = selectedDates.filter((date) => loggedDaySet.has(date)).length;

  useEffect(() => {
    if (!previewDateKey || !accountId) {
      setPreviewPlan(null);
      setPreviewPlanLoading(false);
      return;
    }
    let alive = true;
    setPreviewPlanLoading(true);
    const day = dayMacros(logs, previewDateKey);
    fetchTodayPlan({
      targets: { kcal: goal.kcal, protein_g: goal.protein_g, carbs_g: goal.carbs_g, fat_g: goal.fat_g },
      diet: profile.diet,
      goal: profile.goal,
      date: previewDateKey,
      consumed: { kcal: dayTotal(logs, previewDateKey), protein_g: day.protein_g, carbs_g: day.carbs_g, fat_g: day.fat_g },
      hour: new Date().getHours(),
      aiMode: AI_PLANNER_FULL_MODE,
      profile: plannerProfile,
    })
      .then((p) => {
        if (alive) setPreviewPlan(p);
      })
      .catch(() => {
        if (alive) setPreviewPlan(null);
      })
      .finally(() => {
        if (alive) setPreviewPlanLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [previewDateKey, accountId, logs, goal.kcal, goal.protein_g, goal.carbs_g, goal.fat_g, profile.diet, profile.goal, plannerProfile]);

  return (
    <Screen edgeTop background={colors.bg}>
      <View style={styles.root}>
        <LinearGradient colors={gradients.brand} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.header}>
          <Text style={styles.headerTitle}>Progress</Text>
          <Text style={styles.headerSubtitle}>{rangeLabel}</Text>
        </LinearGradient>

        <ScrollView contentContainerStyle={styles.body}>
          <View style={styles.overviewCard}>
            <View style={styles.rangeRow}>
              {RANGE_OPTIONS.map((option) => {
                const active = option.key === range;
                return (
                  <Pressable
                    key={String(option.key)}
                    style={[styles.rangeChip, active && styles.rangeChipActive]}
                    onPress={() => setRange(option.key)}
                  >
                    <Text style={[styles.rangeChipText, active && styles.rangeChipTextActive]}>{option.label}</Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.heroStats}>
              <HeroStat icon="flame" label="Current streak" value={`${streak}`} />
              <HeroStat icon="trophy" label="Best streak" value={`${best}`} />
              <HeroStat icon="meal" label="Logged days" value={`${loggedCount}`} />
            </View>
          </View>

          {error ? (
            <View style={styles.errorCard}>
              <Icon name="warning" size={18} color={colors.red} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <SectionCard
            icon="target"
            title="Consistency Score"
            subtitle="Days where both calorie and protein targets landed in range"
          >
            {loadingRangeData ? (
              <LoadingBlock />
            ) : (
              <>
                <View style={styles.consistencyHero}>
                  <Text style={styles.consistencyValue}>{consistency.total ? `${consistency.pct}%` : "—"}</Text>
                  <Text style={styles.consistencyLabel}>Target Adherence</Text>
                  <Text style={styles.consistencySub}>
                    {consistency.total
                      ? `${consistency.hits} of ${consistency.total} days hit both calories and protein`
                      : "Log meals for a few days to start seeing adherence."}
                  </Text>
                </View>
                <View style={styles.ruleRow}>
                  <RulePill label="Calories" detail="85–115% of target" color={colors.green} />
                  <RulePill label="Protein" detail="≥85% of target" color={colors.protein} />
                </View>
              </>
            )}
          </SectionCard>

          <SectionCard
            icon="scale"
            title="Smoothed Weight Trend"
            subtitle="Moving-average trend line with your actual weigh-ins overlaid"
          >
            {loadingWeights ? (
              <LoadingBlock />
            ) : filteredWeights.length === 0 ? (
              <EmptyState
                icon="scale"
                title={weights.length ? "No weigh-ins in this range yet" : "No weigh-ins yet"}
                detail="Log your weight to unlock trend tracking and goal projection."
                actionLabel="Log weight"
                onPress={() => setShowWeightSheet(true)}
              />
            ) : (
              <>
                <View style={styles.weightTopRow}>
                  <View style={styles.weightHeadlineBlock}>
                    <Text style={styles.weightHeadline}>{formatWeight(weightTrend.latestTrendKg)} kg</Text>
                    <Text style={styles.weightMeta}>
                      {filteredWeights.length} weigh-ins · last entry {formatWeight(weightTrend.latestActualKg)} kg
                    </Text>
                    {thirtyDayWeightDelta && (
                      <Text style={styles.weightTrendMeta}>
                        Last 30 days: {formatSigned(thirtyDayWeightDelta.delta)} kg ({thirtyDayWeightDelta.label})
                      </Text>
                    )}
                  </View>
                  <Pressable style={styles.secondaryButton} onPress={() => setShowWeightSheet(true)}>
                    <Icon name="plus" size={16} color={colors.green} />
                    <Text style={styles.secondaryButtonText}>Log</Text>
                  </Pressable>
                </View>

                <Svg width={weightChartWidth} height={180}>
                  <G>
                    {weightTrend.guides.map((guide) => (
                      <Line
                        key={guide.key}
                        x1={0}
                        y1={guide.y}
                        x2={weightChartWidth}
                        y2={guide.y}
                        stroke={colors.hairline}
                        strokeWidth={1}
                      />
                    ))}
                    {weightTrend.path ? (
                      <Path
                        d={weightTrend.path}
                        stroke={colors.green}
                        strokeWidth={4}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                      />
                    ) : null}
                    {weightTrend.actualPoints.map((point) => (
                      <Circle key={point.key} cx={point.x} cy={point.y} r={4} fill={colors.greenTint2} stroke={colors.green} strokeWidth={2} />
                    ))}
                  </G>
                </Svg>

                <View style={styles.axisRow}>
                  <Text style={styles.axisLabel}>{weightTrend.startLabel}</Text>
                  <Text style={styles.axisLabel}>{weightTrend.endLabel}</Text>
                </View>
                <Text style={styles.footnote}>Trend line uses a trailing 5-entry moving average to reduce daily scale noise.</Text>
              </>
            )}
          </SectionCard>

          <SectionCard
            icon="nutrition"
            title="Weekly Macro Adherence"
            subtitle="Last 7 days of calories + protein against your target"
          >
            {loadingRangeData ? (
              <LoadingBlock />
            ) : (
              <>
                <Svg width={macroChartWidth} height={190}>
                  <G>
                    <Line x1={0} y1={150} x2={macroChartWidth} y2={150} stroke={colors.line} strokeWidth={1} />
                    {macroChartData.map((entry, index) => {
                      const groupWidth = macroChartWidth / macroChartData.length;
                      const barWidth = Math.max(10, groupWidth * 0.22);
                      const gap = Math.max(4, groupWidth * 0.1);
                      const left = index * groupWidth + (groupWidth - barWidth * 2 - gap) / 2;
                      const color = statusColor(entry.state);
                      const kcalHeight = Math.round(entry.kcalRatio * 116);
                      const proteinHeight = Math.round(entry.proteinRatio * 116);
                      return (
                        <G key={entry.date}>
                          <Rect x={left} y={150 - kcalHeight} width={barWidth} height={kcalHeight} rx={6} fill={color} />
                          <Rect
                            x={left + barWidth + gap}
                            y={150 - proteinHeight}
                            width={barWidth}
                            height={proteinHeight}
                            rx={6}
                            fill={`${color}8C`}
                          />
                          <TextSvg x={index * groupWidth + groupWidth / 2} y={172} value={weekdayLabel(entry.date)} color={colors.mute} />
                        </G>
                      );
                    })}
                  </G>
                </Svg>

                <View style={styles.legendRow}>
                  <LegendItem color={colors.green} text="Both hit" />
                  <LegendItem color={colors.gold} text="One hit" />
                  <LegendItem color={colors.red} text="Neither / no log" />
                </View>
                <View style={styles.legendRow}>
                  <LegendItem color={colors.green} text="Left bar = calories" hollow />
                  <LegendItem color={`${colors.green}8C`} text="Right bar = protein" hollow />
                </View>
              </>
            )}
          </SectionCard>

          <SectionCard
            icon="target"
            title="Goal Projection"
            subtitle="Based on the last 14 days of server weight data"
          >
            {loadingWeights ? (
              <LoadingBlock />
            ) : projection.kind === "enough" ? (
              <>
                <Text style={styles.projectionHeadline}>
                  On track for {formatWeight(projection.targetKg)} kg by {prettyShortDate(projection.eta)}
                </Text>
                <Text style={styles.projectionSub}>
                  Current trend: {formatSigned(projection.slopeKgPerDay * 7)} kg/week · projected weight now{" "}
                  {formatWeight(projection.projectedKg)} kg
                </Text>
              </>
            ) : projection.kind === "reached" ? (
              <>
                <Text style={styles.projectionHeadline}>You&apos;re already at your target range.</Text>
                <Text style={styles.projectionSub}>Target weight: {formatWeight(projection.targetKg)} kg</Text>
              </>
            ) : projection.kind === "stalled" ? (
              <>
                <Text style={styles.projectionHeadline}>Current weight trend isn&apos;t moving toward your target yet.</Text>
                <Text style={styles.projectionSub}>Keep logging weigh-ins for a clearer ETA toward {formatWeight(projection.targetKg)} kg.</Text>
              </>
            ) : (
              <>
                <Text style={styles.projectionHeadline}>Not enough data yet for an honest ETA.</Text>
                <Text style={styles.projectionSub}>You need at least 14 days of weight history and 2 weigh-ins to project a target date.</Text>
              </>
            )}
          </SectionCard>

          <SectionCard
            icon="time"
            title="Calendar consistency"
            subtitle="Last 30 days with tap-to-open day plan"
          >
            {loadingRangeData ? (
              <LoadingBlock />
            ) : (
              <>
                <Text style={styles.progressCalendarSub}>
                  {streakWindow.hits} on target · {streakWindow.logged} logged · tap a day to view
                </Text>
                <View style={styles.progressCalendarWeekRow}>
                  {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
                    <Text key={`${d}-${i}`} style={styles.progressCalendarWeekText}>
                      {d}
                    </Text>
                  ))}
                </View>
                <View style={styles.progressCalendarGrid}>
                  {Array.from({ length: streakWindow.leading }).map((_, i) => (
                    <View key={`lead-${i}`} style={styles.progressCalendarCellBlank} />
                  ))}
                  {streakWindow.cells.map((c) => (
                    <Pressable
                      key={c.date}
                      style={[
                        styles.progressCalendarCell,
                        c.state === "hit"
                          ? styles.progressCalendarCellHit
                          : c.state === "over"
                            ? styles.progressCalendarCellOver
                            : c.state === "under"
                              ? styles.progressCalendarCellUnder
                              : styles.progressCalendarCellEmpty,
                      ]}
                      onPress={() => setPreviewDateKey(c.date)}
                    >
                      <Text style={styles.progressCalendarCellDay}>{c.day}</Text>
                    </Pressable>
                  ))}
                </View>
                <View style={styles.legendRow}>
                  <LegendItem color={colors.green} text="On target" compact />
                  <LegendItem color={colors.orange} text="Over" compact />
                  <LegendItem color={colors.red} text="Under" compact />
                  <LegendItem color={colors.track} text="No log" compact />
                </View>
                {!!previewDateKey && (
                  <View style={styles.progressCalendarHintRow}>
                    <Icon name="time" size={12} color={colors.mute} />
                    <Text style={styles.progressCalendarHint}>Selected: {prettyDate(previewDateKey)}</Text>
                  </View>
                </View>
                <Text style={styles.footnote}>Tap any day to load its plan preview with your current targets and logged meals.</Text>
              </>
            )}
          </SectionCard>

          <SectionCard
            icon="dumbbell"
            title="Exercise Summary"
            subtitle={`Real activity totals for ${range === "all" ? "the last 365 days" : `the last ${range} days`}`}
          >
            {loadingRangeData ? (
              <LoadingBlock />
            ) : exerciseSummary ? (
              <View style={styles.exerciseGrid}>
                <MetricTile label="Active days" value={`${exerciseSummary.activeDays}`} accent={colors.green} />
                <MetricTile label="Minutes" value={`${Math.round(exerciseSummary.totalMinutes)}`} accent={colors.protein} />
                <MetricTile label="Calories burned" value={`${Math.round(exerciseSummary.totalKcal)}`} accent={colors.orange} />
              </View>
            ) : (
              <EmptyState icon="dumbbell" title="No exercise data yet" detail="Logged workouts will appear here automatically." />
            )}
          </SectionCard>

          <View style={styles.bottomSpacer} />
        </ScrollView>

        {previewDateKey && (
          <Modal
            visible={!!previewDateKey}
            transparent
            animationType="fade"
            onRequestClose={() => setPreviewDateKey(null)}
          >
            <View style={styles.previewOverlay}>
              <Pressable style={styles.previewBackdrop} onPress={() => setPreviewDateKey(null)} />
              <View style={styles.previewSheet}>
                <View style={styles.previewHeadRow}>
                  <View>
                    <Text style={styles.previewHead}>Day plan preview</Text>
                    <Text style={styles.previewSub}>{prettyDate(previewDateKey)}</Text>
                  </View>
                  <Pressable onPress={() => setPreviewDateKey(null)} style={styles.previewCloseBtn}>
                    <Icon name="close" size={15} color={colors.mute} />
                  </Pressable>
                </View>
                {previewPlanLoading ? (
                  <View style={styles.previewLoadingRow}>
                    <ActivityIndicator size="small" color={colors.green} />
                    <Text style={styles.previewLoadingText}>Loading plan…</Text>
                  </View>
                ) : previewPlan ? (
                  <>
                    {!!previewPlan.next_meal && (
                      <View style={styles.previewNextPill}>
                        <Icon name="time" size={12} color={colors.green} />
                        <Text style={styles.previewNextText}>Next meal: {previewPlan.next_meal}</Text>
                      </View>
                    )}
                    <View style={styles.previewSlotsWrap}>
                      {previewPlan.slots.map((slot) => (
                        <View key={slot.slot} style={styles.previewSlotRow}>
                          <Text style={styles.previewSlotName}>{slot.label}</Text>
                          <Text style={styles.previewSlotMeal} numberOfLines={1}>
                            {slot.items[0]?.name ?? "No items"}
                          </Text>
                          <Text style={styles.previewSlotKcal}>{slot.kcal} kcal</Text>
                        </View>
                      ))}
                    </View>
                    <Pressable
                      style={styles.previewOpenBtn}
                      onPress={() => {
                        const dateKey = previewDateKey;
                        setPreviewDateKey(null);
                        if (dateKey) navigation.navigate("DayLog", { dateKey });
                      }}
                    >
                      <Icon name="time" size={15} color="#fff" />
                      <Text style={styles.previewOpenBtnText}>Open day details</Text>
                    </Pressable>
                  </>
                ) : (
                  <Text style={styles.previewEmpty}>
                    Couldn&apos;t load a plan for this date right now.
                  </Text>
                )}
              </View>
            </View>
          </Modal>
        )}

        <WeightSheet
          visible={showWeightSheet}
          initialKg={profile.weightKg}
          onClose={() => setShowWeightSheet(false)}
          onLogged={(kg) => {
            onWeightLogged(kg);
            void refreshWeights();
          }}
          onRequireAuth={() => {
            setShowWeightSheet(false);
            onRequireAuth();
          }}
        />
        {/* Stretch goals intentionally deferred: photo comparisons and NSV weekly
            check-ins need confirmed product scope/backing data before shipping. */}
      </View>
    </Screen>
  );
}

function HeroStat({ icon, label, value }: { icon: IconName; label: string; value: string }) {
  return (
    <View style={styles.heroStat}>
      <View style={styles.heroStatIcon}>
        <Icon name={icon} size={16} color={colors.white} />
      </View>
      <Text style={styles.heroStatValue}>{value}</Text>
      <Text style={styles.heroStatLabel}>{label}</Text>
    </View>
  );
}

function SectionCard({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: IconName;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <View style={styles.cardIcon}>
          <Icon name={icon} size={18} color={colors.green} />
        </View>
        <View style={styles.cardHeadText}>
          <Text style={styles.cardTitle}>{title}</Text>
          <Text style={styles.cardSubtitle}>{subtitle}</Text>
        </View>
      </View>
      {children}
    </View>
  );
}

function LoadingBlock() {
  return (
    <View style={styles.loadingBlock}>
      <ActivityIndicator color={colors.green} />
    </View>
  );
}

function RulePill({ label, detail, color }: { label: string; detail: string; color: string }) {
  return (
    <View style={styles.rulePill}>
      <View style={[styles.ruleDot, { backgroundColor: color }]} />
      <Text style={styles.rulePillText}>
        {label}
        <Text style={styles.rulePillSub}> · {detail}</Text>
      </Text>
    </View>
  );
}

function LegendItem({
  color,
  text,
  hollow,
  compact,
}: {
  color: string;
  text: string;
  hollow?: boolean;
  compact?: boolean;
}) {
  return (
    <View style={[styles.legendItem, compact && styles.legendItemCompact]}>
      <View
        style={[
          styles.legendSwatch,
          hollow ? { backgroundColor: colors.card, borderColor: color, borderWidth: 2 } : { backgroundColor: color },
        ]}
      />
      <Text style={styles.legendText}>{text}</Text>
    </View>
  );
}

function MetricTile({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <View style={styles.metricTile}>
      <View style={[styles.metricDot, { backgroundColor: accent }]} />
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

function EmptyState({
  icon,
  title,
  detail,
  actionLabel,
  onPress,
}: {
  icon: IconName;
  title: string;
  detail: string;
  actionLabel?: string;
  onPress?: () => void;
}) {
  return (
    <View style={styles.emptyState}>
      <View style={styles.emptyIcon}>
        <Icon name={icon} size={20} color={colors.mute} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyDetail}>{detail}</Text>
      {actionLabel && onPress ? (
        <Pressable style={styles.primaryButton} onPress={onPress}>
          <Text style={styles.primaryButtonText}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function TextSvg({ x, y, value, color }: { x: number; y: number; value: string; color: string }) {
  return (
    <SvgText x={x} y={y} fill={color} fontSize={11} fontWeight="700" textAnchor="middle">
      {value}
    </SvgText>
  );
}

function adherenceState(day: DaySummary | undefined, goal: GoalTargets): AdherenceState {
  if (!day || day.mealsCount <= 0) return "miss";
  const kcalHit = goal.kcal > 0 && day.kcal >= goal.kcal * CALORIE_HIT_MIN && day.kcal <= goal.kcal * CALORIE_HIT_MAX;
  const proteinHit = goal.protein_g > 0 && day.protein_g >= goal.protein_g * PROTEIN_HIT_MIN;
  if (kcalHit && proteinHit) return "full";
  if (kcalHit || proteinHit) return "partial";
  return "miss";
}

function statusColor(state: AdherenceState): string {
  if (state === "full") return colors.green;
  if (state === "partial") return colors.gold;
  return colors.red;
}

function buildWeightTrend(weights: WeightEntry[], width: number) {
  if (!weights.length) {
    return {
      latestTrendKg: 0,
      latestActualKg: 0,
      path: "",
      actualPoints: [] as { key: string; x: number; y: number }[],
      guides: [] as { key: string; y: number }[],
      startLabel: "",
      endLabel: "",
    };
  }

  const chartHeight = 144;
  const values = weights.map((w) => w.kg);
  const smoothed = weights.map((_, index) => movingAverage(weights, index, WEIGHT_TREND_WINDOW));
  const allValues = [...values, ...smoothed];
  const minKg = Math.min(...allValues);
  const maxKg = Math.max(...allValues);
  const pad = Math.max(0.4, (maxKg - minKg) * 0.25);
  const yMin = minKg - pad;
  const yMax = maxKg + pad;
  const firstAt = weights[0].at;
  const lastAt = weights[weights.length - 1].at;
  const span = Math.max(1, lastAt - firstAt);
  const toX = (at: number) => ((at - firstAt) / span) * width;
  const toY = (kg: number) => chartHeight - ((kg - yMin) / Math.max(0.1, yMax - yMin)) * chartHeight + 8;

  const smoothPoints = smoothed.map((kg, index) => ({ x: toX(weights[index].at), y: toY(kg) }));
  const actualPoints = weights.map((weight, index) => ({
    key: `${weight.at}-${index}`,
    x: toX(weight.at),
    y: toY(weight.kg),
  }));

  return {
    latestTrendKg: smoothed[smoothed.length - 1],
    latestActualKg: values[values.length - 1],
    path: buildLinePath(smoothPoints),
    actualPoints,
    guides: [0.2, 0.5, 0.8].map((fraction) => ({
      key: String(fraction),
      y: 8 + chartHeight * fraction,
    })),
    startLabel: prettyShortDate(new Date(firstAt)),
    endLabel: prettyShortDate(new Date(lastAt)),
  };
}

function buildProjection(weights: WeightEntry[], profile: Profile): ProjectionState {
  if (!weights.length) return { kind: "insufficient" };
  const now = Date.now();
  const cutoff = now - (RECENT_PROJECTION_DAYS - 1) * DAY_MS;
  const recent = weights.filter((w) => w.at >= cutoff);
  if (recent.length < 2) return { kind: "insufficient" };
  const spanDays = (recent[recent.length - 1].at - recent[0].at) / DAY_MS;
  if (spanDays < RECENT_PROJECTION_DAYS - 1) return { kind: "insufficient" };

  const targetKg = profile.targetWeightKg;
  const latestTrendKg = movingAverage(recent, recent.length - 1, Math.min(5, recent.length));
  if (Math.abs(latestTrendKg - targetKg) <= 0.2) return { kind: "reached", targetKg };

  const regression = linearRegression(recent);
  if (!regression) return { kind: "insufficient" };

  const projectedKg = regression.intercept + regression.slopeKgPerDay * regression.nowDay;
  const slopeKgPerDay = regression.slopeKgPerDay;
  const directionOk =
    (profile.goal === "lose" && slopeKgPerDay < -0.01 && projectedKg > targetKg) ||
    (profile.goal === "gain" && slopeKgPerDay > 0.01 && projectedKg < targetKg);

  if (profile.goal === "maintain") {
    return Math.abs(slopeKgPerDay) <= 0.05 ? { kind: "reached", targetKg } : { kind: "stalled", targetKg };
  }
  if (!directionOk) return { kind: "stalled", targetKg };

  const daysToGoal = Math.abs((targetKg - projectedKg) / slopeKgPerDay);
  if (!Number.isFinite(daysToGoal) || daysToGoal <= 0) return { kind: "stalled", targetKg };
  return {
    kind: "enough",
    eta: new Date(now + daysToGoal * DAY_MS),
    slopeKgPerDay,
    projectedKg,
    targetKg,
  };
}

function linearRegression(weights: WeightEntry[]) {
  const n = weights.length;
  const firstAt = weights[0].at;
  const points = weights.map((weight) => ({ x: (weight.at - firstAt) / DAY_MS, y: weight.kg }));
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / n;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    numerator += (point.x - meanX) * (point.y - meanY);
    denominator += (point.x - meanX) * (point.x - meanX);
  }
  if (!denominator) return null;
  const slopeKgPerDay = numerator / denominator;
  const intercept = meanY - slopeKgPerDay * meanX;
  return { slopeKgPerDay, intercept, nowDay: (Date.now() - firstAt) / DAY_MS };
}

function movingAverage(weights: WeightEntry[], index: number, window: number) {
  const from = Math.max(0, index - window + 1);
  const slice = weights.slice(from, index + 1);
  return slice.reduce((sum, weight) => sum + weight.kg, 0) / slice.length;
}

function buildLinePath(points: { x: number; y: number }[]) {
  if (!points.length) return "";
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
}

function buildDateKeys(start: Date, end: Date) {
  const dates: string[] = [];
  let cursor = startOfDay(start);
  while (cursor <= end) {
    dates.push(formatDateKey(cursor));
    cursor = addDays(cursor, 1);
  }
  return dates;
}

function parseDateKey(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

function formatDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return startOfDay(copy);
}

function maxDate(a: Date, b: Date) {
  return a.getTime() >= b.getTime() ? a : b;
}

function weekdayLabel(dateKey: string) {
  return parseDateKey(dateKey).toLocaleDateString(undefined, { weekday: "short" }).slice(0, 1);
}

function prettyShortDate(date: Date) {
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatWeight(value: number) {
  return Math.round(value * 10) / 10;
}

function formatSigned(value: number) {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    paddingTop: sp(10),
    paddingHorizontal: sp(5),
    paddingBottom: sp(4),
    borderBottomLeftRadius: radius.xl,
    borderBottomRightRadius: radius.xl,
  },
  headerTitle: { ...T.h1, color: colors.white },
  headerSubtitle: { ...T.caption, color: `${colors.white}CC`, marginTop: sp(0.5) },
  overviewCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: sp(3),
    gap: sp(3),
    ...elevation.sm,
  },
  rangeRow: { flexDirection: "row", flexWrap: "wrap", gap: sp(2) },
  rangeChip: {
    minWidth: "22%",
    paddingVertical: sp(2.25),
    paddingHorizontal: sp(3),
    borderRadius: radius.pill,
    backgroundColor: colors.cardMuted,
    borderWidth: 1,
    borderColor: colors.line,
  },
  rangeChipActive: { backgroundColor: colors.greenTint, borderColor: colors.greenTint },
  rangeChipText: { ...T.caption, color: colors.inkSoft, textAlign: "center" },
  rangeChipTextActive: { color: colors.green, fontWeight: "800" },
  heroStats: { flexDirection: "row", gap: sp(2) },
  heroStat: {
    flex: 1,
    paddingVertical: sp(3),
    paddingHorizontal: sp(2.5),
    borderRadius: radius.lg,
    backgroundColor: colors.cardMuted,
    borderWidth: 1,
    borderColor: colors.line,
  },
  heroStatIcon: {
    width: sp(8),
    height: sp(8),
    borderRadius: radius.pill,
    backgroundColor: colors.greenTint,
    alignItems: "center",
    justifyContent: "center",
  },
  heroStatValue: { ...T.h2, color: colors.ink, marginTop: sp(2) },
  heroStatLabel: { ...T.tiny, color: colors.mute, marginTop: sp(1) },
  body: { padding: sp(4), paddingBottom: sp(8), gap: sp(4) },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: sp(4),
    gap: sp(3),
    ...elevation.sm,
  },
  cardHead: { flexDirection: "row", gap: sp(3), alignItems: "flex-start" },
  cardIcon: {
    width: sp(10),
    height: sp(10),
    borderRadius: radius.md,
    backgroundColor: colors.greenTint,
    alignItems: "center",
    justifyContent: "center",
  },
  cardHeadText: { flex: 1 },
  cardTitle: { ...T.title, color: colors.ink },
  cardSubtitle: { ...T.caption, color: colors.mute, marginTop: sp(0.5), lineHeight: 18 },
  consistencyHero: { alignItems: "center", paddingVertical: sp(2) },
  consistencyValue: { ...T.display, color: colors.green },
  consistencyLabel: { ...T.title, color: colors.ink, marginTop: sp(1) },
  consistencySub: { ...T.caption, color: colors.mute, textAlign: "center", marginTop: sp(1), lineHeight: 18 },
  ruleRow: { flexDirection: "row", flexWrap: "wrap", gap: sp(2) },
  rulePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: sp(2),
    paddingVertical: sp(2),
    paddingHorizontal: sp(3),
    borderRadius: radius.pill,
    backgroundColor: colors.cardMuted,
  },
  ruleDot: { width: sp(2), height: sp(2), borderRadius: radius.pill },
  rulePillText: { ...T.caption, color: colors.inkSoft },
  rulePillSub: { color: colors.mute },
  loadingBlock: { paddingVertical: sp(8), alignItems: "center", justifyContent: "center" },
  emptyState: { alignItems: "center", paddingVertical: sp(3) },
  emptyIcon: {
    width: sp(11),
    height: sp(11),
    borderRadius: radius.pill,
    backgroundColor: colors.cardMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyTitle: { ...T.title, color: colors.ink, marginTop: sp(3), textAlign: "center" },
  emptyDetail: { ...T.caption, color: colors.mute, textAlign: "center", marginTop: sp(1), lineHeight: 18 },
  primaryButton: {
    marginTop: sp(3),
    backgroundColor: colors.green,
    borderRadius: radius.pill,
    paddingVertical: sp(2.5),
    paddingHorizontal: sp(4),
  },
  primaryButtonText: { ...T.bodyStrong, color: colors.white },
  secondaryButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: sp(1.5),
    paddingVertical: sp(2),
    paddingHorizontal: sp(3),
    borderRadius: radius.pill,
    backgroundColor: colors.greenTint,
  },
  secondaryButtonText: { ...T.caption, color: colors.green },
  weightTopRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  weightHeadlineBlock: { flex: 1, paddingRight: sp(3) },
  weightHeadline: { ...T.h1, color: colors.ink },
  weightMeta: { ...T.caption, color: colors.mute, marginTop: sp(0.5) },
  weightTrendMeta: { ...T.caption, color: colors.inkSoft, marginTop: sp(0.5), fontWeight: "700" },
  axisRow: { flexDirection: "row", justifyContent: "space-between", marginTop: -sp(1) },
  axisLabel: { ...T.tiny, color: colors.mute },
  footnote: { ...T.tiny, color: colors.faint, lineHeight: 16 },
  legendRow: { flexDirection: "row", flexWrap: "wrap", gap: sp(3) },
  legendItem: { flexDirection: "row", alignItems: "center", gap: sp(1.5) },
  legendItemCompact: { gap: sp(1) },
  legendSwatch: { width: sp(2.5), height: sp(2.5), borderRadius: radius.xs },
  legendText: { ...T.tiny, color: colors.mute },
  projectionHeadline: { ...T.h2, color: colors.ink, lineHeight: 28 },
  projectionSub: { ...T.body, color: colors.mute, lineHeight: 22 },
  progressCalendarSub: { ...T.caption, color: colors.mute },
  progressCalendarWeekRow: { flexDirection: "row", marginTop: sp(0.5) },
  progressCalendarWeekText: { flex: 1, textAlign: "center", ...T.tiny, color: colors.faint },
  progressCalendarGrid: { flexDirection: "row", flexWrap: "wrap", marginTop: sp(0.5) },
  progressCalendarCellBlank: { width: "14.2857%", height: 34 },
  progressCalendarCell: {
    width: "14.2857%",
    height: 34,
    borderRadius: radius.sm,
    marginBottom: sp(1.5),
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  progressCalendarCellDay: { ...T.caption, color: colors.ink },
  progressCalendarCellHit: { backgroundColor: colors.greenTint, borderColor: colors.green },
  progressCalendarCellOver: { backgroundColor: colors.cardMuted, borderColor: colors.orange },
  progressCalendarCellUnder: { backgroundColor: colors.redTint, borderColor: colors.red },
  progressCalendarCellEmpty: { backgroundColor: colors.bg, borderColor: colors.line },
  progressCalendarHintRow: { flexDirection: "row", alignItems: "center", gap: sp(1.5) },
  progressCalendarHint: { ...T.tiny, color: colors.mute },
  previewOverlay: { flex: 1, justifyContent: "flex-end" },
  previewBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.35)" },
  previewSheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: sp(4),
    paddingBottom: sp(5),
    gap: sp(2.5),
    maxHeight: "70%",
    ...elevation.md,
  },
  previewHeadRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: sp(2) },
  previewHead: { ...T.title, color: colors.ink },
  previewSub: { ...T.caption, color: colors.mute, marginTop: sp(0.5) },
  previewCloseBtn: {
    width: 30,
    height: 30,
    borderRadius: radius.pill,
    backgroundColor: colors.cardMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  previewLoadingRow: { flexDirection: "row", alignItems: "center", gap: sp(2), paddingVertical: sp(2) },
  previewLoadingText: { ...T.caption, color: colors.mute },
  previewNextPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: sp(1.5),
    alignSelf: "flex-start",
    backgroundColor: colors.greenTint,
    borderRadius: radius.pill,
    paddingVertical: sp(1.25),
    paddingHorizontal: sp(2.5),
  },
  previewNextText: { ...T.caption, color: colors.green },
  previewSlotsWrap: { gap: sp(2) },
  previewSlotRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: sp(2),
    backgroundColor: colors.cardMuted,
    borderRadius: radius.md,
    paddingVertical: sp(2),
    paddingHorizontal: sp(2.5),
  },
  previewSlotName: { ...T.caption, color: colors.green, minWidth: 76, fontWeight: "800" },
  previewSlotMeal: { flex: 1, ...T.caption, color: colors.ink },
  previewSlotKcal: { ...T.tiny, color: colors.mute },
  previewOpenBtn: {
    marginTop: sp(1),
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: sp(1.5),
    backgroundColor: colors.green,
    borderRadius: radius.pill,
    paddingVertical: sp(2.25),
    paddingHorizontal: sp(3.5),
  },
  previewOpenBtnText: { ...T.bodyStrong, color: colors.white },
  previewEmpty: { ...T.caption, color: colors.mute, lineHeight: 18 },
  exerciseGrid: { flexDirection: "row", gap: sp(2) },
  metricTile: { flex: 1, backgroundColor: colors.cardMuted, borderRadius: radius.md, padding: sp(3) },
  metricDot: { width: sp(2), height: sp(2), borderRadius: radius.pill, marginBottom: sp(2) },
  metricValue: { ...T.h2, color: colors.ink },
  metricLabel: { ...T.caption, color: colors.mute, marginTop: sp(1) },
  errorCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: sp(2),
    backgroundColor: colors.redTint,
    borderRadius: radius.md,
    padding: sp(3),
  },
  errorText: { ...T.caption, color: colors.red, flex: 1 },
  bottomSpacer: { height: sp(4) },
});
