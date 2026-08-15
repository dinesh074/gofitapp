import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import { analyzeText, AuthRequiredError, PaywallError } from "./api";
import { colors, radius, elevation } from "./theme";
import Icon from "./Icon";
import Screen from "./Screen";
import PressableScale from "./PressableScale";
import { goBackOrTabs } from "./nav";
import { useApp } from "./AppContext";

function getSpeechRecognition(): any {
  if (Platform.OS !== "web") return null;
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

const EXAMPLES = [
  "2 rotis with dal and a katori of curd",
  "A plate of chicken biryani",
  "Masala dosa with sambar and chutney",
];

function autoVoiceLang(): string {
  if (Platform.OS !== "web") return "en-IN";
  const w = window as any;
  const nav = w?.navigator;
  const lang = String(nav?.languages?.[0] || nav?.language || "en-IN").trim();
  return lang || "en-IN";
}

export default function DescribeMealScreen() {
  const navigation = useNavigation<any>();
  const { requireAuth } = useApp();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<any>(null);
  const keepListeningRef = useRef(false);
  const voiceSupported = !!getSpeechRecognition();

  useEffect(() => {
    return () => {
      keepListeningRef.current = false;
      recognitionRef.current?.stop?.();
    };
  }, []);

  function stopVoice() {
    keepListeningRef.current = false;
    setListening(false);
    recognitionRef.current?.stop?.();
  }

  function startVoice() {
    const SpeechRecognition = getSpeechRecognition();
    if (!SpeechRecognition) return;
    setError(null);
    const rec = new SpeechRecognition();
    rec.lang = autoVoiceLang();
    rec.interimResults = true;
    rec.continuous = true;
    rec.maxAlternatives = 1;
    rec.onresult = (e: any) => {
      let chunk = "";
      for (let i = e.resultIndex ?? 0; i < (e.results?.length ?? 0); i += 1) {
        const result = e.results[i];
        if (result?.isFinal) {
          chunk += ` ${result[0]?.transcript ?? ""}`;
        }
      }
      if (chunk.trim()) setText((prev) => (prev ? `${prev} ${chunk.trim()}` : chunk.trim()));
    };
    rec.onerror = (e: any) => {
      const code = String(e?.error ?? "");
      if (code !== "no-speech" && code !== "aborted") {
        setError("Voice input isn't available right now. You can type your meal below.");
      }
    };
    rec.onend = () => {
      if (!keepListeningRef.current) {
        setListening(false);
        return;
      }
      setTimeout(() => {
        if (keepListeningRef.current) startVoice();
      }, 120);
    };
    recognitionRef.current = rec;
    setListening(true);
    try {
      rec.start();
    } catch {
      setListening(false);
      keepListeningRef.current = false;
      setError("Couldn't start voice input. Try again.");
    }
  }

  function toggleVoice() {
    const SpeechRecognition = getSpeechRecognition();
    if (!SpeechRecognition) return;
    if (keepListeningRef.current || listening) {
      stopVoice();
      return;
    }
    keepListeningRef.current = true;
    startVoice();
  }

  async function submit() {
    if (keepListeningRef.current || listening) stopVoice();
    if (text.trim().length < 2) {
      setError("Describe what you ate - a few words is enough.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const result = await analyzeText(text.trim());
      navigation.replace("Scan", { mode: "review", presetResult: result });
    } catch (e: any) {
      if (e instanceof PaywallError) {
        navigation.navigate("Payment");
        return;
      }
      if (e instanceof AuthRequiredError) {
        requireAuth();
        goBackOrTabs(navigation);
        return;
      }
      setError(e?.message || "Couldn't parse that. Try describing it differently.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen edgeTop background={colors.bg}>
      <View style={styles.header}>
        <Pressable style={styles.iconBtn} onPress={() => goBackOrTabs(navigation)} hitSlop={8}>
          <Icon name="chevronLeft" size={22} color={colors.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>Describe meal</Text>
        <View style={styles.iconBtn} />
      </View>

      <View style={styles.body}>
        <Text style={styles.sub}>No photo needed - tell us what you ate in your own words.</Text>
        {!voiceSupported && (
          <Text style={styles.voiceFallbackHint}>
            Voice auto-detect works where the browser supports speech recognition. On this device, type your meal here.
          </Text>
        )}

        <View style={styles.inputWrap}>
          <TextInput
            style={styles.input}
            placeholder={`e.g. "${EXAMPLES[0]}"`}
            placeholderTextColor={colors.faint}
            value={text}
            onChangeText={setText}
            multiline
            numberOfLines={4}
            maxLength={500}
            autoFocus
          />
          {voiceSupported && (
            <Pressable style={[styles.micBtn, listening && styles.micBtnActive]} onPress={toggleVoice}>
              <Icon name={listening ? "micActive" : "mic"} size={16} color={listening ? "#fff" : colors.green} />
            </Pressable>
          )}
        </View>
        {listening && <Text style={styles.listeningHint}>Listening... tap mic again to stop</Text>}

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
      </View>

    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingTop: 8 },
  iconBtn: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  headerTitle: { color: colors.ink, fontSize: 20, fontWeight: "900" },
  body: { padding: 16, paddingBottom: 24 },
  sub: { color: colors.mute, fontSize: 13, fontWeight: "600", marginBottom: 12, lineHeight: 18 },
  voiceFallbackHint: { color: colors.mute, fontSize: 12, fontWeight: "600", marginTop: -4, marginBottom: 10, lineHeight: 17 },
  inputWrap: { position: "relative" },
  input: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 14,
    paddingRight: 48,
    minHeight: 100,
    fontSize: 14.5,
    color: colors.ink,
    textAlignVertical: "top",
  },
  micBtn: {
    position: "absolute",
    right: 10,
    bottom: 10,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.greenTint,
    alignItems: "center",
    justifyContent: "center",
  },
  micBtnActive: { backgroundColor: colors.red },
  listeningHint: { color: colors.green, fontSize: 12, fontWeight: "700", marginTop: 6 },
  examplesRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
  exampleChip: { backgroundColor: colors.card, borderRadius: 999, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 12, paddingVertical: 8 },
  exampleText: { fontSize: 12, color: colors.mute, fontWeight: "600" },
  error: { color: colors.red, fontSize: 13, fontWeight: "700", marginTop: 12, textAlign: "center" },
  cta: { backgroundColor: colors.green, borderRadius: radius.md, paddingVertical: 15, alignItems: "center", marginTop: 18, ...elevation.sm },
  ctaBusy: { opacity: 0.8 },
  ctaText: { color: "#fff", fontWeight: "900", fontSize: 16 },
});
