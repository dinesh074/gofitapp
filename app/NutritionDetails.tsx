import React from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { colors, radius, elevation } from "./theme";
import Icon from "./Icon";
import { FoodItem } from "./api";

type Props = {
  visible: boolean;
  onClose: () => void;
  item: FoodItem | null;
};

// Friendly label + display unit for each key in FoodItem.micros. Grouped so
// the sheet reads like a real nutrition-facts panel, not a flat data dump.
const FAT_KEYS: [string, string][] = [
  ["saturated_fat_mg", "Saturated fat"], ["monounsaturated_fat_mg", "Monounsaturated fat"],
  ["polyunsaturated_fat_mg", "Polyunsaturated fat"], ["cholesterol_mg", "Cholesterol"],
];
const MINERAL_KEYS: [string, string][] = [
  ["sodium_mg", "Sodium"], ["potassium_mg", "Potassium"], ["calcium_mg", "Calcium"],
  ["iron_mg", "Iron"], ["phosphorus_mg", "Phosphorus"], ["magnesium_mg", "Magnesium"],
  ["zinc_mg", "Zinc"], ["copper_mg", "Copper"], ["selenium_ug", "Selenium"],
  ["manganese_mg", "Manganese"], ["chromium_mg", "Chromium"], ["molybdenum_mg", "Molybdenum"],
];
const VITAMIN_KEYS: [string, string][] = [
  ["vitamin_a_ug", "Vitamin A"], ["vitamin_c_mg", "Vitamin C"], ["vitamin_e_mg", "Vitamin E"],
  ["vitamin_d2_ug", "Vitamin D2"], ["vitamin_d3_ug", "Vitamin D3"],
  ["vitamin_k1_ug", "Vitamin K1"], ["vitamin_k2_ug", "Vitamin K2"],
  ["folate_ug", "Folate"], ["vitamin_b1_thiamine_mg", "Vitamin B1 (Thiamine)"],
  ["vitamin_b2_riboflavin_mg", "Vitamin B2 (Riboflavin)"], ["vitamin_b3_niacin_mg", "Vitamin B3 (Niacin)"],
  ["vitamin_b5_pantothenic_mg", "Vitamin B5 (Pantothenic acid)"], ["vitamin_b6_mg", "Vitamin B6"],
  ["vitamin_b7_biotin_ug", "Vitamin B7 (Biotin)"], ["vitamin_b9_ug", "Vitamin B9"],
  ["carotenoids_ug", "Carotenoids"],
];

function unitOf(key: string): string {
  if (key.endsWith("_mg")) return "mg";
  if (key.endsWith("_ug")) return "µg"; // µg
  return "g";
}

function scoreColor(score: number): string {
  if (score >= 65) return colors.green;
  if (score >= 40) return colors.orange;
  return colors.red;
}

function Row({ label, value, unit }: { label: string; value: number; unit: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>
        {value < 0.01 && value > 0 ? value.toFixed(3) : value}
        <Text style={styles.rowUnit}> {unit}</Text>
      </Text>
    </View>
  );
}

function Section({ title, keys, micros }: { title: string; keys: [string, string][]; micros: Record<string, number> }) {
  const present = keys.filter(([k]) => micros[k] !== undefined && micros[k] !== null);
  if (!present.length) return null;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {present.map(([k, label]) => (
        <Row key={k} label={label} value={micros[k]} unit={unitOf(k)} />
      ))}
    </View>
  );
}

