import React, { useEffect, useMemo, useRef } from "react";
import { Animated, NativeSyntheticEvent, NativeScrollEvent, Platform, StyleSheet, Text, View } from "react-native";
import { colors } from "./theme";

// A vertical wheel / drum picker. The selected value sits in the centre band,
// large and high-contrast; neighbours fade and shrink with distance. It works
// on web and native by driving opacity/scale from a single scroll Animated.Value
// (no per-frame React re-renders), and snaps to whole items.
//
// It is unit-agnostic: the parent passes values already in the display unit and
// gets the chosen display value back, so a cm/in or kg/lb toggle is just a
// different min/max/step + a conversion the parent owns.

const ITEM_HEIGHT = 46;
const VISIBLE = 5; // odd -> a true centre row
const PAD = Math.floor(VISIBLE / 2);

type Props = {
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (v: number) => void;
  formatLabel?: (v: number) => string;
  unit?: string;
  // Round the emitted value to this many decimals (e.g. 1 for 64.0 kg targets).
  decimals?: number;
};

export default function WheelPicker({
  min,
  max,
  step = 1,
  value,
  onChange,
  formatLabel,
  unit,
  decimals = 0,
}: Props) {
  const values = useMemo(() => {
    const out: number[] = [];
    const factor = Math.pow(10, decimals);
    for (let v = min; v <= max + 1e-9; v += step) {
      out.push(Math.round(v * factor) / factor);
    }
    return out;
  }, [min, max, step, decimals]);

  const indexOf = (v: number) => {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < values.length; i++) {
      const d = Math.abs(values[i] - v);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };

  const scrollRef = useRef<Animated.ScrollView>(null);
  const scrollY = useRef(new Animated.Value(indexOf(value) * ITEM_HEIGHT)).current;
  const committedIndex = useRef(indexOf(value));

  // Keep the wheel aligned when the value changes from outside (unit toggle,
  // clamp, goal switch). Don't fight the user mid-gesture: we only re-align when
  // the incoming value differs from what we last emitted.
  useEffect(() => {
    const idx = indexOf(value);
    if (idx !== committedIndex.current) {
      committedIndex.current = idx;
      scrollRef.current?.getNode?.().scrollTo?.({ y: idx * ITEM_HEIGHT, animated: false });
      // Fallback for platforms where getNode isn't present (newer RN / web).
      (scrollRef.current as any)?.scrollTo?.({ y: idx * ITEM_HEIGHT, animated: false });
      scrollY.setValue(idx * ITEM_HEIGHT);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, values.length]);

  const commit = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    const idx = Math.max(0, Math.min(values.length - 1, Math.round(y / ITEM_HEIGHT)));
    if (idx !== committedIndex.current) {
      committedIndex.current = idx;
      onChange(values[idx]);
    }
  };

  return (
    <View style={styles.wrap}>
      {/* Centre selection band */}
      <View pointerEvents="none" style={styles.band} />
      <Animated.ScrollView
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        snapToInterval={ITEM_HEIGHT}
        decelerationRate="fast"
        scrollEventThrottle={16}
        nestedScrollEnabled
        contentContainerStyle={{ paddingVertical: PAD * ITEM_HEIGHT }}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
          useNativeDriver: Platform.OS !== "web",
        })}
        onMomentumScrollEnd={commit}
        onScrollEndDrag={commit}
      >
        {values.map((v, i) => {
          const center = i * ITEM_HEIGHT;
          const inputRange = [
            center - 2 * ITEM_HEIGHT,
            center - ITEM_HEIGHT,
            center,
            center + ITEM_HEIGHT,
            center + 2 * ITEM_HEIGHT,
          ];
          const opacity = scrollY.interpolate({
            inputRange,
            outputRange: [0.2, 0.45, 1, 0.45, 0.2],
            extrapolate: "clamp",
          });
          const scale = scrollY.interpolate({
            inputRange,
            outputRange: [0.72, 0.86, 1, 0.86, 0.72],
            extrapolate: "clamp",
          });
          return (
            <Animated.View key={i} style={[styles.item, { opacity, transform: [{ scale }] }]}>
              <Text style={styles.itemText} numberOfLines={1}>
                {formatLabel ? formatLabel(v) : String(v)}
                {unit ? <Text style={styles.itemUnit}>{` ${unit}`}</Text> : null}
              </Text>
            </Animated.View>
          );
        })}
      </Animated.ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { height: VISIBLE * ITEM_HEIGHT, alignSelf: "stretch", justifyContent: "center" },
  band: {
    position: "absolute",
    left: 0,
    right: 0,
    top: PAD * ITEM_HEIGHT,
    height: ITEM_HEIGHT,
    borderRadius: 14,
    backgroundColor: "rgba(11,122,75,0.08)",
    borderWidth: 1,
    borderColor: "rgba(11,122,75,0.22)",
  },
  item: { height: ITEM_HEIGHT, alignItems: "center", justifyContent: "center" },
  itemText: { fontSize: 26, fontWeight: "900", color: colors.ink, letterSpacing: 0.3 },
  itemUnit: { fontSize: 15, fontWeight: "800", color: colors.mute },
});
