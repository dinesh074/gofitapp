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
import { useNavigation, useRoute } from "@react-navigation/native";
import {
  FoodSuggestion,
  searchFoods,
  AuthRequiredError,
  saveRecipeTemplate,
  analyzeText,
  PaywallError,
  searchRecipeTemplates,
  getRecipeTemplate,
  RecipeTemplateSummary,
} from "./api";
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

type PlannedDishItem = { food: FoodSuggestion; count: number };
type ScreenParams = { mode?: "template" | "search" };

function mealFromDishPlan(name: string, rows: PlannedDishItem[]): Meal {
  const totals = rows.reduce(
    (acc, row) => {
      acc.kcal += row.food.kcal_per_unit * row.count;
      acc.protein_g += row.food.protein_g_per_unit * row.count;
      acc.carbs_g += row.food.carbs_g_per_unit * row.count;
      acc.fat_g += row.food.fat_g_per_unit * row.count;
      if (row.food.micros) {
        for (const [k, v] of Object.entries(row.food.micros)) {
          acc.micros[k] = (acc.micros[k] || 0) + v * row.count;
        }
      }
      return acc;
    },
    { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, micros: {} as Record<string, number> }
  );
  const dish = name.trim() || "Planned dish";
  return {
    dish,
    kcal: Math.round(totals.kcal),
    protein_g: Math.round(totals.protein_g),
    carbs_g: Math.round(totals.carbs_g),
    fat_g: Math.round(totals.fat_g),
    at: Date.now(),
    micros: Object.keys(totals.micros).length > 0 ? totals.micros : undefined,
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
  const route = useRoute<any>();
  const { logMeal, requireAuth } = useApp();
  const openTemplateMode = (((route.params ?? {}) as ScreenParams).mode || "search") === "template";

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
  const [dishName, setDishName] = useState("");
  const [dishItems, setDishItems] = useState<PlannedDishItem[]>([]);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateMsg, setTemplateMsg] = useState<string | null>(null);
  const [estimateLoading, setEstimateLoading] = useState(false);
  const [estimatedMeal, setEstimatedMeal] = useState<Meal | null>(null);
  const lastEstimateQuery = useRef("");
  const [templateQ, setTemplateQ] = useState("");
  const [templateLoading, setTemplateLoading] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [templateResults, setTemplateResults] = useState<RecipeTemplateSummary[]>([]);

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
  const plannedPreview = useMemo(
    () => (dishItems.length > 0 ? mealFromDishPlan(dishName, dishItems) : null),
    [dishName, dishItems]
  );

  useEffect(() => {
    const query = q.trim();
    if (!searched || loading || results.length > 0 || query.length < 2) {
      setEstimateLoading(false);
      if (results.length > 0 || query.length < 2) setEstimatedMeal(null);
      return;
    }
    if (lastEstimateQuery.current === query) return;
    lastEstimateQuery.current = query;
    let alive = true;
    setEstimateLoading(true);
    setEstimatedMeal(null);
    analyzeText(query)
      .then((res) => {
        if (!alive) return;
        const t = res.totals;
        setEstimatedMeal({
          dish: (res.dish || query).trim() || query,
          kcal: Math.round(t?.kcal ?? res.calories_kcal ?? 0),
          protein_g: Math.round(t?.protein_g ?? 0),
          carbs_g: Math.round(t?.carbs_g ?? 0),
          fat_g: Math.round(t?.fat_g ?? 0),
          at: Date.now(),
          micros: t?.micros,
          microsEstimated: !!t?.micros_estimated,
        });
      })
      .catch((e: any) => {
        if (!alive) return;
        if (e instanceof AuthRequiredError) {
          requireAuth();
          goBackOrTabs(navigation);
          return;
        }
        if (e instanceof PaywallError) {
          setError("AI estimate needs Pro scans. Upgrade to estimate foods not in the DB.");
          return;
        }
        const msg = String(e?.message || "");
        if (msg.toLowerCase().includes("can't reach the server")) {
          setError("Network issue while estimating nutrition. Please check your connection and try again.");
          return;
        }
        setError(msg || "Couldn't estimate nutrition right now.");
      })
      .finally(() => {
        if (alive) setEstimateLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [q, searched, loading, results, requireAuth, navigation]);

  useEffect(() => {
    const query = templateQ.trim();
    if (query.length < 2) {
      setTemplateResults([]);
      setTemplateError(null);
      setTemplateLoading(false);
      return;
    }
    let alive = true;
    setTemplateLoading(true);
    setTemplateError(null);
    const t = setTimeout(() => {
      searchRecipeTemplates(query, 10)
        .then((rows) => {
          if (!alive) return;
          setTemplateResults(rows);
        })
        .catch((e: any) => {
          if (!alive) return;
          if (e instanceof AuthRequiredError) {
            requireAuth();
            goBackOrTabs(navigation);
            return;
          }
          setTemplateError(e?.message || "Couldn't load templates right now.");
        })
        .finally(() => {
          if (alive) setTemplateLoading(false);
        });
    }, 260);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [templateQ, requireAuth, navigation]);

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

  function addToDishPlan() {
    if (!selected) return;
    const addedName = selected.name;
    setDishItems((prev) => {
      const idx = prev.findIndex((row) => row.food.key === selected.key);
      if (idx === -1) return [...prev, { food: selected, count }];
      const next = [...prev];
      next[idx] = { ...next[idx], count: Math.min(40, next[idx].count + count) };
      return next;
    });
    setTemplateMsg(`Added ${addedName} to dish plan.`);
    setTimeout(() => setTemplateMsg((cur) => (cur === `Added ${addedName} to dish plan.` ? null : cur)), 1600);
    setSelected(null);
  }

  function removeFromDishPlan(foodKey: string) {
    setDishItems((prev) => prev.filter((row) => row.food.key !== foodKey));
  }

  function logDishPlan() {
    if (!plannedPreview || dishItems.length === 0) return;
    logMeal(plannedPreview);
    setAdded(plannedPreview.dish);
    setDishItems([]);
    setDishName("");
    setTimeout(() => setAdded((cur) => (cur === plannedPreview.dish ? null : cur)), 1800);
  }

  function addEstimatedMeal() {
    if (!estimatedMeal) return;
    logMeal(estimatedMeal);
    setAdded(estimatedMeal.dish);
    setTimeout(() => setAdded((cur) => (cur === estimatedMeal.dish ? null : cur)), 1800);
  }

  function makeRecipeCode(name: string): string {
    const base = (name || "planned_dish")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "planned_dish";
    const suffix = Date.now().toString(36).slice(-6);
    return `${base}_${suffix}`;
  }

  async function saveDishTemplate() {
    if (dishItems.length === 0) return;
    setSavingTemplate(true);
    setTemplateMsg(null);
    try {
      const name = dishName.trim() || "Planned dish";
      await saveRecipeTemplate({
        recipe_code: makeRecipeCode(name),
        name,
        servings: 1,
        ingredients: dishItems.map((row) => ({
          food_key: row.food.key,
          quantity: row.count,
          quantity_unit: row.food.unit || "serving",
        })),
      });
      setTemplateMsg("Saved as dish template.");
      setTimeout(() => setTemplateMsg((cur) => (cur === "Saved as dish template." ? null : cur)), 1800);
    } catch (e: any) {
      if (e instanceof AuthRequiredError) {
        requireAuth();
        goBackOrTabs(navigation);
        return;
      }
      setTemplateMsg(e?.message || "Couldn't save template right now.");
    } finally {
      setSavingTemplate(false);
    }
  }

  async function applyTemplate(row: RecipeTemplateSummary) {
    setTemplateError(null);
    setTemplateLoading(true);
    try {
      const data = await getRecipeTemplate(row.id);
      const loaded = (data.estimate?.items ?? [])
        .filter((it) => typeof it.count === "number" && it.count > 0)
        .map((it) => {
          const c = Math.max(0.1, Number(it.count || 1));
          const per = {
            kcal: Number(it.kcal || 0) / c,
            protein_g: Number(it.protein_g || 0) / c,
            carbs_g: Number(it.carbs_g || 0) / c,
            fat_g: Number(it.fat_g || 0) / c,
          };
          return {
            food: {
              key: it.food_key || it.name.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
              name: it.name,
              unit: it.unit || "serving",
              kcal_per_unit: per.kcal,
              protein_g_per_unit: per.protein_g,
              carbs_g_per_unit: per.carbs_g,
              fat_g_per_unit: per.fat_g,
            } as FoodSuggestion,
            count: c,
          } as PlannedDishItem;
        });
      setDishItems(loaded);
      setDishName(data.recipe?.name || row.name || "Planned dish");
      setTemplateMsg(`Loaded template: ${row.name}`);
    } catch (e: any) {
      if (e instanceof AuthRequiredError) {
        requireAuth();
        goBackOrTabs(navigation);
        return;
      }
      setTemplateError(e?.message || "Couldn't apply that template.");
    } finally {
      setTemplateLoading(false);
    }
  }

  return (
    <Screen edgeTop background={colors.bg}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable style={styles.iconBtn} onPress={() => goBackOrTabs(navigation)} hitSlop={8}>
          <Icon name="chevronLeft" size={22} color={colors.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>{openTemplateMode ? "Add from template" : "Manual search"}</Text>
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
            autoFocus={!openTemplateMode}
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

      {openTemplateMode && (
        <View style={styles.templateCard}>
          <View style={styles.templateHead}>
            <Icon name="nutrition" size={14} color={colors.green} />
            <Text style={styles.templateHeadText}>Add from template</Text>
          </View>
          <TextInput
            style={styles.templateInput}
            value={templateQ}
            onChangeText={setTemplateQ}
            placeholder="Search saved templates"
            placeholderTextColor={colors.faint}
            autoFocus={openTemplateMode}
          />
          {templateLoading ? (
            <View style={styles.templateLoadingRow}>
              <ActivityIndicator size="small" color={colors.green} />
              <Text style={styles.templateHint}>Loading templates…</Text>
            </View>
          ) : templateQ.trim().length >= 2 && templateResults.length === 0 ? (
            <Text style={styles.templateHint}>No template matches yet.</Text>
          ) : null}
          {templateResults.map((row) => (
            <Pressable key={row.id} style={styles.templateRow} onPress={() => void applyTemplate(row)}>
              <View style={{ flex: 1 }}>
                <Text style={styles.templateRowTitle}>{row.name}</Text>
                <Text style={styles.templateRowSub}>{row.recipe_code}</Text>
              </View>
              <Icon name="chevronRight" size={14} color={colors.mute} />
            </Pressable>
          ))}
          {!!templateError && <Text style={styles.templateErr}>{templateError}</Text>}
        </View>
      )}

      <View style={styles.planCard}>
        <View style={styles.planHead}>
          <Icon name="sparkles" size={14} color={colors.green} />
          <Text style={styles.planHeadText}>Plan a dish</Text>
        </View>
        <TextInput
          style={styles.planNameInput}
          value={dishName}
          onChangeText={setDishName}
          placeholder="Dish name (optional)"
          placeholderTextColor={colors.faint}
        />
        {dishItems.length === 0 ? (
          <Text style={styles.planEmpty}>Pick items from search results, then add them here to build one dish.</Text>
        ) : (
          <>
            {dishItems.map((row) => (
              <View key={row.food.key} style={styles.planItemRow}>
                <Text style={styles.planItemText}>
                  {row.food.name} ×{row.count}
                </Text>
                <Pressable onPress={() => removeFromDishPlan(row.food.key)} hitSlop={8}>
                  <Icon name="close" size={16} color={colors.mute} />
                </Pressable>
              </View>
            ))}
            {!!plannedPreview && (
              <Text style={styles.planTotals}>
                ~{plannedPreview.kcal} kcal · P {plannedPreview.protein_g}g · C {plannedPreview.carbs_g}g · F {plannedPreview.fat_g}g
              </Text>
            )}
            <Pressable style={styles.planLogBtn} onPress={logDishPlan}>
              <Icon name="check" size={16} color={colors.white} />
              <Text style={styles.planLogBtnText}>Add planned dish</Text>
            </Pressable>
            <Pressable style={[styles.planSaveBtn, savingTemplate && styles.planSaveBtnBusy]} onPress={saveDishTemplate} disabled={savingTemplate}>
              {savingTemplate ? <ActivityIndicator size="small" color={colors.green} /> : <Icon name="plus" size={16} color={colors.green} />}
              <Text style={styles.planSaveBtnText}>{savingTemplate ? "Saving…" : "Save as template"}</Text>
            </Pressable>
            {!!templateMsg && <Text style={styles.planMsg}>{templateMsg}</Text>}
          </>
        )}
      </View>

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
          <View style={styles.emptyWrap}>
            <Text style={styles.empty}>
              No direct DB match. Pulling an automatic nutrition estimate now.
            </Text>
            {estimateLoading ? (
              <View style={styles.centerEstimate}>
                <ActivityIndicator color={colors.green} />
                <Text style={styles.estimateHint}>Estimating nutrients…</Text>
              </View>
            ) : estimatedMeal ? (
              <View style={styles.estimateCard}>
                <Text style={styles.estimateTitle}>{estimatedMeal.dish}</Text>
                <Text style={styles.estimateMeta}>
                  ~{estimatedMeal.kcal} kcal · P {estimatedMeal.protein_g}g · C {estimatedMeal.carbs_g}g · F {estimatedMeal.fat_g}g
                </Text>
                <Pressable style={styles.estimateAddBtn} onPress={addEstimatedMeal}>
                  <Icon name="plus" size={15} color={colors.white} />
                  <Text style={styles.estimateAddText}>Add estimated meal</Text>
                </Pressable>
              </View>
            ) : (
              <Text style={styles.estimateHint}>Couldn't estimate this right now. Try another query.</Text>
            )}
          </View>
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
                <Pressable
                  style={styles.addCircle}
                  hitSlop={8}
                  onPress={(e) => {
                    e.stopPropagation();
                    const food = item;
                    setDishItems((prev) => {
                      const idx = prev.findIndex((row) => row.food.key === food.key);
                      if (idx === -1) return [...prev, { food, count: 1 }];
                      const next = [...prev];
                      next[idx] = { ...next[idx], count: Math.min(40, next[idx].count + 1) };
                      return next;
                    });
                    setTemplateMsg(`Added ${food.name} to dish plan.`);
                    setTimeout(() => setTemplateMsg((cur) => (cur === `Added ${food.name} to dish plan.` ? null : cur)), 1600);
                  }}
                >
                  <Icon name="plus" size={18} color={colors.white} />
                </Pressable>
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
              <Text style={styles.addBtnText}>Log this item now</Text>
            </Pressable>
            <Pressable style={styles.addToPlanBtn} onPress={addToDishPlan}>
              <Icon name="plus" size={18} color={colors.green} />
              <Text style={styles.addToPlanBtnText}>Add item to dish plan</Text>
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
  templateCard: {
    marginHorizontal: 16,
    marginTop: 10,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.hairline,
    padding: 12,
    gap: 8,
    ...elevation.sm,
  },
  templateHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  templateHeadText: { color: colors.ink, fontSize: 13.5, fontWeight: "800" },
  templateInput: {
    backgroundColor: colors.cardMuted,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.hairline,
    color: colors.ink,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 13.5,
    fontWeight: "600",
  },
  templateLoadingRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  templateHint: { color: colors.mute, fontSize: 12, fontWeight: "600" },
  templateRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    backgroundColor: colors.cardMuted,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  templateRowTitle: { color: colors.ink, fontSize: 12.5, fontWeight: "700" },
  templateRowSub: { color: colors.mute, fontSize: 11, fontWeight: "600", marginTop: 1 },
  templateErr: { color: colors.red, fontSize: 12, fontWeight: "700" },
  planCard: {
    marginHorizontal: 16,
    marginTop: 10,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.hairline,
    padding: 12,
    gap: 8,
    ...elevation.sm,
  },
  planHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  planHeadText: { color: colors.ink, fontSize: 13.5, fontWeight: "800" },
  planNameInput: {
    backgroundColor: colors.cardMuted,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.hairline,
    color: colors.ink,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 13.5,
    fontWeight: "600",
  },
  planEmpty: { color: colors.mute, fontSize: 12.5, fontWeight: "600", lineHeight: 18 },
  planItemRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.cardMuted,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  planItemText: { color: colors.ink, fontSize: 12.5, fontWeight: "700", flex: 1, paddingRight: 8 },
  planTotals: { color: colors.mute, fontSize: 12, fontWeight: "700" },
  planLogBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    backgroundColor: colors.green,
    borderRadius: 10,
    paddingVertical: 10,
  },
  planLogBtnText: { color: colors.white, fontSize: 13.5, fontWeight: "800" },
  planSaveBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    backgroundColor: colors.greenTint,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.green,
    paddingVertical: 9,
  },
  planSaveBtnBusy: { opacity: 0.7 },
  planSaveBtnText: { color: colors.green, fontSize: 13, fontWeight: "800" },
  planMsg: { color: colors.mute, fontSize: 12, fontWeight: "700", textAlign: "center" },

  error: { color: colors.red, fontSize: 12.5, marginTop: 10, paddingHorizontal: 16 },

  listWrap: { flex: 1, paddingHorizontal: 16, marginTop: 10 },
  center: { paddingTop: 48, alignItems: "center", gap: 12, paddingHorizontal: 24 },
  hint: { color: colors.mute, fontSize: 13.5, textAlign: "center", lineHeight: 20 },
  empty: {
    color: colors.mute,
    fontSize: 13,
    textAlign: "center",
    lineHeight: 20,
    paddingHorizontal: 24,
  },
  emptyWrap: { alignItems: "center", gap: 10, paddingTop: 40, paddingHorizontal: 12 },
  centerEstimate: { alignItems: "center", gap: 8 },
  estimateHint: { color: colors.mute, fontSize: 12.5, fontWeight: "600", textAlign: "center" },
  estimateCard: {
    width: "100%",
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.hairline,
    padding: 12,
    gap: 6,
    ...elevation.sm,
  },
  estimateTitle: { color: colors.ink, fontSize: 14, fontWeight: "800" },
  estimateMeta: { color: colors.mute, fontSize: 12, fontWeight: "700" },
  estimateAddBtn: {
    marginTop: 2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    backgroundColor: colors.green,
    borderRadius: 10,
    paddingVertical: 10,
  },
  estimateAddText: { color: colors.white, fontSize: 13, fontWeight: "800" },

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
  addToPlanBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.greenTint,
    borderRadius: radius.md,
    paddingVertical: 14,
    marginTop: 10,
    borderWidth: 1,
    borderColor: colors.green,
  },
  addToPlanBtnText: { color: colors.green, fontWeight: "800", fontSize: 15 },
});
