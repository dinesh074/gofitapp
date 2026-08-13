import React, { useEffect, useMemo, useRef, useState } from "react";
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
import { analyzeImage, AnalysisResult, FoodItem, FoodSuggestion, PortionQuestion, PaywallError, AuthRequiredError, addServerLog, getWater, addWater as apiAddWater, getHabits, setHabit as apiSetHabit } from "./api";
import DescribeMeal from "./DescribeMeal";
import BarcodeScanner from "./BarcodeScanner";
import ShareSheet from "./ShareSheet";
import AddFoodSheet from "./AddFoodSheet";
import FoodSearchSheet from "./FoodSearchSheet";
import { APP_NAME, APP_TAGLINE } from "./config";
import { computeStepGoal, computeWaterGoalMl, GoalTargets, Profile } from "./nutrition";
import {
  dayMacros,
  dayTotal,
  LogMap,
  Meal,
  saveLogs,
  todayKey,
  loadWater,
  saveWater,
  loadHabits,
  saveHabits,
  WaterMap,
  HabitMap,
  WATER_GLASS_ML,
  prettyDate,
  SavedMeal,
  loadRecents,
  recordRecentMeal,
  toggleFavoriteMeal,
} from "./storage";
import { colors, radius, shadow, type as T, gradients, elevation } from "./theme";
import { LinearGradient } from "expo-linear-gradient";
import Icon from "./Icon";
import CalorieRing from "./CalorieRing";
import { suggestNextMeal } from "./mealSuggest";
import {
  loadPortionMemory,
  rememberPortions,
  applyPortionMemory,
  forgetPortion,
  PortionMemory,
} from "./corrections";
import MonthStreak from "./MonthStreak";
import NutritionDetails from "./NutritionDetails";
import Paywall from "./Paywall";
import PressableScale from "./PressableScale";
import { Account } from "./auth";

type Props = {
  profile: Profile;
  goal: GoalTargets;
  logs: LogMap;
  setLogs: React.Dispatch<React.SetStateAction<LogMap>>;
  streak: number;
  account: Account | null;
  onRequireAuth: () => void;
  onAccountUpdate: (account: Account) => void;
  // Bumped by the TabBar's center camera button (see App.tsx) -- opens the
  // camera immediately even if you tapped it from a different tab.
  scanTrigger?: number;
};

function itemTotal(it: FoodItem): number {
  return Math.round(it.count * it.kcal_per_unit);
}

// Builds a fresh FoodItem from a food-DB search result when the user swaps a
// mis-identified ingredient. Count resets to 1 serving (the user tweaks it
// with the +/- stepper); micronutrients scale with count like anchor_items.
function itemFromSuggestion(s: FoodSuggestion, count = 1): FoodItem {
  const c = Math.max(1, Math.round(count));
  const scale = (v?: number) => (v == null ? undefined : Math.round(v * c * 10) / 10);
  const item: FoodItem = {
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
  };
  if (s.health_score !== undefined) item.health_score = s.health_score;
  if (s.benefits) item.benefits = s.benefits;
  if (s.watch_outs) item.watch_outs = s.watch_outs;
  const fiber = scale(s.fiber_g);
  if (fiber !== undefined) item.fiber_g = fiber;
  const sugar = scale(s.sugar_g);
  if (sugar !== undefined) item.sugar_g = sugar;
  const sodium = scale(s.sodium_mg);
  if (sodium !== undefined) item.sodium_mg = sodium;
  const potassium = scale(s.potassium_mg);
  if (potassium !== undefined) item.potassium_mg = potassium;
  const calcium = scale(s.calcium_mg);
  if (calcium !== undefined) item.calcium_mg = calcium;
  const iron = scale(s.iron_mg);
  if (iron !== undefined) item.iron_mg = iron;
  if (s.micros) {
    const m: Record<string, number> = {};
    for (const k of Object.keys(s.micros)) m[k] = Math.round(s.micros[k] * c * 100) / 100;
    item.micros = m;
  }
  return item;
}

// Same [0,65) red / [40,65) amber / [65,100] green bands used everywhere the
// app-computed health_score shows up (see NutritionDetails.tsx).
function scoreColor(score: number): string {
  if (score >= 65) return colors.green;
  if (score >= 40) return colors.orange;
  return colors.red;
}

function MacroProgress({ label, have, goalV, color }: { label: string; have: number; goalV: number; color: string }) {
  const pct = goalV > 0 ? Math.min(100, Math.round((have / goalV) * 100)) : 0;
  return (
    <View style={styles.mp}>
      <Text style={styles.mpTop}>
        {have}
        <Text style={styles.mpGoal}> / {goalV}g</Text>
      </Text>
      <View style={styles.mpTrack}>
        <View style={[styles.mpFill, { width: `${pct}%`, backgroundColor: color }]} />
      </View>
      <View style={styles.mpLabelRow}>
        <View style={[styles.mpDot, { backgroundColor: color }]} />
        <Text style={styles.mpLabel}>{label}</Text>
      </View>
    </View>
  );
}

