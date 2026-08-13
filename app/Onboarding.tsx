import React, { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  Activity,
  ACTIVITY_LABELS,
  clamp,
  computeBmi,
  computeGoal,
  Diet,
  Gender,
  Goal,
  GoalKind,
  GoalPace,
  kgToLb,
  lbToKg,
  cmToIn,
  inToCm,
  formatHeight,
  HeightUnit,
  LIMITS,
  Profile,
  projectPlan,
  tdee,
  WeightUnit,
} from "./nutrition";
import { APP_NAME } from "./config";
import { colors } from "./theme";
import Icon, { IconName } from "./Icon";
import PressableScale from "./PressableScale";
import WheelPicker from "./WheelPicker";
import PaceSlider from "./PaceSlider";

const GREEN = "#0B7A4B";
const BG = "#F4F6F5";
const INK = "#1D2521";
const MUTE = "#8A8F8C";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDate = (d: Date) => `${d.getDate()} ${MONTHS[d.getMonth()]}`;
const fmtKg = (n: number) => `${Math.round(n * 10) / 10}`;

type Props = { onComplete: (p: Profile) => void };

type Draft = {
  gender?: Gender;
  age: number;
  heightCm: number;
  weightKg: number;
  goalKind?: GoalKind;
  targetWeightKg: number;
  goalPace: GoalPace;
  activity?: Activity;
  diet?: Diet;
};

// welcome is index 0; everything after it shows the progress bar. target + pace
// are skipped for goals with no weight change (maintain / general fitness).
const STEPS = [
  "welcome",
  "basics", // gender + age
  "body", // height + weight
  "activity",
  "goal",
  "target",
  "pace",
  "diet",
  "summary",
] as const;

const IDX = STEPS.reduce((m, k, i) => ((m[k] = i), m), {} as Record<(typeof STEPS)[number], number>);

function goalOf(kind: GoalKind): Goal {
  return kind === "loss" ? "lose" : kind === "muscle" ? "gain" : "maintain";
}
const hasWeightTarget = (kind?: GoalKind) => kind === "loss" || kind === "muscle";

