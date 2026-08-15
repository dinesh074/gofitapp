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
import { CameraView, useCameraPermissions } from "expo-camera";
import { useNavigation } from "@react-navigation/native";
import { analyzeBarcode, AuthRequiredError, BarcodeNotFoundError } from "./api";
import { canPhotoScan, pickBarcodeImage, decodeBarcodeFromUri, BarcodeDecodeError } from "./barcodeDecode";
import LiveBarcodeVideo from "./LiveBarcodeVideo";
import { goBackOrTabs } from "./nav";
import Screen from "./Screen";
import Icon from "./Icon";
import PressableScale from "./PressableScale";
import { colors, radius, elevation } from "./theme";
import { useApp } from "./AppContext";

export default function BarcodeLookupScreen() {
  const navigation = useNavigation<any>();
  const { requireAuth } = useApp();
  const [permission, requestPermission] = useCameraPermissions();
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [liveScan, setLiveScan] = useState(false);
  const lockedRef = useRef(false);

  const canUseCamera = Platform.OS !== "web";
  const canLiveScan = Platform.OS === "web";

  useEffect(() => {
    if (canUseCamera && permission && !permission.granted && permission.canAskAgain) {
      requestPermission();
    }
  }, [permission, canUseCamera, requestPermission]);

  async function lookup(code: string) {
    const digits = code.replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 14) {
      setError("Enter a valid barcode number (8-14 digits).");
      lockedRef.current = false;
      return;
    }
    setBusy(true);
    setError(null);
    setNotFound(false);
    try {
      const result = await analyzeBarcode(digits);
      navigation.replace("Scan", { mode: "review", presetResult: result });
    } catch (e: any) {
      if (e instanceof AuthRequiredError) {
        requireAuth();
        goBackOrTabs(navigation);
        return;
      }
      if (e instanceof BarcodeNotFoundError) {
        setNotFound(true);
        setError(e.message || "We couldn't find that barcode in the food database.");
      } else {
        setError(e?.message || "Couldn't look that up. Try again.");
      }
      setBusy(false);
      lockedRef.current = false;
    }
  }

  function onScanned(res: { data: string }) {
    if (lockedRef.current || busy) return;
    lockedRef.current = true;
    void lookup(res.data);
  }

  async function scanFromPhoto() {
    if (busy) return;
    setError(null);
    setNotFound(false);
    try {
      const uri = await pickBarcodeImage();
      if (!uri) return;
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

  function onLiveDetected(code: string) {
    if (lockedRef.current || busy) return;
    lockedRef.current = true;
    void lookup(code);
  }

  return (
    <Screen edgeTop background={colors.bg}>
      <View style={styles.header}>
        <Pressable style={styles.iconBtn} onPress={() => goBackOrTabs(navigation)} hitSlop={8}>
          <Icon name="chevronLeft" size={22} color={colors.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>Barcode lookup</Text>
        <View style={styles.iconBtn} />
      </View>

      <View style={styles.body}>
        <Text style={styles.sub}>Scan packaged food barcodes or type the number manually.</Text>

        {canUseCamera && permission?.granted && !notFound && (
          <View style={styles.cameraWrap}>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              onBarcodeScanned={busy ? undefined : onScanned}
              barcodeScannerSettings={{ barcodeTypes: ["ean13", "ean8", "upc_a", "upc_e", "code128"] }}
            />
            <View style={styles.reticle} pointerEvents="none" />
          </View>
        )}

        {canUseCamera && permission && !permission.granted && (
          <View style={styles.permBox}>
            <Icon name="barcode" size={24} color={colors.mute} />
            <Text style={styles.permText}>Allow camera access to scan barcodes.</Text>
            {permission.canAskAgain && (
              <PressableScale style={styles.permBtn} onPress={requestPermission}>
                <Text style={styles.permBtnText}>Allow camera</Text>
              </PressableScale>
            )}
          </View>
        )}

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
          <PressableScale style={[styles.primaryBtn, busy && styles.btnDisabled]} onPress={() => setLiveScan(true)}>
            <Icon name="barcode" size={16} color="#fff" />
            <Text style={styles.primaryBtnText}>Scan with camera</Text>
          </PressableScale>
        )}

        {canPhotoScan && (
          <PressableScale style={[styles.secondaryBtn, busy && styles.btnDisabled]} onPress={scanFromPhoto}>
            <Icon name="camera" size={16} color={colors.green} />
            <Text style={styles.secondaryBtnText}>Scan a barcode from a photo</Text>
          </PressableScale>
        )}

        <Text style={styles.manualLabel}>Or enter barcode number</Text>
        <View style={styles.manualRow}>
          <TextInput
            style={styles.input}
            value={manual}
            onChangeText={setManual}
            placeholder="e.g. 8906064511273"
            placeholderTextColor={colors.faint}
            keyboardType="number-pad"
            editable={!busy}
            onSubmitEditing={() => lookup(manual)}
          />
          <PressableScale style={[styles.lookupBtn, busy && styles.btnDisabled]} onPress={() => void lookup(manual)}>
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
          <PressableScale style={styles.primaryBtn} onPress={() => navigation.replace("Scan", { mode: "camera" })}>
            <Icon name="camera" size={16} color="#fff" />
            <Text style={styles.primaryBtnText}>Snap label photo instead</Text>
          </PressableScale>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingTop: 8 },
  iconBtn: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  headerTitle: { color: colors.ink, fontSize: 20, fontWeight: "900" },
  body: { padding: 16, paddingBottom: 24 },
  sub: { color: colors.mute, fontSize: 13, fontWeight: "600", marginBottom: 12 },
  cameraWrap: {
    height: 210,
    borderRadius: radius.lg,
    overflow: "hidden",
    backgroundColor: "#000",
    marginBottom: 12,
  },
  reticle: { position: "absolute", left: "15%", right: "15%", top: "30%", bottom: "30%", borderWidth: 2, borderColor: "rgba(255,255,255,0.85)", borderRadius: 10 },
  permBox: { alignItems: "center", gap: 8, padding: 14, borderRadius: radius.lg, backgroundColor: colors.card, marginBottom: 12 },
  permText: { color: colors.mute, fontSize: 12.5, textAlign: "center" },
  permBtn: { backgroundColor: colors.green, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 8 },
  permBtnText: { color: "#fff", fontSize: 13, fontWeight: "800" },
  primaryBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: colors.green, borderRadius: radius.md, paddingVertical: 12, ...elevation.sm, marginBottom: 10 },
  primaryBtnText: { color: "#fff", fontSize: 14, fontWeight: "800" },
  secondaryBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderWidth: 1, borderColor: colors.green, borderRadius: radius.md, backgroundColor: colors.bg, paddingVertical: 12, marginBottom: 10 },
  secondaryBtnText: { color: colors.green, fontSize: 14, fontWeight: "800" },
  manualLabel: { color: colors.mute, fontSize: 12, fontWeight: "700", marginBottom: 6 },
  manualRow: { flexDirection: "row", gap: 8 },
  input: { flex: 1, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, backgroundColor: colors.card, color: colors.ink, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  lookupBtn: { backgroundColor: colors.green, borderRadius: radius.md, justifyContent: "center", paddingHorizontal: 16 },
  lookupBtnText: { color: "#fff", fontSize: 14, fontWeight: "800" },
  btnDisabled: { opacity: 0.5 },
  center: { alignItems: "center", gap: 8, paddingVertical: 10 },
  muted: { color: colors.mute, fontSize: 12.5, fontWeight: "600" },
  error: { color: colors.red, fontSize: 12.5, fontWeight: "700", textAlign: "center", marginTop: 8 },
});

