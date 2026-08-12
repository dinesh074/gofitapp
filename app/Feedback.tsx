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
import { submitFeedback, AuthRequiredError, FeedbackCategory } from "./api";
import { colors, radius, elevation } from "./theme";
import Icon, { IconName } from "./Icon";
import PressableScale from "./PressableScale";

type Props = {
  visible: boolean;
  onClose: () => void;
  onRequireAuth: () => void;
};

const CATEGORIES: { key: FeedbackCategory; label: string; icon: IconName }[] = [
  { key: "bug", label: "Something's broken", icon: "warning" },
  { key: "feature", label: "Feature idea", icon: "star" },
  { key: "general", label: "General feedback", icon: "comment" },
];

// A lightweight way for signed-in users to tell us what's broken or what
// they want next, without leaving the app. Every submission is tied to the
// real account that sent it -- see backend/feedback.py.
export default function Feedback({ visible, onClose, onRequireAuth }: Props) {
  const [category, setCategory] = useState<FeedbackCategory>("feature");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  function reset() {
    setCategory("feature");
    setMessage("");
    setError(null);
    setSent(false);
  }

  function close() {
    reset();
    onClose();
  }

  async function submit() {
    if (message.trim().length < 3) {
      setError("Let us know a bit more — a few words is plenty.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await submitFeedback(category, message.trim());
      setSent(true);
    } catch (e: any) {
      if (e instanceof AuthRequiredError) {
        onClose();
        onRequireAuth();
        return;
      }
      setError(e?.message || "Couldn't send that. Please try again.");
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

          {sent ? (
            <View style={styles.sentWrap}>
              <View style={styles.sentIcon}>
                <Icon name="check" size={30} color={colors.green} />
              </View>
              <Text style={styles.sentTitle}>Thanks — got it!</Text>
              <Text style={styles.sentSub}>
                We read every submission. It genuinely helps shape what we build next.
              </Text>
              <PressableScale style={styles.cta} onPress={close}>
                <Text style={styles.ctaText}>Done</Text>
              </PressableScale>
            </View>
          ) : (
            <>
              <Text style={styles.title}>Send feedback</Text>
              <Text style={styles.sub}>
                Bug, feature idea, or just a thought — we read all of these.
              </Text>

              <View style={styles.catRow}>
                {CATEGORIES.map((c) => {
                  const active = c.key === category;
                  return (
                    <Pressable
                      key={c.key}
                      style={[styles.catChip, active && styles.catChipActive]}
                      onPress={() => setCategory(c.key)}
                    >
                      <Icon name={c.icon} size={15} color={active ? "#fff" : colors.mute} />
                      <Text style={[styles.catChipText, active && styles.catChipTextActive]}>
                        {c.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              <TextInput
                style={styles.input}
                placeholder="What's on your mind?"
                placeholderTextColor={colors.faint}
                value={message}
                onChangeText={setMessage}
                multiline
                numberOfLines={5}
                maxLength={2000}
              />

              {error && <Text style={styles.error}>{error}</Text>}

              <PressableScale
                style={[styles.cta, busy && styles.ctaBusy]}
                onPress={submit}
                disabled={busy}
              >
                {busy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.ctaText}>Send feedback</Text>
                )}
              </PressableScale>
              <Pressable style={styles.later} onPress={close}>
                <Text style={styles.laterText}>Cancel</Text>
              </Pressable>
            </>
          )}
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

  catRow: { flexDirection: "row", gap: 8, marginTop: 18, flexWrap: "wrap" },
  catChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
  },
  catChipActive: { backgroundColor: colors.green, borderColor: colors.green },
  catChipText: { fontSize: 12.5, fontWeight: "700", color: colors.mute },
  catChipTextActive: { color: "#fff" },

  input: {
    marginTop: 16,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 14,
    minHeight: 110,
    fontSize: 14.5,
    color: colors.ink,
    textAlignVertical: "top",
  },

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

  sentWrap: { alignItems: "center", paddingVertical: 12 },
  sentIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.greenTint,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  sentTitle: { fontSize: 20, fontWeight: "900", color: colors.ink },
  sentSub: {
    fontSize: 13,
    color: colors.mute,
    textAlign: "center",
    marginTop: 6,
    lineHeight: 18,
    paddingHorizontal: 12,
  },
});
