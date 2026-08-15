import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { useNavigation } from "@react-navigation/native";
import { analyzeImage, AnalysisResult, FoodItem, FoodSuggestion, Pairing, getCombos, PortionQuestion, PaywallError, AuthRequiredError, addServerLog, getWater, addWater as apiAddWater, getHabits, setHabit as apiSetHabit, recommendMeals, fetchMealVerdict, ApiVerdict, getExerciseLogs, getHomeLayout, putHomeLayout, submitScanCorrection, DayPlan, fetchTodayPlan } from "./api";
import ShareSheet from "./ShareSheet";
import FoodSearchSheet from "./FoodSearchSheet";
import CustomizeHomeSheet from "./CustomizeHomeSheet";
import { DEFAULT_ORDER, HomeModuleKey, resolveLayout } from "./homeModules";
import { AI_PLANNER_FULL_MODE, APP_NAME, APP_SUBTAGLINE, APP_TAGLINE } from "./config";
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
  monthStreak,
  SavedMeal,
  loadRecents,
  recordRecentMeal,
} from "./storage";
import { colors, radius, shadow, type as T, gradients, elevation } from "./theme";
import { LinearGradient } from "expo-linear-gradient";
import Icon, { IconName } from "./Icon";
import CalorieRing from "./CalorieRing";
import { computeSuggestions, recentsToCandidates, BASE_CANDIDATES, Candidate } from "./mealSuggest";
import { mealVerdict, VerdictState } from "./mealVerdict";
import {
  loadPortionMemory,
  rememberPortions,
  applyPortionMemory,
  forgetPortion,
  PortionMemory,
} from "./corrections";
import {
  TrainingContext,
  TRAINING_META,
  trainingTip,
  loadTrainingContext,
  saveTrainingContext,
} from "./training";
import { dayMicros, sumMealMicros } from "./micros";
import NutritionDetails from "./NutritionDetails";
import PressableScale from "./PressableScale";
import TodayPlanCard from "./TodayPlanCard";
import { Account } from "./auth";

// AI-backed extras (Gemini phrasing + micronutrients panel). Core action cards
// (next best move + training) remain visible even when this is off.
const AI_COACH_ENABLED = false;

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
  // Keeps profile.weightKg (and every dependent target) in sync when weight is
  // logged from the global Add hub -- same handler ProgressScreen uses.
  onWeightLogged?: (kg: number) => void;
};

type AddOptionKey =
  | "camera"
  | "gallery"
  | "barcode"
  | "manual"
  | "template"
  | "voice"
  | "exercise"
  | "water"
  | "weight";

const HOME_ADD_OPTIONS: Array<{ key: AddOptionKey; label: string; icon: IconName }> = [
  { key: "camera", label: "Scan meal", icon: "camera" },
  { key: "voice", label: "Voice log", icon: "mic" },
  { key: "gallery", label: "Gallery", icon: "gallery" },
  { key: "barcode", label: "Barcode", icon: "barcode" },
  { key: "manual", label: "Manual", icon: "edit" },
  { key: "template", label: "Template", icon: "nutrition" },
  { key: "exercise", label: "Workout", icon: "dumbbell" },
  { key: "water", label: "Water", icon: "water" },
  { key: "weight", label: "Weight", icon: "scale" },
];
const HOME_ADD_QUICK: AddOptionKey[] = ["camera", "gallery", "voice", "weight"];

function itemTotal(it: FoodItem): number {
  return Math.round(it.count * it.kcal_per_unit);
}

// Traffic-light colour for the "Should you eat this?" verdict states.
function verdictColor(state: VerdictState): string {
  return state === "green" ? colors.green : state === "yellow" ? colors.carbs : colors.red;
}

