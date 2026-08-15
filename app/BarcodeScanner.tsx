import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { analyzeBarcode, AnalysisResult, AuthRequiredError, BarcodeNotFoundError } from "./api";
import { canPhotoScan, pickBarcodeImage, decodeBarcodeFromUri, BarcodeDecodeError } from "./barcodeDecode";
import LiveBarcodeVideo from "./LiveBarcodeVideo";
import { colors, radius, elevation } from "./theme";
import PressableScale from "./PressableScale";
import Icon from "./Icon";

type Props = {
  visible: boolean;
  onClose: () => void;
  onResult: (result: AnalysisResult) => void;
  onRequireAuth: () => void;
  // Called when the user chooses to snap a photo instead (barcode not found,
  // or no camera-scan support) -- lets the parent kick off its photo flow.
  onFallbackToPhoto: () => void;
};

// Packaged-food barcode logging. Talks to /analyze/barcode which is a
// deterministic OpenFoodFacts lookup, NOT an AI call -- so it never consumes a
// free-scan credit (there's no paywall path here). Live camera scanning works
// on native; manual entry is always available (and is the path used on web,
// where camera barcode decoding isn't reliable).
export default function BarcodeScanner({
  visible,
  onClose,
  onResult,
  onRequireAuth,
  onFallbackToPhoto,
}: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  // Web only: whether the live webcam scanner is running. Starting the camera
  // requires a user gesture (and a permission prompt), so it's opt-in via a
  // button rather than auto-started.
  const [liveScan, setLiveScan] = useState(false);
  // Guards against the camera firing onBarcodeScanned dozens of times per
  // second for the same code while a lookup is already in flight.
  const lockedRef = useRef(false);

  const canUseCamera = Platform.OS !== "web";
  // Live webcam scanning via getUserMedia + ZXing is a web capability; on web
  // it's the real "point your camera" scanner (canUseCamera is false on web).
  const canLiveScan = Platform.OS === "web";

  useEffect(() => {
    if (visible && canUseCamera && permission && !permission.granted && permission.canAskAgain) {
      requestPermission();
    }
  }, [visible, permission, canUseCamera]);

  function reset() {
    lockedRef.current = false;
    setManual("");
    setBusy(false);
    setError(null);
    setNotFound(false);
    setLiveScan(false);
  }

  function close() {
    reset();
    onClose();
  }

  async function lookup(code: string) {
    const digits = code.replace(/\D/g, "");
    if (digits.length < 6) {
      setError("Enter a valid barcode number (usually 8–13 digits).");
      lockedRef.current = false;
      return;
    }
    setBusy(true);
    setError(null);
    setNotFound(false);
    try {
      const result = await analyzeBarcode(digits);
      reset();
      onResult(result);
      onClose();
    } catch (e: any) {
      if (e instanceof AuthRequiredError) {
        close();
        onRequireAuth();
        return;
      }
      if (e instanceof BarcodeNotFoundError) {
        setNotFound(true);
        setError(e.message || "We couldn't find that barcode in the food database.");
      } else {
        setError(e?.message || "Couldn't look that up. Try again.");
      }
      setBusy(false);
      // Allow another scan attempt after a failure.
      lockedRef.current = false;
    }
  }

  function onScanned(res: { data: string }) {
    if (lockedRef.current || busy) return;
    lockedRef.current = true;
    void lookup(res.data);
  }

  // Decode a barcode from a still photo (primary path on web, where live camera
  // decoding isn't reliable). Picks an image, decodes locally, then looks it up.
  async function scanFromPhoto() {
    if (busy) return;
    setError(null);
    setNotFound(false);
    try {
      const uri = await pickBarcodeImage();
      if (!uri) return; // cancelled
      setBusy(true);
      const digits = await decodeBarcodeFromUri(uri);
      await lookup(digits);
    } catch (e: any) {
      setBusy(false);
      if (e instanceof BarcodeDecodeError) {
        setError(e.message);
      } else {
        setError(e?.message || "Couldn't read that photo. Try again.");
      }
    }
  }

  // A live read from the web webcam scanner. Same guard as the native camera.
  function onLiveDetected(code: string) {
    if (lockedRef.current || busy) return;
    lockedRef.current = true;
    void lookup(code);
  }

  function useAsPhoto() {
    close();
    onFallbackToPhoto();
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <View style={styles.backdrop}>
        <Pressable style={styles.backdropTap} onPress={close} />
        <View style={styles.sheet}>
          <View style={styles.grabber} />
          <Text style={styles.title}>Scan a barcode</Text>
          <Text style={styles.sub}>
            Point at a packaged food's barcode — we'll pull its nutrition. This is
            free and doesn't use a scan.
          </Text>

          {canUseCamera && permission?.granted && !notFound && (
            <View style={styles.cameraWrap}>
              <CameraView
                style={StyleSheet.absoluteFill}
                facing="back"
                onBarcodeScanned={busy ? undefined : onScanned}
                barcodeScannerSettings={{
                  barcodeTypes: ["ean13", "ean8", "upc_a", "upc_e", "code128"],
                }}
              />
              <View style={styles.reticle} pointerEvents="none" />
            </View>
          )}

          {canUseCamera && permission && !permission.granted && (
            <View style={styles.permBox}>
              <Icon name="barcode" size={28} color={colors.mute} />
              <Text style={styles.permText}>
                Camera access is needed to scan barcodes. You can also type the
                number below.
              </Text>
              {permission.canAskAgain && (
                <PressableScale style={styles.permBtn} onPress={requestPermission}>
                  <Text style={styles.permBtnText}>Allow camera</Text>
                </PressableScale>
              )}
            </View>
          )}

          {/* Web live webcam scanner — the real "point your camera" path. */}
          {canLiveScan && liveScan && !notFound && (
            <View style={styles.cameraWrap}>
              <LiveBarcodeVideo
                onDetected={onLiveDetected}
                onError={(m) => {
                  setError(m);
                  setLiveScan(false);
                }}
              />
              <View style={styles.reticle} pointerEvents="none" />
            </View>
          )}

          {canLiveScan && !liveScan && !notFound && (
            <PressableScale
              style={[styles.photoBtn, busy && styles.lookupBtnDisabled]}
              onPress={() => {
                setError(null);
                setLiveScan(true);
              }}
            >
              <Icon name="barcode" size={16} color="#fff" />
              <Text style={styles.photoBtnText}>Scan with camera</Text>
            </PressableScale>
          )}

          {/* Scan from a still photo — a reliable fallback on web, and a
              fallback on native. Decodes the barcode locally in the browser. */}
          {canPhotoScan && (
            <PressableScale
              style={[styles.photoBtnAlt, busy && styles.lookupBtnDisabled]}
              onPress={scanFromPhoto}
            >
              <Icon name="camera" size={16} color={colors.green} />
              <Text style={styles.photoBtnAltText}>Scan a barcode from a photo</Text>
            </PressableScale>
          )}

          {/* Manual entry — always available, and the primary path on web. */}
          <Text style={styles.manualLabel}>Or enter the barcode number</Text>
          <View style={styles.manualRow}>
            <TextInput
              style={styles.input}
              value={manual}
              onChangeText={setManual}
              placeholder="e.g. 8901491101837"
              placeholderTextColor={colors.faint}
              keyboardType="number-pad"
              editable={!busy}
              onSubmitEditing={() => lookup(manual)}
            />
            <PressableScale
              style={[styles.lookupBtn, busy && styles.lookupBtnDisabled]}
              onPress={() => !busy && lookup(manual)}
            >
              <Text style={styles.lookupBtnText}>Look up</Text>
            </PressableScale>
          </View>

          {busy && (
            <View style={styles.center}>
              <ActivityIndicator color={colors.green} />
              <Text style={styles.muted}>Looking up product…</Text>
            </View>
          )}

          {error && <Text style={styles.error}>{error}</Text>}

          {notFound && (
            <PressableScale style={styles.fallbackBtn} onPress={useAsPhoto}>
              <Icon name="camera" size={16} color="#fff" />
              <Text style={styles.fallbackBtnText}>Snap a photo instead</Text>
            </PressableScale>
          )}

          <Pressable style={styles.cancel} onPress={close}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
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
    paddingBottom: 32,
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
  sub: { fontSize: 13, color: colors.mute, marginTop: 4, marginBottom: 14, lineHeight: 18 },
  cameraWrap: {
    height: 180,
    borderRadius: radius.lg,
    overflow: "hidden",
    backgroundColor: "#000",
    marginBottom: 14,
  },
  reticle: {
    position: "absolute",
    left: "15%",
    right: "15%",
    top: "30%",
    bottom: "30%",
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.85)",
    borderRadius: 10,
  },
  permBox: {
    alignItems: "center",
    gap: 8,
    padding: 16,
    borderRadius: radius.lg,
    backgroundColor: colors.bg,
    marginBottom: 14,
  },
  permText: { fontSize: 13, color: colors.mute, textAlign: "center", lineHeight: 18 },
  permBtn: {
    backgroundColor: colors.green,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: radius.md,
    marginTop: 4,
  },
  permBtnText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  manualLabel: { fontSize: 12, color: colors.mute, marginBottom: 6, fontWeight: "600" },
  photoBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.green,
    paddingVertical: 12,
    borderRadius: radius.md,
    marginBottom: 14,
  },
  photoBtnText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  photoBtnAlt: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.green,
    paddingVertical: 12,
    borderRadius: radius.md,
    marginBottom: 14,
  },
  photoBtnAltText: { color: colors.green, fontWeight: "700", fontSize: 14 },
  manualRow: { flexDirection: "row", gap: 8 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.ink,
    backgroundColor: colors.bg,
  },
  lookupBtn: {
    backgroundColor: colors.green,
    paddingHorizontal: 16,
    justifyContent: "center",
    borderRadius: radius.md,
  },
  lookupBtnDisabled: { opacity: 0.5 },
  lookupBtnText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  center: { alignItems: "center", paddingVertical: 14, gap: 8 },
  muted: { color: colors.mute, fontSize: 13 },
  error: { color: colors.red, fontSize: 13, marginTop: 10, textAlign: "center" },
  fallbackBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.green,
    paddingVertical: 12,
    borderRadius: radius.md,
    marginTop: 12,
  },
  fallbackBtnText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  cancel: { alignSelf: "center", marginTop: 14, padding: 6 },
  cancelText: { color: colors.mute, fontSize: 14, fontWeight: "600" },
});
