import React, { useEffect, useRef } from "react";
import { Animated, StyleSheet, View, ViewStyle } from "react-native";
import { colors, radius } from "./theme";

// Reusable pulsing placeholder block for "optimistic UI" loading states --
// used wherever we show the eventual layout's shape immediately (e.g. Scan's
// result card) instead of a blocking full-screen spinner, so the wait feels
// like "content is arriving" rather than "nothing is happening yet".
export function SkeletonBlock({ style }: { style?: ViewStyle | ViewStyle[] }) {
  const opacity = useRef(new Animated.Value(0.35)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.85, duration: 650, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.35, duration: 650, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);

  return <Animated.View style={[styles.block, style, { opacity }]} />;
}

// Full skeleton shaped like ScanScreen's result card -- same rows/heights so
// the swap from skeleton -> real data doesn't jump the layout around.
export function ScanResultSkeleton() {
  return (
    <View style={styles.card}>
      <SkeletonBlock style={{ width: "60%", height: 20, marginBottom: 8 }} />
      <SkeletonBlock style={{ width: "35%", height: 14, marginBottom: 16 }} />
      <SkeletonBlock style={{ width: "100%", height: 1, marginBottom: 16, opacity: 0.15 }} />
      {[0, 1, 2].map((i) => (
        <View key={i} style={styles.row}>
          <SkeletonBlock style={{ width: 40, height: 40, borderRadius: radius.sm }} />
          <View style={{ flex: 1, marginLeft: 12 }}>
            <SkeletonBlock style={{ width: "70%", height: 14, marginBottom: 6 }} />
            <SkeletonBlock style={{ width: "40%", height: 12 }} />
          </View>
        </View>
      ))}
    </View>
  );
}

// Shaped like TodayPlanCard's slot list -- shown the instant the first plan
// fetch starts, so the card never shows a blank blocking spinner.
export function PlanCardSkeleton() {
  return (
    <View>
      <SkeletonBlock style={{ width: "90%", height: 14, marginBottom: 14 }} />
      {[0, 1, 2, 3].map((i) => (
        <View key={i} style={styles.planRow}>
          <SkeletonBlock style={{ width: 90, height: 12 }} />
          <SkeletonBlock style={{ flex: 1, height: 12, marginLeft: 12 }} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { backgroundColor: colors.line, borderRadius: radius.xs },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: 16,
    marginTop: 16,
  },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 10 },
  planRow: { flexDirection: "row", alignItems: "center", paddingVertical: 8 },
});
