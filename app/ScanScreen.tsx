import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { useNavigation, useRoute } from "@react-navigation/native";
import {
  analyzeImage,
  AnalysisResult,
  FoodItem,
  FoodSuggestion,
  Pairing,
  PortionQuestion,
  getCombos,
  PaywallError,
  AuthRequiredError,
  submitScanCorrection,
} from "./api";
import { inferMealType, Meal, MEAL_TYPES, MEAL_TYPE_LABEL, MealType } from "./storage";
import { colors, radius, elevation, type as T } from "./theme";
import Icon from "./Icon";
import Screen from "./Screen";
import { ScanResultSkeleton } from "./Skeleton";
import { useApp } from "./AppContext";
import FoodSearchSheet from "./FoodSearchSheet";
import PortionPicker from "./PortionPicker";
import { goBackOrTabs } from "./nav";

// Builds a fresh, DB-anchored FoodItem when swapping in a corrected food or
// adding a suggested pairing. Mirrors HomeScreen's itemFromSuggestion so a
// swap here behaves identically to a swap on Home.
function itemFromSuggestion(s: FoodSuggestion, count = 1): FoodItem {
  const c = Math.max(1, count);
  return {
    key: s.key,
    item: s.name,
    count: c,
    unit: s.unit,
    countable: true,
    kcal_per_unit: s.kcal_per_unit,
    protein_g_per_unit: s.protein_g_per_unit,
    carbs_g_per_unit: s.carbs_g_per_unit,
    fat_g_per_unit: s.fat_g_per_unit,
    protein_g: Math.round(s.protein_g_per_unit * c),
    carbs_g: Math.round(s.carbs_g_per_unit * c),
    fat_g: Math.round(s.fat_g_per_unit * c),
    kcal_total: Math.round(s.kcal_per_unit * c),
    source: "db",
    health_score: s.health_score,
    benefits: s.benefits,
    watch_outs: s.watch_outs,
    // Verified DB micros, per-unit -- see mealMicros below for how this gets
    // scaled by the live count instead of trusting a stale total.
    micros_per_unit: s.micros,
    micros_source: s.micros ? "db" : undefined,
  };
}

function itemTotal(it: FoodItem): number {
  return Math.round(it.count * it.kcal_per_unit);
}

type RouteParams = { mode?: "camera" | "gallery" | "review"; presetResult?: AnalysisResult };

