import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Plan } from "./proteinPlan";
import { APP_NAME } from "./config";

const GREEN = "#0B7A4B";

// Polished, screenshot-friendly card summarising a budget-protein plan.
// Rendered off-screen and captured to an image for sharing (viral loop:
// "102g protein · ₹76 today").
export default function PlanShareCard({ plan }: { plan: Plan }) {
  return (
    <View style={styles.card}>
      <Text style={styles.brand}>{APP_NAME}</Text>
      <Text style={styles.label}>MY BUDGET PROTEIN PLAN</Text>

      <View style={styles.heroRow}>
        <View style={styles.heroBox}>
          <Text style={styles.heroVal}>{plan.protein_g}g</Text>
          <Text style={styles.heroKey}>protein</Text>
        </View>
        <View style={styles.heroDivider} />
        <View style={styles.heroBox}>
          <Text style={styles.heroVal}>₹{plan.cost}</Text>
          <Text style={styles.heroKey}>for the day</Text>
        </View>
      </View>

      <View style={styles.items}>
        {plan.items.slice(0, 6).map(({ food, servings }) => (
          <View key={food.id} style={styles.row}>
            <Text style={styles.dish} numberOfLines={1}>
              {food.name}
              {servings > 1 ? `  ×${servings}` : ""}
            </Text>
            <Text style={styles.grams}>{food.protein_g * servings}g</Text>
          </View>
        ))}
      </View>

      <View style={styles.footer}>
        <Text style={styles.footText}>
          {plan.kcal} kcal · ₹{(plan.protein_g > 0 ? plan.cost / plan.protein_g : 0).toFixed(1)}/g protein
        </Text>
        <Text style={styles.tag}>Scan your food with {APP_NAME}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { width: 360, backgroundColor: "#FFFFFF", borderRadius: 28, padding: 28 },
  brand: { color: GREEN, fontSize: 20, fontWeight: "900", letterSpacing: -0.3 },
  label: { color: "#8A938E", fontSize: 12, fontWeight: "800", letterSpacing: 1.2, marginTop: 10 },
  heroRow: { flexDirection: "row", alignItems: "center", marginTop: 8, marginBottom: 4 },
  heroBox: { flex: 1, alignItems: "center" },
  heroDivider: { width: 1, height: 44, backgroundColor: "#ECEFEE" },
  heroVal: { color: "#141A17", fontSize: 40, fontWeight: "900", letterSpacing: -1 },
  heroKey: { color: "#8A938E", fontSize: 13, fontWeight: "700", marginTop: 2 },
  items: { marginTop: 16, borderTopWidth: 1, borderTopColor: "#ECEFEE", paddingTop: 8 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 7 },
  dish: { flex: 1, color: "#3C4844", fontSize: 15, fontWeight: "600" },
  grams: { color: GREEN, fontSize: 15, fontWeight: "800", marginLeft: 12 },
  footer: { marginTop: 16, borderTopWidth: 1, borderTopColor: "#ECEFEE", paddingTop: 14, alignItems: "center" },
  footText: { color: "#141A17", fontSize: 14, fontWeight: "800" },
  tag: { color: "#8A938E", fontSize: 12, fontWeight: "600", marginTop: 4 },
});
