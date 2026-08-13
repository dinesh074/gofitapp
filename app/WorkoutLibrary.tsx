import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { colors, elevation, radius } from "./theme";
import Icon from "./Icon";
import { addExerciseLog, AuthRequiredError, ExerciseDay } from "./api";
import {
  facet,
  filterWorkouts,
  loadWorkouts,
  metForCategory,
  Workout,
  workoutImageUrl,
} from "./workouts";

type Props = {
  visible: boolean;
  date: string; // "YYYY-MM-DD"
  onClose: () => void;
  onLogged?: (day: ExerciseDay) => void;
  onRequireAuth?: () => void;
};

// Minutes of *actual effort* for a single movement. Strength moves are usually
// just a few minutes of real work (a few sets), so we start low; cardio/longer
// sessions can pick the bigger chips.
const DURATIONS = [3, 5, 10, 15, 30];

function levelColor(level: string): string {
  if (level === "expert") return colors.red;
  if (level === "intermediate") return colors.orange;
  return colors.green;
}

// Public-domain guided exercise library (free-exercise-db). Two modes in one
// sheet: a searchable/filterable list, and a detail view with the demonstration
// photos toggling to fake a short animation plus step-by-step instructions and
// a one-tap "add to today" that logs real calories via the exercise backend.
export default function WorkoutLibrary({ visible, date, onClose, onLogged, onRequireAuth }: Props) {
  const [all, setAll] = useState<Workout[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [selected, setSelected] = useState<Workout | null>(null);
  const [busy, setBusy] = useState(false);
  const [logged, setLogged] = useState(false);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await loadWorkouts();
        if (alive) setAll(data);
      } catch (e: any) {
        if (alive) setError(e?.message || "Couldn't load the library.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [visible]);

  const categories = useMemo(() => facet(all, "category"), [all]);
  const list = useMemo(
    () => filterWorkouts(all, { category: category ?? undefined, query }),
    [all, category, query]
  );

  async function log(w: Workout, minutes: number) {
    setBusy(true);
    setError(null);
    try {
      const day = await addExerciseLog(date, w.id, minutes, {
        name: w.name,
        met: metForCategory(w.category),
      });
      onLogged?.(day);
      setLogged(true);
      setTimeout(() => setLogged(false), 1600);
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

  if (!visible) return null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.backdropTap} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.grabber} />

          {selected ? (
            <WorkoutDetail
              workout={selected}
              busy={busy}
              logged={logged}
              onBack={() => setSelected(null)}
              onLog={(m) => log(selected, m)}
            />
          ) : (
            <>
              <Text style={styles.title}>Guided workouts</Text>
              <Text style={styles.sub}>
                Public-domain exercise library — demo photos + step-by-step form.
              </Text>

              <View style={styles.searchWrap}>
                <Icon name="search" size={16} color={colors.mute} />
                <TextInput
                  style={styles.searchInput}
                  placeholder="Search exercises"
                  placeholderTextColor={colors.faint}
                  value={query}
                  onChangeText={setQuery}
                  autoCorrect={false}
                />
                {query.length > 0 && (
                  <Pressable onPress={() => setQuery("")} hitSlop={8}>
                    <Icon name="close" size={16} color={colors.mute} />
                  </Pressable>
                )}
              </View>

              {categories.length > 0 && (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.chipRow}
                >
                  <Pressable
                    style={[styles.chip, !category && styles.chipOn]}
                    onPress={() => setCategory(null)}
                  >
                    <Text style={[styles.chipText, !category && styles.chipTextOn]}>All</Text>
                  </Pressable>
                  {categories.map((c) => (
                    <Pressable
                      key={c}
                      style={[styles.chip, category === c && styles.chipOn]}
                      onPress={() => setCategory(category === c ? null : c)}
                    >
                      <Text style={[styles.chipText, category === c && styles.chipTextOn]}>{c}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              )}

              {error && <Text style={styles.error}>{error}</Text>}

              {loading ? (
                <View style={styles.center}>
                  <ActivityIndicator color={colors.green} />
                  <Text style={styles.muted}>Loading library…</Text>
                </View>
              ) : (
                <FlatList
                  data={list}
                  keyExtractor={(w) => w.id}
                  showsVerticalScrollIndicator={false}
                  initialNumToRender={10}
                  windowSize={7}
                  contentContainerStyle={{ paddingBottom: 12 }}
                  ListEmptyComponent={<Text style={styles.muted}>No exercises match that search.</Text>}
                  renderItem={({ item }) => (
                    <Pressable style={styles.card} onPress={() => setSelected(item)}>
                      {item.images[0] ? (
                        <Image source={{ uri: workoutImageUrl(item.images[0]) }} style={styles.thumb} />
                      ) : (
                        <View style={[styles.thumb, styles.thumbEmpty]}>
                          <Icon name="dumbbell" size={20} color={colors.faint} />
                        </View>
                      )}
                      <View style={{ flex: 1 }}>
                        <Text style={styles.cardName} numberOfLines={2}>{item.name}</Text>
                        <Text style={styles.cardSub} numberOfLines={1}>
                          {item.primaryMuscles.join(", ") || item.category}
                        </Text>
                        <View style={styles.badgeRow}>
                          <View style={[styles.levelBadge, { backgroundColor: levelColor(item.level) }]}>
                            <Text style={styles.levelText}>{item.level}</Text>
                          </View>
                          {item.equipment && <Text style={styles.equipText}>{item.equipment}</Text>}
                        </View>
                      </View>
                      <Icon name="chevronRight" size={18} color={colors.faint} />
                    </Pressable>
                  )}
                />
              )}
            </>
          )}

          {!selected && (
            <Pressable style={styles.cancel} onPress={onClose}>
              <Text style={styles.cancelText}>Done</Text>
            </Pressable>
          )}
        </View>
      </View>
    </Modal>
  );
}

function WorkoutDetail({
  workout,
  busy,
  logged,
  onBack,
  onLog,
}: {
  workout: Workout;
  busy: boolean;
  logged: boolean;
  onBack: () => void;
  onLog: (minutes: number) => void;
}) {
  // Toggle between the start/end demo photos to fake a short animation loop.
  const [frame, setFrame] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (workout.images.length < 2) return;
    timer.current = setInterval(() => setFrame((f) => (f + 1) % workout.images.length), 1100);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [workout.id, workout.images.length]);

  const img = workout.images[frame] ?? workout.images[0];

  return (
    <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
      <Pressable style={styles.backRow} onPress={onBack} hitSlop={8}>
        <Icon name="chevronLeft" size={20} color={colors.ink} />
        <Text style={styles.backText}>All exercises</Text>
      </Pressable>

      <Text style={styles.detailName}>{workout.name}</Text>

      {img ? (
        <Image source={{ uri: workoutImageUrl(img) }} style={styles.detailImage} resizeMode="cover" />
      ) : (
        <View style={[styles.detailImage, styles.thumbEmpty]}>
          <Icon name="dumbbell" size={40} color={colors.faint} />
        </View>
      )}
      {workout.images.length > 1 && (
        <Text style={styles.frameHint}>Demonstration · start ⇄ finish position</Text>
      )}

      <View style={styles.metaRow}>
        <View style={[styles.levelBadge, { backgroundColor: levelColor(workout.level) }]}>
          <Text style={styles.levelText}>{workout.level}</Text>
        </View>
        {!!workout.equipment && <Text style={styles.metaChip}>{workout.equipment}</Text>}
        {!!workout.category && <Text style={styles.metaChip}>{workout.category}</Text>}
        {!!workout.force && <Text style={styles.metaChip}>{workout.force}</Text>}
      </View>

      {workout.primaryMuscles.length > 0 && (
        <Text style={styles.muscles}>
          <Text style={styles.musclesLabel}>Targets: </Text>
          {workout.primaryMuscles.join(", ")}
          {workout.secondaryMuscles.length > 0 && ` · also ${workout.secondaryMuscles.join(", ")}`}
        </Text>
      )}

      <Text style={styles.sectionLabel}>How to do it</Text>
      {workout.instructions.map((step, i) => (
        <View key={i} style={styles.stepRow}>
          <View style={styles.stepNum}>
            <Text style={styles.stepNumText}>{i + 1}</Text>
          </View>
          <Text style={styles.stepText}>{step}</Text>
        </View>
      ))}

      <Text style={styles.sectionLabel}>Add to today</Text>
      <Text style={styles.logHint}>
        We'll estimate calories burned from your weight and the time you did it.
      </Text>
      <View style={styles.durRow}>
        {DURATIONS.map((m) => (
          <Pressable key={m} style={styles.durChip} onPress={() => onLog(m)} disabled={busy}>
            <Text style={styles.durText}>{m}m</Text>
          </Pressable>
        ))}
      </View>
      {busy && <ActivityIndicator color={colors.green} style={{ marginTop: 12 }} />}
      {logged && (
        <View style={styles.loggedToast}>
          <Icon name="check" size={16} color={colors.green} />
          <Text style={styles.loggedToastText}>Added to today</Text>
        </View>
      )}
      <View style={{ height: 24 }} />
    </ScrollView>
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
    height: "88%",
  },
  grabber: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: "#CBD5D0", marginTop: 10, marginBottom: 14 },
  title: { fontSize: 20, fontWeight: "900", color: colors.ink, letterSpacing: -0.3 },
  sub: { fontSize: 13, color: colors.mute, marginTop: 4, marginBottom: 12, lineHeight: 18 },
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.card,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  searchInput: { flex: 1, fontSize: 15, color: colors.ink, padding: 0 },
  chipRow: { gap: 8, paddingVertical: 12 },
  chip: { backgroundColor: colors.card, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1, borderColor: colors.hairline },
  chipOn: { backgroundColor: colors.green, borderColor: colors.green },
  chipText: { color: colors.inkSoft, fontWeight: "700", fontSize: 13, textTransform: "capitalize" },
  chipTextOn: { color: "#fff" },
  error: { color: colors.red, fontSize: 12.5, marginTop: 8 },
  center: { paddingTop: 40, alignItems: "center", flex: 1, gap: 10 },
  muted: { color: colors.mute, fontSize: 13, textAlign: "center", marginTop: 20 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 10,
    marginBottom: 10,
    ...elevation.sm,
  },
  thumb: { width: 64, height: 64, borderRadius: 12, backgroundColor: colors.cardMuted },
  thumbEmpty: { alignItems: "center", justifyContent: "center" },
  cardName: { color: colors.ink, fontWeight: "800", fontSize: 14.5 },
  cardSub: { color: colors.mute, fontWeight: "600", fontSize: 12, marginTop: 2, textTransform: "capitalize" },
  badgeRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 },
  levelBadge: { borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  levelText: { color: "#fff", fontWeight: "800", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.3 },
  equipText: { color: colors.faint, fontWeight: "600", fontSize: 11.5, textTransform: "capitalize" },
  cancel: { alignItems: "center", paddingVertical: 12, marginTop: 2 },
  cancelText: { color: colors.mute, fontWeight: "700", fontSize: 14 },
  // detail
  backRow: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 4, marginBottom: 6 },
  backText: { color: colors.ink, fontWeight: "700", fontSize: 14 },
  detailName: { fontSize: 21, fontWeight: "900", color: colors.ink, letterSpacing: -0.3, marginBottom: 12 },
  detailImage: { width: "100%", height: 220, borderRadius: 18, backgroundColor: colors.cardMuted },
  frameHint: { color: colors.faint, fontSize: 11.5, textAlign: "center", marginTop: 6, fontWeight: "600" },
  metaRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 14 },
  metaChip: { backgroundColor: colors.card, color: colors.inkSoft, fontWeight: "700", fontSize: 12, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, textTransform: "capitalize", overflow: "hidden" },
  muscles: { color: colors.ink, fontSize: 13.5, marginTop: 12, lineHeight: 19, textTransform: "capitalize" },
  musclesLabel: { fontWeight: "800", color: colors.mute, textTransform: "none" },
  sectionLabel: { fontSize: 12, fontWeight: "800", color: colors.mute, textTransform: "uppercase", letterSpacing: 0.4, marginTop: 22, marginBottom: 10 },
  stepRow: { flexDirection: "row", gap: 12, marginBottom: 12 },
  stepNum: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.greenTint, alignItems: "center", justifyContent: "center", marginTop: 1 },
  stepNumText: { color: colors.green, fontWeight: "900", fontSize: 12 },
  stepText: { flex: 1, color: colors.ink, fontSize: 14, lineHeight: 20 },
  logHint: { color: colors.mute, fontSize: 12.5, marginTop: -4, marginBottom: 10, lineHeight: 17 },
  durRow: { flexDirection: "row", gap: 8 },
  durChip: { flex: 1, alignItems: "center", backgroundColor: colors.green, borderRadius: 12, paddingVertical: 12, ...elevation.sm },
  durText: { color: "#fff", fontWeight: "800", fontSize: 14 },
  loggedToast: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 14 },
  loggedToastText: { color: colors.green, fontWeight: "800", fontSize: 14 },
});
