import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { captureRef } from "react-native-view-shot";
import SocialShareCard, {
  FORMAT_LABEL,
  FORMAT_RATIO,
  ShareFormat,
  ShareMacros,
  ShareMeal,
} from "./SocialShareCard";
import { shareImage, saveImage } from "./share";
import { colors, radius, elevation } from "./theme";
import PressableScale from "./PressableScale";
import Icon from "./Icon";

type Props = {
  visible: boolean;
  onClose: () => void;
  total: number;
  meals: ShareMeal[];
  macros: ShareMacros;
  streak: number;
  dateLabel: string;
};

const FORMATS: ShareFormat[] = ["story", "post", "square"];
// Off-screen capture base width; view-shot upscales the output to 1080px.
const CAPTURE_W = 360;
const OUTPUT_W = 1080;

// A curated share sheet: pick a social format, see a live preview, then share
// straight to the OS share sheet (Instagram/TikTok/WhatsApp/…) instead of the
// old silent download. The image is a purpose-built social card, not a
// screenshot of the app.
export default function ShareSheet({
  visible,
  onClose,
  total,
  meals,
  macros,
  streak,
  dateLabel,
}: Props) {
  const [format, setFormat] = useState<ShareFormat>("story");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const captureViewRef = useRef<View>(null);
  // Cache the captured image per format so the Share tap can fire the OS sheet
  // without an intervening await (browsers require the share to happen inside
  // the user gesture, or they block it).
  const cacheRef = useRef<Partial<Record<ShareFormat, string>>>({});

  useEffect(() => {
    if (!visible) {
      cacheRef.current = {};
      setNote(null);
      setError(null);
      setBusy(false);
    }
  }, [visible]);

  // Pre-capture the current format shortly after it renders off-screen.
  useEffect(() => {
    if (!visible) return;
    setNote(null);
    setError(null);
    if (cacheRef.current[format]) return;
    const t = setTimeout(() => {
      void capture(format).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [visible, format]);

  async function capture(fmt: ShareFormat): Promise<string> {
    const uri = await captureRef(captureViewRef, {
      format: "png",
      quality: 1,
      width: OUTPUT_W,
      height: Math.round(OUTPUT_W * FORMAT_RATIO[fmt]),
      result: Platform.OS === "web" ? "data-uri" : "tmpfile",
    });
    cacheRef.current[fmt] = uri;
    return uri;
  }

  const filename = `gofit-${format}-${dateLabel.replace(/[^\w]+/g, "-").toLowerCase()}.png`;

  async function onShare() {
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      const uri = cacheRef.current[format] || (await capture(format));
      const outcome = await shareImage(uri, {
        filename,
        message: `${total.toLocaleString()} kcal today — tracked with gofit.today`,
      });
      if (outcome === "downloaded") setNote("Your browser can't open the share sheet, so we saved the image instead.");
      else if (outcome === "unavailable") setError("Sharing isn't available on this device.");
    } catch (e: any) {
      setError(e?.message || "Couldn't create the image. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function onSave() {
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      const uri = cacheRef.current[format] || (await capture(format));
      await saveImage(uri, filename);
      if (Platform.OS === "web") setNote("Image saved to your downloads.");
    } catch (e: any) {
      setError(e?.message || "Couldn't save the image. Try again.");
    } finally {
      setBusy(false);
    }
  }

  // Preview sizing — keep the tallest (story) within the sheet.
  const previewH = 300;
  const previewW = previewH / FORMAT_RATIO[format];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.backdropTap} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.grabber} />
          <Text style={styles.title}>Share your day</Text>
          <Text style={styles.sub}>Pick a format, then post straight to your story or feed.</Text>

          {/* Format toggle */}
          <View style={styles.segment}>
            {FORMATS.map((f) => (
              <Pressable
                key={f}
                style={[styles.segBtn, format === f && styles.segBtnActive]}
                onPress={() => setFormat(f)}
              >
                <Text style={[styles.segText, format === f && styles.segTextActive]}>
                  {FORMAT_LABEL[f]}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* Live preview */}
          <View style={styles.previewWrap}>
            <View style={[styles.previewClip, { width: previewW, height: previewH }]}>
              <SocialShareCard
                total={total}
                meals={meals}
                macros={macros}
                streak={streak}
                dateLabel={dateLabel}
                format={format}
                width={previewW}
              />
            </View>
          </View>

          {note && <Text style={styles.note}>{note}</Text>}
          {error && <Text style={styles.error}>{error}</Text>}

          {/* Actions */}
          <View style={styles.actions}>
            <PressableScale
              containerStyle={{ flex: 1 }}
              style={[styles.btn, styles.btnPrimary]}
              onPress={() => !busy && onShare()}
            >
              {busy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Icon name="share" size={18} color="#fff" />
                  <Text style={styles.btnPrimaryText}>Share</Text>
                </>
              )}
            </PressableScale>
            <PressableScale style={[styles.btn, styles.btnGhost]} onPress={() => !busy && onSave()}>
              <Icon name="photo" size={18} color={colors.green} />
              <Text style={styles.btnGhostText}>{Platform.OS === "web" ? "Download" : "Save"}</Text>
            </PressableScale>
          </View>

          <Pressable style={styles.cancel} onPress={onClose}>
            <Text style={styles.cancelText}>Close</Text>
          </Pressable>
        </View>
      </View>

      {/* Off-screen full-res card that gets captured. Rendered outside the
          sheet so it never flashes on screen. */}
      <View style={styles.offscreen} pointerEvents="none">
        <View ref={captureViewRef} collapsable={false}>
          <SocialShareCard
            total={total}
            meals={meals}
            macros={macros}
            streak={streak}
            dateLabel={dateLabel}
            format={format}
            width={CAPTURE_W}
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" },
  backdropTap: { ...StyleSheet.absoluteFillObject },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: 20,
    paddingBottom: 30,
    ...elevation.lg,
  },
  grabber: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.line,
    marginBottom: 14,
  },
  title: { fontSize: 20, fontWeight: "800", color: colors.ink },
  sub: { fontSize: 13, color: colors.mute, marginTop: 4, marginBottom: 14 },
  segment: {
    flexDirection: "row",
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    padding: 4,
    gap: 4,
  },
  segBtn: { flex: 1, paddingVertical: 9, borderRadius: radius.sm, alignItems: "center" },
  segBtnActive: { backgroundColor: colors.card, ...elevation.sm },
  segText: { fontSize: 12.5, fontWeight: "700", color: colors.mute },
  segTextActive: { color: colors.green },
  previewWrap: { alignItems: "center", paddingVertical: 18 },
  previewClip: {
    borderRadius: radius.lg,
    overflow: "hidden",
    backgroundColor: colors.green,
    ...elevation.md,
  },
  note: { color: colors.mute, fontSize: 12.5, textAlign: "center", marginBottom: 6 },
  error: { color: colors.red, fontSize: 12.5, textAlign: "center", marginBottom: 6 },
  actions: { flexDirection: "row", gap: 12, marginTop: 4 },
  btn: {
    flexDirection: "row",
    gap: 8,
    borderRadius: radius.md,
    paddingVertical: 15,
    paddingHorizontal: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  btnPrimary: { backgroundColor: colors.green, ...elevation.sm },
  btnPrimaryText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  btnGhost: { backgroundColor: colors.card, borderWidth: 1.5, borderColor: colors.hairline },
  btnGhostText: { color: colors.green, fontWeight: "800", fontSize: 15 },
  cancel: { alignSelf: "center", marginTop: 12, padding: 6 },
  cancelText: { color: colors.mute, fontSize: 14, fontWeight: "600" },
  offscreen: { position: "absolute", left: -10000, top: 0, opacity: 0 },
});
