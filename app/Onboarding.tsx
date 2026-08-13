import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  Activity,
  ACTIVITY_LABELS,
  clamp,
  computeGoal,
  Diet,
  Gender,
  Goal,
  LIMITS,
  Profile,
} from "./nutrition";
import { APP_NAME } from "./config";
import { colors } from "./theme";
import Icon, { IconName } from "./Icon";
import PressableScale from "./PressableScale";

const GREEN = "#0B7A4B";
const BG = "#F4F6F5";
const INK = "#1D2521";
const MUTE = "#8A8F8C";

type Props = { onComplete: (p: Profile) => void };

type Draft = {
  gender?: Gender;
  age: number;
  heightCm: number;
  weightKg: number;
  goal?: Goal;
  targetWeightKg: number;
  activity?: Activity;
  diet?: Diet;
};

const STEPS = [
  "welcome",
  "gender",
  "age",
  "height",
  "weight",
  "goal",
  "target",
  "activity",
  "diet",
  "summary",
] as const;

export default function Onboarding({ onComplete }: Props) {
  const [step, setStep] = useState(0);
  const [d, setD] = useState<Draft>({
    age: 25,
    heightCm: 170,
    weightKg: 70,
    targetWeightKg: 65,
  });

  const key = STEPS[step];
  const progress = step / (STEPS.length - 1);

  const canContinue = useMemo(() => {
    switch (key) {
      case "gender":
        return !!d.gender;
      case "goal":
        return !!d.goal;
      case "activity":
        return !!d.activity;
      case "diet":
        return !!d.diet;
      case "age":
        return d.age >= LIMITS.age.min && d.age <= LIMITS.age.max;
      case "height":
        return d.heightCm >= LIMITS.heightCm.min && d.heightCm <= LIMITS.heightCm.max;
      case "weight":
        return d.weightKg >= LIMITS.weightKg.min && d.weightKg <= LIMITS.weightKg.max;
      case "target":
        return d.targetWeightKg >= LIMITS.weightKg.min && d.targetWeightKg <= LIMITS.weightKg.max;
      default:
        return true;
    }
  }, [key, d]);

  function next() {
    // skip target-weight step when maintaining
    if (key === "goal" && d.goal === "maintain") {
      setD((s) => ({ ...s, targetWeightKg: s.weightKg }));
      setStep((s) => s + 2);
      return;
    }
    if (step < STEPS.length - 1) setStep((s) => s + 1);
  }

  function back() {
    if (key === "activity" && d.goal === "maintain") {
      setStep((s) => s - 2);
      return;
    }
    if (step > 0) setStep((s) => s - 1);
  }

  function finish() {
    const profile: Profile = {
      gender: d.gender!,
      age: d.age,
      heightCm: d.heightCm,
      weightKg: d.weightKg,
      targetWeightKg: d.targetWeightKg,
      goal: d.goal!,
      activity: d.activity!,
      diet: d.diet!,
      createdAt: Date.now(),
    };
    onComplete(profile);
  }

  return (
    <View style={styles.root}>
      {/* Progress */}
      {step > 0 && (
        <View style={styles.progressWrap}>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
          </View>
          <Text style={styles.progressText}>
            Step {step} of {STEPS.length - 2}
          </Text>
        </View>
      )}

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {key === "welcome" && <Welcome />}

        {key === "gender" && (
          <Question title="What's your gender?" sub="We use this to estimate your metabolism accurately.">
            <Option label="Male" selected={d.gender === "male"} onPress={() => setD({ ...d, gender: "male" })} />
            <Option label="Female" selected={d.gender === "female"} onPress={() => setD({ ...d, gender: "female" })} />
          </Question>
        )}

        {key === "age" && (
          <Question title="How old are you?" sub="Age affects how many calories you burn at rest.">
            <NumberField value={d.age} unit="years" min={LIMITS.age.min} max={LIMITS.age.max}
              onChange={(v) => setD({ ...d, age: v })} />
          </Question>
        )}

        {key === "height" && (
          <Question title="How tall are you?" sub="">
            <NumberField value={d.heightCm} unit="cm" step={1} min={LIMITS.heightCm.min} max={LIMITS.heightCm.max}
              onChange={(v) => setD({ ...d, heightCm: v })} />
          </Question>
        )}

        {key === "weight" && (
          <Question title="What's your current weight?" sub="">
            <NumberField value={d.weightKg} unit="kg" min={LIMITS.weightKg.min} max={LIMITS.weightKg.max}
              onChange={(v) => setD({ ...d, weightKg: v })} />
          </Question>
        )}

        {key === "goal" && (
          <Question title="What's your goal?" sub="We'll set your daily calorie target accordingly.">
            <Option label="Lose weight" sublabel="Calorie deficit (~0.45 kg/week)" selected={d.goal === "lose"} onPress={() => setD({ ...d, goal: "lose" })} />
            <Option label="Maintain weight" sublabel="Stay at your current weight" selected={d.goal === "maintain"} onPress={() => setD({ ...d, goal: "maintain" })} />
            <Option label="Gain weight" sublabel="Calorie surplus for muscle" selected={d.goal === "gain"} onPress={() => setD({ ...d, goal: "gain" })} />
          </Question>
        )}

        {key === "target" && (
          <Question title="What's your target weight?" sub="A goal to work towards.">
            <NumberField value={d.targetWeightKg} unit="kg" min={LIMITS.weightKg.min} max={LIMITS.weightKg.max}
              onChange={(v) => setD({ ...d, targetWeightKg: v })} />
          </Question>
        )}

        {key === "activity" && (
          <Question title="How active are you?" sub="Include exercise and daily movement.">
            {(Object.keys(ACTIVITY_LABELS) as Activity[]).map((a) => (
              <Option key={a} label={prettyActivity(a)} sublabel={ACTIVITY_LABELS[a]}
                selected={d.activity === a} onPress={() => setD({ ...d, activity: a })} />
            ))}
          </Question>
        )}

        {key === "diet" && (
          <Question title="Your food preference?" sub="Helps us tailor Indian food suggestions.">
            <Option label="Vegetarian" selected={d.diet === "veg"} onPress={() => setD({ ...d, diet: "veg" })} />
            <Option label="Non-vegetarian" selected={d.diet === "nonveg"} onPress={() => setD({ ...d, diet: "nonveg" })} />
            <Option label="Eggetarian" selected={d.diet === "eggetarian"} onPress={() => setD({ ...d, diet: "eggetarian" })} />
            <Option label="Vegan" selected={d.diet === "vegan"} onPress={() => setD({ ...d, diet: "vegan" })} />
            <Option label="Jain" selected={d.diet === "jain"} onPress={() => setD({ ...d, diet: "jain" })} />
            <Option label="Sattvic" selected={d.diet === "sattvic"} onPress={() => setD({ ...d, diet: "sattvic" })} />
          </Question>
        )}

        {key === "summary" && <Summary draft={d} />}
      </ScrollView>

      {/* Footer nav */}
      <View style={styles.footer}>
        {step > 0 && (
          <Pressable style={[styles.navBtn, styles.backBtn]} onPress={back}>
            <Text style={styles.backText}>Back</Text>
          </Pressable>
        )}
        {key === "summary" ? (
          <PressableScale
            containerStyle={{ flex: 1 }}
            style={[styles.navBtn, styles.primaryBtn]}
            onPress={finish}
          >
            <Text style={styles.primaryText}>Start tracking</Text>
            <Icon name="chevronRight" size={18} color="#fff" />
          </PressableScale>
        ) : (
          <PressableScale
            containerStyle={{ flex: 1 }}
            style={[styles.navBtn, styles.primaryBtn, !canContinue && styles.disabled]}
            onPress={canContinue ? next : undefined}
          >
            <Text style={styles.primaryText}>{step === 0 ? "Get started" : "Continue"}</Text>
          </PressableScale>
        )}
      </View>
    </View>
  );
}

