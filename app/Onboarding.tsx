import React, { useEffect, useMemo, useRef, useState } from "react";
import { Animated, ScrollView, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
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
import { colors, elevation, gradients, radius, sp, type as T } from "./theme";
import Icon, { IconName } from "./Icon";
import PressableScale from "./PressableScale";
import WheelPicker from "./WheelPicker";
import PaceSlider from "./PaceSlider";
import Screen from "./Screen";

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

const STEPS = [
  "welcome",
  "basics",
  "body",
  "activity",
  "goal",
  "target",
  "pace",
  "diet",
  "summary",
] as const;

const IDX = STEPS.reduce((m, k, i) => ((m[k] = i), m), {} as Record<(typeof STEPS)[number], number>);

const ACTIVITY_ICONS: Record<Activity, IconName> = {
  sedentary: "moon",
  light: "walk",
  moderate: "pulse",
  active: "dumbbell",
  very_active: "bicycle",
};

const DIET_OPTIONS: { key: Diet; label: string; icon: IconName }[] = [
  { key: "veg", label: "Vegetarian", icon: "carbs" },
  { key: "nonveg", label: "Non-vegetarian", icon: "meal" },
  { key: "eggetarian", label: "Eggetarian", icon: "protein" },
  { key: "vegan", label: "Vegan", icon: "sparkles" },
  { key: "jain", label: "Jain", icon: "heartOutline" },
  { key: "sattvic", label: "Sattvic", icon: "nutrition" },
];

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
  const totalSteps = STEPS.length - 1;
  const progress = step / totalSteps;

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
    <Screen style={styles.root} background={colors.bg}>
      {step > 0 ? (
        <View style={styles.progressWrap}>
          <View style={styles.progressCard}>
            <View style={styles.progressMeta}>
              <Text style={styles.progressEyebrow}>Personalising your plan</Text>
              <Text style={styles.progressCount}>
                Step {step} of {totalSteps}
              </Text>
            </View>
            <View style={styles.progressTrack}>
              <Animated.View style={[styles.progressFill, { width: widthPct }]} />
            </View>
          </View>
        </View>
      ) : null}

      <ScrollView
        contentContainerStyle={[styles.body, step === 0 && styles.bodyWelcome]}
        keyboardShouldPersistTaps="handled"
      >
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
            <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>Age</Text>
            <View style={styles.inputSurface}>
              <WheelPicker
                min={LIMITS.age.min}
                max={LIMITS.age.max}
                value={d.age}
                unit="yrs"
                onChange={(v) => setD({ ...d, age: v })}
              />
            </View>
          </Question>
        )}

        {key === "body" && (
          <BodyStep
            d={d}
            setD={setD}
            heightUnit={heightUnit}
            setHeightUnit={setHeightUnit}
            weightUnit={weightUnit}
            setWeightUnit={setWeightUnit}
          />
        )}

        {key === "activity" && (
          <Question title="How active are you usually?" sub="Include training and everyday movement.">
            {(Object.keys(ACTIVITY_LABELS) as Activity[]).map((a) => (
              <Option
                key={a}
                icon={ACTIVITY_ICONS[a]}
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
            <GoalCard
              icon="flame"
              title="Weight loss"
              desc="Fat loss while supporting your daily energy."
              selected={d.goalKind === "loss"}
              onPress={() => pickGoal("loss")}
            />
            <GoalCard
              icon="dumbbell"
              title="Muscle gain"
              desc="Support muscle growth with a higher protein target."
              selected={d.goalKind === "muscle"}
              onPress={() => pickGoal("muscle")}
            />
            <GoalCard
              icon="target"
              title="Maintain weight"
              desc="Stay around your current weight while eating well."
              selected={d.goalKind === "maintain"}
              onPress={() => pickGoal("maintain")}
            />
            <GoalCard
              icon="heart"
              title="General fitness"
              desc="Eat well and stay consistent day to day."
              selected={d.goalKind === "fitness"}
              onPress={() => pickGoal("fitness")}
            />
          </Question>
        )}

        {key === "target" && <TargetStep d={d} setD={setD} weightUnit={weightUnit} />}

        {key === "pace" && <PaceStep d={d} setD={setD} />}

        {key === "diet" && (
          <Question title="Your food preference?" sub="Helps us tailor Indian food suggestions.">
            {DIET_OPTIONS.map(({ key: dietKey, label, icon }) => (
              <Option
                key={dietKey}
                icon={icon}
                label={label}
                selected={d.diet === dietKey}
                onPress={() => setD({ ...d, diet: dietKey })}
              />
            ))}
          </Question>
        )}

        {key === "summary" && <Summary draft={d} />}
      </ScrollView>

      <View style={styles.footer}>
        {step > 0 ? (
          <PressableScale style={[styles.navBtn, styles.backBtn]} onPress={back}>
            <Icon name="chevronLeft" size={18} color={colors.ink} />
            <Text style={styles.backText}>Back</Text>
          </PressableScale>
        ) : null}
        {key === "summary" ? (
          <PressableScale containerStyle={{ flex: 1 }} style={[styles.navBtn, styles.primaryBtn]} onPress={finish}>
            <Text style={styles.primaryText}>Start tracking</Text>
            <Icon name="chevronRight" size={18} color={colors.white} />
          </PressableScale>
        ) : (
          <PressableScale
            containerStyle={{ flex: 1 }}
            style={[styles.navBtn, styles.primaryBtn, !canContinue && styles.disabled]}
            onPress={canContinue ? next : undefined}
          >
            <Text style={styles.primaryText}>{step === 0 ? "Get started" : "Continue"}</Text>
            <Icon name="chevronRight" size={18} color={colors.white} />
          </PressableScale>
        )}
      </View>
    </Screen>
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
  const maintain = tdee({
    gender: d.gender ?? "other",
    age: d.age,
    heightCm: d.heightCm,
    weightKg: d.weightKg,
    activity: d.activity ?? "light",
  });

  return (
    <Question
      title="Your height & weight"
      sub="Two numbers that help us estimate your daily nutrition targets."
    >
      <View style={styles.dualRow}>
        <View style={styles.dualCol}>
          <View style={styles.dualHead}>
            <Text style={styles.fieldLabel}>Height</Text>
            <UnitToggle
              options={["cm", "in"]}
              value={heightUnit}
              onChange={(u) => setHeightUnit(u as HeightUnit)}
            />
          </View>
          <View style={styles.inputSurface}>
            <HeightWheel
              valueCm={d.heightCm}
              unit={heightUnit}
              onChangeCm={(v) => setD((s) => ({ ...s, heightCm: v }))}
            />
          </View>
        </View>
        <View style={styles.dualCol}>
          <View style={styles.dualHead}>
            <Text style={styles.fieldLabel}>Weight</Text>
            <UnitToggle
              options={["kg", "lb"]}
              value={weightUnit}
              onChange={(u) => setWeightUnit(u as WeightUnit)}
            />
          </View>
          <View style={styles.inputSurface}>
            <WeightWheel
              valueKg={d.weightKg}
              unit={weightUnit}
              minKg={LIMITS.weightKg.min}
              maxKg={LIMITS.weightKg.max}
              onChangeKg={(v) => setD((s) => ({ ...s, weightKg: v }))}
            />
          </View>
        </View>
      </View>

      <View style={styles.estimateCard}>
        <View style={styles.inlineIconBadge}>
          <Icon name="sparkles" size={16} color={colors.green} />
        </View>
        <Text style={styles.estimateMain}>Targeting ~{maintain.toLocaleString()} kcal/day</Text>
        <Text style={styles.estimateSub}>
          based on your current profile{bmi ? ` · BMI ${bmi.value}` : ""}
        </Text>
      </View>
    </Question>
  );
}

function TargetStep({
  d,
  setD,
  weightUnit,
}: {
  d: Draft;
  setD: React.Dispatch<React.SetStateAction<Draft>>;
  weightUnit: WeightUnit;
}) {
  const losing = d.goalKind === "loss";
  const minKg = losing ? LIMITS.weightKg.min : d.weightKg + 0.5;
  const maxKg = losing ? d.weightKg - 0.5 : LIMITS.weightKg.max;
  const delta = d.targetWeightKg - d.weightKg;
  const deltaLabel = `${delta > 0 ? "+" : "−"}${fmtKg(Math.abs(delta))} kg from today`;

  return (
    <Question title="What weight would you like to reach?" sub="A goal to work towards. You can change it anytime.">
      <View style={styles.singleWheelWrap}>
        <View style={styles.inputSurface}>
          <WeightWheel
            valueKg={d.targetWeightKg}
            unit={weightUnit}
            minKg={minKg}
            maxKg={maxKg}
            step={0.5}
            decimals={1}
            onChangeKg={(v) => setD((s) => ({ ...s, targetWeightKg: v }))}
          />
        </View>
      </View>

      <View style={styles.deltaPill}>
        <Icon name={delta > 0 ? "chevronUp" : "chevronDown"} size={16} color={colors.green} />
        <Text style={styles.deltaText}>{deltaLabel}</Text>
      </View>
    </Question>
  );
}

function PaceStep({ d, setD }: { d: Draft; setD: React.Dispatch<React.SetStateAction<Draft>> }) {
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
    <Question
      title="How fast do you want to reach your goal?"
      sub="This directly changes your calorie target and timeline."
    >
      <View style={styles.sliderCard}>
        <PaceSlider value={d.goalPace} onChange={(p) => setD((s) => ({ ...s, goalPace: p }))} />
      </View>

      <View style={styles.planGrid}>
        <PlanStat label="Timeline" value={plan.weeks > 0 ? `~${plan.weeks} wk` : "—"} />
        <PlanStat label="Reach around" value={plan.targetDate ? fmtDate(plan.targetDate) : "—"} />
        <PlanStat label="Daily target" value={`${plan.kcal.toLocaleString()}`} unit="kcal" />
      </View>
    </Question>
  );
}

function HeightWheel({
  valueCm,
  unit,
  onChangeCm,
}: {
  valueCm: number;
  unit: HeightUnit;
  onChangeCm: (cm: number) => void;
}) {
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
  return (
    <WheelPicker
      min={LIMITS.heightCm.min}
      max={LIMITS.heightCm.max}
      value={Math.round(valueCm)}
      unit="cm"
      onChange={onChangeCm}
    />
  );
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
  return (
    <WheelPicker
      min={minKg}
      max={maxKg}
      step={step}
      decimals={decimals}
      value={valueKg}
      unit="kg"
      onChange={onChangeKg}
    />
  );
}

function Welcome() {
  return (
    <View style={styles.welcome}>
      <LinearGradient colors={gradients.brandDeep} style={styles.welcomeHero}>
        <View style={styles.logoBadge}>
          <Icon name="scan" size={36} color={colors.white} />
        </View>
        <Text style={styles.welcomeEyebrow}>Built for Indian food</Text>
        <Text style={styles.welcomeTitle}>{APP_NAME}</Text>
        <Text style={styles.welcomeSub}>
          Snap a photo of any Indian meal and get accurate calories and macros — built for
          thalis, dosas, biryani and everything in between.
        </Text>
      </LinearGradient>

      <View style={styles.welcomePanel}>
        <View style={styles.bullets}>
          <Bullet icon="camera" text="Instant photo calorie tracking" />
          <Bullet icon="target" text="A personalised daily goal" />
          <Bullet icon="flame" text="Streaks to keep you consistent" />
        </View>
        <Text style={styles.welcomeNote}>
          We'll build your nutrition plan together in under a minute.
        </Text>
      </View>
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

function Question({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.questionCard}>
      <Text style={styles.qTitle}>{title}</Text>
      {!!sub && <Text style={styles.qSub}>{sub}</Text>}
      <View style={styles.questionBody}>{children}</View>
    </View>
  );
}

function Segmented({
  options,
  value,
  onChange,
}: {
  options: { key: string; label: string }[];
  value?: string;
  onChange: (k: string) => void;
}) {
  return (
    <View style={styles.segment}>
      {options.map((o) => {
        const on = value === o.key;
        return (
          <PressableScale
            key={o.key}
            containerStyle={{ flex: 1 }}
            style={[styles.segmentItem, on && styles.segmentItemOn]}
            onPress={() => onChange(o.key)}
          >
            <Text style={[styles.segmentText, on && styles.segmentTextOn]}>{o.label}</Text>
          </PressableScale>
        );
      })}
    </View>
  );
}

function UnitToggle({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (u: string) => void;
}) {
  return (
    <View style={styles.unitToggle}>
      {options.map((o) => {
        const on = value === o;
        return (
          <PressableScale key={o} style={[styles.unitItem, on && styles.unitItemOn]} onPress={() => onChange(o)}>
            <Text style={[styles.unitText, on && styles.unitTextOn]}>{o}</Text>
          </PressableScale>
        );
      })}
    </View>
  );
}

function Option({
  icon,
  label,
  sublabel,
  selected,
  onPress,
}: {
  icon?: IconName;
  label: string;
  sublabel?: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <PressableScale containerStyle={styles.choiceWrap} style={[styles.option, selected && styles.optionSelected]} onPress={onPress}>
      {icon ? (
        <View style={[styles.optionIcon, selected && styles.optionIconSelected]}>
          <Icon name={icon} size={18} color={selected ? colors.white : colors.green} />
        </View>
      ) : null}
      <View style={{ flex: 1 }}>
        <Text style={[styles.optionLabel, selected && styles.optionLabelSelected]}>{label}</Text>
        {!!sublabel && <Text style={styles.optionSub}>{sublabel}</Text>}
      </View>
      <View style={[styles.radio, selected && styles.radioSelected]}>
        {selected ? <Icon name="check" size={14} color={colors.green} /> : null}
      </View>
    </PressableScale>
  );
}

function GoalCard({
  icon,
  title,
  desc,
  selected,
  onPress,
}: {
  icon: IconName;
  title: string;
  desc: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <PressableScale
      containerStyle={styles.choiceWrap}
      style={[styles.goalOption, selected && styles.goalOptionOn]}
      onPress={onPress}
    >
      <View style={[styles.goalIcon, selected && styles.goalIconOn]}>
        <Icon name={icon} size={20} color={selected ? colors.white : colors.green} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.goalOptTitle, selected && styles.optionLabelSelected]}>{title}</Text>
        <Text style={styles.goalOptDesc}>{desc}</Text>
      </View>
      <View style={[styles.radio, selected && styles.radioSelected]}>
        {selected ? <Icon name="check" size={14} color={colors.green} /> : null}
      </View>
    </PressableScale>
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
    <View style={styles.questionCard}>
      <Text style={styles.qTitle}>Your gofit plan</Text>
      <Text style={styles.qSub}>Calculated from everything you just told us.</Text>

      <LinearGradient colors={gradients.brand} style={styles.goalCard}>
        <Text style={styles.goalKcalLabel}>DAILY CALORIE TARGET</Text>
        <Text style={styles.goalKcal}>{g.kcal.toLocaleString()}</Text>
        <Text style={styles.goalKcalUnit}>kcal / day</Text>
        <View style={styles.macroRow}>
          <MacroPill label="Protein" value={`${g.protein_g}g`} />
          <MacroPill label="Carbs" value={`${g.carbs_g}g`} />
          <MacroPill label="Fat" value={`${g.fat_g}g`} />
        </View>
      </LinearGradient>

      <View style={styles.statsCard}>
        <StatRow label="Current weight" value={`${fmtKg(draft.weightKg)} kg`} />
        {hasWeightTarget(kind) ? (
          <StatRow label="Goal weight" value={`${fmtKg(draft.targetWeightKg)} kg`} />
        ) : null}
        <StatRow label="Activity" value={prettyActivity(draft.activity!)} />
        {hasWeightTarget(kind) ? <StatRow label="Goal pace" value={paceLabel} /> : null}
        {plan.targetDate ? (
          <StatRow label="Estimated to reach" value={`${fmtDate(plan.targetDate)} · ~${plan.weeks} wk`} last />
        ) : (
          <StatRow label="Diet" value={DIET_OPTIONS.find((opt) => opt.key === draft.diet)?.label ?? ""} last />
        )}
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

function StatRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <View style={[styles.statRow, !last && styles.statRowDivider]}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },

  progressWrap: { paddingHorizontal: sp(4), paddingTop: sp(3), paddingBottom: sp(1) },
  progressCard: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    paddingHorizontal: sp(4),
    paddingVertical: sp(3.5),
    ...elevation.sm,
  },
  progressMeta: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: sp(2) },
  progressEyebrow: { ...T.overline, color: colors.green, flexShrink: 1 },
  progressCount: { ...T.caption, color: colors.mute },
  progressTrack: {
    height: sp(2),
    borderRadius: radius.pill,
    backgroundColor: colors.track,
    overflow: "hidden",
    marginTop: sp(3),
  },
  progressFill: { height: "100%", borderRadius: radius.pill, backgroundColor: colors.green },

  body: { flexGrow: 1, paddingHorizontal: sp(4), paddingBottom: sp(5) },
  bodyWelcome: { justifyContent: "center", paddingTop: sp(4) },

  welcome: { gap: sp(4) },
  welcomeHero: {
    borderRadius: radius.xl,
    paddingHorizontal: sp(5),
    paddingVertical: sp(7),
    alignItems: "center",
    ...elevation.lg,
  },
  logoBadge: {
    width: sp(21),
    height: sp(21),
    borderRadius: radius.xl,
    backgroundColor: "rgba(255,255,255,0.14)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: sp(4),
  },
  welcomeEyebrow: { ...T.overline, color: "rgba(255,255,255,0.76)", marginBottom: sp(2) },
  welcomeTitle: { ...T.display, color: colors.white, textAlign: "center" },
  welcomeSub: {
    ...T.body,
    color: "rgba(255,255,255,0.88)",
    textAlign: "center",
    lineHeight: 24,
    marginTop: sp(2),
  },
  welcomePanel: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    padding: sp(5),
    ...elevation.md,
  },
  bullets: { gap: sp(3) },
  bulletRow: { flexDirection: "row", alignItems: "center", gap: sp(3) },
  bulletIcon: {
    width: sp(10),
    height: sp(10),
    borderRadius: radius.md,
    backgroundColor: colors.greenTint,
    alignItems: "center",
    justifyContent: "center",
  },
  bullet: { ...T.bodyStrong, color: colors.ink, flex: 1 },
  welcomeNote: {
    ...T.caption,
    color: colors.mute,
    textAlign: "center",
    marginTop: sp(5),
    lineHeight: 20,
  },

  questionCard: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    padding: sp(5),
    ...elevation.md,
  },
  qTitle: { ...T.h1, color: colors.ink },
  qSub: { ...T.body, color: colors.mute, marginTop: sp(1.5), lineHeight: 22 },
  questionBody: { marginTop: sp(5) },

  fieldLabel: { ...T.overline, color: colors.mute, marginBottom: sp(2.5) },
  fieldLabelSpaced: { marginTop: sp(6.5) },

  segment: {
    flexDirection: "row",
    backgroundColor: colors.cardMuted,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 4,
    gap: 6,
  },
  segmentItem: {
    flex: 1,
    paddingVertical: sp(3.5),
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  segmentItemOn: { backgroundColor: colors.green, ...elevation.sm },
  segmentText: { ...T.bodyStrong, color: colors.ink },
  segmentTextOn: { color: colors.white },

  inputSurface: {
    backgroundColor: colors.cardMuted,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: sp(2),
    paddingVertical: sp(1.5),
  },

  unitToggle: {
    flexDirection: "row",
    backgroundColor: colors.cardMuted,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 4,
    gap: 4,
  },
  unitItem: { borderRadius: radius.pill, paddingHorizontal: sp(3), paddingVertical: sp(1.25) },
  unitItemOn: { backgroundColor: colors.card, ...elevation.sm },
  unitText: { ...T.caption, color: colors.mute },
  unitTextOn: { color: colors.green },

  dualRow: { flexDirection: "row", gap: sp(3), marginTop: sp(1) },
  dualCol: { flex: 1 },
  dualHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: sp(2) },

  estimateCard: {
    backgroundColor: colors.greenTint2,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.hairline,
    padding: sp(4),
    marginTop: sp(6),
    alignItems: "center",
  },
  inlineIconBadge: {
    width: sp(9),
    height: sp(9),
    borderRadius: radius.md,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: sp(2.5),
    ...elevation.sm,
  },
  estimateMain: { ...T.h2, color: colors.green, textAlign: "center" },
  estimateSub: { ...T.caption, color: colors.mute, marginTop: sp(1), textAlign: "center" },

  singleWheelWrap: { marginTop: sp(1), alignItems: "center" },
  deltaPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: sp(1.5),
    alignSelf: "center",
    marginTop: sp(5),
    backgroundColor: colors.greenTint,
    borderRadius: radius.pill,
    paddingHorizontal: sp(4),
    paddingVertical: sp(2.5),
  },
  deltaText: { ...T.bodyStrong, color: colors.green },

  sliderCard: {
    marginTop: sp(2),
    backgroundColor: colors.cardMuted,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: sp(4),
    paddingVertical: sp(4),
  },
  planGrid: { flexDirection: "row", gap: sp(2.5), marginTop: sp(6) },
  planStat: {
    flex: 1,
    backgroundColor: colors.cardMuted,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    paddingVertical: sp(4),
    paddingHorizontal: sp(2.5),
    alignItems: "center",
  },
  planStatLabel: { ...T.tiny, color: colors.mute, textAlign: "center", marginBottom: sp(1.5) },
  planStatValue: { ...T.h2, color: colors.ink, textAlign: "center" },
  planStatUnit: { ...T.caption, color: colors.mute },

  choiceWrap: { marginBottom: sp(3) },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: sp(3),
    backgroundColor: colors.cardMuted,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: colors.line,
    padding: sp(4),
  },
  optionSelected: { borderColor: colors.green, backgroundColor: colors.greenTint2 },
  optionIcon: {
    width: sp(11),
    height: sp(11),
    borderRadius: radius.md,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
  },
  optionIconSelected: { backgroundColor: colors.green },
  optionLabel: { ...T.title, color: colors.ink },
  optionLabelSelected: { color: colors.green },
  optionSub: { ...T.caption, color: colors.mute, marginTop: 2, lineHeight: 18 },
  radio: {
    width: sp(7),
    height: sp(7),
    borderRadius: radius.pill,
    backgroundColor: colors.card,
    borderWidth: 1.5,
    borderColor: colors.hairline,
    alignItems: "center",
    justifyContent: "center",
  },
  radioSelected: { borderColor: colors.green, backgroundColor: colors.greenTint },

  goalOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: sp(3.5),
    backgroundColor: colors.cardMuted,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: colors.line,
    padding: sp(4),
  },
  goalOptionOn: { borderColor: colors.green, backgroundColor: colors.greenTint2 },
  goalIcon: {
    width: sp(12),
    height: sp(12),
    borderRadius: radius.md,
    backgroundColor: colors.greenTint,
    alignItems: "center",
    justifyContent: "center",
  },
  goalIconOn: { backgroundColor: colors.green },
  goalOptTitle: { ...T.title, color: colors.ink },
  goalOptDesc: { ...T.caption, color: colors.mute, marginTop: sp(0.75), lineHeight: 18 },

  goalCard: {
    borderRadius: radius.xl,
    padding: sp(6),
    marginTop: sp(6),
    alignItems: "center",
    ...elevation.md,
  },
  goalKcalLabel: { ...T.overline, color: "rgba(255,255,255,0.82)" },
  goalKcal: { color: colors.white, fontSize: 56, fontWeight: "900", marginTop: sp(1) },
  goalKcalUnit: { ...T.body, color: "rgba(255,255,255,0.84)", marginTop: -2 },
  macroRow: { flexDirection: "row", gap: sp(2.5), marginTop: sp(5), alignSelf: "stretch" },
  macroPill: {
    flex: 1,
    backgroundColor: "rgba(255,255,255,0.14)",
    borderRadius: radius.md,
    paddingVertical: sp(3),
    alignItems: "center",
  },
  macroPillVal: { ...T.title, color: colors.white },
  macroPillKey: { ...T.caption, color: "rgba(255,255,255,0.82)", marginTop: 2 },

  statsCard: {
    backgroundColor: colors.cardMuted,
    borderRadius: radius.lg,
    paddingHorizontal: sp(4),
    marginTop: sp(4),
    borderWidth: 1,
    borderColor: colors.line,
  },
  statRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: sp(3.5),
    gap: sp(3),
  },
  statRowDivider: { borderBottomWidth: 1, borderBottomColor: colors.line },
  statLabel: { ...T.body, color: colors.mute, flex: 1 },
  statValue: { ...T.bodyStrong, color: colors.ink, flex: 1, textAlign: "right" },
  disclaimer: {
    ...T.caption,
    color: colors.mute,
    textAlign: "center",
    marginTop: sp(4),
    lineHeight: 18,
  },

  footer: {
    flexDirection: "row",
    gap: sp(3),
    paddingHorizontal: sp(4),
    paddingTop: sp(2),
    paddingBottom: sp(5),
    backgroundColor: colors.bg,
  },
  navBtn: {
    minHeight: sp(14),
    borderRadius: radius.lg,
    paddingHorizontal: sp(4),
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: sp(1.5),
  },
  primaryBtn: { flex: 1, backgroundColor: colors.green, ...elevation.md },
  primaryText: { ...T.title, color: colors.white },
  backBtn: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    ...elevation.sm,
  },
  backText: { ...T.title, color: colors.ink },
  disabled: { opacity: 0.45 },
});
