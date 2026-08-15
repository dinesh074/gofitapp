// Full-page detail for ONE logged meal -- opened when a user taps a meal row
// in DayLogScreen (or anywhere else a meal list lives). Everything shown here
// is read straight from `logs` in AppContext, which is itself populated by a
// real GET /logs call to the backend (see api.ts's getServerLogs / App.tsx's
// syncProfileAndLogs) -- not a locally-computed or placeholder view. The
// micronutrient panel in particular now round-trips through the server
// (backend/progress.py's meal_logs.micros column) instead of living only in
// client memory, so reloading or switching devices no longer silently loses
// it.
import React, { useMemo } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import Screen from "./Screen";
import Icon from "./Icon";
import { colors, radius, elevation } from "./theme";
import { useApp } from "./AppContext";
import { deleteServerLog, AuthRequiredError } from "./api";
import { deleteMeal, LogMap, MEAL_TYPE_LABEL, MealType } from "./storage";
import { MICRO_REFS } from "./micros";
import { goBackOrTabs } from "./nav";

function mealTime(at: number): string {
  const d = new Date(at);
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}

function mealDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export default function MealDetailScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const dateKey: string = route.params?.dateKey;
  const idx: number = route.params?.idx;
  const { logs, setLogs, requireAuth } = useApp();

  const meal = logs[dateKey]?.meals?.[idx];

  const kcalFromMacros = useMemo(() => {
    if (!meal) return { p: 0, c: 0, f: 0, total: 0 };
    const p = Math.round((meal.protein_g || 0) * 4);
    const c = Math.round((meal.carbs_g || 0) * 4);
    const f = Math.round((meal.fat_g || 0) * 9);
    return { p, c, f, total: Math.max(1, p + c + f) };
  }, [meal]);

  function handleDelete() {
    if (!meal) return;
    setLogs((prev: LogMap) => deleteMeal(prev, dateKey, idx));
    if (meal.id) {
      deleteServerLog(meal.id).catch((e) => {
        if (e instanceof AuthRequiredError) requireAuth();
      });
    }
    goBackOrTabs(navigation);
  }

  if (!meal) {
    return (
      <Screen>
        <View style={styles.head}>
          <Pressable style={styles.backBtn} onPress={() => goBackOrTabs(navigation)} hitSlop={10}>
            <Icon name="chevronLeft" size={20} color={colors.ink} />
          </Pressable>
          <Text style={styles.title}>Meal</Text>
        </View>
        <View style={styles.emptyCard}>
          <Icon name="camera" size={22} color={colors.faint} />
          <Text style={styles.emptyText}>This meal is no longer available.</Text>
        </View>
      </Screen>
    );
  }

  const label = meal.mealType ? MEAL_TYPE_LABEL[meal.mealType as MealType] : "Meal";

  return (
    <Screen>
      <View style={styles.head}>
        <Pressable style={styles.backBtn} onPress={() => goBackOrTabs(navigation)} hitSlop={10}>
          <Icon name="chevronLeft" size={20} color={colors.ink} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>{meal.dish}</Text>
          <Text style={styles.sub}>
            {label} · {mealDate(meal.at)} · {mealTime(meal.at)}
          </Text>
        </View>
        <Pressable style={styles.delBtn} onPress={handleDelete} hitSlop={10}>
          <Icon name="trash" size={18} color={colors.red} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {meal.photoUrl ? (
          <Image source={{ uri: meal.photoUrl }} style={styles.photo} />
        ) : (
          <View style={styles.photoPlaceholder}>
            <Icon name="camera" size={28} color={colors.faint} />
            <Text style={styles.photoPlaceholderText}>No photo saved for this meal</Text>
          </View>
        )}

        <View style={styles.kcalCard}>
          <Text style={styles.kcalValue}>{Math.round(meal.kcal)}</Text>
          <Text style={styles.kcalLabel}>calories</Text>
        </View>

        <View style={styles.macroCard}>
          <Text style={styles.sectionHead}>Macros</Text>
          <View style={styles.macroBarTrack}>
            {kcalFromMacros.p > 0 && (
              <View style={[styles.macroSeg, { flex: kcalFromMacros.p, backgroundColor: colors.green }]} />
            )}
            {kcalFromMacros.c > 0 && (
              <View style={[styles.macroSeg, { flex: kcalFromMacros.c, backgroundColor: colors.gold }]} />
            )}
            {kcalFromMacros.f > 0 && (
              <View style={[styles.macroSeg, { flex: kcalFromMacros.f, backgroundColor: colors.orange }]} />
            )}
          </View>
          <View style={styles.macroRows}>
            <MacroRow color={colors.green} label="Protein" grams={meal.protein_g} kcal={kcalFromMacros.p} pct={Math.round((kcalFromMacros.p / kcalFromMacros.total) * 100)} />
            <MacroRow color={colors.gold} label="Carbs" grams={meal.carbs_g} kcal={kcalFromMacros.c} pct={Math.round((kcalFromMacros.c / kcalFromMacros.total) * 100)} />
            <MacroRow color={colors.orange} label="Fat" grams={meal.fat_g} kcal={kcalFromMacros.f} pct={Math.round((kcalFromMacros.f / kcalFromMacros.total) * 100)} />
          </View>
        </View>

        <View style={styles.itemsCard}>
          <Text style={styles.sectionHead}>Logged items</Text>
          {meal.foodItems && meal.foodItems.length > 0 ? (
            <View style={styles.itemsList}>
              {meal.foodItems.map((it, i) => (
                <View key={`${it.key || it.item}-${i}`} style={[styles.itemRow, i > 0 && styles.itemDivider]}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.itemName}>{it.item}</Text>
                    <Text style={styles.itemMeta}>
                      ×{it.count} {it.unit} · {Math.round(it.kcal_total)} kcal · P {Math.round(it.protein_g)}g · C{" "}
                      {Math.round(it.carbs_g)}g · F {Math.round(it.fat_g)}g
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          ) : (
            <Text style={styles.microEmpty}>This meal was logged without item-level breakdown.</Text>
          )}
        </View>

        <View style={styles.microCard}>
          <View style={styles.microHead}>
            <Text style={styles.sectionHead}>Micronutrients</Text>
            {meal.micros && Object.keys(meal.micros).length > 0 && meal.microsEstimated && (
              <View style={styles.estBadge}>
                <Text style={styles.estBadgeText}>Estimated</Text>
              </View>
            )}
          </View>
          {meal.micros && Object.keys(meal.micros).length > 0 && meal.microsEstimated && (
            <Text style={styles.estNote}>
              This dish wasn't matched to our verified food database, so these values are the AI's
              best-guess nutrition estimate, not lab-measured data.
            </Text>
          )}
          {meal.micros && Object.keys(meal.micros).length > 0 ? (
            <View style={styles.microGrid}>
              {MICRO_REFS.filter((ref) => meal.micros?.[ref.key] !== undefined).map((ref) => {
                const have = meal.micros?.[ref.key] ?? 0;
                return (
                  <View key={ref.key} style={styles.microRow}>
                    <Text style={styles.microLabel}>{ref.label}</Text>
                    <Text style={styles.microValue}>
                      {have >= 100 ? Math.round(have) : Math.round(have * 10) / 10}
                      {ref.unit}
                    </Text>
                  </View>
                );
              })}
            </View>
          ) : (
            <Text style={styles.microEmpty}>
              No micronutrient data for this meal -- it was a photo estimate that didn't match a
              specific item in the food database.
            </Text>
          )}
        </View>

        <View style={{ height: 24 }} />
      </ScrollView>
    </Screen>
  );
}

function MacroRow({ color, label, grams, kcal, pct }: { color: string; label: string; grams: number; kcal: number; pct: number }) {
  return (
    <View style={styles.macroRow}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={styles.macroLabel}>{label}</Text>
      <Text style={styles.macroGrams}>{Math.round(grams || 0)}g</Text>
      <Text style={styles.macroPct}>{Number.isFinite(pct) ? pct : 0}%</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 14 },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.card, alignItems: "center", justifyContent: "center", ...elevation.sm },
  delBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.card, alignItems: "center", justifyContent: "center", ...elevation.sm },
  title: { fontSize: 18, fontWeight: "900", color: colors.ink },
  sub: { fontSize: 12, color: colors.mute, marginTop: 1 },
  body: { paddingHorizontal: 16, paddingBottom: 12 },

  photo: { width: "100%", height: 220, borderRadius: radius.lg, backgroundColor: colors.bg, marginBottom: 14 },
  photoPlaceholder: { width: "100%", height: 140, borderRadius: radius.lg, backgroundColor: colors.card, alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 14 },
  photoPlaceholderText: { fontSize: 12, color: colors.faint, fontWeight: "600" },

  kcalCard: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 18, alignItems: "center", marginBottom: 14, ...elevation.sm },
  kcalValue: { fontSize: 34, fontWeight: "900", color: colors.ink },
  kcalLabel: { fontSize: 12, color: colors.mute, fontWeight: "700", marginTop: 2 },

  macroCard: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, marginBottom: 14, ...elevation.sm },
  sectionHead: { fontSize: 14, fontWeight: "800", color: colors.ink, marginBottom: 12 },
  macroBarTrack: { flexDirection: "row", height: 10, borderRadius: 5, overflow: "hidden", backgroundColor: colors.bg, marginBottom: 14 },
  macroSeg: { height: "100%" },
  macroRows: { gap: 10 },
  macroRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  macroLabel: { fontSize: 13, color: colors.ink, fontWeight: "700", flex: 1 },
  macroGrams: { fontSize: 13, color: colors.mute, fontWeight: "700", marginRight: 10 },
  macroPct: { fontSize: 12, color: colors.faint, fontWeight: "700", width: 36, textAlign: "right" },

  itemsCard: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, marginBottom: 14, ...elevation.sm },
  itemsList: { gap: 0 },
  itemRow: { paddingVertical: 8 },
  itemDivider: { borderTopWidth: 1, borderTopColor: colors.hairline },
  itemName: { fontSize: 13.5, color: colors.ink, fontWeight: "800" },
  itemMeta: { fontSize: 12, color: colors.mute, fontWeight: "600", marginTop: 2, lineHeight: 16 },

  microCard: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, marginBottom: 14, ...elevation.sm },
  microHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  estBadge: { backgroundColor: "#FEF3C7", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  estBadgeText: { fontSize: 11, fontWeight: "800", color: colors.gold },
  estNote: { fontSize: 12, color: colors.mute, lineHeight: 17, marginBottom: 12 },
  microGrid: { gap: 10 },
  microRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  microLabel: { fontSize: 13, color: colors.mute, fontWeight: "600" },
  microValue: { fontSize: 13, color: colors.ink, fontWeight: "800" },
  microEmpty: { fontSize: 12, color: colors.faint, lineHeight: 18 },

  emptyCard: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 28, alignItems: "center", gap: 8, marginHorizontal: 16 },
  emptyText: { color: colors.mute, fontSize: 13, fontWeight: "600" },
});