// Builds a fresh FoodItem from a food-DB search result when the user swaps a
// mis-identified ingredient. Count resets to 1 serving (the user tweaks it
// with the +/- stepper); micronutrients scale with count like anchor_items.
function itemFromSuggestion(s: FoodSuggestion, count = 1): FoodItem {
  const c = Math.max(1, Math.round(count));
  const scale = (v?: number) => (v == null ? undefined : Math.round(v * c * 10) / 10);
  const item: FoodItem = {
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
  const navigation = useNavigation<any>();
  const [photo, setPhoto] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showShare, setShowShare] = useState(false);
  const [waterMl, setWaterMl] = useState(0);
  const [steps, setSteps] = useState(0);
  const [exerciseKcal, setExerciseKcal] = useState(0);
  const [layoutOrder, setLayoutOrder] = useState<HomeModuleKey[]>(DEFAULT_ORDER);
  const [hiddenSet, setHiddenSet] = useState<Set<HomeModuleKey>>(new Set());
  const [showCustomize, setShowCustomize] = useState(false);
  const [detailsIndex, setDetailsIndex] = useState<number | null>(null);
  const [swapIndex, setSwapIndex] = useState<number | null>(null);
  // Suggested accompaniments for the current result ("Goes well with"). Indian
  // dishes are rarely eaten alone, so we offer the usual sides as one-tap adds.
  const [pairings, setPairings] = useState<Pairing[]>([]);
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
  // Today's training context (long run / lifting / rest / performance). Drives a
  // fuelling tip + biases the "what to eat next" ideas. Per account + per date.
  const [training, setTraining] = useState<TrainingContext | null>(null);
  // Real foods pulled from the DB (diet-appropriate) to enrich next-meal ideas
  // beyond the built-in list. Fetched once per diet per session; empty until it
  // resolves (the suggester falls back to built-in ideas meanwhile).
  const [dbPool, setDbPool] = useState<Candidate[]>([]);
  const [aiSuggestion, setAiSuggestion] = useState<string | null>(null);
  const [nextMove, setNextMove] = useState<{
    category: string;
    slot: string;
    reason: string;
    meal: {
      name: string;
      kcal: number;
      protein_g: number;
      carbs_g: number;
      fat_g: number;
      items: { name: string; count: number; unit: string; kcal: number; protein_g: number; carbs_g: number; fat_g: number }[];
    };
    alternatives: {
      name: string;
      kcal: number;
      protein_g: number;
      carbs_g: number;
      fat_g: number;
      items: { name: string; count: number; unit: string; kcal: number; protein_g: number; carbs_g: number; fat_g: number }[];
    }[];
  } | null>(null);
  const [nextMoveChoice, setNextMoveChoice] = useState(0);
  const [planNextMealName, setPlanNextMealName] = useState("");
  const [nextMealExpanded, setNextMealExpanded] = useState(true);
  const [previewDateKey, setPreviewDateKey] = useState<string | null>(null);
  const [previewPlan, setPreviewPlan] = useState<DayPlan | null>(null);
  const [previewPlanLoading, setPreviewPlanLoading] = useState(false);
  const recoSig = useRef<string | null>(null);
  // AI-enhanced "should I eat this?" verdict for the meal under review. Tagged
  // with the signature it was fetched for so we never show stale advice after a
  // portion edit; null until it resolves (the on-device verdict shows meanwhile).
  const [aiVerdict, setAiVerdict] = useState<{ sig: string; v: ApiVerdict } | null>(null);
  const verdictSig = useRef<string | null>(null);
  const [recents, setRecents] = useState<SavedMeal[]>([]);
  // Tracks the last scanTrigger value we've already handled, so a fresh
  // mount (which sees whatever value App.tsx is currently holding) doesn't
  // mistake it for a brand new tap and pop the camera open uninvited.
  const lastScanTrigger = useRef(scanTrigger ?? 0);

  useEffect(() => {
    if (scanTrigger === undefined) return;
    if (scanTrigger === lastScanTrigger.current) return;
    lastScanTrigger.current = scanTrigger;
    navigation.navigate("ScanHub");
  }, [scanTrigger]);

  // Quick re-log list (recent + favorite meals) loads from local storage.
  useEffect(() => {
    let alive = true;
    loadRecents().then((r) => alive && setRecents(r));
    return () => {
      alive = false;
    };
  }, []);

  // Home dashboard layout (module order + hidden set) is per-account and synced
  // from the server, so a user's arrangement follows them across devices. We
  // merge whatever the server has with the canonical module set (resolveLayout)
  // so newly-shipped modules still appear for existing users.
  useEffect(() => {
    if (!account) {
      setLayoutOrder(DEFAULT_ORDER);
      setHiddenSet(new Set());
      return;
    }
    let alive = true;
    getHomeLayout()
      .then((saved) => {
        if (!alive) return;
        const { order, hidden } = resolveLayout(saved);
        setLayoutOrder(order);
        setHiddenSet(hidden);
      })
      .catch(() => {
        if (!alive) return;
        setLayoutOrder(DEFAULT_ORDER);
        setHiddenSet(new Set());
      });
    return () => {
      alive = false;
    };
  }, [account?.id]);

  async function saveLayout(order: HomeModuleKey[], hidden: HomeModuleKey[]) {
    setLayoutOrder(order); // optimistic
    setHiddenSet(new Set(hidden));
    try {
      await putHomeLayout({ order, hidden });
    } catch (e) {
      if (e instanceof AuthRequiredError) onRequireAuth();
    }
  }

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

  // Load today's training context for this account (per account + per date, so
  // it never leaks across logins and never carries over to a new day).
  useEffect(() => {
    let alive = true;
    loadTrainingContext(account?.id ?? null, todayKey()).then((c) => {
      if (alive) setTraining(c);
    });
    return () => {
      alive = false;
    };
  }, [account?.id]);

  // The live-remaining-macro recommendation effect lives lower down, after
  // dayKcal/dm/goal are computed (it needs the actual remaining budget).

  const isPro = !!account?.isPro;
  const scansLeft = account?.scansLeft ?? account?.scansLimit ?? null;

  const today = todayKey();
  const dayKcal = dayTotal(logs, today);
  const meals = logs[today]?.meals ?? [];
  const dm = dayMacros(logs, today);
  const last30Summary = useMemo(() => {
    const now = new Date();
    let logged = 0;
    let onTarget = 0;
    let over = 0;
    for (let i = 0; i < 30; i += 1) {
      const d = new Date(now);
      d.setDate(now.getDate() - (29 - i));
      const key = todayKey(d);
      const day = logs[key];
      if (!day || day.meals.length === 0) continue;
      logged += 1;
      const kcal = dayTotal(logs, key);
      if (goal.kcal > 0 && kcal >= goal.kcal * 0.85 && kcal <= goal.kcal * 1.15) onTarget += 1;
      if (goal.kcal > 0 && kcal > goal.kcal * 1.15) over += 1;
    }
    return { logged, onTarget, over };
  }, [logs, goal.kcal]);
  // Personalized from this profile's weightKg/activity (see nutrition.ts) --
  // not the same flat number for every account regardless of who they are.
  const waterGoalMl = useMemo(() => computeWaterGoalMl(profile), [profile.weightKg, profile.activity]);
  const stepGoal = useMemo(() => computeStepGoal(profile), [profile.activity]);

  // Real "what to eat next": ask the backend to rank the WHOLE food DB against
  // today's ACTUAL remaining macros + this user's diet, and (best-effort) return
  // a Gemini one-liner. This is the proper AI/DB path -- NOT a static cached
  // list. It refetches when the remaining budget changes meaningfully (coarse
  // buckets so tiny edits don't spam), debounced ~700ms. Needs auth, costs no
  // scan credit. On any failure the pool just stays empty and the suggester
  // falls back to the built-in ideas + the user's own recents.
  const remKcal = Math.max(0, goal.kcal - dayKcal);
  const remP = Math.max(0, goal.protein_g - dm.protein_g);
  const remC = Math.max(0, goal.carbs_g - dm.carbs_g);
  const remF = Math.max(0, goal.fat_g - dm.fat_g);
  const streakWindow = useMemo(() => monthStreak(logs, goal.kcal, new Date(), 30), [logs, goal.kcal]);
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
      setDbPool([]);
      setAiSuggestion(null);
      setNextMove(null);
      recoSig.current = null;
      return;
    }
    // Coarse signature -- refetch only when it shifts (100 kcal / 10 g buckets).
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
          training: training ?? "",
          aiMode: AI_PLANNER_FULL_MODE,
          profile: plannerProfile,
        },
      )
        .then(({ candidates, suggestion, nextMove: move }) => {
          if (!alive) return;
          setDbPool(candidates);
          setAiSuggestion(suggestion);
          setNextMove(move ?? null);
          setNextMoveChoice(0);
        })
        .catch(() => {
          if (alive) {
            setDbPool([]);
            setAiSuggestion(null);
            setNextMove(null);
          }
        });
    }, 700);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [
    account?.id,
    profile.diet,
    profile.goal,
    remKcal,
    remP,
    remC,
    remF,
    goal.kcal,
    goal.protein_g,
    goal.carbs_g,
    goal.fat_g,
    dayKcal,
    dm.protein_g,
    dm.carbs_g,
    dm.fat_g,
    training,
    today,
  ]);

  useEffect(() => {
    if (!previewDateKey || !account) {
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
  }, [previewDateKey, account?.id, logs, goal.kcal, goal.protein_g, goal.carbs_g, goal.fat_g, profile.diet, profile.goal, plannerProfile]);

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
      try {
        const ex = await getExerciseLogs(today);
        if (alive) setExerciseKcal(ex.totalKcal);
      } catch {
        // best-effort: exercise burn just shows 0 until it loads
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

  // "Should I eat this?" — a pre-meal verdict comparing the scanned plate to
  // what's LEFT in today's budget (the meal isn't logged yet, so we pass the
  // day's current totals as `consumed`) and today's training context.
  const verdict = useMemo(
    () =>
      result
        ? mealVerdict(
            { kcal: mealTotal, protein_g: mealMacros.protein_g, carbs_g: mealMacros.carbs_g, fat_g: mealMacros.fat_g },
            { kcal: dayKcal, protein_g: dm.protein_g, carbs_g: dm.carbs_g, fat_g: dm.fat_g },
            goal,
            training,
          )
        : null,
    [result, mealTotal, mealMacros, dayKcal, dm.protein_g, dm.carbs_g, dm.fat_g, goal, training],
  );

  // Fetch the AI-enhanced verdict (grounded advice from the backend) whenever the
  // reviewed meal or the day's remaining budget shifts meaningfully. Debounced so
  // rapid +/- portion taps don't spam the API; keyed by a coarse signature so we
  // only refetch on real changes. Best-effort: on failure the on-device verdict
  // stands. Needs an account + a real target + at least one verdict line.
  useEffect(() => {
    if (!AI_COACH_ENABLED || !result || !verdict || verdict.lines.length === 0 || !account || goal.kcal <= 0) {
      setAiVerdict(null);
      verdictSig.current = null;
      return;
    }
    const sig = [
      Math.round(mealTotal / 40),
      Math.round(mealMacros.protein_g / 5),
      Math.round(mealMacros.carbs_g / 10),
      Math.round(mealMacros.fat_g / 5),
      Math.round(dayKcal / 100),
      training ?? "",
      result.dish ?? "",
    ].join("|");
    if (sig === verdictSig.current) return;
    let alive = true;
    const timer = setTimeout(() => {
      verdictSig.current = sig;
      fetchMealVerdict({
        meal: { kcal: mealTotal, protein_g: mealMacros.protein_g, carbs_g: mealMacros.carbs_g, fat_g: mealMacros.fat_g },
        consumed: { kcal: dayKcal, protein_g: dm.protein_g, carbs_g: dm.carbs_g, fat_g: dm.fat_g },
        goal: { kcal: goal.kcal, protein_g: goal.protein_g, carbs_g: goal.carbs_g, fat_g: goal.fat_g },
        goalName: profile.goal,
        training: training ?? "",
        dish: result.dish ?? "",
      })
        .then((v) => {
          if (alive && v) setAiVerdict({ sig, v });
        })
        .catch(() => {
          /* keep the on-device verdict */
        });
    }, 600);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [result, verdict, account, mealTotal, mealMacros, dayKcal, dm.protein_g, dm.carbs_g, dm.fat_g, goal, training, profile.goal]);

  // What the card actually shows: the AI verdict when it matches the current meal
  // signature (upgraded advice wording), otherwise the instant on-device verdict.
  const shownVerdict = useMemo(() => {
    if (!verdict) return null;
    const sig = [
      Math.round(mealTotal / 40),
      Math.round(mealMacros.protein_g / 5),
      Math.round(mealMacros.carbs_g / 10),
      Math.round(mealMacros.fat_g / 5),
      Math.round(dayKcal / 100),
      training ?? "",
      result?.dish ?? "",
    ].join("|");
    if (aiVerdict && aiVerdict.sig === sig) {
      // Traffic-lights are authoritative from the on-device rules (identical to
      // the server's); only the advice wording + source come from the AI.
      return { ...verdict, advice: aiVerdict.v.advice, source: aiVerdict.v.source as "ai" | "rule" };
    }
    return { ...verdict, source: "rule" as const };
  }, [verdict, aiVerdict, mealTotal, mealMacros, dayKcal, training, result]);

  async function pick(fromCamera: boolean) {
    setError(null);
    if (!account) {
      onRequireAuth();
      return;
    }
    if (!isPro && (account.scansLeft ?? 0) <= 0) {
      navigation.navigate("Payment");
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

  // Single dispatcher for every Add / Track option so auth/paywall/navigation
  // checks stay consistent across Home and the dedicated Scan hub.
  function handleAddOption(option: AddOptionKey) {
    if (!account) {
      onRequireAuth();
      return;
    }
    if (option === "camera") {
      navigation.navigate("Scan", { mode: "camera" });
      return;
    }
    if (option === "gallery") {
      navigation.navigate("Scan", { mode: "gallery" });
      return;
    }
    if (option === "barcode") {
      navigation.navigate("BarcodeLookup");
      return;
    }
    if (option === "manual") {
      navigation.navigate("ManualSearch");
      return;
    }
    if (option === "template") {
      navigation.navigate("TemplateMeals");
      return;
    }
    // Non-meal trackers -- each routes to a real, already-implemented flow.
    if (option === "exercise") {
      navigation.navigate("ExerciseLog");
      return;
    }
    if (option === "water") {
      navigation.navigate("WaterLog");
      return;
    }
    if (option === "weight") {
      navigation.navigate("WeightLog");
      return;
    }
    // Voice logging flow.
    navigation.navigate("DescribeMeal");
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
    // Fetch "goes well with" sides for the recognised dishes. Non-blocking and
    // best-effort: pairings are a bonus, never a reason to fail the result.
    setPairings([]);
    const names = items.map((it) => it.item).filter(Boolean);
    if (names.length) {
      getCombos(names)
        .then((ps) => setPairings(ps))
        .catch(() => setPairings([]));
    }
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
        navigation.navigate("Payment");
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
    const before = result?.items[index];
    const scanResultId = result?.scan_result_id;
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

  // "Goes well with": append a suggested accompaniment as a new item (count from
  // the combo default; the user still tweaks it with the stepper). Remove it
  // from the suggestion row once added so it can't be added twice.
  function addPairing(p: Pairing) {
    setResult((prev) =>
      prev ? { ...prev, items: [...prev.items, itemFromSuggestion(p, p.count ?? 1)] } : prev
    );
    setPairings((cur) => cur.filter((x) => x.key !== p.key));
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
    const { micros, hasData } = sumMealMicros(result.items);
    const meal: Meal = {
      dish: result.dish,
      kcal: mealTotal,
      protein_g: mealMacros.protein_g,
      carbs_g: mealMacros.carbs_g,
      fat_g: mealMacros.fat_g,
      at: Date.now(),
      ...(hasData ? { micros } : {}),
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
    // Correction engine: learn the portions the user settled on for each food,
    // so next time this account scans the same item we pre-fill their usual.
    void rememberPortions(account?.id ?? null, result.items).then((m) => {
      portionMemory.current = m;
    });
    setResult(null);
    setPhoto(null);
    setLearnedIdx({});
    setPairings([]);
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

  const shareDateLabel = useMemo(() => prettyDate(today), [today]);

  // Set / toggle today's training context (tap a selected chip to clear it).
  function pickTraining(ctx: TrainingContext) {
    const next = training === ctx ? null : ctx;
    setTraining(next);
    void saveTrainingContext(account?.id ?? null, today, next);
  }

  // "What to eat next" -- deterministic, recomputed as the day's totals change.
  // The candidate pool blends the built-in ideas, the user's own recent/favourite
  // meals (boosted so it feels personal), and real diet-appropriate foods from
  // the DB (accurate nutrition + variety). Today's training context biases which
  // ones win (carbs before endurance, protein for lifting). We surface several
  // ranked options and let the user shuffle for more, so it never feels canned.
  const [mealShuffle, setMealShuffle] = useState(0);
  const nextPlan = useMemo(() => {
    // Database-first by default: use ranked DB candidates + user recents.
    // Hardcoded ideas are an emergency-only fallback when nothing else exists.
    const recentsPool = recentsToCandidates(recents);
    const candidates: Candidate[] =
      dbPool.length > 0
        ? [...recentsPool, ...dbPool]
        : recentsPool.length > 0
          ? recentsPool
          : BASE_CANDIDATES;
    return computeSuggestions(
      { kcal: dayKcal, protein_g: dm.protein_g, carbs_g: dm.carbs_g, fat_g: dm.fat_g },
      goal,
      profile,
      new Date(),
      training,
      candidates,
      { count: 3, offset: mealShuffle * 3 },
    );
  }, [dayKcal, dm.protein_g, dm.carbs_g, dm.fat_g, goal, profile.diet, profile.goal, training, recents, dbPool, mealShuffle]);

  // Fuelling tip for today's training context (null when none selected).
  const trainTip = useMemo(
    () =>
      training
        ? trainingTip(
            training,
            {
              kcal: Math.max(0, goal.kcal - dayKcal),
              protein_g: Math.max(0, goal.protein_g - dm.protein_g),
              carbs_g: Math.max(0, goal.carbs_g - dm.carbs_g),
              fat_g: Math.max(0, goal.fat_g - dm.fat_g),
            },
            goal,
            profile,
          )
        : null,
    [training, dayKcal, dm.protein_g, dm.carbs_g, dm.fat_g, goal, profile.goal],
  );

  // Daily micronutrient roll-up (from DB-matched foods only -- see micros.ts).
  const micro = useMemo(() => dayMicros(logs, today), [logs, today]);
  const fibreRow = micro.rows.find((r) => r.key === "fiber_g");

  const pct = Math.min(100, Math.round((dayKcal / goal.kcal) * 100));

  // Each dashboard module rendered on demand in the user's chosen order. These
  // are the exact sections that were previously hard-coded top-to-bottom in the
  // scroll; order + visibility now come from the synced layout.
  function renderModule(key: HomeModuleKey): React.ReactNode {
    switch (key) {
      case "summary":
        return (
          <View style={styles.dayCard}>
            <Text style={styles.dayLabel}>TODAY&apos;S NUTRITION</Text>
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
        );
      case "todayPlan":
        return (
          <TodayPlanCard
            goal={goal}
            diet={profile.diet}
            goalName={profile.goal}
            date={today}
            account={account}
            onRequireAuth={onRequireAuth}
            training={training}
            aiMode={AI_PLANNER_FULL_MODE}
            profileContext={plannerProfile}
            onPlanResolved={(p) => setPlanNextMealName((p.next_meal || "").trim())}
            fiberTarget={fibreRow?.target}
            consumed={{
              kcal: dayKcal,
              protein_g: dm.protein_g,
              carbs_g: dm.carbs_g,
              fat_g: dm.fat_g,
              ...(fibreRow ? { fiber_g: fibreRow.have } : {}),
            }}
          />
        );
      case "training":
        return (
          <View style={styles.trainCard}>
            <View style={styles.trainHeadRow}>
              <Icon name="pulse" size={14} color={colors.green} />
              <Text style={styles.trainHead}>Today's training</Text>
            </View>
            <View style={styles.trainChips}>
              {TRAINING_META.map((m) => {
                const on = training === m.key;
                return (
                  <Pressable
                    key={m.key}
                    onPress={() => pickTraining(m.key)}
                    style={[styles.trainChip, on && styles.trainChipOn]}
                  >
                    <Icon name={m.icon} size={13} color={on ? "#fff" : colors.inkSoft} />
                    <Text style={[styles.trainChipText, on && styles.trainChipTextOn]}>{m.label}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={styles.trainHint}>
              {trainTip ?? "Tag today's plan and we'll tune your next-meal and fuelling tips to match."}
            </Text>
          </View>
        );
      case "nextMeal":
        const optionsRaw = nextMove
          ? [nextMove.meal, ...(nextMove.alternatives ?? [])]
          : nextPlan.options.map((o) => ({
              name: o.name,
              kcal: o.kcal,
              protein_g: 0,
              carbs_g: 0,
              fat_g: 0,
              items: [],
            }));
        const options = nextMove
          ? (() => {
              if (!planNextMealName) return optionsRaw;
              const ban = planNextMealName.trim().toLowerCase();
              const filtered = optionsRaw.filter((m) => m.name.trim().toLowerCase() !== ban);
              return filtered.length > 0 ? filtered : optionsRaw;
            })()
          : optionsRaw;
        const selected = options[Math.max(0, nextMove ? (nextMoveChoice % options.length) : 0)];
        const alternatives = nextMove
          ? options.filter((_, idx) => idx !== (nextMoveChoice % options.length))
          : nextPlan.options.slice(1).map((o) => ({
              name: o.name,
              kcal: o.kcal,
              protein_g: 0,
              carbs_g: 0,
              fat_g: 0,
              items: [],
            }));
        const nextMovePayload = {
          category: nextMove?.category ?? "",
          slot: nextMove?.slot ?? "",
          reason: nextMove?.reason ?? nextPlan.rationale,
          biggestGap,
          selected: selected
            ? {
                name: selected.name,
                kcal: selected.kcal ?? 0,
                protein_g: selected.protein_g ?? 0,
                carbs_g: selected.carbs_g ?? 0,
                fat_g: selected.fat_g ?? 0,
              }
            : null,
          alternatives: alternatives.map((opt) => ({
            name: opt.name,
            kcal: opt.kcal ?? 0,
            protein_g: opt.protein_g ?? 0,
            carbs_g: opt.carbs_g ?? 0,
            fat_g: opt.fat_g ?? 0,
          })),
        };
        return (
          <View style={styles.nextCard}>
            <View style={styles.nextHeaderRow}>
              <View style={styles.nextHeaderTitle}>
                <Icon name="sparkles" size={15} color={colors.green} />
                <Text style={styles.nextHeader}>What should I do next?</Text>
              </View>
              <Pressable
                style={styles.moduleToggleBtn}
                onPress={() => setNextMealExpanded((v) => !v)}
                hitSlop={8}
              >
                <Text style={styles.moduleToggleText}>{nextMealExpanded ? "Hide" : "Show"}</Text>
                <Icon name={nextMealExpanded ? "chevronUp" : "chevronDown"} size={13} color={colors.green} />
              </Pressable>
            </View>
            {!nextMealExpanded ? (
              <Text style={styles.nextCollapsedText}>
                {selected?.name ? `Next meal: ${selected.name}` : "Tap Show to view your next best move."}
              </Text>
            ) : (
              <>
                <Text style={styles.nextMoveTitle}>Your next best move</Text>
                {!!nextMove?.category && (
                  <View style={styles.nextCategoryPill}>
                    <Text style={styles.nextCategoryText}>{nextMove.category.replace(/_/g, " ")}</Text>
                  </View>
                )}
                <View style={styles.nextFocusRow}>
                  {(nextMove ? [`${selected?.protein_g ?? 0}g protein`, `${selected?.kcal ?? 0} kcal`] : nextPlan.focus).map((f) => (
                    <View key={f} style={styles.nextChip}>
                      <Text style={styles.nextChipText}>{f}</Text>
                    </View>
                  ))}
                </View>
                {!!selected && (
                  <View style={styles.nextMainCard}>
                    <Text style={styles.nextMainName}>{selected.name}</Text>
                    <Text style={styles.nextMainMeta}>
                      {selected.kcal > 0 ? `~${selected.kcal} kcal` : "Light option"}
                      {nextMove ? ` · P ${Math.round(selected.protein_g)}g · C ${Math.round(selected.carbs_g)}g · F ${Math.round(selected.fat_g)}g` : ""}
                    </Text>
                  </View>
                )}
                {alternatives.map((opt, i) => (
                  <Text key={`${opt.name}-${i}`} style={styles.nextIdea}>
                    <Text style={styles.nextIdeaLabel}>Swap option: </Text>
                    {opt.name}
                    {opt.kcal > 0 ? <Text style={styles.nextIdeaKcal}>{`  ~${opt.kcal} kcal`}</Text> : null}
                  </Text>
                ))}
                <Text style={styles.nextGap}>{biggestGap}</Text>
                <Text style={styles.nextRationale}>{nextMove?.reason ?? nextPlan.rationale}</Text>
                {!!aiSuggestion && nextPlan.options[0]?.source === "db" && (
                  <View style={styles.nextCoachRow}>
                    <Icon name="nutrition" size={12} color={colors.mute} />
                    <Text style={styles.nextCoach}>{aiSuggestion}</Text>
                  </View>
                )}
                <View style={styles.nextActions}>
                  <PressableScale style={[styles.btn, styles.btnPrimary, styles.nextActionBtn]} onPress={() => navigation.navigate("ScanHub")}>
                    <Icon name="plus" size={15} color="#fff" />
                    <Text style={styles.btnPrimaryText}>Log this now</Text>
                  </PressableScale>
                  <Pressable
                    style={styles.nextMoreBtn}
                    onPress={() => {
                      if (nextMove && options.length > 1) {
                        setNextMoveChoice((n) => n + 1);
                      } else {
                        setMealShuffle((n) => n + 1);
                      }
                    }}
                    hitSlop={8}
                  >
                    <Icon name="refresh" size={13} color={colors.green} />
                    <Text style={styles.nextMoreText}>Swap</Text>
                  </Pressable>
                </View>
                <Pressable
                  style={styles.nextOpenScreenBtn}
                  onPress={() => navigation.navigate("NextMove" as never, nextMovePayload as never)}
                >
                  <Icon name="chevronRight" size={13} color={colors.green} />
                  <Text style={styles.nextOpenScreenText}>Open full screen</Text>
                </Pressable>
              </>
            )}
          </View>
        );
      case "addHub":
        const addMeta = Object.fromEntries(HOME_ADD_OPTIONS.map((o) => [o.key, o]));
        const quickItems: Array<{ key: AddOptionKey | "more"; label: string; icon: IconName }> = [
          ...HOME_ADD_QUICK.map((k) => ({
            key: k,
            label: k === "camera" ? "Scan" : k === "gallery" ? "Gallery" : k === "voice" ? "Voice" : "Weight",
            icon: addMeta[k]?.icon ?? "plus",
          })),
          { key: "more", label: "More", icon: "chevronDown" },
        ];
        return (
          <View style={styles.addHubCard}>
            <View style={styles.addHubHead}>
              <Icon name="plus" size={15} color={colors.green} />
              <Text style={styles.addHubTitle}>Add / Track</Text>
            </View>
            <Text style={styles.addHubSub}>Five quick actions. Tap More for scan hub and all options.</Text>
            <View style={styles.addHubQuickRow}>
              {quickItems.map((item) => (
                <Pressable
                  key={item.key}
                  style={styles.addHubQuickBtn}
                  onPress={() => (item.key === "more" ? navigation.navigate("ScanHub") : handleAddOption(item.key))}
                  accessibilityLabel={item.key === "more" ? "Open more options" : addMeta[item.key]?.label}
                >
                  <Icon name={item.icon} size={18} color={colors.green} />
                  <Text style={styles.addHubChipQuickText}>{item.label}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        );
      case "calendar":
        return (
          <View style={styles.calendarCard}>
            <View style={styles.calendarHead}>
              <Icon name="time" size={15} color={colors.green} />
              <Text style={styles.calendarTitle}>Consistency calendar</Text>
            </View>
            <Text style={styles.calendarSub}>
              {streakWindow.hits} on target · {streakWindow.logged} logged · tap a day to view
            </Text>
            <View style={styles.calendarWeekRow}>
              {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
                <Text key={`${d}-${i}`} style={styles.calendarWeekText}>{d}</Text>
              ))}
            </View>
            <View style={styles.calendarGrid}>
              {Array.from({ length: streakWindow.leading }).map((_, i) => (
                <View key={`lead-${i}`} style={styles.calendarCellBlank} />
              ))}
              {streakWindow.cells.map((c) => (
                <Pressable
                  key={c.date}
                  style={[
                    styles.calendarCell,
                    c.state === "hit"
                      ? styles.calendarCellHit
                      : c.state === "over"
                        ? styles.calendarCellOver
                        : c.state === "under"
                          ? styles.calendarCellUnder
                          : styles.calendarCellEmpty,
                  ]}
                  onPress={() => setPreviewDateKey(c.date)}
                >
                  <Text style={styles.calendarCellDay}>{c.day}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        );
      case "streak":
        return (
          <View style={styles.streakSummaryCard}>
            <View style={styles.streakSummaryHead}>
              <Icon name="trophy" size={16} color={colors.green} />
              <Text style={styles.streakSummaryTitle}>Last 30 days</Text>
            </View>
            <Text style={styles.streakSummarySub}>
              {last30Summary.onTarget} days on target · {last30Summary.logged} logged · {last30Summary.over} over target
            </Text>
            <Pressable style={styles.streakSummaryBtn} onPress={() => navigation.navigate("Progress")}>
              <Icon name="chevronRight" size={13} color={colors.green} />
              <Text style={styles.streakSummaryBtnText}>Open progress details</Text>
            </Pressable>
          </View>
        );
      case "micros":
        return AI_COACH_ENABLED ? (
          <View style={styles.microCard}>
            <View style={styles.microHeadRow}>
              <Icon name="nutrition" size={15} color={colors.green} />
              <Text style={styles.microHead}>Micronutrients today</Text>
            </View>
            {micro.trackedMeals > 0 ? (
              <>
                {micro.rows.map((r) => {
                  const barColor =
                    r.state === "ok" ? colors.green : r.state === "low" ? colors.carbs : colors.red;
                  const fill = Math.min(100, r.pct);
                  return (
                    <View key={r.key} style={styles.microRow}>
                      <View style={styles.microTop}>
                        <Text style={styles.microLabel}>
                          {r.label}
                          {r.kind === "limit" ? <Text style={styles.microNote}>  · keep under</Text> : null}
                        </Text>
                        <Text style={styles.microVal}>
                          {r.have}
                          <Text style={styles.microTarget}>
                            {" "}
                            / {r.target} {r.unit}
                          </Text>
                        </Text>
                      </View>
                      <View style={styles.microTrack}>
                        <View style={[styles.microFill, { width: `${fill}%`, backgroundColor: barColor }]} />
                      </View>
                    </View>
                  );
                })}
                <Text style={styles.microFoot}>
                  From {micro.trackedMeals} of {micro.totalMeals} logged{" "}
                  {micro.totalMeals === 1 ? "meal" : "meals"}
                  {micro.estimatedMeals > 0
                    ? ` (${micro.estimatedMeals} AI-estimated, not verified)`
                    : " matched to our food database"}
                  . Reference intakes for a healthy adult — not medical advice.
                </Text>
              </>
            ) : (
              <Text style={styles.microEmpty}>
                Log a food from a barcode or the food database to see fibre, iron, sodium and more vs
                your daily targets. Photo-only estimates don't carry full micronutrient data yet.
              </Text>
            )}
          </View>
        ) : null;
      case "wellness":
        return (
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
        );
      case "exercise":
        return (
          <PressableScale style={styles.exerciseCard} onPress={() => navigation.navigate("ExerciseLog")}>
            <View style={styles.exerciseIcon}>
              <Icon name="dumbbell" size={18} color={colors.green} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.exerciseTitle}>Exercise</Text>
              <Text style={styles.exerciseSub}>
                {exerciseKcal > 0
                  ? `${Math.round(exerciseKcal)} kcal burned today · tap to add more`
                  : "Quick log or guided workouts with demo photos"}
              </Text>
            </View>
            <Icon name="chevronRight" size={18} color={colors.mute} />
          </PressableScale>
        );
      default:
        return null;
    }
  }

  return (
    <View style={styles.root}>
      <LinearGradient colors={gradients.brand} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.header}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.brand}>{APP_NAME}</Text>
            <Text style={styles.tagline}>{APP_TAGLINE}</Text>
            <Text style={styles.taglineSub}>{APP_SUBTAGLINE}</Text>
          </View>
          <View style={styles.streakPill}>
            <Icon name="flame" size={15} color="#FFD8A8" />
            <Text style={styles.streakText}>{streak}</Text>
          </View>
        </View>
      </LinearGradient>

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <View style={styles.customizeRow}>
          <Pressable style={styles.customizeBtn} onPress={() => setShowCustomize(true)} hitSlop={6}>
            <Icon name="settings" size={13} color={colors.mute} />
            <Text style={styles.customizeText}>Customize</Text>
          </Pressable>
        </View>

        {layoutOrder.map((key) => {
          if (hiddenSet.has(key)) return null;
          const node = renderModule(key);
          return node ? <React.Fragment key={key}>{node}</React.Fragment> : null;
        })}

        {account && !isPro && (
          <Pressable style={styles.trialChip} onPress={() => (scansLeft && scansLeft > 0 ? null : navigation.navigate("Payment"))}>
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

            {pairings.length > 0 && (
              <View style={styles.pairBlock}>
                <View style={styles.qHeaderRow}>
                  <Icon name="plus" size={14} color={colors.green} />
                  <Text style={styles.qHeader}>Goes well with</Text>
                </View>
                <Text style={styles.qSubtitle}>
                  Indian meals are rarely eaten alone — tap to add the usual sides.
                </Text>
                <View style={styles.pairWrap}>
                  {pairings.map((p) => (
                    <Pressable key={p.key} style={styles.pairChip} onPress={() => addPairing(p)}>
                      <Icon name="plus" size={13} color={colors.green} />
                      <Text style={styles.pairChipText}>{p.name}</Text>
                      <Text style={styles.pairChipKcal}>
                        {Math.round((p.count ?? 1) * p.kcal_per_unit)} kcal
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            )}

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

            {shownVerdict && shownVerdict.lines.length > 0 && (
              <View style={[styles.verdictCard, { borderColor: verdictColor(shownVerdict.overall) }]}>
                <View style={styles.verdictHead}>
                  <View style={[styles.verdictDot, { backgroundColor: verdictColor(shownVerdict.overall) }]} />
                  <Text style={styles.verdictTitle}>Should you eat this?</Text>
                  {shownVerdict.source === "ai" && (
                    <View style={styles.verdictAiBadge}>
                      <Icon name="sparkles" size={10} color={colors.green} />
                      <Text style={styles.verdictAiText}>AI</Text>
                    </View>
                  )}
                </View>
                <Text style={[styles.verdictHeadline, { color: verdictColor(shownVerdict.overall) }]}>
                  {shownVerdict.headline}
                </Text>
                {shownVerdict.lines.map((ln, i) => (
                  <View key={i} style={styles.verdictRow}>
                    <View style={[styles.verdictBullet, { backgroundColor: verdictColor(ln.state) }]} />
                    <Text style={styles.verdictLine}>{ln.text}</Text>
                  </View>
                ))}
                <Text style={styles.verdictAdvice}>{shownVerdict.advice}</Text>
                <Text style={styles.verdictFoot}>Guidance based on your day so far — not medical advice.</Text>
              </View>
            )}

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
                  <PressableScale
                    style={[styles.btn, styles.btnPrimary, styles.previewOpenBtn]}
                    onPress={() => {
                      const dateKey = previewDateKey;
                      setPreviewDateKey(null);
                      if (dateKey) navigation.navigate("DayLog", { dateKey });
                    }}
                  >
                    <Icon name="time" size={15} color="#fff" />
                    <Text style={styles.btnPrimaryText}>Open day details</Text>
                  </PressableScale>
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
      {swapIndex !== null && (
        <FoodSearchSheet
          visible={swapIndex !== null}
          replacing={result?.items[swapIndex]?.item ?? null}
          onClose={() => setSwapIndex(null)}
          onPick={(food) => applySwap(swapIndex, food)}
          onRequireAuth={onRequireAuth}
        />
      )}

      {showCustomize && (
        <CustomizeHomeSheet
          visible={showCustomize}
          order={layoutOrder}
          hidden={hiddenSet}
          onClose={() => setShowCustomize(false)}
          onSave={saveLayout}
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
  header: { paddingTop: Platform.OS === "web" ? 20 : 56, paddingBottom: 26, paddingHorizontal: 20, borderBottomLeftRadius: 24, borderBottomRightRadius: 24 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  streakPill: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "rgba(255,255,255,0.18)", borderRadius: 999, paddingHorizontal: 13, paddingVertical: 8 },
  streakText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  brand: { color: "#fff", fontSize: 26, fontWeight: "800", letterSpacing: -0.3 },
  tagline: { color: "#CDEBD9", fontSize: 13, marginTop: 2, fontWeight: "700", lineHeight: 18, maxWidth: 250 },
  taglineSub: { color: "#E4F4EA", fontSize: 11.5, marginTop: 3, fontWeight: "600", maxWidth: 260 },
  body: { padding: 16, paddingBottom: 24, marginTop: -12 },
  customizeRow: { flexDirection: "row", justifyContent: "flex-end", marginBottom: 8 },
  customizeBtn: { flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 4, paddingHorizontal: 6 },
  customizeText: { color: colors.mute, fontWeight: "700", fontSize: 12.5 },
  dayCard: { backgroundColor: colors.card, borderRadius: 22, padding: 20, marginBottom: 16, ...elevation.md },
  nextCard: { backgroundColor: colors.greenTint, borderRadius: 18, padding: 16, marginBottom: 16, gap: 8 },
  nextHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  nextHeaderTitle: { flexDirection: "row", alignItems: "center", gap: 6, flex: 1 },
  nextHeader: { color: colors.green, fontSize: 14, fontWeight: "900" },
  moduleToggleBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.cardMuted,
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 10,
  },
  moduleToggleText: { color: colors.green, fontSize: 12, fontWeight: "800" },
  nextCollapsedText: { color: colors.mute, fontSize: 12.5, fontWeight: "600" },
  nextMoveTitle: { color: colors.ink, fontSize: 18, fontWeight: "900" },
  nextCategoryPill: {
    alignSelf: "flex-start",
    backgroundColor: colors.card,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.line,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  nextCategoryText: { color: colors.inkSoft, fontSize: 11, fontWeight: "800", textTransform: "uppercase" },
  nextMainCard: { backgroundColor: colors.card, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.line },
  nextMainName: { color: colors.ink, fontSize: 15.5, fontWeight: "800" },
  nextMainMeta: { color: colors.mute, fontSize: 12, fontWeight: "700", marginTop: 2 },
  nextGap: { color: colors.inkSoft, fontSize: 12.5, fontWeight: "700" },
  nextFocusRow: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  nextChip: { backgroundColor: colors.white, borderRadius: 999, paddingVertical: 4, paddingHorizontal: 11, borderWidth: 1, borderColor: colors.line },
  nextChipText: { color: colors.ink, fontSize: 11.5, fontWeight: "800" },
  nextIdea: { color: colors.ink, fontSize: 13.5, fontWeight: "700", lineHeight: 19 },
  nextIdeaLabel: { color: colors.green, fontWeight: "900" },
  nextIdeaKcal: { color: colors.mute, fontSize: 12, fontWeight: "700" },
  nextRationale: { color: colors.mute, fontSize: 12, fontWeight: "600", lineHeight: 16 },
  nextCoachRow: { flexDirection: "row", alignItems: "flex-start", gap: 5, marginTop: 8 },
  nextCoach: { flex: 1, color: colors.mute, fontSize: 11.5, fontStyle: "italic", lineHeight: 15 },
  nextActions: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 6 },
  nextActionBtn: { flex: 0, paddingHorizontal: 14, paddingVertical: 11, borderRadius: 12 },
  nextMoreBtn: { flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 8, paddingHorizontal: 10 },
  nextMoreText: { color: colors.green, fontSize: 12.5, fontWeight: "800" },
  nextOpenScreenBtn: { marginTop: 2, alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 4 },
  nextOpenScreenText: { color: colors.green, fontSize: 12.5, fontWeight: "800", textDecorationLine: "underline" },
  addHubCard: { backgroundColor: colors.card, borderRadius: 18, padding: 16, marginBottom: 16, gap: 8, ...elevation.sm },
  addHubHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  addHubTitle: { color: colors.ink, fontSize: 14, fontWeight: "900" },
  addHubSub: { color: colors.mute, fontSize: 12.5, fontWeight: "600" },
  addHubQuickRow: { flexDirection: "row", alignItems: "stretch", gap: 8, marginTop: 2 },
  addHubQuickBtn: {
    flex: 1,
    minHeight: 58,
    backgroundColor: colors.greenTint,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 8,
    paddingHorizontal: 4,
    gap: 2,
  },
  addHubChipQuickText: { color: colors.green, fontSize: 10.5, fontWeight: "800", textAlign: "center" },
  calendarCard: { backgroundColor: colors.card, borderRadius: 18, padding: 16, marginBottom: 16, gap: 8, ...elevation.sm },
  calendarHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  calendarTitle: { color: colors.ink, fontSize: 14, fontWeight: "900" },
  calendarSub: { color: colors.mute, fontSize: 12.5, fontWeight: "600" },
  calendarWeekRow: { flexDirection: "row", marginTop: 2 },
  calendarWeekText: { flex: 1, textAlign: "center", color: colors.faint, fontSize: 11, fontWeight: "700" },
  calendarGrid: { flexDirection: "row", flexWrap: "wrap", marginTop: 2 },
  calendarCellBlank: { width: "14.2857%", height: 34 },
  calendarCell: {
    width: "14.2857%",
    height: 34,
    borderRadius: 10,
    marginBottom: 6,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  calendarCellDay: { color: colors.ink, fontSize: 12, fontWeight: "700" },
  calendarCellHit: { backgroundColor: colors.greenTint, borderColor: colors.green },
  calendarCellOver: { backgroundColor: colors.cardMuted, borderColor: colors.orange },
  calendarCellUnder: { backgroundColor: colors.redTint, borderColor: colors.red },
  calendarCellEmpty: { backgroundColor: colors.bg, borderColor: colors.line },
  streakSummaryCard: { backgroundColor: colors.card, borderRadius: 18, padding: 16, marginBottom: 16, gap: 8, ...elevation.sm },
  streakSummaryHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  streakSummaryTitle: { color: colors.ink, fontSize: 14, fontWeight: "900" },
  streakSummarySub: { color: colors.mute, fontSize: 12.5, fontWeight: "600" },
  streakSummaryBtn: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: colors.greenTint, borderRadius: 999, paddingVertical: 6, paddingHorizontal: 10 },
  streakSummaryBtnText: { color: colors.green, fontSize: 12, fontWeight: "800" },
  previewOverlay: { flex: 1, justifyContent: "flex-end" },
  previewBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.35)" },
  previewSheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: 16,
    paddingBottom: 20,
    gap: 10,
    maxHeight: "70%",
    ...elevation.md,
  },
  previewHeadRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  previewHead: { color: colors.ink, fontSize: 16, fontWeight: "900" },
  previewSub: { color: colors.mute, fontSize: 12, fontWeight: "600", marginTop: 2 },
  previewCloseBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.cardMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  previewLoadingRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8 },
  previewLoadingText: { color: colors.mute, fontSize: 12.5, fontWeight: "600" },
  previewNextPill: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    backgroundColor: colors.greenTint,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  previewNextText: { color: colors.green, fontSize: 12, fontWeight: "800" },
  previewSlotsWrap: { borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8, gap: 8 },
  previewSlotRow: { backgroundColor: colors.bg, borderRadius: 12, paddingVertical: 9, paddingHorizontal: 10, gap: 2 },
  previewSlotName: { color: colors.inkSoft, fontSize: 11.5, fontWeight: "800", textTransform: "uppercase" },
  previewSlotMeal: { color: colors.ink, fontSize: 13, fontWeight: "700" },
  previewSlotKcal: { color: colors.mute, fontSize: 11.5, fontWeight: "700" },
  previewOpenBtn: { marginTop: 4 },
  previewEmpty: { color: colors.mute, fontSize: 12.5, fontWeight: "600", lineHeight: 18 },

  trainCard: { backgroundColor: colors.card, borderRadius: 18, padding: 16, marginBottom: 16, gap: 10, ...elevation.sm },
  trainHeadRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  trainHead: { color: colors.ink, fontSize: 14, fontWeight: "900" },
  trainChips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  trainChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: colors.cardMuted,
    borderRadius: 999,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.line,
  },
  trainChipOn: { backgroundColor: colors.green, borderColor: colors.green },
  trainChipText: { color: colors.inkSoft, fontSize: 12, fontWeight: "800" },
  trainChipTextOn: { color: "#fff" },
  trainHint: { color: colors.mute, fontSize: 12, fontWeight: "600", lineHeight: 17 },

  microCard: { backgroundColor: colors.card, borderRadius: 18, padding: 16, marginBottom: 16, gap: 10, ...elevation.sm },
  microHeadRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 2 },
  microHead: { color: colors.ink, fontSize: 14, fontWeight: "900" },
  microRow: { gap: 5 },
  microTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  microLabel: { color: colors.inkSoft, fontSize: 12.5, fontWeight: "700" },
  microNote: { color: colors.mute, fontSize: 10.5, fontWeight: "600" },
  microVal: { color: colors.ink, fontSize: 12.5, fontWeight: "800" },
  microTarget: { color: colors.mute, fontSize: 11, fontWeight: "600" },
  microTrack: { height: 6, borderRadius: 3, backgroundColor: colors.cardMuted, overflow: "hidden" },
  microFill: { height: "100%", borderRadius: 3 },
  microFoot: { color: colors.mute, fontSize: 11, fontWeight: "500", lineHeight: 15, marginTop: 2 },
  microEmpty: { color: colors.mute, fontSize: 12.5, fontWeight: "500", lineHeight: 17 },
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
  exerciseCard: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.card, borderRadius: 18, padding: 14, marginBottom: 16, ...elevation.sm },
  exerciseIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.cardMuted, alignItems: "center", justifyContent: "center" },
  exerciseTitle: { color: colors.ink, fontSize: 15, fontWeight: "900" },
  exerciseSub: { color: colors.mute, fontSize: 12.5, fontWeight: "600", marginTop: 2 },
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
  pairBlock: { marginTop: 14, padding: 12, borderRadius: 14, backgroundColor: colors.greenTint, gap: 10 },
  pairWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  pairChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 20,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.green,
  },
  pairChipText: { fontSize: 13, fontWeight: "800", color: colors.ink },
  pairChipKcal: { fontSize: 11, fontWeight: "700", color: colors.mute },
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
  verdictCard: { marginTop: 14, borderWidth: 1.5, borderRadius: 14, padding: 14, backgroundColor: colors.bg },
  verdictHead: { flexDirection: "row", alignItems: "center", gap: 7 },
  verdictDot: { width: 9, height: 9, borderRadius: 5 },
  verdictTitle: { fontSize: 13, fontWeight: "800", color: colors.ink },
  verdictAiBadge: { flexDirection: "row", alignItems: "center", gap: 3, marginLeft: "auto", backgroundColor: colors.card, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2 },
  verdictAiText: { fontSize: 10, fontWeight: "800", color: colors.green },
  verdictHeadline: { fontSize: 15, fontWeight: "800", marginTop: 6 },
  verdictRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 },
  verdictBullet: { width: 7, height: 7, borderRadius: 4 },
  verdictLine: { flex: 1, fontSize: 12.5, color: colors.ink, lineHeight: 17 },
  verdictAdvice: { fontSize: 13, fontWeight: "700", color: colors.ink, marginTop: 11, lineHeight: 18 },
  verdictFoot: { fontSize: 10.5, color: colors.mute, marginTop: 8 },
  empty: { textAlign: "center", color: colors.mute, marginTop: 24, paddingHorizontal: 20, lineHeight: 20 },
});