export default function HomeScreen({ profile, goal, logs, setLogs, streak, account, onRequireAuth, onAccountUpdate, scanTrigger }: Props) {
  const [photo, setPhoto] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPaywall, setShowPaywall] = useState(false);
  const [showDescribe, setShowDescribe] = useState(false);
  const [showBarcode, setShowBarcode] = useState(false);
  const [showAddSheet, setShowAddSheet] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [waterMl, setWaterMl] = useState(0);
  const [steps, setSteps] = useState(0);
  const [detailsIndex, setDetailsIndex] = useState<number | null>(null);
  const [swapIndex, setSwapIndex] = useState<number | null>(null);
  // Thali clarification: selected option index per question id. Empty = every
  // question sits on its baseline (default) option, so totals match the AI's
  // first estimate until the user answers.
  const [answers, setAnswers] = useState<Record<string, number>>({});
  // Correction/learning engine: this account's remembered portions, loaded once
  // per account and kept in sync as the user logs meals. `learnedIdx` maps an
  // item index -> the AI's ORIGINAL count, present only for items we auto-set to
  // the user's usual portion (so we can show a "your usual" chip + undo).
  const portionMemory = useRef<PortionMemory>({});
  const [learnedIdx, setLearnedIdx] = useState<Record<number, number>>({});
  const [recents, setRecents] = useState<SavedMeal[]>([]);
  // Tracks the last scanTrigger value we've already handled, so a fresh
  // mount (which sees whatever value App.tsx is currently holding) doesn't
  // mistake it for a brand new tap and pop the camera open uninvited.
  const lastScanTrigger = useRef(scanTrigger ?? 0);

  useEffect(() => {
    if (scanTrigger === undefined) return;
    if (scanTrigger === lastScanTrigger.current) return;
    lastScanTrigger.current = scanTrigger;
    setShowAddSheet(true);
  }, [scanTrigger]);

  // Quick re-log list (recent + favorite meals) loads from local storage.
  useEffect(() => {
    let alive = true;
    loadRecents().then((r) => alive && setRecents(r));
    return () => {
      alive = false;
    };
  }, []);

  // Load this account's learned portions (correction engine). Reloads when the
  // signed-in account changes so we never apply one user's habits to another.
  useEffect(() => {
    let alive = true;
    loadPortionMemory(account?.id ?? null).then((m) => {
      if (alive) portionMemory.current = m;
    });
    return () => {
      alive = false;
    };
  }, [account?.id]);

  const isPro = !!account?.isPro;
  const scansLeft = account?.scansLeft ?? account?.scansLimit ?? null;

  const today = todayKey();
  const dayKcal = dayTotal(logs, today);
  const meals = logs[today]?.meals ?? [];
  const dm = dayMacros(logs, today);
  // Personalized from this profile's weightKg/activity (see nutrition.ts) --
  // not the same flat number for every account regardless of who they are.
  const waterGoalMl = useMemo(() => computeWaterGoalMl(profile), [profile.weightKg, profile.activity]);
  const stepGoal = useMemo(() => computeStepGoal(profile), [profile.activity]);

  // Water + habit (steps) load from local cache instantly, then reconcile with
  // the server. Pure data entry -- no AI, no scan credit touched here.
  useEffect(() => {
    let alive = true;
    (async () => {
      const [water, habits] = await Promise.all([loadWater(), loadHabits()]);
      if (!alive) return;
      setWaterMl(water[today] ?? 0);
      setSteps(habits[today]?.steps ?? 0);
      if (!account) return;
      try {
        const w = await getWater(today);
        if (alive) {
          setWaterMl(w.ml);
          const nextW: WaterMap = { ...water, [today]: w.ml };
          void saveWater(nextW);
        }
      } catch {
        // best-effort: local cache already shown
      }
      try {
        const h = await getHabits(today);
        if (alive && typeof h.habits.steps === "number") {
          setSteps(h.habits.steps);
          const nextH: HabitMap = { ...habits, [today]: { ...habits[today], steps: h.habits.steps } };
          void saveHabits(nextH);
        }
      } catch {
        // best-effort
      }
    })();
    return () => {
      alive = false;
    };
  }, [today, account]);

  async function changeWater(deltaMl: number) {
    const next = Math.max(0, waterMl + deltaMl);
    setWaterMl(next); // optimistic
    const map = await loadWater();
    void saveWater({ ...map, [today]: next });
    if (!account) return;
    try {
      const res = await apiAddWater(today, deltaMl);
      setWaterMl(res.ml);
      const m2 = await loadWater();
      void saveWater({ ...m2, [today]: res.ml });
    } catch (e: any) {
      if (e instanceof AuthRequiredError) onRequireAuth();
      // else keep the optimistic local value
    }
  }

  async function changeSteps(delta: number) {
    const next = Math.max(0, steps + delta);
    setSteps(next); // optimistic
    const map = await loadHabits();
    void saveHabits({ ...map, [today]: { ...map[today], steps: next } });
    if (!account) return;
    try {
      const res = await apiSetHabit(today, "steps", next);
      const v = res.habits.steps ?? next;
      setSteps(v);
      const m2 = await loadHabits();
      void saveHabits({ ...m2, [today]: { ...m2[today], steps: v } });
    } catch (e: any) {
      if (e instanceof AuthRequiredError) onRequireAuth();
    }
  }

  const mealTotal = useMemo(
    () => (result ? result.items.reduce((s, it) => s + itemTotal(it), 0) : 0),
    [result]
  );

  const mealMacros = useMemo(() => {
    const m = { protein_g: 0, carbs_g: 0, fat_g: 0 };
    if (result) {
      for (const it of result.items) {
        m.protein_g += it.count * it.protein_g_per_unit;
        m.carbs_g += it.count * it.carbs_g_per_unit;
        m.fat_g += it.count * it.fat_g_per_unit;
      }
    }
    return {
      protein_g: Math.round(m.protein_g),
      carbs_g: Math.round(m.carbs_g),
      fat_g: Math.round(m.fat_g),
    };
  }, [result]);

  async function pick(fromCamera: boolean) {
    setError(null);
    if (!account) {
      onRequireAuth();
      return;
    }
    if (!isPro && (account.scansLeft ?? 0) <= 0) {
      setShowPaywall(true);
      return;
    }
    // On web there is no OS media/camera permission to request up front -- the
    // browser handles it via the file picker (gallery) or the getUserMedia
    // prompt (camera) at the moment of use. Calling requestMediaLibrary/Camera
    // permissions on web can spuriously return granted:false on some browsers,
    // which was blocking gallery uploads entirely. So only gate on native.
    if (Platform.OS !== "web") {
      const perm = fromCamera
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        setError("Permission denied for " + (fromCamera ? "camera" : "photos"));
        return;
      }
    }
    const res = fromCamera
      ? await ImagePicker.launchCameraAsync({ quality: 0.6 })
      : await ImagePicker.launchImageLibraryAsync({ quality: 0.6 });
    if (res.canceled || !res.assets?.length) return;
    const uri = res.assets[0].uri;
    setPhoto(uri);
    setResult(null);
    runAnalyze(uri);
  }

  // Single dispatcher for every option in AddFoodSheet -- one gate (auth +
  // paywall) shared across all four entry points instead of each button
  // repeating its own copy of the same two checks.
  function handleAddOption(option: "camera" | "gallery" | "barcode" | "describe") {
    setShowAddSheet(false);
    if (!account) {
      onRequireAuth();
      return;
    }
    if (option === "camera") {
      void pick(true);
      return;
    }
    if (option === "gallery") {
      void pick(false);
      return;
    }
    if (option === "barcode") {
      setShowBarcode(true);
      return;
    }
    // describe
    if (!isPro && (scansLeft ?? 0) <= 0) {
      setShowPaywall(true);
      return;
    }
    setShowDescribe(true);
  }

  // Shared between the photo path and the text-description path (and, once
  // built, voice -- speech transcribes to text and goes through the same
  // /analyze/text call DescribeMeal already uses) -- both return the exact
  // same AnalysisResult shape, so applying one to screen state is identical.
  function applyResult(data: AnalysisResult) {
    setAnswers({}); // new scan -> reset any thali clarifications
    // Correction engine: pre-apply the user's usual portions for foods they've
    // logged before, so the AI's generic guess becomes their reality.
    const { items, learned } = applyPortionMemory(data.items, portionMemory.current);
    setResult({ ...data, items });
    setLearnedIdx(learned);
    if (data.usage && account) {
      onAccountUpdate({
        ...account,
        isPro: data.usage.is_pro,
        scansUsed: data.usage.scans_used,
        scansLimit: data.usage.scans_limit,
        scansLeft: data.usage.is_pro ? null : Math.max(0, data.usage.scans_limit - data.usage.scans_used),
      });
    }
  }

  async function runAnalyze(uri: string) {
    setLoading(true);
    setError(null);
    try {
      const data = await analyzeImage(uri);
      applyResult(data);
    } catch (e: any) {
      if (e instanceof PaywallError) {
        setShowPaywall(true);
      } else if (e instanceof AuthRequiredError) {
        onRequireAuth();
      } else {
        setError(e.message ?? "Something went wrong");
      }
    } finally {
      setLoading(false);
    }
  }

  // Thali clarification: the user picks how much ghee / bowl size / etc. Each
  // option carries a `factor` that multiplies the target item's per-unit kcal
  // AND macros. We apply it relative to the previously-selected option (ratio =
  // new/prev) so re-answering is exact and idempotent, and keep the per-unit
  // values at full precision so repeated toggles never drift.
  function answerQuestion(q: PortionQuestion, optIdx: number) {
    const prevIdx = answers[q.id] ?? q.default_index;
    const prevFactor = q.options[prevIdx]?.factor ?? 1;
    const newFactor = q.options[optIdx]?.factor ?? 1;
    if (!prevFactor) return;
    const ratio = newFactor / prevFactor;
    setResult((prev) => {
      if (!prev) return prev;
      const items = prev.items.map((it, i) => {
        if (i !== q.target_item) return it;
        const scale = (v?: number) => (v == null ? v : v * ratio);
        const next: FoodItem = {
          ...it,
          kcal_per_unit: it.kcal_per_unit * ratio,
          protein_g_per_unit: it.protein_g_per_unit * ratio,
          carbs_g_per_unit: it.carbs_g_per_unit * ratio,
          fat_g_per_unit: it.fat_g_per_unit * ratio,
        };
        // Scale any per-unit micros too so the details panel stays consistent.
        next.fiber_g = scale(it.fiber_g);
        next.sugar_g = scale(it.sugar_g);
        next.sodium_mg = scale(it.sodium_mg);
        next.potassium_mg = scale(it.potassium_mg);
        next.calcium_mg = scale(it.calcium_mg);
        next.iron_mg = scale(it.iron_mg);
        next.kcal_total = Math.round(next.count * next.kcal_per_unit);
        next.protein_g = Math.round(next.count * next.protein_g_per_unit * 10) / 10;
        next.carbs_g = Math.round(next.count * next.carbs_g_per_unit * 10) / 10;
        next.fat_g = Math.round(next.count * next.fat_g_per_unit * 10) / 10;
        return next;
      });
      return { ...prev, items };
    });
    setAnswers((a) => ({ ...a, [q.id]: optIdx }));
  }

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

  // Ingredient swap: replace a mis-identified item with the right food from the
  // DB (local search, no AI, no scan credit). Count resets to 1 serving.
  function applySwap(index: number, s: FoodSuggestion) {
    setResult((prev) => {
      if (!prev) return prev;
      const items = prev.items.map((it, i) => (i === index ? itemFromSuggestion(s) : it));
      return { ...prev, items };
    });
    // Any thali questions that adjusted this item no longer apply -- the food
    // changed -- so reset them to baseline to avoid mis-scaling the new item.
    setAnswers((a) => {
      const next = { ...a };
      for (const q of result?.questions ?? []) {
        if (q.target_item === index) delete next[q.id];
      }
      return next;
    });
    setSwapIndex(null);
  }

  // Shared meal-logging path used by both "Add to today" and the quick re-log
  // list. Updates local state instantly, records the meal into recents, and
  // syncs to the server in the background.
  function logMeal(meal: Meal) {
    setLogs((prev) => {
      const day = prev[today] ?? { date: today, meals: [] };
      const next: LogMap = { ...prev, [today]: { ...day, meals: [...day.meals, meal] } };
      saveLogs(next);
      return next;
    });
    void recordRecentMeal(meal).then(setRecents);
    // Local state above already updated instantly for a fast UI. Make it
    // durable in the background: POST to the real meal_logs table (backend/
    // progress.py) and stamp the returned id onto the local copy once it
    // resolves, so a later delete can also sync server-side.
    addServerLog(today, meal)
      .then(({ id }) => {
        setLogs((prev) => {
          const day = prev[today];
          if (!day) return prev;
          const meals = day.meals.map((m) => (m.at === meal.at ? { ...m, id } : m));
          const next: LogMap = { ...prev, [today]: { ...day, meals } };
          saveLogs(next);
          return next;
        });
      })
      .catch((e) => {
        if (e instanceof AuthRequiredError) onRequireAuth();
        // else: best-effort -- the meal is still saved locally either way.
      });
  }

  function addToDay() {
    if (!result) return;
    const meal: Meal = {
      dish: result.dish,
      kcal: mealTotal,
      protein_g: mealMacros.protein_g,
      carbs_g: mealMacros.carbs_g,
      fat_g: mealMacros.fat_g,
      at: Date.now(),
    };
    logMeal(meal);
    // Correction engine: learn the portions the user settled on for each food,
    // so next time this account scans the same item we pre-fill their usual.
    void rememberPortions(account?.id ?? null, result.items).then((m) => {
      portionMemory.current = m;
    });
    setResult(null);
    setPhoto(null);
    setLearnedIdx({});
  }

  // "Not my usual": revert an auto-applied learned portion back to the AI's
  // original count for this item, and forget it so we stop pre-applying it.
  function undoLearned(index: number) {
    const original = learnedIdx[index];
    if (original === undefined) return;
    setResult((prev) => {
      if (!prev) return prev;
      const items = prev.items.map((it, i) => {
        if (i !== index) return it;
        return {
          ...it,
          count: original,
          kcal_total: Math.round(original * it.kcal_per_unit),
          protein_g: Math.round(original * it.protein_g_per_unit * 10) / 10,
          carbs_g: Math.round(original * it.carbs_g_per_unit * 10) / 10,
          fat_g: Math.round(original * it.fat_g_per_unit * 10) / 10,
        };
      });
      const name = prev.items[index]?.item ?? "";
      void forgetPortion(account?.id ?? null, name).then((m) => {
        portionMemory.current = m;
      });
      return { ...prev, items };
    });
    setLearnedIdx((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
  }

  // One-tap re-add of a recent/favorite meal (no re-scan).
  function quickLog(saved: SavedMeal) {
    setShowAddSheet(false);
    if (!account) {
      onRequireAuth();
      return;
    }
    logMeal({
      dish: saved.dish,
      kcal: saved.kcal,
      protein_g: saved.protein_g,
      carbs_g: saved.carbs_g,
      fat_g: saved.fat_g,
      at: Date.now(),
    });
  }

  function toggleFav(dish: string) {
    void toggleFavoriteMeal(dish).then(setRecents);
  }

  const shareDateLabel = useMemo(() => prettyDate(today), [today]);

  // "What to eat next" -- deterministic, recomputed as the day's totals change.
  // Recomputes on each render's day totals; the Date() inside keys off wall time
  // which is fine (it only reads the hour to pick a meal slot).
  const nextMeal = useMemo(
    () => suggestNextMeal(
      { kcal: dayKcal, protein_g: dm.protein_g, carbs_g: dm.carbs_g, fat_g: dm.fat_g },
      goal,
      profile,
    ),
    [dayKcal, dm.protein_g, dm.carbs_g, dm.fat_g, goal, profile.diet, profile.goal],
  );

  const pct = Math.min(100, Math.round((dayKcal / goal.kcal) * 100));

  return (
    <View style={styles.root}>
      <LinearGradient colors={gradients.brand} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.header}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.brand}>{APP_NAME}</Text>
            <Text style={styles.tagline}>{APP_TAGLINE}</Text>
          </View>
          <View style={styles.streakPill}>
            <Icon name="flame" size={15} color="#FFD8A8" />
            <Text style={styles.streakText}>{streak}</Text>
          </View>
        </View>
      </LinearGradient>

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <View style={styles.dayCard}>
          <Text style={styles.dayLabel}>TODAY</Text>
          <View style={styles.ringWrap}>
            <CalorieRing value={dayKcal} goal={goal.kcal} />
          </View>
          <Text style={styles.remaining}>
            {dayKcal <= goal.kcal
              ? `${goal.kcal - dayKcal} kcal remaining today`
              : `${dayKcal - goal.kcal} kcal over your target`}
          </Text>

          <View style={styles.dayMacroBar}>
            <MacroProgress label="Protein" have={dm.protein_g} goalV={goal.protein_g} color={colors.protein} />
            <MacroProgress label="Carbs" have={dm.carbs_g} goalV={goal.carbs_g} color={colors.carbs} />
            <MacroProgress label="Fat" have={dm.fat_g} goalV={goal.fat_g} color={colors.fat} />
          </View>

          <View style={styles.dayFootRow}>
            <Text style={styles.daySub}>{meals.length} meals logged</Text>
            {meals.length > 0 && (
              <Pressable style={styles.shareBtn} onPress={() => setShowShare(true)}>
                <Icon name="share" size={14} color={colors.green} />
                <Text style={styles.shareBtnText}>Share my day</Text>
              </Pressable>
            )}
          </View>
        </View>

        <View style={styles.nextCard}>
          <View style={styles.nextHeaderRow}>
            <Icon name="sparkles" size={15} color={colors.green} />
            <Text style={styles.nextHeader}>{nextMeal.headline}</Text>
          </View>
          <View style={styles.nextFocusRow}>
            {nextMeal.focus.map((f) => (
              <View key={f} style={styles.nextChip}>
                <Text style={styles.nextChipText}>{f}</Text>
              </View>
            ))}
          </View>
          {!!nextMeal.idea && (
            <Text style={styles.nextIdea}>
              <Text style={styles.nextIdeaLabel}>Try: </Text>
              {nextMeal.idea}
              {nextMeal.kcal > 0 ? <Text style={styles.nextIdeaKcal}>{`  ~${nextMeal.kcal} kcal`}</Text> : null}
            </Text>
          )}
          <Text style={styles.nextRationale}>{nextMeal.rationale}</Text>
        </View>

        <MonthStreak logs={logs} goalKcal={goal.kcal} />

        <View style={styles.wellRow}>
          <View style={styles.wellCard}>
            <View style={styles.wellHead}>
              <Icon name="water" size={16} color={colors.fat} />
              <Text style={styles.wellTitle}>Water</Text>
            </View>
            <Text style={styles.wellValue}>
              {(waterMl / 1000).toFixed(2)}
              <Text style={styles.wellUnit}> / {(waterGoalMl / 1000).toFixed(1)} L</Text>
            </Text>
            <View style={styles.wellTrack}>
              <View
                style={[
                  styles.wellFill,
                  { width: `${Math.min(100, Math.round((waterMl / waterGoalMl) * 100))}%`, backgroundColor: colors.fat },
                ]}
              />
            </View>
            <View style={styles.wellBtns}>
              <Pressable style={styles.wellStep} onPress={() => changeWater(-WATER_GLASS_ML)}>
                <Icon name="minus" size={16} color={colors.mute} />
              </Pressable>
              <Text style={styles.wellStepLabel}>+1 glass</Text>
              <Pressable style={styles.wellStep} onPress={() => changeWater(WATER_GLASS_ML)}>
                <Icon name="plus" size={16} color={colors.green} />
              </Pressable>
            </View>
          </View>

          <View style={styles.wellCard}>
            <View style={styles.wellHead}>
              <Icon name="walk" size={16} color={colors.green} />
              <Text style={styles.wellTitle}>Steps</Text>
            </View>
            <Text style={styles.wellValue}>
              {steps.toLocaleString()}
              <Text style={styles.wellUnit}> / {stepGoal.toLocaleString()}</Text>
            </Text>
            <View style={styles.wellTrack}>
              <View
                style={[
                  styles.wellFill,
                  { width: `${Math.min(100, Math.round((steps / stepGoal) * 100))}%`, backgroundColor: colors.green },
                ]}
              />
            </View>
            <View style={styles.wellBtns}>
              <Pressable style={styles.wellStep} onPress={() => changeSteps(-1000)}>
                <Icon name="minus" size={16} color={colors.mute} />
              </Pressable>
              <Text style={styles.wellStepLabel}>±1,000</Text>
              <Pressable style={styles.wellStep} onPress={() => changeSteps(1000)}>
                <Icon name="plus" size={16} color={colors.green} />
              </Pressable>
            </View>
          </View>
        </View>

        {/* One button, one sheet (AddFoodSheet) -- camera, gallery, barcode
            and describe used to each get their own row on this screen, which
            just meant hunting for the right one. The center TabBar button
            (via scanTrigger) opens the exact same sheet. */}
        <PressableScale style={[styles.btn, styles.btnPrimary, styles.addFoodBtn]} onPress={() => setShowAddSheet(true)}>
          <Icon name="camera" size={18} color="#fff" />
          <Text style={styles.btnPrimaryText}>Add food</Text>
        </PressableScale>

        {account && !isPro && (
          <Pressable style={styles.trialChip} onPress={() => (scansLeft && scansLeft > 0 ? null : setShowPaywall(true))}>
            <Icon name="flame" size={13} color={colors.orange} />
            <Text style={styles.trialText}>
              {typeof scansLeft === "number" && scansLeft > 0
                ? `${scansLeft} free ${scansLeft === 1 ? "scan" : "scans"} left`
                : "Free scans used — upgrade to Pro"}
            </Text>
          </Pressable>
        )}

        {photo && <Image source={{ uri: photo }} style={styles.preview} />}

        {loading && (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={colors.green} />
            <Text style={styles.muted}>Analyzing your plate…</Text>
          </View>
        )}

        {error && <Text style={styles.error}>{error}</Text>}

        {result && !loading && (
          <View style={styles.resultCard}>
            <Text style={styles.dish}>{result.dish}</Text>
            <Text style={styles.cuisine}>{result.cuisine}</Text>
            <Text style={styles.hint}>Tap − / + to fix the portion</Text>

            {result.items.map((it, i) => (
              <View key={i} style={styles.itemCard}>
                <View style={styles.itemRow}>
                  <View style={{ flex: 1 }}>
                    <View style={styles.itemNameRow}>
                      <Text style={styles.itemName}>{it.item}</Text>
                      {it.health_score !== undefined && (
                        <View style={[styles.scoreDot, { backgroundColor: scoreColor(it.health_score) }]}>
                          <Text style={styles.scoreDotText}>{Math.round(it.health_score)}</Text>
                        </View>
                      )}
                    </View>
                    <Text style={styles.itemSub}>
                      {Math.round(it.kcal_per_unit)} kcal / {it.unit}
                      {it.countable ? "" : "  (size)"}
                    </Text>
                    <Text style={styles.itemMacros}>
                      P {Math.round(it.count * it.protein_g_per_unit)}g · C{" "}
                      {Math.round(it.count * it.carbs_g_per_unit)}g · F{" "}
                      {Math.round(it.count * it.fat_g_per_unit)}g
                    </Text>
                    {learnedIdx[i] !== undefined && (
                      <Pressable style={styles.usualChip} onPress={() => undoLearned(i)}>
                        <Icon name="sparkles" size={11} color={colors.green} />
                        <Text style={styles.usualChipText}>
                          Your usual · tap to reset to {learnedIdx[i]}
                        </Text>
                      </Pressable>
                    )}
                  </View>
                  <View style={styles.stepper}>
                    <Pressable style={styles.stepBtn} onPress={() => adjust(i, -1)}>
                      <Icon name="minus" size={16} color={colors.green} />
                    </Pressable>
                    <Text style={styles.count}>{it.count}</Text>
                    <Pressable style={styles.stepBtn} onPress={() => adjust(i, 1)}>
                      <Icon name="plus" size={16} color={colors.green} />
                    </Pressable>
                  </View>
                  <Text style={styles.itemKcal}>{itemTotal(it)}</Text>
                </View>

                {(!!it.benefits?.length || !!it.watch_outs?.length) && (
                  <View style={styles.chipRow}>
                    {(it.benefits ?? []).map((b) => (
                      <View key={b} style={styles.chipGood}>
                        <Text style={styles.chipGoodText}>{b}</Text>
                      </View>
                    ))}
                    {(it.watch_outs ?? []).map((w) => (
                      <View key={w} style={styles.chipWarn}>
                        <Text style={styles.chipWarnText}>{w}</Text>
                      </View>
                    ))}
                  </View>
                )}

                <View style={styles.itemActions}>
                  {it.source === "db" && (
                    <Pressable onPress={() => setDetailsIndex(i)} style={styles.detailsLink}>
                      <Icon name="info" size={12} color={colors.mute} />
                      <Text style={styles.detailsLinkText}>Full nutrition facts</Text>
                    </Pressable>
                  )}
                  <Pressable onPress={() => setSwapIndex(i)} style={styles.swapLink}>
                    <Icon name="swap" size={12} color={colors.green} />
                    <Text style={styles.swapLinkText}>Not right? Swap</Text>
                  </Pressable>
                </View>
              </View>
            ))}

            {!!result.questions?.length && (
              <View style={styles.qBlock}>
                <View style={styles.qHeaderRow}>
                  <Icon name="sparkles" size={14} color={colors.green} />
                  <Text style={styles.qHeader}>Fine-tune your thali</Text>
                </View>
                <Text style={styles.qSubtitle}>
                  A photo can't see everything — a tap makes the numbers more accurate.
                </Text>
                {result.questions.map((q) => {
                  const selected = answers[q.id] ?? q.default_index;
                  return (
                    <View key={q.id} style={styles.qItem}>
                      <Text style={styles.qPrompt}>
                        {q.prompt}
                        {result.items[q.target_item] ? (
                          <Text style={styles.qTarget}>{"  · " + result.items[q.target_item].item}</Text>
                        ) : null}
                      </Text>
                      <View style={styles.qOptions}>
                        {q.options.map((opt, oi) => {
                          const active = oi === selected;
                          return (
                            <Pressable
                              key={oi}
                              onPress={() => answerQuestion(q, oi)}
                              style={[styles.qChip, active && styles.qChipActive]}
                            >
                              <Text style={[styles.qChipText, active && styles.qChipTextActive]}>
                                {opt.label}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </View>
                    </View>
                  );
                })}
              </View>
            )}

            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Meal total</Text>
              <Text style={styles.totalKcal}>{mealTotal} kcal</Text>
            </View>

            <View style={styles.macroBar}>
              <View style={styles.macroBox}>
                <Text style={styles.macroVal}>{mealMacros.protein_g}g</Text>
                <Text style={styles.macroKey}>Protein</Text>
              </View>
              <View style={styles.macroBox}>
                <Text style={styles.macroVal}>{mealMacros.carbs_g}g</Text>
                <Text style={styles.macroKey}>Carbs</Text>
              </View>
              <View style={styles.macroBox}>
                <Text style={styles.macroVal}>{mealMacros.fat_g}g</Text>
                <Text style={styles.macroKey}>Fat</Text>
              </View>
            </View>

            <PressableScale style={[styles.btn, styles.btnPrimary, styles.addBtn]} onPress={addToDay}>
              <Icon name="plus" size={18} color="#fff" />
              <Text style={styles.btnPrimaryText}>Add to today</Text>
            </PressableScale>
          </View>
        )}

        {!result && !loading && !photo && (
          <Text style={styles.empty}>
            Point your camera at a thali, dosa, biryani or any Indian dish.
          </Text>
        )}
      </ScrollView>

      {showShare && (
        <ShareSheet
          visible={showShare}
          onClose={() => setShowShare(false)}
          total={dayKcal}
          meals={meals}
          macros={dm}
          streak={streak}
          dateLabel={shareDateLabel}
        />
      )}

      {/* Each <Modal> is mounted only while open, not just toggled via `visible`.
          On react-native-web, an always-mounted-but-hidden <Modal> still
          contributes a full viewport-height offset to the next sibling
          Modal's portal, pushing it entirely below the visible screen with no
          way to scroll to it (that's what made the Budget sheet unreachable —
          its content rendered ~720px below the fold). Unmounting when closed
          removes that phantom offset entirely. */}
      {showAddSheet && (
        <AddFoodSheet
          visible={showAddSheet}
          onClose={() => setShowAddSheet(false)}
          onPick={handleAddOption}
          recents={recents}
          onQuickLog={quickLog}
          onToggleFav={toggleFav}
        />
      )}

      {swapIndex !== null && (
        <FoodSearchSheet
          visible={swapIndex !== null}
          replacing={result?.items[swapIndex]?.item ?? null}
          onClose={() => setSwapIndex(null)}
          onPick={(food) => applySwap(swapIndex, food)}
          onRequireAuth={onRequireAuth}
        />
      )}

      {showPaywall && (
        <Paywall
          visible={showPaywall}
          onClose={() => setShowPaywall(false)}
          onUpgraded={(a) => {
            onAccountUpdate(a);
            setShowPaywall(false);
          }}
          onRequireAuth={() => {
            setShowPaywall(false);
            onRequireAuth();
          }}
        />
      )}

      {showDescribe && (
        <DescribeMeal
          visible={showDescribe}
          onClose={() => setShowDescribe(false)}
          onResult={(data) => {
            setPhoto(null);
            applyResult(data);
          }}
          onRequireAuth={() => {
            setShowDescribe(false);
            onRequireAuth();
          }}
          onPaywall={() => {
            setShowDescribe(false);
            setShowPaywall(true);
          }}
        />
      )}

      {showBarcode && (
        <BarcodeScanner
          visible={showBarcode}
          onClose={() => setShowBarcode(false)}
          onResult={(data) => {
            setPhoto(null);
            applyResult(data);
          }}
          onRequireAuth={() => {
            setShowBarcode(false);
            onRequireAuth();
          }}
          onFallbackToPhoto={() => {
            setShowBarcode(false);
            void pick(true);
          }}
        />
      )}

      {detailsIndex !== null && (
        <NutritionDetails
          visible={detailsIndex !== null}
          onClose={() => setDetailsIndex(null)}
          item={result?.items[detailsIndex] ?? null}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { paddingTop: 56, paddingBottom: 26, paddingHorizontal: 20, borderBottomLeftRadius: 24, borderBottomRightRadius: 24 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  streakPill: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "rgba(255,255,255,0.18)", borderRadius: 999, paddingHorizontal: 13, paddingVertical: 8 },
  streakText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  brand: { color: "#fff", fontSize: 26, fontWeight: "800", letterSpacing: -0.3 },
  tagline: { color: "#CDEBD9", fontSize: 13, marginTop: 2 },
  body: { padding: 16, paddingBottom: 24, marginTop: -12 },
  dayCard: { backgroundColor: colors.card, borderRadius: 22, padding: 20, marginBottom: 16, ...elevation.md },
  nextCard: { backgroundColor: colors.greenTint, borderRadius: 18, padding: 16, marginBottom: 16, gap: 8 },
  nextHeaderRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  nextHeader: { color: colors.green, fontSize: 14, fontWeight: "900" },
  nextFocusRow: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  nextChip: { backgroundColor: "#fff", borderRadius: 999, paddingVertical: 4, paddingHorizontal: 11, borderWidth: 1, borderColor: colors.line },
  nextChipText: { color: colors.ink, fontSize: 11.5, fontWeight: "800" },
  nextIdea: { color: colors.ink, fontSize: 14.5, fontWeight: "700", lineHeight: 20 },
  nextIdeaLabel: { color: colors.green, fontWeight: "900" },
  nextIdeaKcal: { color: colors.mute, fontSize: 12, fontWeight: "700" },
  nextRationale: { color: colors.mute, fontSize: 12, fontWeight: "600", lineHeight: 16 },
  dayLabel: { color: colors.mute, fontSize: 11, fontWeight: "800", letterSpacing: 1.2, textAlign: "center" },
  ringWrap: { alignItems: "center", marginTop: 10, marginBottom: 6 },
  dayKcal: { color: colors.green, fontSize: 34, fontWeight: "900", marginTop: 2 },
  goalTopRow: { flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: 2 },
  goalTarget: { color: colors.mute, fontSize: 15, fontWeight: "700" },
  progressTrack: { height: 10, borderRadius: 5, backgroundColor: colors.track, overflow: "hidden", marginTop: 8 },
  progressFill: { height: 10, borderRadius: 5, backgroundColor: colors.green },
  progressOver: { backgroundColor: colors.orange },
  remaining: { color: colors.mute, fontSize: 12.5, marginTop: 2, fontWeight: "600", textAlign: "center" },
  dayMacroBar: { flexDirection: "row", gap: 12, marginTop: 18, marginBottom: 4 },
  mp: { flex: 1 },
  mpTop: { color: colors.ink, fontSize: 13, fontWeight: "800" },
  mpGoal: { color: colors.mute, fontSize: 11, fontWeight: "600" },
  mpTrack: { height: 6, borderRadius: 3, backgroundColor: colors.track, overflow: "hidden", marginTop: 5 },
  mpFill: { height: 6, borderRadius: 3, backgroundColor: colors.green },
  mpLabelRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 6 },
  mpDot: { width: 7, height: 7, borderRadius: 4 },
  mpLabel: { color: colors.mute, fontSize: 11, fontWeight: "600" },
  dayFootRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 16 },
  daySub: { color: colors.mute, fontSize: 12.5, fontWeight: "600" },
  shareBtn: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.greenTint, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 9 },
  shareBtnText: { color: colors.green, fontWeight: "800", fontSize: 13 },
  btn: { flex: 1, flexDirection: "row", gap: 8, borderRadius: 16, paddingVertical: 15, alignItems: "center", justifyContent: "center" },
  btnPrimary: { backgroundColor: colors.green, ...elevation.sm },
  btnPrimaryText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  addFoodBtn: { marginBottom: 16 },
  wellRow: { flexDirection: "row", gap: 12, marginBottom: 16 },
  wellCard: { flex: 1, backgroundColor: colors.card, borderRadius: 18, padding: 14, ...elevation.sm },
  wellHead: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 },
  wellTitle: { color: colors.mute, fontWeight: "800", fontSize: 12.5, letterSpacing: 0.3 },
  wellValue: { color: colors.ink, fontWeight: "800", fontSize: 22 },
  wellUnit: { color: colors.faint, fontWeight: "700", fontSize: 13 },
  wellTrack: { height: 6, borderRadius: 3, backgroundColor: colors.line, marginTop: 8, overflow: "hidden" },
  wellFill: { height: "100%", borderRadius: 3 },
  wellBtns: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 12 },
  wellStep: { width: 34, height: 34, borderRadius: 10, borderWidth: 1.5, borderColor: colors.hairline, alignItems: "center", justifyContent: "center" },
  wellStepLabel: { color: colors.mute, fontWeight: "700", fontSize: 12 },
  trialChip: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, alignSelf: "center", backgroundColor: colors.greenTint, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7, marginBottom: 16 },
  trialText: { color: colors.green, fontWeight: "800", fontSize: 12.5 },

  preview: { width: "100%", height: 220, borderRadius: 16, marginBottom: 16 },
  center: { alignItems: "center", paddingVertical: 24 },
  muted: { color: colors.mute, marginTop: 8 },
  error: { color: colors.red, backgroundColor: colors.redTint, padding: 12, borderRadius: 12 },
  resultCard: { backgroundColor: colors.card, borderRadius: 18, padding: 16, ...shadow.card },
  dish: { fontSize: 20, fontWeight: "800", color: colors.ink },
  cuisine: { color: colors.mute, marginBottom: 8 },
  hint: { color: colors.green, fontSize: 12, marginBottom: 8 },
  itemCard: { paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.line },
  itemRow: { flexDirection: "row", alignItems: "center" },
  itemNameRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  itemName: { fontSize: 15, fontWeight: "700", color: colors.ink },
  itemSub: { color: colors.mute, fontSize: 12 },
  itemMacros: { color: colors.green, fontSize: 11, fontWeight: "600", marginTop: 2 },
  scoreDot: { minWidth: 20, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center", paddingHorizontal: 3 },
  scoreDotText: { color: "#fff", fontSize: 10, fontWeight: "800" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  chipGood: { backgroundColor: colors.greenTint, borderRadius: 999, paddingVertical: 4, paddingHorizontal: 9 },
  chipGoodText: { color: colors.green, fontWeight: "700", fontSize: 10.5 },
  chipWarn: { backgroundColor: colors.redTint, borderRadius: 999, paddingVertical: 4, paddingHorizontal: 9 },
  chipWarnText: { color: colors.orange, fontWeight: "700", fontSize: 10.5 },
  detailsLink: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 8, alignSelf: "flex-start" },
  detailsLinkText: { color: colors.mute, fontSize: 11.5, fontWeight: "700", textDecorationLine: "underline" },
  itemActions: { flexDirection: "row", alignItems: "center", gap: 16, marginTop: 8, flexWrap: "wrap" },
  swapLink: { flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start" },
  swapLinkText: { color: colors.green, fontSize: 11.5, fontWeight: "800", textDecorationLine: "underline" },
  usualChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
    marginTop: 6,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 999,
    backgroundColor: colors.greenTint,
  },
  usualChipText: { fontSize: 10.5, fontWeight: "800", color: colors.green },
  qBlock: { marginTop: 14, padding: 12, borderRadius: 14, backgroundColor: colors.greenTint, gap: 10 },
  qHeaderRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  qHeader: { fontSize: 14, fontWeight: "900", color: colors.green },
  qSubtitle: { fontSize: 11.5, color: colors.mute, marginTop: -4, lineHeight: 16 },
  qItem: { gap: 7 },
  qPrompt: { fontSize: 13, fontWeight: "700", color: colors.ink },
  qTarget: { fontSize: 12, fontWeight: "600", color: colors.mute },
  qOptions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  qChip: { paddingVertical: 7, paddingHorizontal: 13, borderRadius: 999, backgroundColor: "#fff", borderWidth: 1, borderColor: colors.line },
  qChipActive: { backgroundColor: colors.green, borderColor: colors.green },
  qChipText: { fontSize: 12.5, fontWeight: "700", color: colors.ink },
  qChipTextActive: { color: "#fff" },
  stepper: { flexDirection: "row", alignItems: "center", marginHorizontal: 8 },
  stepBtn: { width: 30, height: 30, borderRadius: 8, backgroundColor: colors.greenTint, alignItems: "center", justifyContent: "center" },
  stepBtnText: { color: colors.green, fontSize: 18, fontWeight: "900" },
  count: { minWidth: 34, textAlign: "center", fontWeight: "800", color: colors.ink },
  itemKcal: { minWidth: 52, textAlign: "right", fontWeight: "800", color: colors.ink },
  totalRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.line },
  totalLabel: { fontSize: 15, fontWeight: "700", color: colors.ink },
  totalKcal: { fontSize: 22, fontWeight: "900", color: colors.green },
  macroBar: { flexDirection: "row", gap: 8, marginTop: 10 },
  macroBox: { flex: 1, backgroundColor: colors.bg, borderRadius: 12, paddingVertical: 10, alignItems: "center" },
  macroVal: { fontSize: 16, fontWeight: "800", color: colors.ink },
  macroKey: { fontSize: 11, color: colors.mute, marginTop: 2 },
  addBtn: { marginTop: 14 },
  empty: { textAlign: "center", color: colors.mute, marginTop: 24, paddingHorizontal: 20, lineHeight: 20 },
});
