import React, { useEffect, useRef, useState } from "react";
import { Animated, LayoutChangeEvent, Pressable, StyleSheet, Text, View } from "react-native";
import { GoalPace } from "./nutrition";
import { colors } from "./theme";

// A 3-stop pace "slider": Relaxed / Recommended / Ambitious. It reads and writes
// a real GoalPace that feeds the calorie + timeline calculation (not a label),
// with an animated thumb that snaps to the selected stop. Implemented as a
// track + animated thumb + three tap zones so it behaves identically on web and
// native without a native slider dependency.

const STOPS: GoalPace[] = ["relaxed", "recommended", "ambitious"];
const LABELS: Record<GoalPace, string> = {
  relaxed: "Relaxed",
  recommended: "Recommended",
  ambitious: "Ambitious",
};
const THUMB = 30;

export default function PaceSlider({
  value,
  onChange,
}: {
  value: GoalPace;
  onChange: (p: GoalPace) => void;
}) {
  const [width, setWidth] = useState(0);
  const idx = Math.max(0, STOPS.indexOf(value));
  const left = useRef(new Animated.Value(0)).current;

  const posFor = (i: number) => {
    if (width <= 0) return 0;
    return (i / (STOPS.length - 1)) * (width - THUMB);
  };

  useEffect(() => {
    Animated.spring(left, {
      toValue: posFor(idx),
      useNativeDriver: false,
      friction: 8,
      tension: 90,
    }).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, width]);

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  return (
    <View>
      <View style={styles.track} onLayout={onLayout}>
        <View style={styles.fillTrack} />
        {STOPS.map((_, i) => (
          <View key={i} style={[styles.tick, { left: posFor(i) + THUMB / 2 - 2 }]} />
        ))}
        <Animated.View style={[styles.thumb, { left }]} />
        {/* Tap zones sit above everything so the whole bar is selectable */}
        <View style={styles.zones}>
          {STOPS.map((p) => (
            <Pressable key={p} style={styles.zone} onPress={() => onChange(p)} accessibilityRole="button" accessibilityLabel={LABELS[p]} />
          ))}
        </View>
      </View>
      <View style={styles.labels}>
        {STOPS.map((p) => (
          <Pressable key={p} style={styles.labelZone} onPress={() => onChange(p)}>
            <Text style={[styles.label, p === value && styles.labelActive]}>{LABELS[p]}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  track: { height: THUMB, justifyContent: "center", marginTop: 8 },
  fillTrack: { position: "absolute", left: 0, right: 0, height: 6, borderRadius: 3, backgroundColor: "#E2E8E4" },
  tick: { position: "absolute", width: 4, height: 4, borderRadius: 2, backgroundColor: "#CBD5D0" },
  thumb: {
    position: "absolute",
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: colors.green,
    borderWidth: 4,
    borderColor: "#fff",
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  zones: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, flexDirection: "row" },
  zone: { flex: 1 },
  labels: { flexDirection: "row", marginTop: 10 },
  labelZone: { flex: 1, alignItems: "center" },
  label: { fontSize: 13, color: colors.mute, fontWeight: "700" },
  labelActive: { color: colors.green, fontWeight: "900" },
});
