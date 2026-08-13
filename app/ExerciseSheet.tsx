import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  ExerciseCatalog,
  ExerciseCategory,
  ExerciseDay,
  getExerciseCatalog,
  getExerciseLogs,
  addExerciseLog,
  deleteExerciseLog,
  AuthRequiredError,
} from "./api";
import { colors, elevation } from "./theme";
import Icon from "./Icon";

type Props = {
  visible: boolean;
  date: string; // "YYYY-MM-DD"
  // Bump to force a reload of today's entries (e.g. after a guided workout was
  // logged from the library while this sheet stayed open).
  reloadToken?: number;
  onClose: () => void;
  // Bubble the day's burned total up so Home can reflect it immediately.
  onChanged?: (day: ExerciseDay) => void;
  // Open the guided workout library (photos + step-by-step form).
  onBrowseGuided?: () => void;
  onRequireAuth?: () => void;
};

// Preset durations offered when logging an activity. Keeps entry to two taps
// (pick activity -> pick minutes) instead of a fiddly number input.
const DURATIONS = [10, 20, 30, 45, 60];

// The catalog is static, so cache it across opens for the whole app session.
let _catalogCache: ExerciseCatalog | null = null;

export default function ExerciseSheet({ visible, date, reloadToken, onClose, onChanged, onBrowseGuided, onRequireAuth }: Props) {
  const [categories, setCategories] = useState<ExerciseCategory[]>(_catalogCache?.categories ?? []);
  const [day, setDay] = useState<ExerciseDay | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which activity is awaiting a duration choice (null = none selected).
  const [pending, setPending] = useState<{ key: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) {
      setPending(null);
      setError(null);
      return;
    }
    let alive = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        if (!_catalogCache) {
          _catalogCache = await getExerciseCatalog();
        }
        const d = await getExerciseLogs(date);
        if (!alive) return;
        setCategories(_catalogCache.categories);
        setDay(d);
      } catch (e: any) {
        if (!alive) return;
        if (e instanceof AuthRequiredError) {
          onRequireAuth?.();
          onClose();
          return;
        }
        setError(e?.message || "Couldn't load exercises. Try again.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [visible, date, reloadToken]);

  async function log(key: string, minutes: number) {
    setBusy(true);
    setError(null);
    try {
      const d = await addExerciseLog(date, key, minutes);
      setDay(d);
      onChanged?.(d);
      setPending(null);
    } catch (e: any) {
      if (e instanceof AuthRequiredError) {
        onRequireAuth?.();
        onClose();
        return;
      }
      setError(e?.message || "Couldn't log that. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    setBusy(true);
    try {
      const d = await deleteExerciseLog(id);
      setDay(d);
      onChanged?.(d);
    } catch (e: any) {
      if (e instanceof AuthRequiredError) {
        onRequireAuth?.();
        onClose();
        return;
      }
      setError(e?.message || "Couldn't remove that. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!visible) return null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.backdropTap} onPress={onClose} />
        <View style={styles.sheet}>
        <View style={styles.grabber} />
        <View style={styles.headRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Exercise</Text>
            <Text style={styles.sub}>Log today's activity — calories burned use your weight.</Text>
          </View>
          <View style={styles.burnBadge}>
            <Icon name="flame" size={14} color={colors.orange} />
            <Text style={styles.burnText}>{Math.round(day?.totalKcal ?? 0)} kcal</Text>
          </View>
        </View>

        {error && <Text style={styles.error}>{error}</Text>}

        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.green} />
          </View>
        ) : (
          <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
            {onBrowseGuided && (
              <Pressable style={styles.guidedBtn} onPress={onBrowseGuided} disabled={busy}>
                <Icon name="playCircle" size={18} color={colors.green} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.guidedTitle}>Guided workouts</Text>
                  <Text style={styles.guidedSub}>Demo photos & step-by-step form · adds to today</Text>
                </View>
                <Icon name="chevronRight" size={18} color={colors.mute} />
              </Pressable>
            )}
            {/* Today's logged entries */}
            {day && day.entries.length > 0 && (
              <View style={styles.loggedWrap}>
                <Text style={styles.sectionLabel}>
                  Today · {Math.round(day.totalMinutes)} min · {Math.round(day.totalKcal)} kcal
                </Text>
                {day.entries.map((e) => (
                  <View key={e.id} style={styles.loggedRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.loggedName}>{e.name}</Text>
                      <Text style={styles.loggedSub}>
                        {Math.round(e.minutes)} min · {Math.round(e.kcal)} kcal
                      </Text>
                    </View>
                    <Pressable onPress={() => remove(e.id)} hitSlop={8} disabled={busy}>
                      <Icon name="trash" size={18} color={colors.mute} />
                    </Pressable>
                  </View>
                ))}
              </View>
            )}

            {/* Catalog grouped by category */}
            {categories.map((cat) => (
              <View key={cat.key} style={styles.catBlock}>
                <Text style={styles.sectionLabel}>{cat.label}</Text>
                {cat.items.map((it) => {
                  const active = pending?.key === it.key;
                  return (
                    <View key={it.key}>
                      <Pressable
                        style={[styles.row, active && styles.rowActive]}
                        onPress={() => setPending(active ? null : { key: it.key, name: it.name })}
                        disabled={busy}
                      >
                        <Icon name="dumbbell" size={16} color={colors.green} />
                        <Text style={styles.rowName}>{it.name}</Text>
                        <Icon name={active ? "close" : "plus"} size={18} color={colors.mute} />
                      </Pressable>
                      {active && (
                        <View style={styles.durRow}>
                          {DURATIONS.map((m) => (
                            <Pressable
                              key={m}
                              style={styles.durChip}
                              onPress={() => log(it.key, m)}
                              disabled={busy}
                            >
                              <Text style={styles.durText}>{m}m</Text>
                            </Pressable>
                          ))}
                        </View>
                      )}
                    </View>
                  );
                })}
              </View>
            ))}
            <View style={{ height: 20 }} />
          </ScrollView>
        )}

        <Pressable style={styles.cancel} onPress={onClose}>
          <Text style={styles.cancelText}>Done</Text>
        </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" },
  backdropTap: { flex: 1 },
  sheet: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    paddingHorizontal: 20,
    paddingBottom: 24,
    height: "82%",
  },
  grabber: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: "#CBD5D0", marginTop: 10, marginBottom: 14 },
  headRow: { flexDirection: "row", alignItems: "flex-start", gap: 12, marginBottom: 8 },
  title: { fontSize: 20, fontWeight: "900", color: colors.ink, letterSpacing: -0.3 },
  sub: { fontSize: 13, color: colors.mute, marginTop: 4, lineHeight: 18 },
  burnBadge: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: colors.card, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: colors.hairline },
  burnText: { color: colors.ink, fontWeight: "800", fontSize: 13 },
  error: { color: colors.red, fontSize: 12.5, marginTop: 8 },
  center: { paddingTop: 40, alignItems: "center", flex: 1 },
  loggedWrap: { marginTop: 8, marginBottom: 4 },
  guidedBtn: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.card, borderRadius: 14, padding: 14, marginTop: 12, borderWidth: 1, borderColor: colors.green, ...elevation.sm },
  guidedTitle: { color: colors.ink, fontWeight: "800", fontSize: 15 },
  guidedSub: { color: colors.mute, fontWeight: "600", fontSize: 12, marginTop: 2 },
  sectionLabel: { fontSize: 12, fontWeight: "800", color: colors.mute, textTransform: "uppercase", letterSpacing: 0.4, marginTop: 14, marginBottom: 8 },
  loggedRow: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.card, borderRadius: 14, padding: 14, marginBottom: 8, ...elevation.sm },
  loggedName: { color: colors.ink, fontWeight: "800", fontSize: 15 },
  loggedSub: { color: colors.mute, fontWeight: "600", fontSize: 12, marginTop: 2 },
  catBlock: {},
  row: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.card, borderRadius: 14, padding: 14, marginBottom: 8, ...elevation.sm },
  rowActive: { borderWidth: 1, borderColor: colors.green, marginBottom: 0, borderBottomLeftRadius: 0, borderBottomRightRadius: 0 },
  rowName: { color: colors.ink, fontWeight: "800", fontSize: 15, flex: 1 },
  durRow: { flexDirection: "row", gap: 8, backgroundColor: colors.card, borderWidth: 1, borderTopWidth: 0, borderColor: colors.green, borderBottomLeftRadius: 14, borderBottomRightRadius: 14, padding: 12, marginBottom: 8 },
  durChip: { flex: 1, alignItems: "center", backgroundColor: colors.bg, borderRadius: 10, paddingVertical: 10, borderWidth: 1, borderColor: colors.hairline },
  durText: { color: colors.ink, fontWeight: "800", fontSize: 13 },
  cancel: { alignItems: "center", paddingVertical: 14, marginTop: 4 },
  cancelText: { color: colors.mute, fontWeight: "700", fontSize: 14 },
});
