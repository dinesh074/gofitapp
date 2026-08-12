import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Meal } from "./storage";
import { APP_NAME } from "./config";

const GREEN = "#0B7A4B";

type Props = { total: number; meals: Meal[]; streak: number };

// A polished card rendered off-screen and captured to an image for sharing.
export default function ShareCard({ total, meals, streak }: Props) {
  return (
    <View style={styles.card}>
      <Text style={styles.brand}>{APP_NAME}</Text>
      <Text style={styles.label}>WHAT I ATE TODAY</Text>
      <Text style={styles.total}>{total}</Text>
      <Text style={styles.kcal}>kcal</Text>

      <View style={styles.meals}>
        {meals.slice(0, 6).map((m, i) => (
          <View key={i} style={styles.mealRow}>
            <Text style={styles.mealDish} numberOfLines={1}>
              {m.dish}
            </Text>
            <Text style={styles.mealKcal}>{m.kcal}</Text>
          </View>
        ))}
      </View>

      <View style={styles.footer}>
        <Text style={styles.streak}>🔥 {streak} day streak</Text>
        <Text style={styles.tag}>tracked with {APP_NAME}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { width: 340, borderRadius: 24, backgroundColor: GREEN, padding: 24 },
  brand: { color: "#CDEBD9", fontWeight: "800", fontSize: 14 },
  label: { color: "#9FD6BA", fontSize: 12, fontWeight: "700", letterSpacing: 1, marginTop: 18 },
  total: { color: "#fff", fontSize: 72, fontWeight: "900", marginTop: -4 },
  kcal: { color: "#CDEBD9", fontSize: 18, fontWeight: "700", marginTop: -8 },
  meals: { backgroundColor: "rgba(255,255,255,0.12)", borderRadius: 16, padding: 14, marginTop: 18 },
  mealRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  mealDish: { color: "#fff", fontSize: 15, fontWeight: "600", flex: 1, marginRight: 12 },
  mealKcal: { color: "#fff", fontSize: 15, fontWeight: "800" },
  footer: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 20 },
  streak: { color: "#fff", fontSize: 16, fontWeight: "800" },
  tag: { color: "#9FD6BA", fontSize: 11 },
});
