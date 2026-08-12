import React from "react";
import { View, Text, StyleSheet } from "react-native";
import Svg, { Circle, Defs, LinearGradient, Stop } from "react-native-svg";
import { colors, type as T } from "./theme";

type Props = {
  value: number; // consumed
  goal: number;
  size?: number;
  stroke?: number;
};

// Circular calorie-remaining ring — the signature Cal-AI style hero metric.
export default function CalorieRing({ value, goal, size = 176, stroke = 16 }: Props) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = goal > 0 ? Math.min(1, value / goal) : 0;
  const over = value > goal;
  const remaining = Math.max(0, goal - value);
  const dash = c * pct;

  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Svg width={size} height={size}>
        <Defs>
          <LinearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={over ? "#E4572E" : "#12A566"} />
            <Stop offset="1" stopColor={over ? "#C0392B" : "#0B7A4B"} />
          </LinearGradient>
        </Defs>
        {/* Track */}
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.track} strokeWidth={stroke} fill="none" />
        {/* Progress */}
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="url(#ring)"
          strokeWidth={stroke}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${dash} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <View style={styles.center}>
        <Text style={styles.big}>{over ? value - goal : remaining}</Text>
        <Text style={styles.label}>{over ? "kcal over" : "kcal left"}</Text>
        <Text style={styles.sub}>
          {value} / {goal}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { position: "absolute", alignItems: "center" },
  big: { ...T.display, color: colors.ink },
  label: { ...T.caption, color: colors.mute, marginTop: -2 },
  sub: { ...T.tiny, color: colors.faint, marginTop: 6, letterSpacing: 0.5 },
});
