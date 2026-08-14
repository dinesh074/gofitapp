// Shared screen shell. Every top-level screen renders inside this so safe-area
// insets (notch / status bar / home indicator / web address bar) are handled in
// ONE place instead of each screen guessing a paddingTop. This is what removes
// the inconsistent "top gap" and shaky vertical alignment across screens.
import React from "react";
import { Platform, StyleSheet, View, ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "./theme";

type Props = {
  children: React.ReactNode;
  // When true, don't reserve top inset (e.g. a full-bleed gradient header draws
  // under the status bar and handles its own inset).
  edgeTop?: boolean;
  // When false, don't reserve the bottom inset (screens inside the tab bar,
  // which already sits above the home indicator).
  insetBottom?: boolean;
  style?: ViewStyle;
  background?: string;
};

export default function Screen({
  children,
  edgeTop = false,
  insetBottom = false,
  style,
  background = colors.bg,
}: Props) {
  const insets = useSafeAreaInsets();
  // On web there is no notch; keep a small, consistent top pad only.
  const top = edgeTop ? 0 : Platform.OS === "web" ? 0 : insets.top;
  const bottom = insetBottom ? insets.bottom : 0;
  return (
    <View
      style={[
        styles.root,
        { backgroundColor: background, paddingTop: top, paddingBottom: bottom },
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