export default function Onboarding({ onComplete }: Props) {
  const [step, setStep] = useState(0);
  const [heightUnit, setHeightUnit] = useState<HeightUnit>("cm");
  const [weightUnit, setWeightUnit] = useState<WeightUnit>("kg");
  const [d, setD] = useState<Draft>({
    age: 25,
    heightCm: 170,
    weightKg: 70,
    targetWeightKg: 65,
    goalPace: "recommended",
  });

  const key = STEPS[step];
  const progress = step / (STEPS.length - 1);

  // Animated progress bar (persists all draft values across back/forward — the
  // draft is never reset on navigation).
  const anim = useRef(new Animated.Value(progress)).current;
  useEffect(() => {
    Animated.timing(anim, { toValue: progress, duration: 260, useNativeDriver: false }).start();
  }, [progress, anim]);
  const widthPct = anim.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] });

  const canContinue = useMemo(() => {
    switch (key) {
      case "basics":
        return !!d.gender;
      case "goal":
        return !!d.goalKind;
      case "activity":
        return !!d.activity;
      case "diet":
        return !!d.diet;
      case "target": {
        if (d.goalKind === "loss") return d.targetWeightKg < d.weightKg;
        if (d.goalKind === "muscle") return d.targetWeightKg > d.weightKg;
        return true;
      }
      default:
        return true;
    }
  }, [key, d]);

  function next() {
    // Skip target + pace for maintain / general fitness.
    if (key === "goal" && !hasWeightTarget(d.goalKind)) {
      setD((s) => ({ ...s, targetWeightKg: s.weightKg }));
      setStep(IDX.diet);
      return;
    }
    if (step < STEPS.length - 1) setStep((s) => s + 1);
  }

  function back() {
    if (key === "diet" && !hasWeightTarget(d.goalKind)) {
      setStep(IDX.goal);
      return;
    }
    if (step > 0) setStep((s) => s - 1);
  }

  // Selecting a goal seeds a sensible default target on the correct side of the
  // user's current weight so the target wheel never opens on an invalid value.
  function pickGoal(kind: GoalKind) {
    setD((s) => {
      let target = s.weightKg;
      if (kind === "loss") target = clamp(Math.round(s.weightKg - 5), LIMITS.weightKg.min, s.weightKg - 1);
      else if (kind === "muscle") target = clamp(Math.round(s.weightKg + 4), s.weightKg + 1, LIMITS.weightKg.max);
      return { ...s, goalKind: kind, targetWeightKg: target };
    });
  }

  function finish() {
    const kind = d.goalKind!;
    const profile: Profile = {
      gender: d.gender!,
      age: d.age,
      heightCm: d.heightCm,
      weightKg: d.weightKg,
      targetWeightKg: hasWeightTarget(kind) ? d.targetWeightKg : d.weightKg,
      goal: goalOf(kind),
      goalKind: kind,
      goalPace: d.goalPace,
      activity: d.activity!,
      diet: d.diet!,
      createdAt: Date.now(),
    };
    onComplete(profile);
  }

  return (
    <View style={styles.root}>
      {step > 0 && (
        <View style={styles.progressWrap}>
          <View style={styles.progressTrack}>
            <Animated.View style={[styles.progressFill, { width: widthPct }]} />
          </View>
        </View>
      )}

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {key === "welcome" && <Welcome />}

        {key === "basics" && (
          <Question title="A few basics about you" sub="Used to estimate your nutrition targets.">
            <Text style={styles.fieldLabel}>Gender</Text>
            <Segmented
              options={[
                { key: "male", label: "Male" },
                { key: "female", label: "Female" },
                { key: "other", label: "Other" },
              ]}
              value={d.gender}
              onChange={(g) => setD({ ...d, gender: g as Gender })}
            />
            <Text style={[styles.fieldLabel, { marginTop: 26 }]}>Age</Text>
            <WheelPicker
              min={LIMITS.age.min}
              max={LIMITS.age.max}
              value={d.age}
              unit="yrs"
              onChange={(v) => setD({ ...d, age: v })}
            />
          </Question>
        )}

        {key === "body" && <BodyStep d={d} setD={setD} heightUnit={heightUnit} setHeightUnit={setHeightUnit} weightUnit={weightUnit} setWeightUnit={setWeightUnit} />}

        {key === "activity" && (
          <Question title="How active are you usually?" sub="Include training and everyday movement.">
            {(Object.keys(ACTIVITY_LABELS) as Activity[]).map((a) => (
              <Option
                key={a}
                label={prettyActivity(a)}
                sublabel={ACTIVITY_LABELS[a]}
                selected={d.activity === a}
                onPress={() => setD({ ...d, activity: a })}
              />
            ))}
          </Question>
        )}

        {key === "goal" && (
          <Question title="What's your main goal?" sub="We'll shape your calorie and protein targets around it.">
            <GoalCard icon="flame" title="Weight loss" desc="Fat loss while supporting your daily energy." selected={d.goalKind === "loss"} onPress={() => pickGoal("loss")} />
            <GoalCard icon="dumbbell" title="Muscle gain" desc="Support muscle growth with a higher protein target." selected={d.goalKind === "muscle"} onPress={() => pickGoal("muscle")} />
            <GoalCard icon="target" title="Maintain weight" desc="Stay around your current weight while eating well." selected={d.goalKind === "maintain"} onPress={() => pickGoal("maintain")} />
            <GoalCard icon="heart" title="General fitness" desc="Eat well and stay consistent day to day." selected={d.goalKind === "fitness"} onPress={() => pickGoal("fitness")} />
          </Question>
        )}

        {key === "target" && <TargetStep d={d} setD={setD} weightUnit={weightUnit} />}

        {key === "pace" && <PaceStep d={d} setD={setD} />}

        {key === "diet" && (
          <Question title="Your food preference?" sub="Helps us tailor Indian food suggestions.">
            {([
              ["veg", "Vegetarian"],
              ["nonveg", "Non-vegetarian"],
              ["eggetarian", "Eggetarian"],
              ["vegan", "Vegan"],
              ["jain", "Jain"],
              ["sattvic", "Sattvic"],
            ] as [Diet, string][]).map(([k, label]) => (
              <Option key={k} label={label} selected={d.diet === k} onPress={() => setD({ ...d, diet: k })} />
            ))}
          </Question>
        )}

        {key === "summary" && <Summary draft={d} />}
      </ScrollView>

      <View style={styles.footer}>
        {step > 0 && (
          <Pressable style={[styles.navBtn, styles.backBtn]} onPress={back}>
            <Text style={styles.backText}>Back</Text>
          </Pressable>
        )}
        {key === "summary" ? (
          <PressableScale containerStyle={{ flex: 1 }} style={[styles.navBtn, styles.primaryBtn]} onPress={finish}>
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
    sedentary: "Mostly sedentary",
    light: "Lightly active",
    moderate: "Regular training",
    active: "Highly active",
    very_active: "Athlete / very active",
  }[a];
}

/* ---------- step screens ---------- */

function BodyStep({
  d,
  setD,
  heightUnit,
  setHeightUnit,
  weightUnit,
  setWeightUnit,
}: {
  d: Draft;
  setD: React.Dispatch<React.SetStateAction<Draft>>;
  heightUnit: HeightUnit;
  setHeightUnit: (u: HeightUnit) => void;
  weightUnit: WeightUnit;
  setWeightUnit: (u: WeightUnit) => void;
}) {
  const bmi = computeBmi(d.heightCm, d.weightKg);
  // Provisional maintenance estimate (activity may not be chosen yet — default
  // to "light"). Real, goal-aware targets are shown on the summary screen.
  const maintain = tdee({
    gender: d.gender ?? "other",
    age: d.age,
    heightCm: d.heightCm,
    weightKg: d.weightKg,
    activity: d.activity ?? "light",
  });

  return (
    <View>
      <Text style={styles.qTitle}>Your height & weight</Text>
      <Text style={styles.qSub}>Two numbers that help us estimate your daily nutrition targets.</Text>

      <View style={styles.dualRow}>
        <View style={styles.dualCol}>
          <View style={styles.dualHead}>
            <Text style={styles.fieldLabel}>Height</Text>
            <UnitToggle options={["cm", "in"]} value={heightUnit} onChange={(u) => setHeightUnit(u as HeightUnit)} />
          </View>
          <HeightWheel valueCm={d.heightCm} unit={heightUnit} onChangeCm={(v) => setD((s) => ({ ...s, heightCm: v }))} />
        </View>
        <View style={styles.dualCol}>
          <View style={styles.dualHead}>
            <Text style={styles.fieldLabel}>Weight</Text>
            <UnitToggle options={["kg", "lb"]} value={weightUnit} onChange={(u) => setWeightUnit(u as WeightUnit)} />
          </View>
          <WeightWheel valueKg={d.weightKg} unit={weightUnit} minKg={LIMITS.weightKg.min} maxKg={LIMITS.weightKg.max} onChangeKg={(v) => setD((s) => ({ ...s, weightKg: v }))} />
        </View>
      </View>

      <View style={styles.estimateCard}>
        <Text style={styles.estimateMain}>Targeting ~{maintain.toLocaleString()} kcal/day</Text>
        <Text style={styles.estimateSub}>
          based on your current profile{bmi ? ` · BMI ${bmi.value}` : ""}
        </Text>
      </View>
    </View>
  );
}

function TargetStep({ d, setD, weightUnit }: { d: Draft; setD: React.Dispatch<React.SetStateAction<Draft>>; weightUnit: WeightUnit }) {
  const losing = d.goalKind === "loss";
  const minKg = losing ? LIMITS.weightKg.min : d.weightKg + 0.5;
  const maxKg = losing ? d.weightKg - 0.5 : LIMITS.weightKg.max;
  const delta = d.targetWeightKg - d.weightKg;
  const deltaLabel = `${delta > 0 ? "+" : "−"}${fmtKg(Math.abs(delta))} kg from today`;

  return (
    <View>
      <Text style={styles.qTitle}>What weight would you like to reach?</Text>
      <Text style={styles.qSub}>A goal to work towards. You can change it anytime.</Text>

      <View style={{ marginTop: 24, alignSelf: "center", width: 200 }}>
        <WeightWheel valueKg={d.targetWeightKg} unit={weightUnit} minKg={minKg} maxKg={maxKg} step={0.5} decimals={1} onChangeKg={(v) => setD((s) => ({ ...s, targetWeightKg: v }))} />
      </View>

      <View style={styles.deltaPill}>
        <Text style={styles.deltaText}>{deltaLabel}</Text>
      </View>
    </View>
  );
}

function PaceStep({ d, setD }: { d: Draft; setD: React.Dispatch<React.SetStateAction<Draft>> }) {
  // Build a real profile so the projection (weeks / date / kcal) is computed by
  // the single nutrition engine and updates live as the pace changes.
  const profile: Profile = {
    gender: d.gender ?? "other",
    age: d.age,
    heightCm: d.heightCm,
    weightKg: d.weightKg,
    targetWeightKg: d.targetWeightKg,
    goal: goalOf(d.goalKind ?? "maintain"),
    goalKind: d.goalKind,
    goalPace: d.goalPace,
    activity: d.activity ?? "light",
    diet: d.diet ?? "veg",
    createdAt: Date.now(),
  };
  const plan = projectPlan(profile);

  return (
    <View>
      <Text style={styles.qTitle}>How fast do you want to reach your goal?</Text>
      <Text style={styles.qSub}>This directly changes your calorie target and timeline.</Text>

      <View style={{ marginTop: 28 }}>
        <PaceSlider value={d.goalPace} onChange={(p) => setD((s) => ({ ...s, goalPace: p }))} />
      </View>

      <View style={styles.planGrid}>
        <PlanStat label="Timeline" value={plan.weeks > 0 ? `~${plan.weeks} wk` : "—"} />
        <PlanStat label="Reach around" value={plan.targetDate ? fmtDate(plan.targetDate) : "—"} />
        <PlanStat label="Daily target" value={`${plan.kcal.toLocaleString()}`} unit="kcal" />
      </View>
    </View>
  );
}

/* ---------- unit-aware wheels ---------- */

function HeightWheel({ valueCm, unit, onChangeCm }: { valueCm: number; unit: HeightUnit; onChangeCm: (cm: number) => void }) {
  if (unit === "in") {
    const minIn = Math.round(cmToIn(LIMITS.heightCm.min));
    const maxIn = Math.round(cmToIn(LIMITS.heightCm.max));
    return (
      <WheelPicker
        min={minIn}
        max={maxIn}
        value={Math.round(cmToIn(valueCm))}
        formatLabel={(v) => formatHeight(inToCm(v), "in")}
        onChange={(v) => onChangeCm(Math.round(inToCm(v)))}
      />
    );
  }
  return <WheelPicker min={LIMITS.heightCm.min} max={LIMITS.heightCm.max} value={Math.round(valueCm)} unit="cm" onChange={onChangeCm} />;
}

function WeightWheel({
  valueKg,
  unit,
  minKg,
  maxKg,
  step = 1,
  decimals = 0,
  onChangeKg,
}: {
  valueKg: number;
  unit: WeightUnit;
  minKg: number;
  maxKg: number;
  step?: number;
  decimals?: number;
  onChangeKg: (kg: number) => void;
}) {
  if (unit === "lb") {
    return (
      <WheelPicker
        min={Math.round(kgToLb(minKg))}
        max={Math.round(kgToLb(maxKg))}
        value={Math.round(kgToLb(valueKg))}
        unit="lb"
        onChange={(v) => onChangeKg(Math.round(lbToKg(v) * 10) / 10)}
      />
    );
  }
  return <WheelPicker min={minKg} max={maxKg} step={step} decimals={decimals} value={valueKg} unit="kg" onChange={onChangeKg} />;
}

/* ---------- shared UI ---------- */

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
      <Text style={styles.welcomeNote}>We'll build your nutrition plan together in under a minute.</Text>
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

function Segmented({ options, value, onChange }: { options: { key: string; label: string }[]; value?: string; onChange: (k: string) => void }) {
  return (
    <View style={styles.segment}>
      {options.map((o) => {
        const on = value === o.key;
        return (
          <Pressable key={o.key} style={[styles.segmentItem, on && styles.segmentItemOn]} onPress={() => onChange(o.key)}>
            <Text style={[styles.segmentText, on && styles.segmentTextOn]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function UnitToggle({ options, value, onChange }: { options: string[]; value: string; onChange: (u: string) => void }) {
  return (
    <View style={styles.unitToggle}>
      {options.map((o) => {
        const on = value === o;
        return (
          <Pressable key={o} style={[styles.unitItem, on && styles.unitItemOn]} onPress={() => onChange(o)}>
            <Text style={[styles.unitText, on && styles.unitTextOn]}>{o}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Option({ label, sublabel, selected, onPress }: { label: string; sublabel?: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable style={[styles.option, selected && styles.optionSelected]} onPress={onPress}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.optionLabel, selected && styles.optionLabelSelected]}>{label}</Text>
        {!!sublabel && <Text style={styles.optionSub}>{sublabel}</Text>}
      </View>
      <View style={[styles.radio, selected && styles.radioSelected]}>{selected && <View style={styles.radioDot} />}</View>
    </Pressable>
  );
}

function GoalCard({ icon, title, desc, selected, onPress }: { icon: IconName; title: string; desc: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable style={[styles.goalOption, selected && styles.goalOptionOn]} onPress={onPress}>
      <View style={[styles.goalIcon, selected && styles.goalIconOn]}>
        <Icon name={icon} size={20} color={selected ? "#fff" : colors.green} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.goalOptTitle, selected && styles.optionLabelSelected]}>{title}</Text>
        <Text style={styles.goalOptDesc}>{desc}</Text>
      </View>
    </Pressable>
  );
}

function PlanStat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <View style={styles.planStat}>
      <Text style={styles.planStatLabel}>{label}</Text>
      <Text style={styles.planStatValue}>
        {value}
        {unit ? <Text style={styles.planStatUnit}>{` ${unit}`}</Text> : null}
      </Text>
    </View>
  );
}

function Summary({ draft }: { draft: Draft }) {
  const kind = draft.goalKind ?? "maintain";
  const profile: Profile = {
    gender: draft.gender!,
    age: draft.age,
    heightCm: draft.heightCm,
    weightKg: draft.weightKg,
    targetWeightKg: hasWeightTarget(kind) ? draft.targetWeightKg : draft.weightKg,
    goal: goalOf(kind),
    goalKind: kind,
    goalPace: draft.goalPace,
    activity: draft.activity!,
    diet: draft.diet!,
    createdAt: Date.now(),
  };
  const g = computeGoal(profile);
  const plan = projectPlan(profile);
  const paceLabel = { relaxed: "Relaxed", recommended: "Recommended", ambitious: "Ambitious" }[draft.goalPace];

  return (
    <View>
      <Text style={styles.qTitle}>Your gofit plan</Text>
      <Text style={styles.qSub}>Calculated from everything you just told us.</Text>

      <View style={styles.goalCard}>
        <Text style={styles.goalKcalLabel}>DAILY CALORIE TARGET</Text>
        <Text style={styles.goalKcal}>{g.kcal.toLocaleString()}</Text>
        <Text style={styles.goalKcalUnit}>kcal / day</Text>
        <View style={styles.macroRow}>
          <MacroPill label="Protein" value={`${g.protein_g}g`} />
          <MacroPill label="Carbs" value={`${g.carbs_g}g`} />
          <MacroPill label="Fat" value={`${g.fat_g}g`} />
        </View>
      </View>

      <View style={styles.statsCard}>
        <StatRow label="Current weight" value={`${fmtKg(draft.weightKg)} kg`} />
        {hasWeightTarget(kind) && <StatRow label="Goal weight" value={`${fmtKg(draft.targetWeightKg)} kg`} />}
        <StatRow label="Activity" value={prettyActivity(draft.activity!)} />
        {hasWeightTarget(kind) && <StatRow label="Goal pace" value={paceLabel} />}
        {plan.targetDate && <StatRow label="Estimated to reach" value={`${fmtDate(plan.targetDate)} · ~${plan.weeks} wk`} />}
      </View>
      <Text style={styles.disclaimer}>Estimates for guidance only, not medical advice. You can adjust anytime.</Text>
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
  fieldLabel: { fontSize: 13, fontWeight: "800", color: MUTE, letterSpacing: 0.4, textTransform: "uppercase", marginBottom: 10 },

  segment: { flexDirection: "row", backgroundColor: "#fff", borderRadius: 14, borderWidth: 2, borderColor: "#EAEFEB", padding: 4, gap: 4 },
  segmentItem: { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: "center" },
  segmentItemOn: { backgroundColor: GREEN },
  segmentText: { fontSize: 15, fontWeight: "800", color: INK },
  segmentTextOn: { color: "#fff" },

  unitToggle: { flexDirection: "row", backgroundColor: "#EEF3F0", borderRadius: 10, padding: 3 },
  unitItem: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 8 },
  unitItemOn: { backgroundColor: "#fff", shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 3, shadowOffset: { width: 0, height: 1 } },
  unitText: { fontSize: 13, fontWeight: "800", color: MUTE },
  unitTextOn: { color: GREEN },

  dualRow: { flexDirection: "row", gap: 12, marginTop: 22 },
  dualCol: { flex: 1 },
  dualHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },

  estimateCard: { backgroundColor: "#fff", borderRadius: 18, padding: 18, marginTop: 24, alignItems: "center", borderWidth: 2, borderColor: "#EAEFEB" },
  estimateMain: { fontSize: 20, fontWeight: "900", color: GREEN },
  estimateSub: { fontSize: 13, color: MUTE, marginTop: 4 },

  deltaPill: { alignSelf: "center", marginTop: 20, backgroundColor: colors.greenTint, borderRadius: 999, paddingHorizontal: 18, paddingVertical: 10 },
  deltaText: { color: GREEN, fontWeight: "900", fontSize: 15 },

  planGrid: { flexDirection: "row", gap: 10, marginTop: 30 },
  planStat: { flex: 1, backgroundColor: "#fff", borderRadius: 16, paddingVertical: 16, paddingHorizontal: 10, alignItems: "center", borderWidth: 2, borderColor: "#EAEFEB" },
  planStatLabel: { fontSize: 11, color: MUTE, fontWeight: "700", marginBottom: 6, textAlign: "center" },
  planStatValue: { fontSize: 20, fontWeight: "900", color: INK },
  planStatUnit: { fontSize: 12, fontWeight: "700", color: MUTE },

  option: { flexDirection: "row", alignItems: "center", backgroundColor: "#fff", borderRadius: 16, borderWidth: 2, borderColor: "#EAEFEB", padding: 18, marginBottom: 12 },
  optionSelected: { borderColor: GREEN, backgroundColor: "#F0F8F3" },
  optionLabel: { fontSize: 16, fontWeight: "700", color: INK },
  optionLabelSelected: { color: GREEN },
  optionSub: { fontSize: 13, color: MUTE, marginTop: 2 },
  radio: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: "#CBD5D0", alignItems: "center", justifyContent: "center" },
  radioSelected: { borderColor: GREEN },
  radioDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: GREEN },

  goalOption: { flexDirection: "row", alignItems: "center", gap: 14, backgroundColor: "#fff", borderRadius: 16, borderWidth: 2, borderColor: "#EAEFEB", padding: 16, marginBottom: 12 },
  goalOptionOn: { borderColor: GREEN, backgroundColor: "#F0F8F3" },
  goalIcon: { width: 44, height: 44, borderRadius: 12, backgroundColor: colors.greenTint, alignItems: "center", justifyContent: "center" },
  goalIconOn: { backgroundColor: GREEN },
  goalOptTitle: { fontSize: 16, fontWeight: "800", color: INK },
  goalOptDesc: { fontSize: 13, color: MUTE, marginTop: 3, lineHeight: 18 },

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
