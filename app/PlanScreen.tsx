import React, { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import Screen from "./Screen";
import Icon from "./Icon";
import PressableScale from "./PressableScale";
import TodayPlanCard from "./TodayPlanCard";
import { useApp } from "./AppContext";
import { dayMacros, dayTotal, todayKey } from "./storage";
import { dayMicros } from "./micros";
import { recommendMeals, DayPlan } from "./api";
import { colors, elevation } from "./theme";
import { notifyNextMealRecommendation, notifyPlanUpdate } from "./push";

type MoveMeal = {
  name: string;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
};

export default function PlanScreen() {
  const navigation = useNavigation<any>();
  const { profile, goal, logs, account, requireAuth } = useApp();
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
  const recoSig = useRef<string | null>(null);
  const notifyRecoSig = useRef<string | null>(null);
  const notifyPlanSig = useRef<string | null>(null);

  const remKcal = Math.max(0, goal.kcal - dayKcal);
  const remP = Math.max(0, goal.protein_g - dm.protein_g);
  const remC = Math.max(0, goal.carbs_g - dm.carbs_g);
  const remF = Math.max(0, goal.fat_g - dm.fat_g);

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
    const sig = `${profile.diet}|${profile.goal}|${Math.round(remKcal / 100)}|${Math.round(remP / 10)}|${Math.round(remC / 10)}`;
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

  const options = nextMove ? [nextMove.meal, ...(nextMove.alternatives ?? [])] : [];
  const selected = options.length > 0 ? options[nextMoveChoice % options.length] : null;
  const alternatives = options.filter((_, idx) => idx !== (nextMoveChoice % Math.max(1, options.length))).slice(0, 3);

  useEffect(() => {
    if (!selected) return;
    const sig = `${today}|${selected.name}|${Math.round(selected.kcal)}|${Math.round(selected.protein_g)}`;
    if (notifyRecoSig.current === sig) return;
    notifyRecoSig.current = sig;
    void notifyNextMealRecommendation(selected);
  }, [today, selected?.name, selected?.kcal, selected?.protein_g, selected?.carbs_g, selected?.fat_g]);

  function onPlanResolved(plan: DayPlan) {
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

  return (
    <Screen edgeTop>
      <View style={styles.root}>
        <View style={styles.header}>
          <Text style={styles.headTitle}>Plan</Text>
          <Text style={styles.headSub}>Daily plan and next best meal in one place.</Text>
        </View>
        <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
          <View style={styles.nextCard}>
            <View style={styles.nextHeadRow}>
              <View style={styles.nextHeadTitle}>
                <Icon name="sparkles" size={15} color={colors.green} />
                <Text style={styles.nextHeadText}>Your next best move</Text>
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
                {alternatives.map((alt) => (
                  <Text key={alt.name} style={styles.altText}>
                    <Text style={styles.altLabel}>Alternative: </Text>
                    {alt.name}
                  </Text>
                ))}
                <Text style={styles.gapText}>{biggestGap}</Text>
                {!!nextMove?.reason && <Text style={styles.reasonText}>{nextMove.reason}</Text>}
                <View style={styles.nextActions}>
                  <PressableScale
                    style={[styles.logBtn]}
                    onPress={() => {
                      navigation.navigate("Tabs", { screen: "ScanHub" });
                    }}
                  >
                    <Icon name="plus" size={15} color="#fff" />
                    <Text style={styles.logBtnText}>Log this now</Text>
                  </PressableScale>
                  <Pressable
                    style={styles.openBtn}
                    onPress={() =>
                      navigation.navigate("NextMove", {
                        category: nextMove?.category ?? "",
                        slot: nextMove?.slot ?? "",
                        reason: nextMove?.reason ?? "",
                        biggestGap,
                        selected,
                        alternatives,
                      })
                    }
                  >
                    <Icon name="chevronRight" size={13} color={colors.green} />
                    <Text style={styles.openBtnText}>Open full screen</Text>
                  </Pressable>
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
  header: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 10, backgroundColor: colors.bg },
  headTitle: { color: colors.ink, fontSize: 24, fontWeight: "900" },
  headSub: { color: colors.mute, fontSize: 12.5, fontWeight: "600", marginTop: 2 },
  body: { padding: 16, paddingBottom: 28 },
  nextCard: { backgroundColor: colors.card, borderRadius: 18, padding: 16, marginBottom: 16, gap: 9, ...elevation.sm },
  nextHeadRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  nextHeadTitle: { flexDirection: "row", alignItems: "center", gap: 6, flex: 1 },
  nextHeadText: { color: colors.ink, fontSize: 14, fontWeight: "900" },
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
  altText: { color: colors.inkSoft, fontSize: 12.5, fontWeight: "600" },
  altLabel: { color: colors.mute, fontWeight: "700" },
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
  openBtn: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: colors.cardMuted,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  openBtnText: { color: colors.green, fontSize: 12, fontWeight: "800" },
  emptyText: { color: colors.mute, fontSize: 12.5, fontWeight: "600", lineHeight: 17 },
});
