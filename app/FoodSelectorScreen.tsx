import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import { FoodSuggestion, searchFoods, AuthRequiredError } from "./api";
import { Meal } from "./storage";
import { colors, radius, elevation, type as T } from "./theme";
import Icon from "./Icon";
import Screen from "./Screen";
import { useApp } from "./AppContext";
import { goBackOrTabs } from "./nav";

// Turns a food-DB suggestion + a chosen serving count into a loggable Meal.
// Calories/macros always come straight from the DB row (never guessed) and
// scale linearly with the count, matching backend anchor_items behaviour.
function mealFromSuggestion(s: FoodSuggestion, count: number): Meal {
  const c = Math.max(1, count);
  const micros = s.micros
    ? Object.fromEntries(Object.entries(s.micros).map(([k, v]) => [k, v * c]))
    : undefined;
  return {
    dish: c > 1 ? `${s.name} ×${c}` : s.name,
    kcal: Math.round(s.kcal_per_unit * c),
    protein_g: Math.round(s.protein_g_per_unit * c),
    carbs_g: Math.round(s.carbs_g_per_unit * c),
    fat_g: Math.round(s.fat_g_per_unit * c),
    at: Date.now(),
    // Verified DB micros, scaled to the chosen portion count -- this is a
    // direct catalog pick (not a photo estimate), so it's always "db" sourced.
    micros,
  };
}

function MacroPill({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <View style={styles.macroPill}>
      <View style={[styles.macroDot, { backgroundColor: color }]} />
      <Text style={styles.macroVal}>{value}g</Text>
      <Text style={styles.macroLabel}>{label}</Text>
    </View>
  );
}

