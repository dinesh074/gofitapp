import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { FoodSuggestion, searchFoods, AuthRequiredError } from "./api";
import { colors, radius, elevation } from "./theme";
import Icon from "./Icon";

type Props = {
  visible: boolean;
  // The name of the item being replaced, shown as context ("Replacing: Paneer").
  replacing?: string | null;
  onClose: () => void;
  onPick: (food: FoodSuggestion) => void;
  onRequireAuth?: () => void;
};

// Search-and-swap sheet: the user taps "Not right?" on a scanned item and
// picks the correct food from the local DB. This is a plain lookup (no AI,
// no scan credit) so it's instant and free to use as often as needed.
export default function FoodSearchSheet({
  visible,
  replacing,
  onClose,
  onPick,
  onRequireAuth,
}: Props) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<FoodSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const reqId = useRef(0);

  useEffect(() => {
    if (!visible) {
      setQ("");
      setResults([]);
      setError(null);
      setSearched(false);
      setLoading(false);
    }
  }, [visible]);

  // Debounced search so we don't fire a request on every keystroke.
  useEffect(() => {
    if (!visible) return;
    const query = q.trim();
    if (query.length < 2) {
      setResults([]);
      setSearched(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const id = ++reqId.current;
    const t = setTimeout(async () => {
      try {
        const r = await searchFoods(query);
        if (id !== reqId.current) return; // a newer query superseded this one
        setResults(r);
        setSearched(true);
      } catch (e: any) {
        if (id !== reqId.current) return;
        if (e instanceof AuthRequiredError) {
          onRequireAuth?.();
          onClose();
          return;
        }
        setError(e?.message || "Couldn't search foods. Try again.");
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    }, 280);
    return () => clearTimeout(t);
  }, [q, visible]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.backdropTap} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.grabber} />
          <Text style={styles.title}>Swap ingredient</Text>
          {replacing ? (
            <Text style={styles.sub}>
              Replacing <Text style={styles.subStrong}>{replacing}</Text> — search for the right food.
            </Text>
          ) : (
            <Text style={styles.sub}>Search the food database for the right item.</Text>
          )}

          <View style={styles.searchRow}>
            <Icon name="search" size={18} color={colors.mute} />
            <TextInput
              style={styles.input}
              value={q}
              onChangeText={setQ}
              placeholder="e.g. tofu, rajma, chicken curry"
              placeholderTextColor={colors.faint}
              autoFocus
              autoCorrect={false}
              returnKeyType="search"
            />
            {q.length > 0 && (
              <Pressable onPress={() => setQ("")} hitSlop={8}>
                <Icon name="close" size={18} color={colors.mute} />
              </Pressable>
            )}
          </View>

          {error && <Text style={styles.error}>{error}</Text>}

          <View style={styles.listWrap}>
            {loading ? (
              <View style={styles.center}>
                <ActivityIndicator color={colors.green} />
              </View>
            ) : searched && results.length === 0 ? (
              <Text style={styles.empty}>
                No matches. Try a simpler name (e.g. "dal" instead of "yellow moong dal fry").
              </Text>
            ) : (
              <FlatList
                data={results}
                keyExtractor={(it) => it.key}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
                renderItem={({ item }) => (
                  <Pressable style={styles.row} onPress={() => onPick(item)}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowName}>{item.name}</Text>
                      <Text style={styles.rowSub}>
                        {Math.round(item.kcal_per_unit)} kcal / {item.unit} · P{" "}
                        {Math.round(item.protein_g_per_unit)}g
                      </Text>
                    </View>
                    <Icon name="plus" size={18} color={colors.green} />
                  </Pressable>
                )}
              />
            )}
          </View>

          <Pressable style={styles.cancel} onPress={onClose}>
            <Text style={styles.cancelText}>Cancel</Text>
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
    height: "80%",
  },
  grabber: {
    alignSelf: "center",
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: "#CBD5D0",
    marginTop: 10,
    marginBottom: 14,
  },
  title: { fontSize: 20, fontWeight: "900", color: colors.ink, letterSpacing: -0.3 },
  sub: { fontSize: 13, color: colors.mute, marginTop: 4, marginBottom: 14, lineHeight: 18 },
  subStrong: { color: colors.ink, fontWeight: "800" },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.card,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  input: { flex: 1, fontSize: 15, fontWeight: "600", color: colors.ink, paddingVertical: 12 },
  error: { color: colors.red, fontSize: 12.5, marginTop: 10 },
  listWrap: { flex: 1, marginTop: 14 },
  center: { paddingTop: 30, alignItems: "center" },
  empty: { color: colors.mute, fontSize: 13, textAlign: "center", paddingTop: 24, lineHeight: 19, paddingHorizontal: 20 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 14,
    marginBottom: 8,
    ...elevation.sm,
  },
  rowName: { color: colors.ink, fontWeight: "800", fontSize: 15 },
  rowSub: { color: colors.mute, fontWeight: "600", fontSize: 12, marginTop: 2 },
  cancel: { alignItems: "center", paddingVertical: 14, marginTop: 4 },
  cancelText: { color: colors.mute, fontWeight: "700", fontSize: 14 },
});
