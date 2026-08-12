import React, { useEffect, useMemo, useState } from "react";
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
  clamp,
  computeGoal,
  Diet,
  Gender,
  Goal,
  LIMITS,
  Profile,
} from "./nutrition";
import { APP_NAME } from "./config";
import { loadRemindersEnabled } from "./storage";
import { setRemindersEnabled } from "./push";
import Icon from "./Icon";

const GREEN = "#0B7A4B";
const BG = "#F4F6F5";
const INK = "#1D2521";
const MUTE = "#8A8F8C";

type Props = {
  profile: Profile;
  onSave: (p: Profile) => void;
  onClose: () => void;
  onResetAll: () => void;
};

const GENDERS: { key: Gender; label: string }[] = [
  { key: "male", label: "Male" },
  { key: "female", label: "Female" },
];
const GOALS: { key: Goal; label: string }[] = [
  { key: "lose", label: "Lose" },
  { key: "maintain", label: "Maintain" },
  { key: "gain", label: "Gain" },
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

export default function Settings({ profile, onSave, onClose, onResetAll }: Props) {
  const [d, setD] = useState<Profile>({ ...profile });
  const [confirmReset, setConfirmReset] = useState(false);
  const [reminders, setReminders] = useState(true);

  const goal = useMemo(() => computeGoal(d), [d]);

  useEffect(() => {
    loadRemindersEnabled().then(setReminders);
  }, []);

  function toggleReminders(on: boolean) {
    setReminders(on); // optimistic; setRemindersEnabled persists + (re)schedules
    setRemindersEnabled(on)
      .then((applied) => setReminders(applied))
      .catch(() => {});
  }

  // Keep target sensible: maintain => equals current weight.
  function setGoal(g: Goal) {
    setD((s) => ({
      ...s,
      goal: g,
      targetWeightKg: g === "maintain" ? s.weightKg : s.targetWeightKg,
    }));
  }

  function save() {
    onSave({ ...d });
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
            onChangeText={(t) => setD({ ...d, name: t })}
          />
        </Field>

        <Field label="Gender">
          <Segmented
            options={GENDERS}
            value={d.gender}
            onChange={(v) => setD({ ...d, gender: v })}
          />
        </Field>

        <Field label="Age">
          <Stepper
            value={d.age}
            unit="yrs"
            min={LIMITS.age.min}
            max={LIMITS.age.max}
            onChange={(v) => setD({ ...d, age: v })}
          />
        </Field>

        <Field label="Height">
          <Stepper
            value={d.heightCm}
            unit="cm"
            min={LIMITS.heightCm.min}
            max={LIMITS.heightCm.max}
            onChange={(v) => setD({ ...d, heightCm: v })}
          />
        </Field>

        <Field label="Current weight">
          <Stepper
            value={d.weightKg}
            unit="kg"
            min={LIMITS.weightKg.min}
            max={LIMITS.weightKg.max}
            onChange={(v) => setD({ ...d, weightKg: v })}
          />
        </Field>

        <Field label="Goal">
          <Segmented options={GOALS} value={d.goal} onChange={setGoal} />
        </Field>

        {d.goal !== "maintain" && (
          <Field label="Target weight">
            <Stepper
              value={d.targetWeightKg}
              unit="kg"
              min={LIMITS.weightKg.min}
              max={LIMITS.weightKg.max}
              onChange={(v) => setD({ ...d, targetWeightKg: v })}
            />
          </Field>
        )}

        <Field label="Activity level">
          <View style={styles.wrap}>
            {(Object.keys(ACTIVITY_SHORT) as Activity[]).map((a) => (
              <Chip
                key={a}
                label={ACTIVITY_SHORT[a]}
                selected={d.activity === a}
                onPress={() => setD({ ...d, activity: a })}
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
                onPress={() => setD({ ...d, diet: o.key })}
              />
            ))}
          </View>
        </Field>

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

function Stepper({
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
  return (
    <View style={styles.stepper}>
      <Pressable style={styles.stepBtn} onPress={() => onChange(clamp(value - step, min, max))}>
        <Text style={styles.stepBtnText}>−</Text>
      </Pressable>
      <View style={styles.stepCenter}>
        <TextInput
          style={styles.stepInput}
          keyboardType="numeric"
          value={String(value)}
          onChangeText={(t) => {
            const n = parseInt(t.replace(/[^0-9]/g, ""), 10);
            if (!isNaN(n)) onChange(clamp(n, min, max));
            else if (t === "") onChange(min);
          }}
        />
        <Text style={styles.stepUnit}>{unit}</Text>
      </View>
      <Pressable style={styles.stepBtn} onPress={() => onChange(clamp(value + step, min, max))}>
        <Text style={styles.stepBtnText}>+</Text>
      </Pressable>
    </View>
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

  field: { backgroundColor: "#fff", borderRadius: 16, padding: 16, marginBottom: 12 },
  fieldLabel: { color: MUTE, fontSize: 12, fontWeight: "700", letterSpacing: 0.5, marginBottom: 12, textTransform: "uppercase" },
  nameInput: { borderWidth: 2, borderColor: "#EAEFEB", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, fontWeight: "700", color: INK },
  hintText: { color: MUTE, fontSize: 12, marginTop: 10 },

  segment: { flexDirection: "row", backgroundColor: "#EEF2F0", borderRadius: 12, padding: 4, gap: 4 },
  segItem: { flex: 1, paddingVertical: 10, borderRadius: 9, alignItems: "center" },
  segItemActive: { backgroundColor: GREEN },
  segText: { color: INK, fontWeight: "700", fontSize: 14 },
  segTextActive: { color: "#fff" },

  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, borderWidth: 2, borderColor: "#EAEFEB", backgroundColor: "#fff" },
  chipActive: { borderColor: GREEN, backgroundColor: "#F0F8F3" },
  chipText: { color: INK, fontWeight: "700", fontSize: 13 },
  chipTextActive: { color: GREEN },

  stepper: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  stepBtn: { width: 48, height: 48, borderRadius: 24, backgroundColor: "#EAF4EE", alignItems: "center", justifyContent: "center" },
  stepBtnText: { fontSize: 24, fontWeight: "800", color: GREEN },
  stepCenter: { alignItems: "center", flex: 1 },
  stepInput: { fontSize: 32, fontWeight: "900", color: INK, textAlign: "center", minWidth: 80, padding: 0 },
  stepUnit: { fontSize: 13, color: MUTE, marginTop: -2 },

  reminderCard: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: "#fff", borderRadius: 16, padding: 16, marginBottom: 12 },
  reminderTitle: { color: INK, fontWeight: "800", fontSize: 15 },
  reminderSub: { color: MUTE, fontSize: 12, marginTop: 3, lineHeight: 17 },

  dangerHeading: { color: "#C0392B", fontSize: 12, fontWeight: "800", letterSpacing: 0.5, marginTop: 12, marginBottom: 10, textTransform: "uppercase" },
  dangerBtn: { backgroundColor: "#FDECEA", borderRadius: 14, paddingVertical: 14, alignItems: "center", borderWidth: 1, borderColor: "#F5C6C0" },
  dangerText: { color: "#C0392B", fontWeight: "800", fontSize: 15 },
  confirmBox: { backgroundColor: "#FDECEA", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#F5C6C0" },
  confirmText: { color: "#922B21", fontSize: 13, lineHeight: 19, marginBottom: 14 },
  confirmRow: { flexDirection: "row", gap: 10 },
  confirmBtn: { flex: 1, borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  confirmCancel: { backgroundColor: "#fff", borderWidth: 1, borderColor: "#E2E8E4" },
  confirmCancelText: { color: INK, fontWeight: "700" },
  confirmDelete: { backgroundColor: "#C0392B" },
  confirmDeleteText: { color: "#fff", fontWeight: "800" },

  footerNote: { color: MUTE, fontSize: 12, textAlign: "center", marginTop: 24 },
});
