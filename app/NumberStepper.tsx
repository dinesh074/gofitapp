import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radius, sp, type as T } from "./theme";
import Icon from "./Icon";

type Props = {
  value: number;
  min: number;
  max: number;
  step?: number;
  decimals?: number;
  unit?: string;
  onChange: (v: number) => void;
  formatValue?: (v: number) => string;
  compact?: boolean;
};

function roundTo(v: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(v * f) / f;
}

export default function NumberStepper({
  value,
  min,
  max,
  step = 1,
  decimals = 0,
  unit,
  onChange,
  formatValue,
  compact = false,
}: Props) {
  const shown = roundTo(Math.min(max, Math.max(min, value)), decimals);
  const canDec = shown > min + 1e-9;
  const canInc = shown < max - 1e-9;

  function adjust(dir: -1 | 1) {
    const next = roundTo(Math.min(max, Math.max(min, shown + dir * step)), decimals);
    if (next !== shown) onChange(next);
  }

  return (
    <View style={[styles.row, compact && styles.rowCompact]}>
      <Pressable
        style={[styles.btn, !canDec && styles.btnDisabled]}
        onPress={() => adjust(-1)}
        disabled={!canDec}
      >
        <Icon name="minus" size={18} color={canDec ? colors.ink : colors.mute} />
      </Pressable>
      <View style={[styles.valueWrap, compact && styles.valueWrapCompact]}>
        <Text style={[styles.value, compact && styles.valueCompact]}>
          {formatValue ? formatValue(shown) : shown.toFixed(decimals)}
          {unit ? <Text style={styles.unit}>{` ${unit}`}</Text> : null}
        </Text>
      </View>
      <Pressable
        style={[styles.btn, !canInc && styles.btnDisabled]}
        onPress={() => adjust(1)}
        disabled={!canInc}
      >
        <Icon name="plus" size={18} color={canInc ? colors.ink : colors.mute} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: sp(2) },
  rowCompact: { justifyContent: "center" },
  btn: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
  },
  btnDisabled: { backgroundColor: colors.cardMuted },
  valueWrap: {
    flex: 1,
    minHeight: 44,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: sp(3),
  },
  valueWrapCompact: { flex: 0, minWidth: 132, paddingHorizontal: sp(2.5) },
  value: { ...T.h2, color: colors.ink },
  valueCompact: { ...T.title, color: colors.ink },
  unit: { ...T.caption, color: colors.mute },
});
