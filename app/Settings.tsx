import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  Activity,
  ACTIVITY_LABELS,
  computeGoal,
  Diet,
  Gender,
  GoalKind,
  goalOfKind,
  hasWeightTargetGoalKind,
  normalizeProfile,
  resolveGoalKind,
  resolveGoalPace,
  isCompleteProfile,
  LIMITS,
  Profile,
  projectPlan,
  fmtPlanDate,
} from "./nutrition";
import { APP_NAME } from "./config";
import { getProfile } from "./api";
import { loadRemindersEnabled } from "./storage";
import { setRemindersEnabled, scheduleGlp1DoseReminder } from "./push";
import Icon from "./Icon";
import PaceSlider from "./PaceSlider";
import NumberStepper from "./NumberStepper";
import { colors, radius, sp, type as T } from "./theme";

// Aliased to the shared design system (theme.ts) so this screen stays in sync
// with the rest of the app instead of drifting with its own near-duplicate values.
const GREEN = colors.green;
const BG = colors.bg;
const INK = colors.ink;
const MUTE = colors.mute;

type Props = {
  profile: Profile;
  onSave: (p: Profile) => void;
  onClose: () => void;
  onResetAll: () => void;
};

const GENDERS: { key: Gender; label: string }[] = [
  { key: "male", label: "Male" },
  { key: "female", label: "Female" },
  { key: "other", label: "Other" },
];
const GOAL_KINDS: { key: GoalKind; label: string; sub: string }[] = [
  { key: "loss", label: "Weight loss", sub: "Reduce body weight" },
  { key: "muscle", label: "Muscle gain", sub: "Increase lean mass" },
  { key: "maintain", label: "Maintain weight", sub: "Keep current body weight" },
  { key: "fitness", label: "General fitness", sub: "Improve overall health" },
];
const DIETS: { key: Diet; label: string }[] = [
  { key: "veg", label: "Veg" },
  { key: "nonveg", label: "Non-veg" },
  { key: "eggetarian", label: "Egg" },
  { key: "vegan", label: "Vegan" },
  { key: "jain", label: "Jain" },
  { key: "sattvic", label: "Sattvic" },
];

const ACTIVITY_SHORT: Record<Activity, string> = {
  sedentary: "Sedentary",
  light: "Light",
  moderate: "Moderate",
  active: "Very active",
  very_active: "Extra active",
};

// Sunday=1..Saturday=7, matching expo-notifications' WEEKLY trigger weekday.
const WEEKDAYS: { key: number; label: string }[] = [
  { key: 1, label: "Sun" },
  { key: 2, label: "Mon" },
  { key: 3, label: "Tue" },
  { key: 4, label: "Wed" },
  { key: 5, label: "Thu" },
  { key: 6, label: "Fri" },
  { key: 7, label: "Sat" },
];