// Dedicated, full-screen scan flow: capture -> real network analysis -> fully
// editable itemized result -> add to today. Previously this lived as a card
// mixed into Home's scrolling dashboard; it's now its own pushed screen (like
// Cal AI / Healthify's scan flow) so the capture + review moment gets full
// focus instead of competing with the rest of Home for space.
export default function ScanScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute();
  const { mode, presetResult } = (route.params as RouteParams) ?? {};
  const { account, requireAuth, logMeal } = useApp();

  const [photo, setPhoto] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pairings, setPairings] = useState<Pairing[]>([]);
  const [swapIndex, setSwapIndex] = useState<number | null>(null);
  const [portionIndex, setPortionIndex] = useState<number | null>(null);
  const [added, setAdded] = useState(false);
  const captureBusy = useRef(false);
  // Cosmetic-only, cycling through the real steps the backend actually
  // performs (vision call -> DB match -> totals) so the wait feels
  // purposeful instead of a static spinner. Purely perceived-speed: the
  // underlying network call still takes the same 2-7s (see ai_provider.py),
  // this doesn't change that -- it just gives the user something to read
  // instead of staring at an unchanging "Analyzing..." label the whole time.
  const LOADING_STEPS = [
    "Looking at your plate…",
    "Identifying each item…",
    "Matching to the food database…",
    "Calculating calories & macros…",
  ];
  const [loadingStep, setLoadingStep] = useState(0);
  // Auto-guessed from the clock the moment the photo lands, but shown as a
  // row of tappable chips (not silently applied) since "morning snack" vs
  // "lunch" right at the boundary is exactly the kind of guess a real user
  // needs to be able to correct in one tap, not dig into a menu for.
  const [mealType, setMealType] = useState<MealType>(() => inferMealType(Date.now()));

  const isPro = !!account?.isPro;

  const capture = useCallback(
    async (fromCamera: boolean) => {
      if (captureBusy.current || loading) return;
      captureBusy.current = true;
      setError(null);
      if (!isPro && (account?.scansLeft ?? 0) <= 0) {
        navigation.navigate("Payment");
        captureBusy.current = false;
        return;
      }
      if (Platform.OS !== "web") {
        const perm = fromCamera
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
          setError("Permission denied for " + (fromCamera ? "camera" : "photos"));
          captureBusy.current = false;
          return;
        }
      }
      const pickerOptions = {
        quality: 0.4,
        allowsEditing: false,
        exif: false,
        base64: false,
      } as const;
      const res = fromCamera
        ? await ImagePicker.launchCameraAsync(pickerOptions)
        : await ImagePicker.launchImageLibraryAsync(pickerOptions);
      if (res.canceled || !res.assets?.length) {
        captureBusy.current = false;
        return;
      }
      const uri = res.assets[0].uri;
      setPhoto(uri);
      setResult(null);
      setPairings([]);
      setLoading(true);
      setLoadingStep(0);
      try {
        // Real network call to the backend's Gemini-backed /analyze -- this
        // spinner reflects actual analysis time (typically 2-6s), not a fake
        // delay. The same exact photo is now cached server-side, so retaking
        // this screen with the identical file returns identical numbers.
        // analyzeImage() itself silently retries a transient failure a
        // couple more times (see api.ts's withScanRetry) before this ever
        // throws, so the loading state above just keeps cycling through it.
        const data = await analyzeImage(uri);
        setResult(data);
        const names = data.items.map((it) => it.item).filter(Boolean);
        if (names.length) {
          getCombos(names)
            .then(setPairings)
            .catch(() => setPairings([]));
        }
      } catch (e: any) {
        if (e instanceof PaywallError) {
          navigation.navigate("Payment");
        } else if (e instanceof AuthRequiredError) {
          requireAuth();
        } else {
          setError(e?.message ?? "Couldn't analyze that photo. Please try again.");
        }
      } finally {
        setLoading(false);
        captureBusy.current = false;
      }
    },
    [account?.scansLeft, isPro, loading, requireAuth]
  );

  useEffect(() => {
    if (!loading) return;
    const id = setInterval(() => {
      setLoadingStep((s) => (s + 1) % LOADING_STEPS.length);
    }, 1300);
    return () => clearInterval(id);
  }, [loading]);

  useEffect(() => {
    if (!presetResult) return;
    setPhoto(null);
    setResult(presetResult);
    const names = presetResult.items.map((it) => it.item).filter(Boolean);
    if (names.length) {
      getCombos(names)
        .then(setPairings)
        .catch(() => setPairings([]));
    } else {
      setPairings([]);
    }
  }, [presetResult]);

  // Auto-launch the requested capture mode the moment this screen opens, so
  // tapping "Scan a meal" goes straight to the camera instead of landing on
  // an empty intermediate screen first.
  useEffect(() => {
    if (!account) {
      requireAuth();
      goBackOrTabs(navigation);
      return;
    }
    if (presetResult || mode === "review") return;
    void capture(mode !== "gallery");
    // Only ever run this once per screen mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function adjust(index: number, delta: number) {
    setResult((prev) => {
      if (!prev) return prev;
      const items = prev.items.map((it, i) => {
        if (i !== index) return it;
        const step = it.countable ? 1 : 0.5;
        const next = Math.max(step, Math.round((it.count + delta * step) * 2) / 2);
        return { ...it, count: next, kcal_total: Math.round(next * it.kcal_per_unit) };
      });
      return { ...prev, items };
    });
  }

  function setPortion(index: number, count: number) {
    setResult((prev) => {
      if (!prev) return prev;
      const items = prev.items.map((it, i) =>
        i === index ? { ...it, count, kcal_total: Math.round(count * it.kcal_per_unit) } : it
      );
      return { ...prev, items };
    });
    setPortionIndex(null);
  }

  // Clarifying-question answers (e.g. "how much ghee on the roti?", "what
  // size was the katori?") -- things a photo genuinely can't tell, prepared
  // server-side (see main.py's ANALYSIS_PROMPT "QUESTIONS" section). Each
  // question's baseline option is always factor 1.0 and already reflected in
  // the AI's initial estimate, so answering nothing changes nothing.
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!result?.questions?.length) return;
    const init: Record<string, number> = {};
    for (const q of result.questions) init[q.id] = q.default_index;
    setQuestionAnswers(init);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.questions]);

  function answerQuestion(q: PortionQuestion, optionIndex: number) {
    const prevIndex = questionAnswers[q.id] ?? q.default_index;
    const prevFactor = q.options[prevIndex]?.factor ?? 1;
    const nextFactor = q.options[optionIndex]?.factor ?? 1;
    const ratio = prevFactor > 0 ? nextFactor / prevFactor : nextFactor;
    setQuestionAnswers((s) => ({ ...s, [q.id]: optionIndex }));
    if (ratio === 1) return;
    setResult((prev) => {
      if (!prev || !prev.items[q.target_item]) return prev;
      const items = prev.items.map((it, idx) => {
        if (idx !== q.target_item) return it;
        const kcal_per_unit = it.kcal_per_unit * ratio;
        const protein_g_per_unit = it.protein_g_per_unit * ratio;
        const carbs_g_per_unit = it.carbs_g_per_unit * ratio;
        const fat_g_per_unit = it.fat_g_per_unit * ratio;
        const micros_per_unit = it.micros_per_unit
          ? Object.fromEntries(Object.entries(it.micros_per_unit).map(([k, v]) => [k, v * ratio]))
          : it.micros_per_unit;
        return {
          ...it,
          kcal_per_unit,
          protein_g_per_unit,
          carbs_g_per_unit,
          fat_g_per_unit,
          micros_per_unit,
          kcal_total: Math.round(it.count * kcal_per_unit),
          protein_g: Math.round(it.count * protein_g_per_unit),
          carbs_g: Math.round(it.count * carbs_g_per_unit),
          fat_g: Math.round(it.count * fat_g_per_unit),
        };
      });
      return { ...prev, items };
    });
  }

  function removeItem(index: number) {
    const before = result?.items[index];
    const scanResultId = result?.scan_result_id;
    setResult((prev) => (prev ? { ...prev, items: prev.items.filter((_, i) => i !== index) } : prev));
    if (scanResultId && before?.item) {
      void submitScanCorrection({
        scan_result_id: scanResultId,
        item_name: before.item,
        from_food_name: before.source === "db" ? before.item : undefined,
        note: "user_removed",
      });
    }
  }

  function applySwap(index: number, s: FoodSuggestion) {
    const before = result?.items[index];
    const scanResultId = result?.scan_result_id;
    setResult((prev) => {
      if (!prev) return prev;
      const items = prev.items.map((it, i) => (i === index ? itemFromSuggestion(s) : it));
      return { ...prev, items };
    });
    setSwapIndex(null);
    if (scanResultId && before?.item) {
      void submitScanCorrection({
        scan_result_id: scanResultId,
        item_name: before.item,
        from_food_name: before.source === "db" ? before.item : undefined,
        to_food_name: s.name,
        note: "user_swap",
      });
    }
  }

  function addPairing(p: Pairing) {
    setResult((prev) =>
      prev ? { ...prev, items: [...prev.items, itemFromSuggestion(p, p.count ?? 1)] } : prev
    );
    setPairings((cur) => cur.filter((x) => x.key !== p.key));
  }

  const mealTotal = useMemo(
    () => (result ? result.items.reduce((s, it) => s + itemTotal(it), 0) : 0),
    [result]
  );
  const mealMacros = useMemo(() => {
    if (!result) return { protein_g: 0, carbs_g: 0, fat_g: 0 };
    return result.items.reduce(
      (acc, it) => ({
        protein_g: acc.protein_g + it.count * it.protein_g_per_unit,
        carbs_g: acc.carbs_g + it.count * it.carbs_g_per_unit,
        fat_g: acc.fat_g + it.count * it.fat_g_per_unit,
      }),
      { protein_g: 0, carbs_g: 0, fat_g: 0 }
    );
  }, [result]);
  // Recomputed from the CURRENT items (post edit/swap/remove), not the
  // /analyze response's stale totals -- otherwise adjusting a portion or
  // swapping an ingredient would silently log the wrong micro panel.
  const mealMicros = useMemo(() => {
    if (!result) return { micros: undefined as Record<string, number> | undefined, estimated: false };
    const sums: Record<string, number> = {};
    let estimated = false;
    for (const it of result.items) {
      if (!it.micros_per_unit) continue;
      for (const [k, v] of Object.entries(it.micros_per_unit)) {
        sums[k] = (sums[k] ?? 0) + v * it.count;
      }
      if (it.micros_source === "ai_estimated") estimated = true;
    }
    return { micros: Object.keys(sums).length ? sums : undefined, estimated };
  }, [result]);

  function confirmAdd() {
    if (!result) return;
    const meal: Meal = {
      dish: result.dish,
      kcal: mealTotal,
      protein_g: Math.round(mealMacros.protein_g),
      carbs_g: Math.round(mealMacros.carbs_g),
      fat_g: Math.round(mealMacros.fat_g),
      at: Date.now(),
      mealType,
      photoPath: result.photo_path,
      photoUrl: result.photo_url,
      // Real per-meal micro panel, recomputed from the current (possibly
      // edited) items -- verified DB data, or the vision model's own
      // estimate for unmatched items (see FoodItem.micros_source).
      micros: mealMicros.micros,
      microsEstimated: mealMicros.estimated,
      foodItems: result.items.map((it) => ({
        key: it.key,
        item: it.item,
        count: it.count,
        unit: it.unit,
        source: it.source,
        kcal_per_unit: it.kcal_per_unit,
        protein_g_per_unit: it.protein_g_per_unit,
        carbs_g_per_unit: it.carbs_g_per_unit,
        fat_g_per_unit: it.fat_g_per_unit,
        fiber_g_per_unit: it.fiber_g_per_unit,
        sugar_g_per_unit: it.sugar_g_per_unit,
        sodium_mg_per_unit: it.sodium_mg_per_unit,
        potassium_mg_per_unit: it.potassium_mg_per_unit,
        calcium_mg_per_unit: it.calcium_mg_per_unit,
        iron_mg_per_unit: it.iron_mg_per_unit,
        kcal_total: it.kcal_total,
        protein_g: it.protein_g,
        carbs_g: it.carbs_g,
        fat_g: it.fat_g,
        micros: it.micros,
        micros_source: it.micros_source,
        micros_per_unit: it.micros_per_unit,
      })),
    };
    logMeal(meal);
    setAdded(true);
    setTimeout(() => goBackOrTabs(navigation), 900);
  }

  return (
    <Screen edgeTop background={colors.bg}>
      <View style={styles.header}>
        <Pressable style={styles.iconBtn} onPress={() => goBackOrTabs(navigation)} hitSlop={8}>
          <Icon name="chevronLeft" size={22} color={colors.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>{mode === "review" ? "Review meal" : "Scan meal"}</Text>
        <Pressable
          style={styles.iconBtn}
          onPress={() => void capture(mode !== "gallery")}
          hitSlop={8}
          disabled={loading || mode === "review"}
        >
          <Icon name="camera" size={20} color={loading || mode === "review" ? colors.faint : colors.ink} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        {photo && <Image source={{ uri: photo }} style={styles.preview} />}

        {loading && (
          <>
            {/* Optimistic UI: the result card's shape appears immediately
                (skeleton) instead of a blank blocking spinner, so the screen
                looks "already working" from frame one. The tiny status line
                below is the only thing that changes while the real AI call
                (2-6s) runs underneath. */}
            <View style={styles.centerCompact}>
              <ActivityIndicator size="small" color={colors.green} />
              <Text style={styles.mutedSmall}>{LOADING_STEPS[loadingStep]}</Text>
            </View>
            <ScanResultSkeleton />
          </>
        )}

        {error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
            {mode !== "review" && (
              <Pressable style={styles.retryBtn} onPress={() => void capture(mode !== "gallery")}>
              <Text style={styles.retryText}>Try again</Text>
              </Pressable>
            )}
          </View>
        )}

        {added && (
          <View style={styles.addedBanner}>
            <Icon name="check" size={16} color={colors.white} />
            <Text style={styles.addedText}>Added to today</Text>
          </View>
        )}

        {result && !loading && (
          <View style={styles.resultCard}>
            <Text style={styles.dish}>{result.dish}</Text>
            <Text style={styles.cuisine}>{result.cuisine}</Text>
            <Text style={styles.hint}>Every field below is editable — fix anything the AI got wrong.</Text>

            <Text style={styles.mealTypeLabel}>Logging as</Text>
            <View style={styles.mealTypeRow}>
              {MEAL_TYPES.map((mt) => (
                <Pressable
                  key={mt}
                  style={[styles.mealTypeChip, mealType === mt && styles.mealTypeChipActive]}
                  onPress={() => setMealType(mt)}
                >
                  <Text style={[styles.mealTypeChipText, mealType === mt && styles.mealTypeChipTextActive]}>
                    {MEAL_TYPE_LABEL[mt]}
                  </Text>
                </Pressable>
              ))}
            </View>

            {result.items.map((it, i) => (
              <View key={i} style={styles.itemCard}>
                <View style={styles.itemRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.itemName}>{it.item}</Text>
                    <Text style={styles.itemSub}>
                      {Math.round(it.kcal_per_unit)} kcal / {it.unit}
                      {it.countable ? "" : "  (size)"}
                    </Text>
                    <Text style={styles.itemMacros}>
                      P {Math.round(it.protein_g_per_unit)}g · C{" "}
                      {Math.round(it.carbs_g_per_unit)}g · F{" "}
                      {Math.round(it.fat_g_per_unit)}g <Text style={styles.itemMacrosUnit}>per {it.unit}</Text>
                    </Text>
                    <View style={styles.itemActions}>
                      <Pressable onPress={() => setSwapIndex(i)} style={styles.swapLink}>
                        <Icon name="swap" size={12} color={colors.green} />
                        <Text style={styles.swapLinkText}>Not right? Swap</Text>
                      </Pressable>
                      <Pressable onPress={() => setPortionIndex(i)} style={styles.swapLink}>
                        <Icon name="scale" size={12} color={colors.green} />
                        <Text style={styles.swapLinkText}>Portion size</Text>
                      </Pressable>
                      <Pressable onPress={() => removeItem(i)} style={styles.removeLink} hitSlop={6}>
                        <Icon name="close" size={12} color={colors.mute} />
                        <Text style={styles.removeLinkText}>Remove</Text>
                      </Pressable>
                    </View>
                  </View>
                  <View style={styles.stepper}>
                    <Pressable style={styles.stepBtn} onPress={() => adjust(i, -1)}>
                      <Icon name="minus" size={16} color={colors.green} />
                    </Pressable>
                    <Pressable onPress={() => setPortionIndex(i)}>
                      <Text style={styles.count}>{it.count}</Text>
                    </Pressable>
                    <Pressable style={styles.stepBtn} onPress={() => adjust(i, 1)}>
                      <Icon name="plus" size={16} color={colors.green} />
                    </Pressable>
                  </View>
                  <Text style={styles.itemKcal}>{itemTotal(it)}</Text>
                </View>
              </View>
            ))}

            {result.questions && result.questions.filter((q) => result.items[q.target_item]).length > 0 && (
              <View style={styles.questionsBlock}>
                <Text style={styles.pairTitle}>Help us get this right</Text>
                {result.questions
                  .filter((q) => result.items[q.target_item])
                  .map((q) => (
                    <View key={q.id} style={styles.questionRow}>
                      <Text style={styles.questionPrompt}>
                        {q.prompt} <Text style={styles.questionTarget}>({result.items[q.target_item].item})</Text>
                      </Text>
                      <View style={styles.mealTypeRow}>
                        {q.options.map((opt, oi) => {
                          const active = (questionAnswers[q.id] ?? q.default_index) === oi;
                          return (
                            <Pressable
                              key={oi}
                              style={[styles.mealTypeChip, active && styles.mealTypeChipActive]}
                              onPress={() => answerQuestion(q, oi)}
                            >
                              <Text style={[styles.mealTypeChipText, active && styles.mealTypeChipTextActive]}>
                                {opt.label}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </View>
                    </View>
                  ))}
              </View>
            )}

            {pairings.length > 0 && (
              <View style={styles.pairBlock}>
                <Text style={styles.pairTitle}>Goes well with</Text>
                <View style={styles.pairRow}>
                  {pairings.map((p) => (
                    <Pressable key={p.key} style={styles.pairChip} onPress={() => addPairing(p)}>
                      <Icon name="plus" size={12} color={colors.green} />
                      <Text style={styles.pairChipText}>{p.name}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            )}

            <View style={styles.totalRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.totalLabel}>Meal total</Text>
                <Text style={styles.itemMacros}>
                  P {Math.round(mealMacros.protein_g)}g · C {Math.round(mealMacros.carbs_g)}g · F{" "}
                  {Math.round(mealMacros.fat_g)}g
                </Text>
              </View>
              <Text style={styles.totalKcal}>{mealTotal} kcal</Text>
            </View>

            <Pressable style={styles.addBtn} onPress={confirmAdd}>
              <Icon name="check" size={18} color={colors.white} />
              <Text style={styles.addBtnText}>Add to today</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>

      {swapIndex !== null && (
        <FoodSearchSheet
          visible={swapIndex !== null}
          replacing={result?.items[swapIndex]?.item ?? null}
          onClose={() => setSwapIndex(null)}
          onPick={(food) => applySwap(swapIndex, food)}
          onRequireAuth={requireAuth}
        />
      )}

      <PortionPicker
        visible={portionIndex !== null}
        item={portionIndex !== null ? result?.items[portionIndex] ?? null : null}
        onClose={() => setPortionIndex(null)}
        onApply={(count) => portionIndex !== null && setPortion(portionIndex, count)}
      />
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

  preview: { width: "100%", height: 220, borderRadius: radius.lg, marginBottom: 16, backgroundColor: colors.cardMuted },
  center: { alignItems: "center", paddingVertical: 32, gap: 8 },
  centerCompact: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingTop: 16 },
  muted: { color: colors.mute, fontWeight: "700", fontSize: 14 },
  mutedSmall: { color: colors.faint, fontWeight: "600", fontSize: 12 },

  errorBox: { backgroundColor: colors.redTint, borderRadius: radius.md, padding: 16, marginBottom: 12 },
  errorText: { color: colors.red, fontWeight: "700", fontSize: 13.5, lineHeight: 19 },
  retryBtn: { alignSelf: "flex-start", marginTop: 10 },
  retryText: { color: colors.green, fontWeight: "800", fontSize: 13 },

  addedBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    alignSelf: "center",
    backgroundColor: colors.green,
    borderRadius: radius.pill,
    paddingVertical: 8,
    paddingHorizontal: 16,
    marginBottom: 12,
    ...elevation.sm,
  },
  addedText: { color: colors.white, fontWeight: "800", fontSize: 13 },

  resultCard: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, ...elevation.sm },
  dish: { ...T.h2, color: colors.ink },
  cuisine: { color: colors.mute, fontWeight: "600", fontSize: 13, marginTop: 2 },
  hint: { color: colors.mute, fontSize: 12.5, marginTop: 8, marginBottom: 14, lineHeight: 18 },
  mealTypeLabel: { color: colors.mute, fontWeight: "700", fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 8 },
  mealTypeRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 16 },
  mealTypeChip: { backgroundColor: colors.cardMuted, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 7 },
  mealTypeChipActive: { backgroundColor: colors.green },
  mealTypeChipText: { color: colors.mute, fontWeight: "700", fontSize: 12 },
  mealTypeChipTextActive: { color: colors.white },

  itemCard: { backgroundColor: colors.cardMuted, borderRadius: radius.md, padding: 12, marginBottom: 10 },
  itemRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  itemName: { color: colors.ink, fontWeight: "800", fontSize: 15 },
  itemSub: { color: colors.mute, fontWeight: "600", fontSize: 11.5, marginTop: 2 },
  itemMacros: { color: colors.mute, fontWeight: "600", fontSize: 11, marginTop: 3 },
  itemMacrosUnit: { color: colors.faint, fontWeight: "500" },
  itemActions: { flexDirection: "row", gap: 14, marginTop: 8, flexWrap: "wrap" },
  swapLink: { flexDirection: "row", alignItems: "center", gap: 4 },
  swapLinkText: { color: colors.green, fontSize: 11.5, fontWeight: "800", textDecorationLine: "underline" },
  removeLink: { flexDirection: "row", alignItems: "center", gap: 4 },
  removeLinkText: { color: colors.mute, fontSize: 11.5, fontWeight: "700" },

  stepper: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.card,
    borderRadius: radius.pill,
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  stepBtn: { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  count: { color: colors.ink, fontWeight: "800", fontSize: 14, minWidth: 20, textAlign: "center" },
  itemKcal: { color: colors.ink, fontWeight: "900", fontSize: 15, minWidth: 44, textAlign: "right" },

  pairBlock: { marginTop: 6, marginBottom: 8 },
  pairTitle: { color: colors.ink, fontWeight: "800", fontSize: 13, marginBottom: 8 },
  questionsBlock: { marginTop: 6, marginBottom: 8 },
  questionRow: { marginBottom: 12 },
  questionPrompt: { color: colors.ink, fontWeight: "700", fontSize: 12.5, marginBottom: 8, lineHeight: 17 },
  questionTarget: { color: colors.mute, fontWeight: "500" },
  pairRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  pairChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.greenTint,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  pairChipText: { color: colors.green, fontWeight: "700", fontSize: 12.5 },

  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingTop: 14,
    marginTop: 4,
  },
  totalLabel: { color: colors.mute, fontWeight: "700", fontSize: 13 },
  totalKcal: { color: colors.ink, fontWeight: "900", fontSize: 20 },

  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.green,
    borderRadius: radius.md,
    paddingVertical: 16,
    marginTop: 16,
    ...elevation.md,
  },
  addBtnText: { color: colors.white, fontWeight: "800", fontSize: 16 },
});
