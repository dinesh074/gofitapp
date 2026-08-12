import React, { useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { analyzeText, AnalysisResult, PaywallError, AuthRequiredError } from "./api";
import { colors, radius, elevation } from "./theme";
import PressableScale from "./PressableScale";

type Props = {
  visible: boolean;
  onClose: () => void;
  onResult: (result: AnalysisResult) => void;
  onRequireAuth: () => void;
  onPaywall: () => void;
};

const EXAMPLES = [
  "2 rotis with dal and a katori of curd",
  "A plate of chicken biryani",
  "Masala dosa with sambar and chutney",
];

// Text-based meal logging -- same free-scan gate and DB-anchoring as a
// photo scan (backend/main.py's /analyze/text), just described in words.
// Useful when a photo isn't practical, and this is also the pipeline voice
// input feeds into (speech -> transcribed text -> this same call).
export default function DescribeMeal({ visible, onClose, onResult, onRequireAuth, onPaywall }: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    setText("");
    setError(null);
    onClose();
  }

  async function submit() {
    if (text.trim().length < 2) {
      setError("Describe what you ate — a few words is enough.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const result = await analyzeText(text.trim());
      setText("");
      onResult(result);
      onClose();
    } catch (e: any) {
      if (e instanceof PaywallError) {
        onClose();
        onPaywall();
        return;
      }
      if (e instanceof AuthRequiredError) {
        onClose();
        onRequireAuth();
        return;
      }
      setError(e?.message || "Couldn't parse that. Try describing it differently.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <View style={styles.backdrop}>
        <Pressable style={styles.backdropTap} onPress={close} />
        <View style={styles.sheet}>
          <View style={styles.grabber} />
          <Text style={styles.title}>Describe your meal</Text>
          <Text style={styles.sub}>
            No photo needed — just tell us what you ate, in your own words.
          </Text>

          <TextInput
            style={styles.input}
            placeholder={`e.g. "${EXAMPLES[0]}"`}
            placeholderTextColor={colors.faint}
            value={text}
            onChangeText={setText}
            multiline
            numberOfLines={3}
            maxLength={500}
            autoFocus
          />

          <View style={styles.examplesRow}>
            {EXAMPLES.map((ex) => (
              <Pressable key={ex} style={styles.exampleChip} onPress={() => setText(ex)}>
                <Text style={styles.exampleText}>{ex}</Text>
              </Pressable>
            ))}
          </View>

          {error && <Text style={styles.error}>{error}</Text>}

          <PressableScale style={[styles.cta, busy && styles.ctaBusy]} onPress={submit} disabled={busy}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.ctaText}>Analyze</Text>}
          </PressableScale>
          <Pressable style={styles.later} onPress={close}>
            <Text style={styles.laterText}>Cancel</Text>
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
    maxHeight: "90%",
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
  title: { fontSize: 22, fontWeight: "900", color: colors.ink, letterSpacing: -0.3 },
  sub: { fontSize: 13, color: colors.mute, marginTop: 4, lineHeight: 18 },
  input: {
    marginTop: 16,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 14,
    minHeight: 90,
    fontSize: 14.5,
    color: colors.ink,
    textAlignVertical: "top",
  },
  examplesRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
  exampleChip: {
    backgroundColor: colors.card,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  exampleText: { fontSize: 12, color: colors.mute, fontWeight: "600" },
  error: { color: colors.red, fontSize: 13, fontWeight: "700", marginTop: 12, textAlign: "center" },
  cta: {
    backgroundColor: colors.green,
    borderRadius: radius.md,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: 18,
    ...elevation.sm,
  },
  ctaBusy: { opacity: 0.8 },
  ctaText: { color: "#fff", fontWeight: "900", fontSize: 16 },
  later: { alignItems: "center", paddingVertical: 14 },
  laterText: { color: colors.mute, fontWeight: "700", fontSize: 14 },
});