export default function Settings({ profile, onSave, onClose, onResetAll }: Props) {
  const [d, setD] = useState<Profile>({ ...normalizeProfile(profile)! });
  const [confirmReset, setConfirmReset] = useState(false);
  const [reminders, setReminders] = useState(true);
  // Set once the user changes any field, so an in-flight server refresh (below)
  // can't clobber edits already in progress.
  const edited = useRef(false);

  const goal = useMemo(() => computeGoal(d), [d]);
  const plan = useMemo(() => projectPlan(d), [d]);

  useEffect(() => {
    loadRemindersEnabled().then(setReminders);
  }, []);

  useEffect(() => {
    const kind = resolveGoalKind(d);
    if (!hasWeightTargetGoalKind(kind) && d.targetWeightKg !== d.weightKg) {
      setD((s) => ({ ...s, targetWeightKg: s.weightKg }));
    }
  }, [d.goalKind, d.weightKg, d.targetWeightKg]); // keep maintain/fitness goals consistent

  // Always edit against the account's TRUE saved profile. The `profile` prop is
  // normally the server-synced truth, but on a fast boot it can briefly be the
  // local cache -- so pull the authoritative server copy on open and seed the
  // form with it (unless the user has already started editing). This is why the
  // edit screen shows your real saved values to update, not stale/blank data.
  useEffect(() => {
    let cancelled = false;
    getProfile()
      .then(({ profile: sp }) => {
        if (!cancelled && !edited.current && isCompleteProfile(sp)) setD({ ...normalizeProfile(sp)! });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Every field change goes through this so `edited` is tracked in one place.
  function update(patch: Partial<Profile> | ((s: Profile) => Profile)) {
    edited.current = true;
    setD((s) => (typeof patch === "function" ? patch(s) : { ...s, ...patch }));
  }

  function toggleReminders(on: boolean) {
    setReminders(on); // optimistic; setRemindersEnabled persists + (re)schedules
    setRemindersEnabled(on)
      .then((applied) => setReminders(applied))
      .catch(() => {});
  }

  // Keep the 4-way goal framing from onboarding intact on edits, while mapping
  // to the 3-way engine goal used for calorie math.
  function setGoalKind(kind: GoalKind) {
    update((s) => ({
      ...s,
      goalKind: kind,
      goal: goalOfKind(kind),
      targetWeightKg: hasWeightTargetGoalKind(kind) ? s.targetWeightKg : s.weightKg,
    }));
  }

  function save() {
    onSave(normalizeProfile({ ...d })!);
    scheduleGlp1DoseReminder(d.onGlp1 ? d.glp1DoseWeekday : undefined).catch(() => {});
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable style={styles.hBtn} onPress={onClose} hitSlop={10}>
          <Icon name="close" size={20} color={INK} />
        </Pressable>
        <Text style={styles.hTitle}>Edit your profile</Text>
        <Pressable style={styles.hBtn} onPress={save} hitSlop={10}>
          <Text style={[styles.hBtnText, styles.hSave]}>Save</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {/* Live goal preview */}
        <View style={styles.goalCard}>
          <Text style={styles.goalLabel}>DAILY CALORIE TARGET</Text>
          <Text style={styles.goalKcal}>{goal.kcal}</Text>
          <Text style={styles.goalUnit}>kcal / day</Text>
          <View style={styles.macroRow}>
            <Pill label="Protein" value={`${goal.protein_g}g`} />
            <Pill label="Carbs" value={`${goal.carbs_g}g`} />
            <Pill label="Fat" value={`${goal.fat_g}g`} />
          </View>
        </View>

        <Field label="Display name">
          <TextInput
            style={styles.nameInput}
            value={d.name ?? ""}
            placeholder="Your name"
            placeholderTextColor={MUTE}
            maxLength={24}
            onChangeText={(t) => update({ name: t })}
          />
        </Field>

        <Field label="Gender">
          <Segmented
            options={GENDERS}
            value={d.gender}
            onChange={(v) => update({ gender: v })}
          />
        </Field>

        <Field label="Age">
          <NumberStepper
            value={d.age}
            unit="yrs"
            min={LIMITS.age.min}
            max={LIMITS.age.max}
            compact
            onChange={(v) => update({ age: v })}
          />
        </Field>

        <Field label="Height">
          <NumberStepper
            value={d.heightCm}
            unit="cm"
            min={LIMITS.heightCm.min}
            max={LIMITS.heightCm.max}
            compact
            onChange={(v) => update({ heightCm: v })}
          />
        </Field>

        <Field label="Current weight">
          <NumberStepper
            value={d.weightKg}
            unit="kg"
            min={LIMITS.weightKg.min}
            max={LIMITS.weightKg.max}
            step={0.5}
            decimals={1}
            compact
            onChange={(v) => update({ weightKg: v })}
          />
        </Field>

        <Field label="Goal">
          <View style={styles.wrap}>
            {GOAL_KINDS.map((o) => {
              const selected = resolveGoalKind(d) === o.key;
              return (
                <Pressable key={o.key} style={[styles.goalChip, selected && styles.goalChipActive]} onPress={() => setGoalKind(o.key)}>
                  <Text style={[styles.goalChipTitle, selected && styles.goalChipTitleActive]}>{o.label}</Text>
                  <Text style={[styles.goalChipSub, selected && styles.goalChipSubActive]}>{o.sub}</Text>
                </Pressable>
              );
            })}
          </View>
        </Field>

        {hasWeightTargetGoalKind(resolveGoalKind(d)) && (
          <Field label="Target weight">
            <NumberStepper
              value={d.targetWeightKg}
              unit="kg"
              min={LIMITS.weightKg.min}
              max={LIMITS.weightKg.max}
              step={0.5}
              decimals={1}
              compact
              onChange={(v) => update({ targetWeightKg: v })}
            />
          </Field>
        )}

        {hasWeightTargetGoalKind(resolveGoalKind(d)) && (
          <Field label="Goal pace">
            <PaceSlider
              value={resolveGoalPace(d)}
              onChange={(v) => update({ goalPace: v })}
            />
            {plan.weeks > 0 && (
              <View style={styles.planGrid}>
                <PlanStat label="Timeline" value={`~${plan.weeks} wk`} />
                <PlanStat label="Reach around" value={plan.targetDate ? fmtPlanDate(plan.targetDate) : "—"} />
                <PlanStat label="Rate" value={`${Math.abs(plan.ratePerWeekKg).toFixed(2)} kg/wk`} />
              </View>
            )}
          </Field>
        )}

        <Field label="Activity level">
          <View style={styles.wrap}>
            {(Object.keys(ACTIVITY_SHORT) as Activity[]).map((a) => (
              <Chip
                key={a}
                label={ACTIVITY_SHORT[a]}
                selected={d.activity === a}
                onPress={() => update({ activity: a })}
              />
            ))}
          </View>
          <Text style={styles.hintText}>{ACTIVITY_LABELS[d.activity]}</Text>
        </Field>

        <Field label="Food preference">
          <View style={styles.wrap}>
            {DIETS.map((o) => (
              <Chip
                key={o.key}
                label={o.label}
                selected={d.diet === o.key}
                onPress={() => update({ diet: o.key })}
              />
            ))}
          </View>
        </Field>

        {/* GLP-1 medication toggle -- targets safety signal only, never medical
            advice. See computeGoal()/effectiveGoalPace() in nutrition.ts for
            what this actually changes (higher protein floor, capped pace). */}
        <View style={styles.reminderCard}>
          <View style={{ flex: 1 }}>
            <Text style={styles.reminderTitle}>On a GLP-1 medication?</Text>
            <Text style={styles.reminderSub}>
              Ozempic, Wegovy, Mounjaro, Zepbound, or similar. Raises your protein target and keeps pace
              gentle -- always follow your prescriber's guidance.
            </Text>
          </View>
          <Switch
            value={!!d.onGlp1}
            onValueChange={(v) => update({ onGlp1: v })}
            trackColor={{ false: "#D6DEDA", true: GREEN }}
            thumbColor="#fff"
          />
        </View>

        {d.onGlp1 && (
          <Field label="Dose day (weekly reminder)">
            <View style={styles.wrap}>
              {WEEKDAYS.map((o) => (
                <Chip
                  key={o.key}
                  label={o.label}
                  selected={d.glp1DoseWeekday === o.key}
                  onPress={() => update({ glp1DoseWeekday: d.glp1DoseWeekday === o.key ? undefined : o.key })}
                />
              ))}
            </View>
            <Text style={styles.hintText}>
              {d.glp1DoseWeekday
                ? "We'll nudge you at 9am on your dose day -- tap the day again to clear it."
                : "Optional -- pick the day you usually take your dose to get a gentle weekly reminder."}
            </Text>
          </Field>
        )}
        {/* Reminders */}
        <View style={styles.reminderCard}>
          <View style={{ flex: 1 }}>
            <Text style={styles.reminderTitle}>Daily reminders</Text>
            <Text style={styles.reminderSub}>
              Gentle nudges to log meals and water through the day.
            </Text>
          </View>
          <Switch
            value={reminders}
            onValueChange={toggleReminders}
            trackColor={{ false: "#D6DEDA", true: GREEN }}
            thumbColor="#fff"
          />
        </View>

        {/* Danger zone */}
        <Text style={styles.dangerHeading}>Danger zone</Text>
        {!confirmReset ? (
          <Pressable style={styles.dangerBtn} onPress={() => setConfirmReset(true)}>
            <Text style={styles.dangerText}>Reset all data</Text>
          </Pressable>
        ) : (
          <View style={styles.confirmBox}>
            <Text style={styles.confirmText}>
              This erases your profile and every logged meal. This can't be undone.
            </Text>
            <View style={styles.confirmRow}>
              <Pressable
                style={[styles.confirmBtn, styles.confirmCancel]}
                onPress={() => setConfirmReset(false)}
              >
                <Text style={styles.confirmCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.confirmBtn, styles.confirmDelete]}
                onPress={onResetAll}
              >
                <Text style={styles.confirmDeleteText}>Erase everything</Text>
              </Pressable>
            </View>
          </View>
        )}

        <Text style={styles.footerNote}>{APP_NAME} · estimates for guidance only</Text>
      </ScrollView>
    </View>
  );
}

/* ---------- sub-components ---------- */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

function Pill({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.pill}>
      <Text style={styles.pillVal}>{value}</Text>
      <Text style={styles.pillKey}>{label}</Text>
    </View>
  );
}

function PlanStat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.planStat}>
      <Text style={styles.planStatLabel}>{label}</Text>
      <Text style={styles.planStatValue}>{value}</Text>
    </View>
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View style={styles.segment}>
      {options.map((o) => {
        const active = o.key === value;
        return (
          <Pressable
            key={o.key}
            style={[styles.segItem, active && styles.segItemActive]}
            onPress={() => onChange(o.key)}
          >
            <Text style={[styles.segText, active && styles.segTextActive]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable style={[styles.chip, selected && styles.chipActive]} onPress={onPress}>
      <Text style={[styles.chipText, selected && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

/* ---------- styles ---------- */

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG },
  header: {
    backgroundColor: GREEN,
    paddingTop: 52,
    paddingBottom: 16,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  hBtn: { minWidth: 48 },
  hBtnText: { color: "#fff", fontSize: 18, fontWeight: "800" },
  hSave: { fontSize: 16, textAlign: "right" },
  hTitle: { color: "#fff", fontSize: 17, fontWeight: "800" },

  body: { padding: 16, paddingBottom: 48 },

  goalCard: { backgroundColor: GREEN, borderRadius: 22, padding: 20, alignItems: "center", marginBottom: 20 },
  goalLabel: { color: "#9FD6BA", fontSize: 11, fontWeight: "700", letterSpacing: 1 },
  goalKcal: { color: "#fff", fontSize: 48, fontWeight: "900", marginTop: 2 },
  goalUnit: { color: "#CDEBD9", fontSize: 13, marginTop: -4 },
  macroRow: { flexDirection: "row", gap: 10, marginTop: 16, alignSelf: "stretch" },
  pill: { flex: 1, backgroundColor: "rgba(255,255,255,0.14)", borderRadius: 12, paddingVertical: 10, alignItems: "center" },
  pillVal: { color: "#fff", fontSize: 16, fontWeight: "800" },
  pillKey: { color: "#CDEBD9", fontSize: 11, marginTop: 2 },
  planGrid: { flexDirection: "row", gap: sp(2.5), marginTop: sp(3) },
  planStat: {
    flex: 1,
    backgroundColor: colors.cardMuted,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    paddingVertical: sp(3),
    paddingHorizontal: sp(2),
    alignItems: "center",
  },
  planStatLabel: { ...T.tiny, color: colors.mute, textAlign: "center", marginBottom: sp(1) },
  planStatValue: { ...T.h2, color: colors.ink, textAlign: "center" },

  field: { backgroundColor: "#fff", borderRadius: 16, padding: 14, marginBottom: 10 },
  fieldLabel: { color: MUTE, fontSize: 12, fontWeight: "700", letterSpacing: 0.5, marginBottom: 12, textTransform: "uppercase" },
  nameInput: { borderWidth: 2, borderColor: "#EAEFEB", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, fontWeight: "700", color: INK },
  hintText: { color: MUTE, fontSize: 12, marginTop: 10 },

  segment: { flexDirection: "row", backgroundColor: "#EEF2F0", borderRadius: 12, padding: 4, gap: 4 },
  segItem: { flex: 1, paddingVertical: 10, borderRadius: 9, alignItems: "center" },
  segItemActive: { backgroundColor: GREEN },
  segText: { color: INK, fontWeight: "700", fontSize: 14 },
  segTextActive: { color: "#fff" },

  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  goalChip: {
    flexBasis: "48%",
    borderRadius: 12,
    borderWidth: 2,
    borderColor: "#EAEFEB",
    backgroundColor: "#fff",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  goalChipActive: { borderColor: GREEN, backgroundColor: "#F0F8F3" },
  goalChipTitle: { color: INK, fontWeight: "800", fontSize: 13 },
  goalChipTitleActive: { color: GREEN },
  goalChipSub: { color: MUTE, fontSize: 11, marginTop: 3 },
  goalChipSubActive: { color: GREEN },
  chip: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, borderWidth: 2, borderColor: "#EAEFEB", backgroundColor: "#fff" },
  chipActive: { borderColor: GREEN, backgroundColor: "#F0F8F3" },
  chipText: { color: INK, fontWeight: "700", fontSize: 13 },
  chipTextActive: { color: GREEN },

  reminderCard: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: "#fff", borderRadius: 16, padding: 16, marginBottom: 12 },
  reminderTitle: { color: INK, fontWeight: "800", fontSize: 15 },
  reminderSub: { color: MUTE, fontSize: 12, marginTop: 3, lineHeight: 17 },

  dangerHeading: { color: colors.red, fontSize: 12, fontWeight: "800", letterSpacing: 0.5, marginTop: 12, marginBottom: 10, textTransform: "uppercase" },
  dangerBtn: { backgroundColor: colors.redTint, borderRadius: 14, paddingVertical: 14, alignItems: "center", borderWidth: 1, borderColor: "#F5C6C0" },
  dangerText: { color: colors.red, fontWeight: "800", fontSize: 15 },
  confirmBox: { backgroundColor: colors.redTint, borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#F5C6C0" },
  confirmText: { color: "#922B21", fontSize: 13, lineHeight: 19, marginBottom: 14 },
  confirmRow: { flexDirection: "row", gap: 10 },
  confirmBtn: { flex: 1, borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  confirmCancel: { backgroundColor: "#fff", borderWidth: 1, borderColor: "#E2E8E4" },
  confirmCancelText: { color: INK, fontWeight: "700" },
  confirmDelete: { backgroundColor: colors.red },
  confirmDeleteText: { color: "#fff", fontWeight: "800" },

  footerNote: { color: MUTE, fontSize: 12, textAlign: "center", marginTop: 24 },
});
