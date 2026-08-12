import React, { useMemo, useRef, useState } from "react";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { captureRef } from "react-native-view-shot";
import * as Sharing from "expo-sharing";
import { colors, elevation, radius, type as T } from "./theme";
import Icon from "./Icon";
import PressableScale from "./PressableScale";
import { generatePlan, PRESETS, MEAL_MODES, Plan, PlanInput, SlotKey } from "./proteinPlan";
import { LogMap, Meal, saveLogs, todayKey } from "./storage";
import PlanShareCard from "./PlanShareCard";

type Props = {
  visible: boolean;
  onClose: () => void;
  defaultProtein: number; // from the user's goal
  setLogs: React.Dispatch<React.SetStateAction<LogMap>>;
};

type Mode = "day" | SlotKey;

function clampInt(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(v)));
}

export default function BudgetProtein({ visible, onClose, defaultProtein, setLogs }: Props) {
  const [budget, setBudget] = useState(120);
  const [veg, setVeg] = useState(true);
  const [target, setTarget] = useState(clampInt(defaultProtein || 90, 20, 250));
  const [mode, setMode] = useState<Mode>("day");
  const [added, setAdded] = useState(false);
  const [seed, setSeed] = useState(0); // 0 = deterministic best; >0 = shuffled
  const shareRef = useRef<View>(null);

  const plan: Plan = useMemo(
    () =>
      generatePlan({
        budget,
        targetProtein: target,
        veg,
        seed,
        slot: mode === "day" ? undefined : mode,
      } as PlanInput),
    [budget, target, veg, seed, mode]
  );

  function shuffle() {
    setSeed((s) => (s === 0 ? 1 : s + 1));
    setAdded(false);
  }

  function selectMode(m: Mode) {
    setMode(m);
    setSeed(0);
    setAdded(false);
  }

  async function sharePlan() {
    if (!plan.items.length) return;
    try {
      const uri = await captureRef(shareRef, { format: "png", quality: 1 });
      if (Platform.OS === "web") {
        window.open(uri, "_blank");
        return;
      }
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri);
    } catch {
      // sharing is best-effort
    }
  }

  function applyPreset(p: (typeof PRESETS)[number]) {
    setBudget(p.budget);
    setVeg(p.veg);
    setSeed(0);
    setAdded(false);
  }

  function addToDay() {
    if (!plan.items.length) return;
    const scopeLabel =
      mode === "day" ? "Protein plan" : MEAL_MODES.find((m) => m.key === mode)?.label ?? "Meal";
    const meal: Meal = {
      dish: `${scopeLabel} · ₹${plan.cost}`,
      kcal: plan.kcal,
      protein_g: plan.protein_g,
      carbs_g: 0,
      fat_g: 0,
      at: Date.now(),
    };
    const today = todayKey();
    setLogs((prev) => {
      const day = prev[today] ?? { date: today, meals: [] };
      const next: LogMap = { ...prev, [today]: { ...day, meals: [...day.meals, meal] } };
      saveLogs(next);
      return next;
    });
    setAdded(true);
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.grip} />
          <View style={styles.headRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Budget protein plan</Text>
              <Text style={styles.subtitle}>
                {mode === "day" ? "A day of Indian meals on a budget" : `Plan your ${MEAL_MODES.find((m) => m.key === mode)?.label.toLowerCase()}`}
              </Text>
            </View>
            <Pressable onPress={shuffle} hitSlop={10} style={styles.shuffleBtn}>
              <Icon name="scan" size={16} color={colors.green} />
              <Text style={styles.shuffleTxt}>Surprise me</Text>
            </Pressable>
            <Pressable onPress={onClose} hitSlop={10} style={styles.closeBtn}>
              <Icon name="close" size={20} color={colors.mute} />
            </Pressable>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 8 }}>
            {/* Meal mode: full day or a single meal */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.modeRow}>
              {MEAL_MODES.map((m) => {
                const on = mode === m.key;
                return (
                  <Pressable key={m.key} style={[styles.mode, on && styles.modeOn]} onPress={() => selectMode(m.key as Mode)}>
                    <Text style={[styles.modeTxt, on && styles.modeTxtOn]}>{m.label}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>

            {/* Presets */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.presetRow}>
              {PRESETS.map((p) => (
                <Pressable key={p.id} style={styles.preset} onPress={() => applyPreset(p)}>
                  <Text style={styles.presetLabel}>{p.label}</Text>
                  <Text style={styles.presetNote}>{p.note}</Text>
                </Pressable>
              ))}
            </ScrollView>

            {/* Veg toggle */}
            <View style={styles.toggleRow}>
              <Pressable style={[styles.toggle, veg && styles.toggleOn]} onPress={() => setVeg(true)}>
                <Text style={[styles.toggleTxt, veg && styles.toggleTxtOn]}>Veg</Text>
              </Pressable>
              <Pressable style={[styles.toggle, !veg && styles.toggleOn]} onPress={() => setVeg(false)}>
                <Text style={[styles.toggleTxt, !veg && styles.toggleTxtOn]}>Non-veg</Text>
              </Pressable>
            </View>

            {/* Steppers */}
            <View style={styles.stepCard}>
              <Stepper
                label={mode === "day" ? "Daily budget" : "Meal budget"}
                value={`₹${budget}`}
                onMinus={() => { setBudget((b) => clampInt(b - 10, 30, 500)); setAdded(false); }}
                onPlus={() => { setBudget((b) => clampInt(b + 10, 30, 500)); setAdded(false); }}
              />
              <View style={styles.stepDivider} />
              <Stepper
                label="Protein target"
                value={`${target} g`}
                onMinus={() => { setTarget((t) => clampInt(t - 5, 20, 250)); setAdded(false); }}
                onPlus={() => { setTarget((t) => clampInt(t + 5, 20, 250)); setAdded(false); }}
              />
            </View>

            {/* Result summary */}
            <View style={styles.summary}>
              <Summary big label="Protein" value={`${plan.protein_g}g`} ok={plan.metTarget} />
              <Summary label="Cost" value={`₹${plan.cost}`} ok={plan.withinBudget} />
              <Summary label="Calories" value={`${plan.kcal}`} />
            </View>

            {!plan.metTarget && (
              <View style={styles.notice}>
                <Icon name="info" size={14} color={colors.orange} />
                <Text style={styles.noticeTxt}>
                  ₹{budget} tops out at {plan.protein_g}g. Raise the budget or lower the target to hit {target}g.
                </Text>
              </View>
            )}

            {/* Meal-slot day plan */}
            {plan.slots.map((slot) => (
              <View key={slot.key} style={styles.slot}>
                <View style={styles.slotHead}>
                  <Text style={styles.slotTitle}>
                    {slot.emoji}  {slot.label}
                  </Text>
                  <Text style={styles.slotMeta}>
                    {slot.protein_g}g · ₹{slot.cost}
                  </Text>
                </View>
                {slot.items.map(({ food, servings }) => (
                  <View key={food.id} style={styles.item}>
                    <View style={styles.itemIcon}>
                      <Icon name={food.veg ? "carbs" : "protein"} size={16} color={colors.green} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.itemName}>
                        {food.name}
                        {servings > 1 ? `  ×${servings}` : ""}
                      </Text>
                      <Text style={styles.itemSub}>
                        {servings > 1 ? `${servings} × ` : ""}
                        {food.serving} · {food.tag}
                      </Text>
                    </View>
                    <View style={styles.itemRight}>
                      <Text style={styles.itemProtein}>{food.protein_g * servings}g</Text>
                      <Text style={styles.itemCost}>₹{food.cost * servings}</Text>
                    </View>
                  </View>
                ))}
              </View>
            ))}

            {!plan.items.length && (
              <Text style={styles.empty}>No foods fit this budget. Try raising it a little.</Text>
            )}
          </ScrollView>

          <View style={styles.ctaRow}>
            <PressableScale
              containerStyle={{ flex: 1 }}
              style={styles.shareBtn}
              onPress={sharePlan}
            >
              <Icon name="share" size={18} color={colors.green} />
              <Text style={styles.shareTxt}>Share</Text>
            </PressableScale>
            <PressableScale
              containerStyle={{ flex: 2 }}
              style={[styles.cta, added && styles.ctaDone]}
              onPress={addToDay}
            >
              <Icon name={added ? "check" : "plus"} size={18} color="#fff" />
              <Text style={styles.ctaTxt}>{added ? "Added to today" : "Log to today"}</Text>
            </PressableScale>
          </View>
        </View>
      </View>

      {/* Off-screen card captured for sharing */}
      <View style={styles.offscreen} pointerEvents="none">
        <View ref={shareRef} collapsable={false}>
          <PlanShareCard plan={plan} />
        </View>
      </View>
    </Modal>
  );
}

function Stepper({ label, value, onMinus, onPlus }: { label: string; value: string; onMinus: () => void; onPlus: () => void }) {
  return (
    <View style={styles.stepRow}>
      <Text style={styles.stepLabel}>{label}</Text>
      <View style={styles.stepper}>
        <Pressable style={styles.stepBtn} onPress={onMinus}>
          <Icon name="minus" size={16} color={colors.green} />
        </Pressable>
        <Text style={styles.stepValue}>{value}</Text>
        <Pressable style={styles.stepBtn} onPress={onPlus}>
          <Icon name="plus" size={16} color={colors.green} />
        </Pressable>
      </View>
    </View>
  );
}

function Summary({ label, value, big, ok }: { label: string; value: string; big?: boolean; ok?: boolean }) {
  return (
    <View style={styles.sumBox}>
      <Text style={[styles.sumVal, big && styles.sumValBig, ok === false && styles.sumBad, ok === true && styles.sumGood]}>
        {value}
      </Text>
      <Text style={styles.sumLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(10,20,16,0.45)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.bg, borderTopLeftRadius: 26, borderTopRightRadius: 26, paddingHorizontal: 18, paddingTop: 10, paddingBottom: 20, maxHeight: "92%" },
  grip: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: colors.hairline, marginBottom: 12 },
  headRow: { flexDirection: "row", alignItems: "center", marginBottom: 14 },
  title: { color: colors.ink, fontSize: 20, fontWeight: "800", letterSpacing: -0.3 },
  subtitle: { color: colors.mute, fontSize: 13, marginTop: 2, fontWeight: "600" },
  closeBtn: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.card, alignItems: "center", justifyContent: "center" },
  shuffleBtn: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.greenTint, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8, marginRight: 8 },
  shuffleTxt: { color: colors.green, fontWeight: "800", fontSize: 12.5 },
  presetRow: { gap: 10, paddingRight: 6, paddingBottom: 4 },
  modeRow: { gap: 8, paddingRight: 6, paddingBottom: 12 },
  mode: { backgroundColor: colors.card, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 9, borderWidth: 1, borderColor: colors.hairline },
  modeOn: { backgroundColor: colors.green, borderColor: colors.green },
  modeTxt: { color: colors.mute, fontWeight: "800", fontSize: 13 },
  modeTxtOn: { color: "#fff" },
  preset: { backgroundColor: colors.card, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1, borderColor: colors.hairline },
  presetLabel: { color: colors.ink, fontWeight: "800", fontSize: 13 },
  presetNote: { color: colors.mute, fontSize: 11, marginTop: 2, fontWeight: "600" },
  toggleRow: { flexDirection: "row", gap: 8, marginTop: 14 },
  toggle: { flex: 1, alignItems: "center", paddingVertical: 10, borderRadius: 12, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.hairline },
  toggleOn: { backgroundColor: colors.greenTint, borderColor: colors.green },
  toggleTxt: { color: colors.mute, fontWeight: "800", fontSize: 13 },
  toggleTxtOn: { color: colors.green },
  stepCard: { backgroundColor: colors.card, borderRadius: 16, marginTop: 12, paddingHorizontal: 16, ...elevation.sm },
  stepRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 14 },
  stepDivider: { height: 1, backgroundColor: colors.line },
  stepLabel: { color: colors.ink, fontWeight: "700", fontSize: 14 },
  stepper: { flexDirection: "row", alignItems: "center", gap: 4 },
  stepBtn: { width: 32, height: 32, borderRadius: 10, backgroundColor: colors.greenTint, alignItems: "center", justifyContent: "center" },
  stepValue: { minWidth: 56, textAlign: "center", color: colors.ink, fontWeight: "800", fontSize: 15 },
  summary: { flexDirection: "row", gap: 10, marginTop: 14 },
  sumBox: { flex: 1, backgroundColor: colors.card, borderRadius: 14, paddingVertical: 12, alignItems: "center", ...elevation.sm },
  sumVal: { color: colors.ink, fontSize: 17, fontWeight: "800" },
  sumValBig: { fontSize: 20 },
  sumGood: { color: colors.green },
  sumBad: { color: colors.orange },
  sumLabel: { color: colors.mute, fontSize: 11, fontWeight: "600", marginTop: 2 },
  notice: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.redTint, borderRadius: 12, padding: 10, marginTop: 12 },
  noticeTxt: { flex: 1, color: colors.inkSoft, fontSize: 12, fontWeight: "600" },
  slot: { marginTop: 18 },
  slotHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 2 },
  slotTitle: { color: colors.ink, fontSize: 14, fontWeight: "800", letterSpacing: -0.2 },
  slotMeta: { color: colors.mute, fontSize: 12, fontWeight: "700" },
  item: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.card, borderRadius: 14, padding: 12, marginTop: 8 },
  itemIcon: { width: 34, height: 34, borderRadius: 10, backgroundColor: colors.greenTint, alignItems: "center", justifyContent: "center" },
  itemName: { color: colors.ink, fontWeight: "700", fontSize: 14 },
  itemSub: { color: colors.mute, fontSize: 12, marginTop: 2 },
  itemRight: { alignItems: "flex-end" },
  itemProtein: { color: colors.green, fontWeight: "800", fontSize: 14 },
  itemCost: { color: colors.mute, fontSize: 12, fontWeight: "600", marginTop: 2 },
  empty: { color: colors.mute, textAlign: "center", marginTop: 20, fontSize: 13 },
  cta: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: colors.green, borderRadius: 16, paddingVertical: 15, ...elevation.sm },
  ctaDone: { backgroundColor: colors.greenSoft },
  ctaTxt: { color: "#fff", fontWeight: "800", fontSize: 15 },
  ctaRow: { flexDirection: "row", gap: 10, marginTop: 14 },
  shareBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: colors.card, borderRadius: 16, paddingVertical: 15, borderWidth: 1.5, borderColor: colors.hairline },
  shareTxt: { color: colors.green, fontWeight: "800", fontSize: 15 },
  offscreen: { position: "absolute", left: -1000, top: 0, opacity: 0 },
});
