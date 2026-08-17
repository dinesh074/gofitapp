import React, { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Screen from "./Screen";
import Icon from "./Icon";
import PressableScale from "./PressableScale";
import TodayPlanCard from "./TodayPlanCard";
import CalorieRing from "./CalorieRing";
import { useApp } from "./AppContext";
import { dayMacros, dayTotal, todayKey } from "./storage";
import { dayMicros } from "./micros";
import { recommendMeals, DayPlan, PlannerProfileContext } from "./api";
import { AI_PLANNER_FULL_MODE } from "./config";
import { colors, elevation, gradients, radius, sp, type as T } from "./theme";
import { notifyNextMealRecommendation, notifyPlanUpdate } from "./push";

type MoveMeal = {
  name: string;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
};

function GlanceStat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={styles.glanceStatRow}>
      <View style={[styles.glanceStatDot, { backgroundColor: color }]} />
      <View>
        <Text style={styles.glanceStatValue}>{value}</Text>
        <Text style={styles.glanceStatLabel}>{label}</Text>
      </View>
    </View>
  );
}

export default function PlanScreen() {
  const { profile, goal, logs, account, requireAuth, logMeal } = useApp();
  const today = todayKey();
  const dayKcal = dayTotal(logs, today);
  const dm = dayMacros(logs, today);
  const fibreRow = dayMicros(logs, today).rows.find((r) => r.key === "fiber_g");
  const [nextMove, setNextMove] = useState<{
    category: string;
    slot: string;
    reason: string;
    meal: MoveMeal;
    alternatives: MoveMeal[];
  } | null>(null);
  const [nextMoveChoice, setNextMoveChoice] = useState(0);
  const [planNextMealName, setPlanNextMealName] = useState("");
  const recoSig = useRef<string | null>(null);
  const notifyRecoSig = useRef<string | null>(null);
  const notifyPlanSig = useRef<string | null>(null);

  const remKcal = Math.max(0, goal.kcal - dayKcal);
  const remP = Math.max(0, goal.protein_g - dm.protein_g);
  const remC = Math.max(0, goal.carbs_g - dm.carbs_g);
  const remF = Math.max(0, goal.fat_g - dm.fat_g);
  const plannerProfile: PlannerProfileContext = {
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
    on_glp1: profile.onGlp1,
    avoid_foods: profile.avoidFoods || [],
    budget_pref: profile.budgetPref || "",
    avoidFoods: profile.avoidFoods || [],
    budgetPref: profile.budgetPref || "",
  };

  const biggestGap = useMemo(() => {
    const rows = [
      { key: "protein", left: remP, target: Math.max(1, goal.protein_g) },
      { key: "carbs", left: remC, target: Math.max(1, goal.carbs_g) },
      { key: "fat", left: remF, target: Math.max(1, goal.fat_g) },
    ];
    rows.sort((a, b) => b.left / b.target - a.left / a.target);
    const top = rows[0];
    if (!top || top.left <= 0) return "You're broadly on track today.";
    return `${Math.round(top.left)}g ${top.key} still to go today.`;
  }, [remP, remC, remF, goal.protein_g, goal.carbs_g, goal.fat_g]);

  useEffect(() => {
    if (!account) {
      setNextMove(null);
      recoSig.current = null;
      return;
    }
    // Same time-aware bucketing as HomeScreen -- refetch when the meal-time
    // window changes (breakfast/lunch/snack/dinner), not just remaining macros.
    const hour = new Date().getHours();
    const slotBucket = hour < 4 ? "dinner" : hour < 11 ? "breakfast" : hour < 16 ? "lunch" : hour < 19 ? "snack" : "dinner";
    const sig = `${profile.diet}|${profile.goal}|${Math.round(remKcal / 100)}|${Math.round(remP / 10)}|${Math.round(remC / 10)}|${slotBucket}`;
    if (sig === recoSig.current) return;
    let alive = true;
    const timer = setTimeout(() => {
      recoSig.current = sig;
      recommendMeals(
        { kcal: remKcal, protein_g: remP, carbs_g: remC, fat_g: remF },
        profile.diet,
        profile.goal,
        "",
        {
          targets: { kcal: goal.kcal, protein_g: goal.protein_g, carbs_g: goal.carbs_g, fat_g: goal.fat_g },
          consumed: { kcal: dayKcal, protein_g: dm.protein_g, carbs_g: dm.carbs_g, fat_g: dm.fat_g },
          date: today,
          aiMode: AI_PLANNER_FULL_MODE,
          profile: plannerProfile,
          hour,
        },
      )
        .then(({ nextMove: move }) => {
          if (!alive) return;
          setNextMove(
            move
              ? {
                  category: move.category,
                  slot: move.slot,
                  reason: move.reason,
                  meal: move.meal,
                  alternatives: move.alternatives ?? [],
                }
              : null,
          );
          setNextMoveChoice(0);
        })
        .catch(() => {
          if (alive) setNextMove(null);
        });
    }, 600);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [account?.id, profile.diet, profile.goal, remKcal, remP, remC, remF, goal.kcal, goal.protein_g, goal.carbs_g, goal.fat_g, dayKcal, dm.protein_g, dm.carbs_g, dm.fat_g, today]);

  const optionsRaw = nextMove ? [nextMove.meal, ...(nextMove.alternatives ?? [])] : [];
  const options = useMemo(() => {
    if (!optionsRaw.length || !planNextMealName) return optionsRaw;
    const ban = planNextMealName.trim().toLowerCase();
    const filtered = optionsRaw.filter((m) => m.name.trim().toLowerCase() !== ban);
    return filtered.length > 0 ? filtered : optionsRaw;
  }, [optionsRaw, planNextMealName]);
  const selected = options.length > 0 ? options[nextMoveChoice % options.length] : null;

  useEffect(() => {
    if (!selected) return;
    const sig = `${today}|${selected.name}|${Math.round(selected.kcal)}|${Math.round(selected.protein_g)}`;
    if (notifyRecoSig.current === sig) return;
    notifyRecoSig.current = sig;
    void notifyNextMealRecommendation(selected);
  }, [today, selected?.name, selected?.kcal, selected?.protein_g, selected?.carbs_g, selected?.fat_g]);

  function onPlanResolved(plan: DayPlan) {
    setPlanNextMealName((plan.next_meal || "").trim());
    const slot = plan.slots.find((s) => s.items.length > 0 && s.upcoming !== false) ?? plan.slots.find((s) => s.items.length > 0);
    const item = slot?.items[0];
    if (!slot || !item) return;
    const sig = `${plan.date}|${item.name}|${Math.round(slot.kcal)}`;
    if (notifyPlanSig.current === sig) return;
    notifyPlanSig.current = sig;
    void notifyPlanUpdate({
      name: item.name,
      kcal: slot.kcal,
      protein_g: slot.protein_g ?? 0,
      carbs_g: slot.carbs_g ?? 0,
      fat_g: slot.fat_g ?? 0,
    });
  }

  function logSelectedMeal() {
    if (!selected) return;
    const at = Date.now();
    logMeal({
      dish: selected.name,
      kcal: Math.round(selected.kcal),
      protein_g: Math.round(selected.protein_g),
      carbs_g: Math.round(selected.carbs_g),
      fat_g: Math.round(selected.fat_g),
      at,
      foodItems: [
        {
          item: selected.name,
          count: 1,
          unit: "serving",
          source: "plan",
          kcal_per_unit: Math.round(selected.kcal),
          protein_g_per_unit: Math.round(selected.protein_g),
          carbs_g_per_unit: Math.round(selected.carbs_g),
          fat_g_per_unit: Math.round(selected.fat_g),
          kcal_total: Math.round(selected.kcal),
          protein_g: Math.round(selected.protein_g),
          carbs_g: Math.round(selected.carbs_g),
          fat_g: Math.round(selected.fat_g),
        },
      ],
    });
  }

  return (
    <Screen edgeTop>
      <View style={styles.root}>
        <LinearGradient colors={gradients.brand} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.header}>
          <Text style={styles.headTitle}>Plan</Text>
          <Text style={styles.headSub}>Daily plan and next best meal in one place.</Text>
        </LinearGradient>
        <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
          <View style={styles.glanceCard}>
            <CalorieRing value={dayKcal} goal={goal.kcal} size={92} stroke={11} />
            <View style={styles.glanceStats}>
              <GlanceStat label="Protein left" value={`${Math.round(remP)}g`} color={colors.protein} />
              <GlanceStat label="Carbs left" value={`${Math.round(remC)}g`} color={colors.gold} />
              <GlanceStat label="Fat left" value={`${Math.round(remF)}g`} color={colors.fat} />
            </View>
          </View>

          <View style={styles.nextCard}>
            <View style={styles.nextHeadRow}>
              <View style={styles.cardIcon}>
                <Icon name="sparkles" size={17} color={colors.green} />
              </View>
              <View style={styles.nextHeadText}>
                <Text style={styles.nextHeadTitle}>Your next best move</Text>
                <Text style={styles.nextHeadSubtitle}>AI-picked to close today&apos;s biggest gap</Text>
              </View>
              {options.length > 1 && (
                <Pressable style={styles.swapBtn} onPress={() => setNextMoveChoice((n) => n + 1)}>
                  <Icon name="refresh" size={13} color={colors.green} />
                  <Text style={styles.swapText}>Swap</Text>
                </Pressable>
              )}
            </View>
            {selected ? (
              <>
                {!!nextMove?.category && (
                  <View style={styles.categoryPill}>
                    <Text style={styles.categoryText}>{nextMove.category.replace(/_/g, " ")}</Text>
                  </View>
                )}
                <View style={styles.mainMeal}>
                  <Text style={styles.mainMealName}>{selected.name}</Text>
                  <Text style={styles.mainMealMeta}>
                    ~{Math.round(selected.kcal)} kcal · P {Math.round(selected.protein_g)}g · C {Math.round(selected.carbs_g)}g · F {Math.round(selected.fat_g)}g
                  </Text>
                </View>
                {options.length > 1 && (
                  <View style={styles.altList}>
                    {options.map((opt, idx) => {
                      const isSelected = idx === nextMoveChoice % options.length;
                      if (isSelected) return null;
                      return (
                        <Pressable key={opt.name} style={styles.altRow} onPress={() => setNextMoveChoice(idx)}>
                          <Icon name="swap" size={13} color={colors.green} />
                          <Text style={styles.altText}>{opt.name}</Text>
                          <Text style={styles.altMeta}>~{Math.round(opt.kcal)} kcal</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                )}
                <Text style={styles.gapText}>{biggestGap}</Text>
                {!!nextMove?.reason && <Text style={styles.reasonText}>{nextMove.reason}</Text>}
                <View style={styles.nextActions}>
                  <PressableScale
                    style={[styles.logBtn]}
                    onPress={logSelectedMeal}
                  >
                    <Icon name="plus" size={15} color="#fff" />
                    <Text style={styles.logBtnText}>Log this now</Text>
                  </PressableScale>
                </View>
              </>
            ) : (
              <Pressable onPress={requireAuth}>
                <Text style={styles.emptyText}>
                  We&apos;ll show your next meal recommendation here after your profile and today&apos;s targets sync.
                </Text>
              </Pressable>
            )}
          </View>

          <TodayPlanCard
            goal={goal}
            diet={profile.diet}
            goalName={profile.goal}
            date={today}
            account={account}
            onRequireAuth={requireAuth}
            training=""
            aiMode={AI_PLANNER_FULL_MODE}
            profileContext={plannerProfile}
            fiberTarget={fibreRow?.target}
            consumed={{
              kcal: dayKcal,
              protein_g: dm.protein_g,
              carbs_g: dm.carbs_g,
              fat_g: dm.fat_g,
              ...(fibreRow ? { fiber_g: fibreRow.have } : {}),
            }}
            onPlanResolved={onPlanResolved}
          />
        </ScrollView>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    paddingTop: sp(10),
    paddingHorizontal: sp(5),
    paddingBottom: sp(4),
    borderBottomLeftRadius: radius.xl,
    borderBottomRightRadius: radius.xl,
  },
  headTitle: { ...T.h1, color: colors.white },
  headSub: { ...T.caption, color: `${colors.white}CC`, marginTop: sp(0.5) },
  body: { padding: 16, paddingBottom: 28 },
  glanceCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: sp(4),
    marginBottom: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: sp(4),
    ...elevation.sm,
  },
  glanceStats: { flex: 1, gap: sp(2.5) },
  glanceStatRow: { flexDirection: "row", alignItems: "center", gap: sp(2) },
  glanceStatDot: { width: 8, height: 8, borderRadius: 4 },
  glanceStatValue: { ...T.body, color: colors.ink, fontWeight: "800" },
  glanceStatLabel: { ...T.caption, color: colors.mute },
  nextCard: { backgroundColor: colors.card, borderRadius: 18, padding: 16, marginBottom: 16, gap: 9, ...elevation.sm },
  nextHeadRow: { flexDirection: "row", alignItems: "flex-start", gap: sp(3) },
  cardIcon: {
    width: sp(10),
    height: sp(10),
    borderRadius: radius.md,
    backgroundColor: colors.greenTint,
    alignItems: "center",
    justifyContent: "center",
  },
  nextHeadText: { flex: 1 },
  nextHeadTitle: { color: colors.ink, fontSize: 14, fontWeight: "900" },
  nextHeadSubtitle: { ...T.tiny, color: colors.mute, marginTop: sp(0.5) },
  swapBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: colors.greenTint,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  swapText: { color: colors.green, fontSize: 12, fontWeight: "800" },
  categoryPill: {
    alignSelf: "flex-start",
    backgroundColor: colors.greenTint,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  categoryText: { color: colors.green, fontSize: 11, fontWeight: "800", textTransform: "uppercase" },
  mainMeal: { backgroundColor: colors.cardMuted, borderRadius: 12, padding: 10 },
  mainMealName: { color: colors.ink, fontSize: 15, fontWeight: "800" },
  mainMealMeta: { color: colors.mute, fontSize: 12, fontWeight: "700", marginTop: 2 },
  altText: { color: colors.inkSoft, fontSize: 12.5, fontWeight: "700", flex: 1 },
  altList: { gap: 2 },
  altRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  altMeta: { color: colors.mute, fontSize: 11.5, fontWeight: "700" },
  gapText: { color: colors.inkSoft, fontSize: 12.5, fontWeight: "700" },
  reasonText: { color: colors.mute, fontSize: 12, fontWeight: "600", lineHeight: 17 },
  nextActions: { gap: 8, marginTop: 2 },
  logBtn: {
    backgroundColor: colors.green,
    borderRadius: 12,
    paddingVertical: 11,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  logBtnText: { color: "#fff", fontSize: 14, fontWeight: "800" },
  emptyText: { color: colors.mute, fontSize: 12.5, fontWeight: "600", lineHeight: 17 },
});