function prettyActivity(a: Activity): string {
  return {
    sedentary: "Sedentary",
    light: "Lightly active",
    moderate: "Moderately active",
    active: "Very active",
    very_active: "Extra active",
  }[a];
}

/* ---------- sub-components ---------- */

function Welcome() {
  return (
    <View style={styles.welcome}>
      <View style={styles.logoBadge}>
        <Icon name="scan" size={38} color="#fff" />
      </View>
      <Text style={styles.welcomeTitle}>{APP_NAME}</Text>
      <Text style={styles.welcomeSub}>
        Snap a photo of any Indian meal and get accurate calories and macros — built for
        thalis, dosas, biryani and everything in between.
      </Text>
      <View style={styles.bullets}>
        <Bullet icon="camera" text="Instant photo calorie tracking" />
        <Bullet icon="target" text="A personalized daily goal" />
        <Bullet icon="flame" text="Streaks to keep you consistent" />
      </View>
      <Text style={styles.welcomeNote}>Let's set up your personal plan in under a minute.</Text>
    </View>
  );
}

function Bullet({ icon, text }: { icon: IconName; text: string }) {
  return (
    <View style={styles.bulletRow}>
      <View style={styles.bulletIcon}>
        <Icon name={icon} size={16} color={colors.green} />
      </View>
      <Text style={styles.bullet}>{text}</Text>
    </View>
  );
}

function Question({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <View>
      <Text style={styles.qTitle}>{title}</Text>
      {!!sub && <Text style={styles.qSub}>{sub}</Text>}
      <View style={{ marginTop: 20 }}>{children}</View>
    </View>
  );
}