export default function FoodSelectorScreen() {
  const navigation = useNavigation<any>();
  const { logMeal, requireAuth } = useApp();

  const [q, setQ] = useState("");
  const [results, setResults] = useState<FoodSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const reqId = useRef(0);

  // The food the user tapped to fine-tune the portion before adding.
  const [selected, setSelected] = useState<FoodSuggestion | null>(null);
  const [count, setCount] = useState(1);
  const [added, setAdded] = useState<string | null>(null);

  // Debounced search — one request after typing settles, not per keystroke.
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setResults([]);
      setSearched(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const id = ++reqId.current;
    const t = setTimeout(async () => {
      try {
        const r = await searchFoods(query);
        if (id !== reqId.current) return;
        setResults(r);
        setSearched(true);
      } catch (e: any) {
        if (id !== reqId.current) return;
        if (e instanceof AuthRequiredError) {
          requireAuth();
          goBackOrTabs(navigation);
          return;
        }
        setError(e?.message || "Couldn't search foods. Try again.");
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    }, 280);
    return () => clearTimeout(t);
  }, [q]);

  const preview = useMemo(
    () => (selected ? mealFromSuggestion(selected, count) : null),
    [selected, count]
  );

  function openPortion(food: FoodSuggestion) {
    setSelected(food);
    setCount(1);
  }

  function confirmAdd() {
    if (!selected || !preview) return;
    logMeal(preview);
    setAdded(selected.name);
    setSelected(null);
    // Brief inline confirmation, then clear so a rapid second add reads fresh.
    setTimeout(() => setAdded((cur) => (cur === selected.name ? null : cur)), 1800);
  }

  return (
    <Screen edgeTop background={colors.bg}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable style={styles.iconBtn} onPress={() => goBackOrTabs(navigation)} hitSlop={8}>
          <Icon name="chevronLeft" size={22} color={colors.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>Add food</Text>
        <View style={styles.iconBtn} />
      </View>

      {/* Search */}
      <View style={styles.searchWrap}>
        <View style={styles.searchRow}>
          <Icon name="search" size={18} color={colors.mute} />
          <TextInput
            style={styles.input}
            value={q}
            onChangeText={setQ}
            placeholder="Search 1,000+ foods — dal, paneer, dosa…"
            placeholderTextColor={colors.faint}
            autoFocus
            autoCorrect={false}
            returnKeyType="search"
          />
          {q.length > 0 && (
            <Pressable onPress={() => setQ("")} hitSlop={8}>
              <Icon name="close" size={18} color={colors.mute} />
            </Pressable>
          )}
        </View>
      </View>

      {added && (
        <View style={styles.addedBanner}>
          <Icon name="check" size={15} color={colors.white} />
          <Text style={styles.addedText}>Added {added} to today</Text>
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      {/* Results */}
      <View style={styles.listWrap}>
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.green} />
          </View>
        ) : !searched ? (
          <View style={styles.center}>
            <Icon name="search" size={30} color={colors.faint} />
            <Text style={styles.hint}>
              Start typing to find a food. Calories come straight from our database — no guessing.
            </Text>
          </View>
        ) : results.length === 0 ? (
          <Text style={styles.empty}>
            No matches. Try a simpler name (e.g. “dal” instead of “yellow moong dal fry”).
          </Text>
        ) : (
          <FlatList
            data={results}
            keyExtractor={(it) => it.key}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 24 }}
            renderItem={({ item }) => (
              <Pressable style={styles.row} onPress={() => openPortion(item)}>
                <View style={styles.rowKcal}>
                  <Text style={styles.rowKcalNum}>{Math.round(item.kcal_per_unit)}</Text>
                  <Text style={styles.rowKcalUnit}>kcal</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowName}>{item.name}</Text>
                  <Text style={styles.rowSub}>
                    per {item.unit} · P {Math.round(item.protein_g_per_unit)}g · C{" "}
                    {Math.round(item.carbs_g_per_unit)}g · F {Math.round(item.fat_g_per_unit)}g
                  </Text>
                </View>
                <View style={styles.addCircle}>
                  <Icon name="plus" size={18} color={colors.white} />
                </View>
              </Pressable>
            )}
          />
        )}
      </View>

      {/* Portion picker (in-screen sheet) */}
      {selected && preview && (
        <View style={styles.sheetBackdrop}>
          <Pressable style={styles.sheetTap} onPress={() => setSelected(null)} />
          <View style={styles.sheet}>
            <View style={styles.grabber} />
            <Text style={styles.sheetTitle}>{selected.name}</Text>
            <Text style={styles.sheetSub}>
              {Math.round(selected.kcal_per_unit)} kcal per {selected.unit}
            </Text>

            <View style={styles.stepperRow}>
              <Text style={styles.stepperLabel}>Servings</Text>
              <View style={styles.stepper}>
                <Pressable
                  style={[styles.stepBtn, count <= 1 && styles.stepBtnOff]}
                  onPress={() => setCount((c) => Math.max(1, c - 1))}
                  hitSlop={6}
                >
                  <Icon name="minus" size={18} color={count <= 1 ? colors.faint : colors.ink} />
                </Pressable>
                <Text style={styles.stepCount}>{count}</Text>
                <Pressable
                  style={styles.stepBtn}
                  onPress={() => setCount((c) => Math.min(20, c + 1))}
                  hitSlop={6}
                >
                  <Icon name="plus" size={18} color={colors.ink} />
                </Pressable>
              </View>
            </View>

            <View style={styles.totalCard}>
              <View>
                <Text style={styles.totalKcal}>{preview.kcal}</Text>
                <Text style={styles.totalKcalLabel}>kcal total</Text>
              </View>
              <View style={styles.macroRow}>
                <MacroPill label="Protein" value={preview.protein_g} color={colors.protein} />
                <MacroPill label="Carbs" value={preview.carbs_g} color={colors.carbs} />
                <MacroPill label="Fat" value={preview.fat_g} color={colors.fat} />
              </View>
            </View>

            <Pressable style={styles.addBtn} onPress={confirmAdd}>
              <Icon name="check" size={18} color={colors.white} />
              <Text style={styles.addBtnText}>Add to today</Text>
            </Pressable>
          </View>
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingTop: Platform.OS === "web" ? 14 : 8,
    paddingBottom: 6,
  },
  iconBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  headerTitle: { ...T.h2, color: colors.ink },

  searchWrap: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 4 },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: colors.hairline,
    ...elevation.sm,
  },
  input: { flex: 1, fontSize: 15, fontWeight: "600", color: colors.ink, paddingVertical: 13 },

  addedBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    alignSelf: "center",
    backgroundColor: colors.green,
    borderRadius: radius.pill,
    paddingVertical: 8,
    paddingHorizontal: 16,
    marginTop: 8,
    ...elevation.sm,
  },
  addedText: { color: colors.white, fontWeight: "800", fontSize: 13 },

  error: { color: colors.red, fontSize: 12.5, marginTop: 10, paddingHorizontal: 16 },

  listWrap: { flex: 1, paddingHorizontal: 16, marginTop: 10 },
  center: { paddingTop: 48, alignItems: "center", gap: 12, paddingHorizontal: 24 },
  hint: { color: colors.mute, fontSize: 13.5, textAlign: "center", lineHeight: 20 },
  empty: {
    color: colors.mute,
    fontSize: 13,
    textAlign: "center",
    paddingTop: 40,
    lineHeight: 20,
    paddingHorizontal: 24,
  },

  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: 12,
    marginBottom: 8,
    ...elevation.sm,
  },
  rowKcal: {
    width: 52,
    height: 52,
    borderRadius: 14,
    backgroundColor: colors.greenTint,
    alignItems: "center",
    justifyContent: "center",
  },
  rowKcalNum: { color: colors.green, fontWeight: "900", fontSize: 16, letterSpacing: -0.3 },
  rowKcalUnit: { color: colors.green, fontWeight: "700", fontSize: 9.5, marginTop: -1 },
  rowName: { color: colors.ink, fontWeight: "800", fontSize: 15 },
  rowSub: { color: colors.mute, fontWeight: "600", fontSize: 11.5, marginTop: 3 },
  addCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.green,
    alignItems: "center",
    justifyContent: "center",
  },

  sheetBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "flex-end",
  },
  sheetTap: { flex: 1 },
  sheet: {
    backgroundColor: colors.bgElevated,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: Platform.OS === "ios" ? 34 : 22,
  },
  grabber: {
    alignSelf: "center",
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: "#CBD5D0",
    marginBottom: 14,
  },
  sheetTitle: { ...T.h2, color: colors.ink },
  sheetSub: { color: colors.mute, fontWeight: "600", fontSize: 13, marginTop: 2 },

  stepperRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 20,
  },
  stepperLabel: { ...T.title, color: colors.ink },
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    gap: 18,
    backgroundColor: colors.cardMuted,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  stepBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
    ...elevation.sm,
  },
  stepBtnOff: { opacity: 0.6 },
  stepCount: { ...T.h2, color: colors.ink, minWidth: 26, textAlign: "center" },

  totalCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.cardMuted,
    borderRadius: radius.lg,
    padding: 16,
    marginTop: 18,
  },
  totalKcal: { fontSize: 30, fontWeight: "900", color: colors.ink, letterSpacing: -0.6 },
  totalKcalLabel: { color: colors.mute, fontWeight: "700", fontSize: 12, marginTop: -2 },
  macroRow: { flexDirection: "row", gap: 14 },
  macroPill: { alignItems: "center", gap: 3 },
  macroDot: { width: 8, height: 8, borderRadius: 4 },
  macroVal: { color: colors.ink, fontWeight: "800", fontSize: 14 },
  macroLabel: { color: colors.mute, fontWeight: "600", fontSize: 10.5 },

  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.green,
    borderRadius: radius.md,
    paddingVertical: 16,
    marginTop: 20,
    ...elevation.md,
  },
  addBtnText: { color: colors.white, fontWeight: "800", fontSize: 16 },
});
