import React, { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { LIMITS, clamp } from "./nutrition";
import { addWeight } from "./storage";
import { addServerWeight, AuthRequiredError } from "./api";
import { colors, radius, elevation } from "./theme";
import Icon from "./Icon";

type Props = {
  visible: boolean;
  initialKg: number;
  onClose: () => void;
  // Bubble the new weight up so the profile / targets stay in sync (App keeps
  // profile.weightKg as the single source of truth for goal math).
  onLogged: (kg: number) => void;
  onRequireAuth?: () => void;
};

// Compact quick-log for today's weight, reachable from the global Add hub. Same
// real persistence path as the Progress screen: local cache (addWeight) + the
// weight_logs table (addServerWeight), then it tells the app so every dependent
// target recalculates.
export default function WeightSheet({ visible, initialKg, onClose, onLogged, onRequireAuth }: Props) {
  const [entry, setEntry] = useState<number>(Math.round(initialKg));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (visible) setEntry(Math.round(initialKg));
  }, [visible, initialKg]);

  async function save() {
    setBusy(true);
    try {
      await addWeight(entry);
      await addServerWeight(entry);
      onLogged(entry);
      onClose();
    } catch (e) {
      if (e instanceof AuthRequiredError) onRequireAuth?.();
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
          <Text style={styles.title}>Log today's weight</Text>
          <Text style={styles.sub}>Updates your profile and all dependent targets.</Text>

          <View style={styles.inputRow}>
            <Pressable
              style={styles.btn}
              onPress={() => setEntry((v) => clamp(v - 1, LIMITS.weightKg.min, LIMITS.weightKg.max))}
            >
              <Icon name="minus" size={22} color={colors.green} />
            </Pressable>
            <View style={styles.center}>
              <TextInput
                style={styles.input}
                keyboardType="numeric"
                value={String(entry)}
                onChangeText={(t) => {
                  const n = parseInt(t.replace(/[^0-9]/g, ""), 10);
                  if (!isNaN(n)) setEntry(clamp(n, LIMITS.weightKg.min, LIMITS.weightKg.max));
                  else if (t === "") setEntry(LIMITS.weightKg.min);
                }}
              />
              <Text style={styles.unit}>kg</Text>
            </View>
            <Pressable
              style={styles.btn}
              onPress={() => setEntry((v) => clamp(v + 1, LIMITS.weightKg.min, LIMITS.weightKg.max))}
            >
              <Icon name="plus" size={22} color={colors.green} />
            </Pressable>
          </View>

          <Pressable style={styles.logBtn} onPress={save} disabled={busy}>
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.logBtnText}>Save weight</Text>
            )}
          </Pressable>
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
    paddingBottom: 26,
  },
  grabber: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: "#CBD5D0", marginTop: 10, marginBottom: 14 },
  title: { fontSize: 20, fontWeight: "900", color: colors.ink, letterSpacing: -0.3 },
  sub: { fontSize: 13, color: colors.mute, marginTop: 4, marginBottom: 18, lineHeight: 18 },
  inputRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  btn: { width: 52, height: 52, borderRadius: 26, backgroundColor: colors.greenTint, alignItems: "center", justifyContent: "center" },
  center: { alignItems: "center", flex: 1 },
  input: { fontSize: 34, fontWeight: "900", color: colors.ink, textAlign: "center", minWidth: 90, padding: 0 },
  unit: { fontSize: 13, color: colors.mute, marginTop: -2 },
  logBtn: { backgroundColor: colors.green, borderRadius: radius.md, paddingVertical: 15, alignItems: "center", marginTop: 22, ...elevation.sm },
  logBtnText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  cancel: { alignItems: "center", paddingVertical: 12, marginTop: 2 },
  cancelText: { color: colors.mute, fontWeight: "700", fontSize: 14 },
});
