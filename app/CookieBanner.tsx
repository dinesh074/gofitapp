import React, { useEffect, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { colors, radius, elevation } from "./theme";
import { openLegal, privacyUrl } from "./legalLinks";

const KEY = "calai.cookie_consent.v1";

// Web-only: local storage (not third-party tracking cookies) keeps you signed
// in and remembers preferences on this browser. This banner discloses that
// plainly once, then remembers your acknowledgement the same way.
export default function CookieBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    let cancelled = false;
    AsyncStorage.getItem(KEY).then((v) => {
      if (!cancelled && !v) setVisible(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (Platform.OS !== "web" || !visible) return null;

  function accept() {
    setVisible(false);
    void AsyncStorage.setItem(KEY, "1");
  }

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <View style={styles.banner}>
        <Text style={styles.text}>
          We use your browser's local storage to keep you signed in and remember your
          preferences on this device — no third-party tracking cookies.{" "}
          <Text style={styles.link} onPress={() => void openLegal(privacyUrl())}>
            Privacy Policy
          </Text>
        </Text>
        <Pressable style={styles.btn} onPress={accept}>
          <Text style={styles.btnText}>Got it</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    padding: 14,
    zIndex: 999,
  },
  banner: {
    maxWidth: 640,
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: colors.ink,
    borderRadius: radius.md,
    padding: 16,
    ...elevation.lg,
  },
  text: { flex: 1, color: "#fff", fontSize: 12.5, lineHeight: 18 },
  link: { color: "#9FE3BE", fontWeight: "800", textDecorationLine: "underline" },
  btn: {
    backgroundColor: colors.green,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  btnText: { color: "#fff", fontWeight: "800", fontSize: 13 },
});