// Full nutrition-facts breakdown for one scanned item, including the complete
// vitamin/mineral panel and the app-computed health score. Mounted only while
// visible (see HomeScreen.tsx's comment on the Paywall modal for why --
export default function NutritionDetails({ visible, onClose, item }: Props) {
  if (!item) return null;
  const micros = item.micros || {};

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.backdropTap} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.grip} />
          <View style={styles.headRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>{item.item}</Text>
              <Text style={styles.subtitle}>
                {item.count} × {item.unit} · {item.kcal_total} kcal
              </Text>
            </View>
            <Pressable onPress={onClose} hitSlop={10} style={styles.closeBtn}>
              <Icon name="close" size={20} color={colors.mute} />
            </Pressable>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 20 }}>
            {item.health_score !== undefined && (
              <View style={styles.scoreCard}>
                <View style={[styles.scoreBadge, { backgroundColor: scoreColor(item.health_score) }]}>
                  <Text style={styles.scoreNum}>{Math.round(item.health_score)}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.scoreLabel}>App dietary balance score</Text>
                  <Text style={styles.scoreNote}>
                    Computed from this dish's real nutrient data — not an official rating, not medical advice.
                  </Text>
                </View>
              </View>
            )}

            {!!item.benefits?.length && (
              <View style={styles.chipRow}>
                {item.benefits.map((b) => (
                  <View key={b} style={styles.chipGood}>
                    <Icon name="check" size={12} color={colors.green} />
                    <Text style={styles.chipGoodText}>{b}</Text>
                  </View>
                ))}
              </View>
            )}
            {!!item.watch_outs?.length && (
              <View style={styles.chipRow}>
                {item.watch_outs.map((w) => (
                  <View key={w} style={styles.chipWarn}>
                    <Icon name="info" size={12} color={colors.orange} />
                    <Text style={styles.chipWarnText}>{w}</Text>
                  </View>
                ))}
              </View>
            )}

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>This serving ({item.count} × {item.unit})</Text>
              <Row label="Energy" value={item.kcal_total} unit="kcal" />
              <Row label="Protein" value={item.protein_g} unit="g" />
              <Row label="Carbohydrates" value={item.carbs_g} unit="g" />
              {item.fiber_g !== undefined && <Row label="  of which fiber" value={item.fiber_g} unit="g" />}
              {item.sugar_g !== undefined && <Row label="  of which sugar" value={item.sugar_g} unit="g" />}
              <Row label="Fat" value={item.fat_g} unit="g" />
            </View>

            <Section title="Fat breakdown" keys={FAT_KEYS} micros={micros} />
            <Section title="Minerals" keys={MINERAL_KEYS} micros={micros} />
            <Section title="Vitamins" keys={VITAMIN_KEYS} micros={micros} />

            {!Object.keys(micros).length && (
              <Text style={styles.empty}>
                Full micronutrient data isn't available for this item yet — it was estimated by the AI rather than matched to our food database.
              </Text>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" },
  backdropTap: { flex: 1 },
  sheet: { backgroundColor: colors.bg, borderTopLeftRadius: 26, borderTopRightRadius: 26, paddingHorizontal: 20, paddingTop: 10, paddingBottom: 12, maxHeight: "88%" },
  grip: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: colors.hairline, marginBottom: 12 },
  headRow: { flexDirection: "row", alignItems: "center", marginBottom: 14 },
  title: { color: colors.ink, fontSize: 18, fontWeight: "800", letterSpacing: -0.2, textTransform: "capitalize" },
  subtitle: { color: colors.mute, fontSize: 12.5, marginTop: 2, fontWeight: "600" },
  closeBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.card, alignItems: "center", justifyContent: "center" },

  scoreCard: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.card, borderRadius: radius.md, padding: 12, marginBottom: 10, ...elevation.sm },
  scoreBadge: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  scoreNum: { color: "#fff", fontWeight: "900", fontSize: 16 },
  scoreLabel: { color: colors.ink, fontWeight: "800", fontSize: 13.5 },
  scoreNote: { color: colors.mute, fontSize: 11, marginTop: 2, fontWeight: "500" },

  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 8 },
  chipGood: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: colors.greenTint, borderRadius: 999, paddingVertical: 5, paddingHorizontal: 10 },
  chipGoodText: { color: colors.green, fontWeight: "700", fontSize: 11.5 },
  chipWarn: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: colors.redTint, borderRadius: 999, paddingVertical: 5, paddingHorizontal: 10 },
  chipWarnText: { color: colors.orange, fontWeight: "700", fontSize: 11.5 },

  section: { marginTop: 12 },
  sectionTitle: { color: colors.mute, fontSize: 11.5, fontWeight: "800", letterSpacing: 0.4, textTransform: "uppercase", marginBottom: 6 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: colors.line },
  rowLabel: { color: colors.inkSoft, fontSize: 13.5, fontWeight: "600" },
  rowValue: { color: colors.ink, fontSize: 13.5, fontWeight: "800" },
  rowUnit: { color: colors.mute, fontWeight: "600", fontSize: 12 },
  empty: { color: colors.mute, fontSize: 12.5, textAlign: "center", marginTop: 16, fontStyle: "italic" },
});
