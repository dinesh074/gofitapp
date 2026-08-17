import React, { useMemo, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Slider from "@react-native-community/slider";
import { FoodItem } from "./api";
import { colors, radius, elevation, type as T } from "./theme";
import Icon from "./Icon";

// Real-world portions people actually think in, not just a bare "count":
// grams, bowl/plate size, how much of a shared dish got eaten, and fruit
// size. All of these ultimately just set `count` (the multiplier the rest of
// the app already uses for kcal_total = count * kcal_per_unit) -- this sheet
// is a friendlier front-end onto that one number, not a new data model.
//
// - Countable items (idli, samosa, banana...): grams don't make sense per-
//   piece, so this shows a piece stepper + "part of it" presets (¼/½/¾/whole)
//   for "I only ate half of it", plus small/medium/large for fruit-like items.
// - Bulk items (curry, dal, rice -- countable=false, unit like "bowl"/
//   "plate"/"katori"/"cup"): count 1.0 is treated as this dish's normal single
//   serving (~100g baseline, matching how the AI already estimates a "medium"
//   serving), so grams = count * 100 and back-converts the same way.
type Props = {
  visible: boolean;
  item: FoodItem | null;
  onClose: () => void;
  onApply: (count: number) => void;
};

const FRUIT_KEYWORDS = ["banana", "apple", "mango", "orange", "papaya", "guava", "grape", "pear", "watermelon", "chikoo", "pomegranate", "fruit"];

function isFruitLike(name: string): boolean {
  const n = name.toLowerCase();
  return FRUIT_KEYWORDS.some((k) => n.includes(k));
}

// Realistic per-unit baseline serving weight (grams) -- previously this was
// a flat 100g for every non-countable item regardless of unit, which made
// "Full plate" of a rice dish display as "≈ 100g" (a real full plate is
// 250-350g). That mislabeling made otherwise-plausible calorie estimates
// look absurd (e.g. "594 kcal ≈ 100g" reads as 594kcal/100g, when the dish
// is actually a ~280g plate at a much more normal ~210 kcal/100g). This does
// NOT change any calorie math -- kcal_total is still count * kcal_per_unit
// exactly as before -- it only fixes the displayed gram estimate to match
// what the unit name actually means.
function gramsBaselineForUnit(unit: string): number {
  const u = unit.toLowerCase();
  if (u.includes("100g")) return 100;
  if (u.includes("plate")) return 280;
  if (u.includes("katori")) return 150;
  if (u.includes("bowl")) return 180;
  if (u.includes("cup") || u.includes("glass") || u.includes("jar")) return 220;
  if (u.includes("tablespoon")) return 15;
  return 150;
}

export default function PortionPicker({ visible, item, onClose, onApply }: Props) {
  const [count, setCount] = useState(item?.count ?? 1);
  useMemo(() => {
    if (item) setCount(item.count);
    // Re-seed the slider every time a different item is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.item]);

  if (!item) return null;
  const fruit = isFruitLike(item.item);
  const gramsBaseline = gramsBaselineForUnit(item.unit || "");
  const grams = Math.round(count * gramsBaseline);
  const kcalPreview = Math.round(count * item.kcal_per_unit);

  function setGrams(g: number) {
    setCount(Math.max(0.05, g / gramsBaseline));
  }

  const partPresets: { label: string; value: number }[] = [
    { label: "¼", value: 0.25 },
    { label: "½", value: 0.5 },
    { label: "¾", value: 0.75 },
    { label: "Whole", value: 1 },
    { label: "1½×", value: 1.5 },
    { label: "2×", value: 2 },
  ];
  const bowlPresets: { label: string; value: number }[] = [
    { label: "Small bowl", value: 0.5 },
    { label: "Medium bowl", value: 1 },
    { label: "Large bowl", value: 1.5 },
  ];
  const platePresets: { label: string; value: number }[] = [
    { label: "Quarter plate", value: 0.25 },
    { label: "Half plate", value: 0.5 },
    { label: "Full plate", value: 1 },
  ];
  const fruitPresets: { label: string; value: number }[] = [
    { label: "Small", value: 0.75 },
    { label: "Medium", value: 1 },
    { label: "Large", value: 1.3 },
  ];

  const unitLower = (item.unit || "").toLowerCase();
  const isPlate = unitLower.includes("plate");
  const isBowlish = unitLower.includes("bowl") || unitLower.includes("katori") || unitLower.includes("cup");
  const presets = fruit ? fruitPresets : isPlate ? platePresets : isBowlish ? bowlPresets : partPresets;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.backdropTap} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.grabber} />
          <Text style={styles.title}>{item.item}</Text>
          <Text style={styles.sub}>How much did you actually have?</Text>

          <View style={styles.previewRow}>
            <Text style={styles.previewKcal}>{kcalPreview} kcal</Text>
            {!item.countable && <Text style={styles.previewGrams}>≈ {grams} g</Text>}
          </View>

          <View style={styles.presetRow}>
            {presets.map((p) => (
              <Pressable
                key={p.label}
                style={[styles.presetChip, Math.abs(count - p.value) < 0.01 && styles.presetChipActive]}
                onPress={() => setCount(p.value)}
              >
                <Text style={[styles.presetChipText, Math.abs(count - p.value) < 0.01 && styles.presetChipTextActive]}>
                  {p.label}
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.sliderLabel}>Fine-tune ({item.countable ? "pieces" : "portion"})</Text>
          <Slider
            style={{ width: "100%", height: 36 }}
            minimumValue={0.05}
            maximumValue={item.countable ? 10 : 4}
            step={0.05}
            value={count}
            onValueChange={setCount}
            minimumTrackTintColor={colors.green}
            maximumTrackTintColor={colors.line}
            thumbTintColor={colors.green}
          />
          <Text style={styles.sliderValue}>{count.toFixed(2)}×</Text>

          {!item.countable && (
            <View style={styles.gramsRow}>
              <Text style={styles.gramsLabel}>Or enter grams</Text>
              <TextInput
                style={styles.gramsInput}
                keyboardType="numeric"
                value={String(grams)}
                onChangeText={(t) => {
                  const n = parseInt(t.replace(/[^0-9]/g, ""), 10);
                  if (!isNaN(n)) setGrams(n);
                }}
              />
            </View>
          )}

          <Pressable
            style={styles.applyBtn}
            onPress={() => {
              onApply(Math.round(count * 20) / 20);
              onClose();
            }}
          >
            <Icon name="check" size={18} color={colors.white} />
            <Text style={styles.applyBtnText}>Use this portion</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  backdropTap: { flex: 1 },
  sheet: { backgroundColor: colors.bg, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 32 },
  grabber: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: "#CBD5D0", marginBottom: 12 },
  title: { ...T.h2, color: colors.ink },
  sub: { color: colors.mute, fontWeight: "600", fontSize: 13, marginTop: 2, marginBottom: 16 },

  previewRow: { flexDirection: "row", alignItems: "baseline", gap: 10, marginBottom: 16 },
  previewKcal: { color: colors.ink, fontWeight: "900", fontSize: 26 },
  previewGrams: { color: colors.mute, fontWeight: "700", fontSize: 14 },

  presetRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 16 },
  presetChip: { backgroundColor: colors.cardMuted, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 9 },
  presetChipActive: { backgroundColor: colors.green },
  presetChipText: { color: colors.mute, fontWeight: "700", fontSize: 13 },
  presetChipTextActive: { color: colors.white },

  sliderLabel: { color: colors.mute, fontWeight: "700", fontSize: 12, marginBottom: 2 },
  sliderValue: { color: colors.ink, fontWeight: "800", fontSize: 13, textAlign: "center", marginBottom: 12 },

  gramsRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 16 },
  gramsLabel: { color: colors.mute, fontWeight: "700", fontSize: 13 },
  gramsInput: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.sm,
    paddingHorizontal: 14,
    paddingVertical: 8,
    fontWeight: "800",
    fontSize: 15,
    color: colors.ink,
    minWidth: 80,
    textAlign: "center",
  },

  applyBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.green,
    borderRadius: radius.md,
    paddingVertical: 16,
    ...elevation.md,
  },
  applyBtnText: { color: colors.white, fontWeight: "800", fontSize: 16 },
});
