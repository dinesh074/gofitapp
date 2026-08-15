import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import Screen from "./Screen";
import Icon from "./Icon";
import { colors, elevation } from "./theme";
import {
  addExerciseLog,
  AuthRequiredError,
  deleteExerciseLog,
  ExerciseCatalog,
  ExerciseDay,
  ExerciseHistoryDay,
  getExerciseCatalog,
  getExerciseHistory,
  getExerciseLogs,
} from "./api";
import { todayKey } from "./storage";
import { useApp } from "./AppContext";
import { goBackOrTabs } from "./nav";
import WorkoutLibrary from "./WorkoutLibrary";

const DURATIONS = [10, 20, 30, 45, 60];
const HISTORY_DAYS = 14;

function shortDate(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00`);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export default function ExerciseLogScreen() {
  const navigation = useNavigation<any>();
  const { requireAuth } = useApp();
  const date = todayKey();
  const [catalog, setCatalog] = useState<ExerciseCatalog | null>(null);
  const [day, setDay] = useState<ExerciseDay | null>(null);
  const [history, setHistory] = useState<ExerciseHistoryDay[]>([]);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [c, d, h] = await Promise.all([getExerciseCatalog(), getExerciseLogs(date), getExerciseHistory(HISTORY_DAYS)]);
        if (!alive) return;
        setCatalog(c);
        setDay(d);
        setHistory(h.days ?? []);
      } catch (e: any) {
        if (!alive) return;
        if (e instanceof AuthRequiredError) {
          requireAuth();
          goBackOrTabs(navigation);
          return;
        }
        setError(e?.message || "Couldn't load workouts.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [date]);

  async function log(key: string, minutes: number) {
    setBusy(true);
    setError(null);
    try {
      const [d, h] = await Promise.all([addExerciseLog(date, key, minutes), getExerciseHistory(HISTORY_DAYS)]);
      setDay(d);
      setHistory(h.days ?? []);
      setPendingKey(null);
    } catch (e: any) {
      if (e instanceof AuthRequiredError) {
        requireAuth();
        goBackOrTabs(navigation);
        return;
      }
      setError(e?.message || "Couldn't log workout.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    setBusy(true);
    try {
      const [d, h] = await Promise.all([deleteExerciseLog(id), getExerciseHistory(HISTORY_DAYS)]);
      setDay(d);
      setHistory(h.days ?? []);
    } catch (e: any) {
      if (e instanceof AuthRequiredError) {
        requireAuth();
        goBackOrTabs(navigation);
        return;
      }
      setError(e?.message || "Couldn't delete workout.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen edgeTop>
      <View style={styles.root}>
        <View style={styles.head}>
          <Pressable style={styles.backBtn} onPress={() => goBackOrTabs(navigation)} hitSlop={8}>
            <Icon name="chevronLeft" size={18} color={colors.green} />
            <Text style={styles.backText}>Back</Text>
          </Pressable>
          <Text style={styles.title}>Exercise</Text>
          <View style={styles.kcalPill}>
            <Icon name="flame" size={13} color={colors.orange} />
            <Text style={styles.kcalText}>{Math.round(day?.totalKcal ?? 0)} kcal</Text>
          </View>
        </View>
        <ScrollView contentContainerStyle={styles.body}>
          {error && <Text style={styles.error}>{error}</Text>}
          {loading ? (
            <View style={styles.center}>
              <ActivityIndicator color={colors.green} />
            </View>
          ) : (
            <>
              {!!day?.entries?.length && (
                <View style={styles.card}>
                  <Text style={styles.section}>Today · {Math.round(day.totalMinutes)} min · {Math.round(day.totalKcal)} kcal</Text>
                  {day.entries.map((e) => (
                    <View key={e.id} style={styles.loggedRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.loggedName}>{e.name}</Text>
                        <Text style={styles.loggedSub}>{Math.round(e.minutes)} min · {Math.round(e.kcal)} kcal</Text>
                      </View>
                      <Pressable onPress={() => remove(e.id)} disabled={busy}>
                        <Icon name="trash" size={16} color={colors.mute} />
                      </Pressable>
                    </View>
                  ))}
                </View>
              )}
              <View style={styles.card}>
                <Text style={styles.section}>Exercise history · last {HISTORY_DAYS} days</Text>
                <Text style={styles.historyHint}>Past entries are view-only. Add/edit/delete is available for today only.</Text>
                {(history ?? []).filter((h) => h.date !== date).length === 0 ? (
                  <Text style={styles.emptyHistory}>No past exercise entries in this window.</Text>
                ) : (
                  (history ?? [])
                    .filter((h) => h.date !== date)
                    .map((h) => (
                      <View key={h.date} style={styles.historyDay}>
                        <Text style={styles.historyTitle}>
                          {shortDate(h.date)} · {Math.round(h.totalMinutes)} min · {Math.round(h.totalKcal)} kcal
                        </Text>
                        {h.entries.map((e, i) => (
                          <View key={e.id} style={[styles.historyRow, i > 0 && styles.historyRowDivider]}>
                            <Text style={styles.historyName}>{e.name}</Text>
                            <Text style={styles.historyMeta}>{Math.round(e.minutes)} min · {Math.round(e.kcal)} kcal</Text>
                          </View>
                        ))}
                      </View>
                    ))
                )}
              </View>

              {(catalog?.categories ?? []).map((cat) => (
                <View key={cat.key} style={styles.card}>
                  <Text style={styles.section}>{cat.label}</Text>
                  {cat.items.map((it) => {
                    const active = pendingKey === it.key;
                    return (
                      <View key={it.key}>
                        <Pressable
                          style={[styles.itemRow, active && styles.itemRowActive]}
                          onPress={() => setPendingKey(active ? null : it.key)}
                          disabled={busy}
                        >
                          <Icon name="dumbbell" size={15} color={colors.green} />
                          <Text style={styles.itemName}>{it.name}</Text>
                          <Icon name={active ? "chevronUp" : "chevronDown"} size={14} color={colors.mute} />
                        </Pressable>
                        {active && (
                          <View style={styles.durRow}>
                            {DURATIONS.map((d) => (
                              <Pressable key={d} style={styles.durChip} onPress={() => log(it.key, d)} disabled={busy}>
                                <Text style={styles.durText}>{d}m</Text>
                              </Pressable>
                            ))}
                          </View>
                        )}
                      </View>
                    );
                  })}
                </View>
              ))}

              <Pressable style={styles.guidedBtn} onPress={() => setShowLibrary(true)}>
                <View style={styles.guidedIcon}>
                  <Icon name="dumbbell" size={16} color={colors.green} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.guidedTitle}>Guided workouts</Text>
                  <Text style={styles.guidedSub}>Demo photos + step-by-step form</Text>
                </View>
                <Icon name="chevronRight" size={16} color={colors.mute} />
              </Pressable>
            </>
          )}
        </ScrollView>
      </View>

      {showLibrary && (
        <WorkoutLibrary
          visible={showLibrary}
          date={date}
          onClose={() => setShowLibrary(false)}
          onLogged={(d) => setDay(d)}
          onRequireAuth={() => {
            setShowLibrary(false);
            requireAuth();
          }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  head: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8, flexDirection: "row", alignItems: "center", gap: 10 },
  backBtn: { flexDirection: "row", alignItems: "center", gap: 4, width: 70 },
  backText: { color: colors.green, fontWeight: "800", fontSize: 13 },
  title: { flex: 1, textAlign: "center", color: colors.ink, fontSize: 20, fontWeight: "900" },
  kcalPill: { width: 92, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, backgroundColor: colors.cardMuted, borderRadius: 999, paddingVertical: 6 },
  kcalText: { color: colors.inkSoft, fontSize: 12, fontWeight: "800" },
  body: { padding: 16, paddingBottom: 28, gap: 10 },
  error: { color: colors.red, fontSize: 12.5, fontWeight: "700" },
  center: { alignItems: "center", justifyContent: "center", paddingVertical: 20 },
  card: { backgroundColor: colors.card, borderRadius: 14, padding: 12, gap: 8, ...elevation.sm },
  section: { color: colors.mute, fontSize: 11.5, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.4 },
  loggedRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.line },
  loggedName: { color: colors.ink, fontSize: 14, fontWeight: "700" },
  loggedSub: { color: colors.mute, fontSize: 12, fontWeight: "600", marginTop: 1 },
  historyHint: { color: colors.faint, fontSize: 11.5, fontWeight: "600", marginTop: -2, marginBottom: 2 },
  emptyHistory: { color: colors.mute, fontSize: 12.5, fontWeight: "600", paddingVertical: 4 },
  historyDay: { borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8, marginTop: 2 },
  historyTitle: { color: colors.ink, fontSize: 12.5, fontWeight: "800", marginBottom: 5 },
  historyRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, paddingVertical: 5 },
  historyRowDivider: { borderTopWidth: 1, borderTopColor: colors.hairline },
  historyName: { color: colors.inkSoft, fontSize: 12.5, fontWeight: "700", flex: 1 },
  historyMeta: { color: colors.mute, fontSize: 11.5, fontWeight: "700" },
  itemRow: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.cardMuted, borderRadius: 10, paddingVertical: 9, paddingHorizontal: 10, marginTop: 2 },
  itemRowActive: { borderWidth: 1, borderColor: colors.greenTint },
  itemName: { flex: 1, color: colors.ink, fontSize: 13, fontWeight: "700" },
  durRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8, marginBottom: 2 },
  durChip: { backgroundColor: colors.greenTint, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  durText: { color: colors.green, fontSize: 12, fontWeight: "800" },
  guidedBtn: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.card, borderRadius: 14, padding: 12, ...elevation.sm },
  guidedIcon: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.greenTint, alignItems: "center", justifyContent: "center" },
  guidedTitle: { color: colors.ink, fontWeight: "800", fontSize: 14 },
  guidedSub: { color: colors.mute, fontWeight: "600", fontSize: 12, marginTop: 1 },
});