function Option({
  label,
  sublabel,
  selected,
  onPress,
}: {
  label: string;
  sublabel?: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable style={[styles.option, selected && styles.optionSelected]} onPress={onPress}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.optionLabel, selected && styles.optionLabelSelected]}>{label}</Text>
        {!!sublabel && <Text style={styles.optionSub}>{sublabel}</Text>}
      </View>
      <View style={[styles.radio, selected && styles.radioSelected]}>
        {selected && <View style={styles.radioDot} />}
      </View>
    </Pressable>
  );
}

function NumberField({
  value,
  unit,
  min,
  max,
  step = 1,
  onChange,
}: {
  value: number;
  unit: string;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  // Keep the latest value in a ref so the hold-to-repeat interval always reads
  // the current number instead of the one captured when the press started.
  const valueRef = useRef(value);
  valueRef.current = value;
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const bump = (dir: number) => onChange(clamp(valueRef.current + dir * step, min, max));

  const stopHold = () => {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    if (repeatTimer.current) {
      clearInterval(repeatTimer.current);
      repeatTimer.current = null;
    }
  };

  // Fire once immediately on press, then (if still held) auto-repeat.
  const startHold = (dir: number) => {
    stopHold();
    bump(dir);
    holdTimer.current = setTimeout(() => {
      repeatTimer.current = setInterval(() => bump(dir), 80);
    }, 350);
  };

  // Clean up any running timers if the field unmounts mid-hold.
  useEffect(() => stopHold, []);

  return (
    <View style={styles.numberField}>
      <Pressable
        style={({ pressed }) => [styles.numBtn, pressed && styles.numBtnPressed]}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel={`Decrease ${unit}`}
        onPressIn={() => startHold(-1)}
        onPressOut={stopHold}
      >
        <Icon name="minus" size={26} color={GREEN} />
      </Pressable>
      <View style={styles.numCenter}>
        <TextInput
          style={styles.numInput}
          keyboardType="numeric"
          value={String(value)}
          onChangeText={(t) => {
            const n = parseInt(t.replace(/[^0-9]/g, ""), 10);
            if (!isNaN(n)) onChange(n);
            else if (t === "") onChange(min);
          }}
          onBlur={() => onChange(clamp(value, min, max))}
        />
        <Text style={styles.numUnit}>{unit}</Text>
      </View>
      <Pressable
        style={({ pressed }) => [styles.numBtn, pressed && styles.numBtnPressed]}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel={`Increase ${unit}`}
        onPressIn={() => startHold(1)}
        onPressOut={stopHold}
      >
        <Icon name="plus" size={26} color={GREEN} />
      </Pressable>
    </View>
  );
}

function Summary({ draft }: { draft: Draft }) {
  const profile: Profile = {
    gender: draft.gender!,
    age: draft.age,
    heightCm: draft.heightCm,
    weightKg: draft.weightKg,
    targetWeightKg: draft.targetWeightKg,
    goal: draft.goal!,
    activity: draft.activity!,
    diet: draft.diet!,
    createdAt: Date.now(),
  };
  const g = computeGoal(profile);
  return (
    <View>
      <Text style={styles.qTitle}>Your daily plan</Text>
      <Text style={styles.qSub}>Calculated from your body metrics and goal.</Text>

      <View style={styles.goalCard}>
        <Text style={styles.goalKcalLabel}>DAILY CALORIE TARGET</Text>
        <Text style={styles.goalKcal}>{g.kcal}</Text>
        <Text style={styles.goalKcalUnit}>kcal / day</Text>

        <View style={styles.macroRow}>
          <MacroPill label="Protein" value={`${g.protein_g}g`} />
          <MacroPill label="Carbs" value={`${g.carbs_g}g`} />
          <MacroPill label="Fat" value={`${g.fat_g}g`} />
        </View>
      </View>

      <View style={styles.statsCard}>
        <StatRow label="Basal metabolic rate (BMR)" value={`${g.bmr} kcal`} />
        <StatRow label="Maintenance (TDEE)" value={`${g.tdee} kcal`} />
        <StatRow
          label="Goal adjustment"
          value={
            profile.goal === "lose" ? "−500 kcal" : profile.goal === "gain" ? "+400 kcal" : "±0 kcal"
          }
        />
      </View>
      <Text style={styles.disclaimer}>
        Estimates for guidance only, not medical advice. You can adjust anytime.
      </Text>
    </View>
  );
}

function MacroPill({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.macroPill}>
      <Text style={styles.macroPillVal}>{value}</Text>
      <Text style={styles.macroPillKey}>{label}</Text>
    </View>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statRow}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

/* ---------- styles ---------- */

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG },
  progressWrap: { paddingTop: 56, paddingHorizontal: 24, paddingBottom: 8 },
  progressTrack: { height: 6, borderRadius: 3, backgroundColor: "#E2E8E4", overflow: "hidden" },
  progressFill: { height: 6, borderRadius: 3, backgroundColor: GREEN },
  progressText: { color: MUTE, fontSize: 12, marginTop: 8, fontWeight: "600" },

  body: { padding: 24, paddingBottom: 24, flexGrow: 1 },

  welcome: { flex: 1, alignItems: "center", justifyContent: "center", paddingTop: 40 },
  logoBadge: { width: 88, height: 88, borderRadius: 26, backgroundColor: GREEN, alignItems: "center", justifyContent: "center", marginBottom: 16 },
  bullets: { marginTop: 28, alignSelf: "stretch", gap: 14 },
  bulletRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  bulletIcon: { width: 34, height: 34, borderRadius: 10, backgroundColor: colors.greenTint, alignItems: "center", justifyContent: "center" },
  bullet: { fontSize: 15, color: INK, fontWeight: "600" },
  welcomeTitle: { fontSize: 30, fontWeight: "900", color: GREEN, marginBottom: 12 },
  welcomeSub: { fontSize: 15, color: INK, textAlign: "center", lineHeight: 22 },
  welcomeNote: { marginTop: 28, color: MUTE, textAlign: "center", fontSize: 13 },

  qTitle: { fontSize: 24, fontWeight: "800", color: INK },
  qSub: { fontSize: 14, color: MUTE, marginTop: 6, lineHeight: 20 },

  option: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 16,
    borderWidth: 2,
    borderColor: "#EAEFEB",
    padding: 18,
    marginBottom: 12,
  },
  optionSelected: { borderColor: GREEN, backgroundColor: "#F0F8F3" },
  optionLabel: { fontSize: 16, fontWeight: "700", color: INK },
  optionLabelSelected: { color: GREEN },
  optionSub: { fontSize: 13, color: MUTE, marginTop: 2 },
  radio: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: "#CBD5D0", alignItems: "center", justifyContent: "center" },
  radioSelected: { borderColor: GREEN },
  radioDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: GREEN },

  numberField: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 20 },
  numBtn: { width: 56, height: 56, borderRadius: 28, backgroundColor: "#fff", borderWidth: 2, borderColor: "#EAEFEB", alignItems: "center", justifyContent: "center" },
  numBtnPressed: { backgroundColor: "#EAF5EE", borderColor: GREEN },
  numCenter: { alignItems: "center", minWidth: 120 },
  numInput: { fontSize: 48, fontWeight: "900", color: INK, textAlign: "center", minWidth: 100, padding: 0 },
  numUnit: { fontSize: 15, color: MUTE, marginTop: -4 },

  goalCard: { backgroundColor: GREEN, borderRadius: 24, padding: 24, marginTop: 24, alignItems: "center" },
  goalKcalLabel: { color: "#9FD6BA", fontSize: 12, fontWeight: "700", letterSpacing: 1 },
  goalKcal: { color: "#fff", fontSize: 60, fontWeight: "900", marginTop: 4 },
  goalKcalUnit: { color: "#CDEBD9", fontSize: 14, marginTop: -6 },
  macroRow: { flexDirection: "row", gap: 10, marginTop: 20, alignSelf: "stretch" },
  macroPill: { flex: 1, backgroundColor: "rgba(255,255,255,0.14)", borderRadius: 14, paddingVertical: 12, alignItems: "center" },
  macroPillVal: { color: "#fff", fontSize: 18, fontWeight: "800" },
  macroPillKey: { color: "#CDEBD9", fontSize: 12, marginTop: 2 },

  statsCard: { backgroundColor: "#fff", borderRadius: 18, padding: 8, marginTop: 16 },
  statRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 12, paddingHorizontal: 12 },
  statLabel: { color: INK, fontSize: 14 },
  statValue: { color: INK, fontSize: 14, fontWeight: "800" },
  disclaimer: { color: MUTE, fontSize: 12, textAlign: "center", marginTop: 16, lineHeight: 18 },

  footer: { flexDirection: "row", gap: 12, padding: 20, paddingBottom: 32, backgroundColor: BG },
  navBtn: { borderRadius: 16, paddingVertical: 16, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 6 },
  primaryBtn: { flex: 1, backgroundColor: GREEN },
  primaryText: { color: "#fff", fontWeight: "800", fontSize: 16 },
  backBtn: { paddingHorizontal: 24, backgroundColor: "#fff", borderWidth: 1, borderColor: "#E2E8E4" },
  backText: { color: INK, fontWeight: "700", fontSize: 16 },
  disabled: { opacity: 0.4 },
});
