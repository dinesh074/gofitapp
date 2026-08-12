import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { APP_NAME } from "./config";
import { gradients } from "./theme";

export type ShareFormat = "story" | "post" | "square";

// Social platform target sizes. Output is captured at 1080px wide.
export const FORMAT_RATIO: Record<ShareFormat, number> = {
  story: 1920 / 1080, // 9:16 — Instagram/Facebook Stories, TikTok, Reels
  post: 1350 / 1080, // 4:5 — Instagram feed (max portrait)
  square: 1080 / 1080, // 1:1 — classic square post
};

export const FORMAT_LABEL: Record<ShareFormat, string> = {
  story: "Story · 9:16",
  post: "Post · 4:5",
  square: "Square · 1:1",
};

export type ShareMeal = { dish: string; kcal: number };
export type ShareMacros = { protein_g: number; carbs_g: number; fat_g: number };

type Props = {
  total: number;
  meals: ShareMeal[];
  macros: ShareMacros;
  streak: number;
  dateLabel: string;
  format: ShareFormat;
  // Rendered width in px. The card lays everything out proportionally to a
  // 1080-wide design canvas, so the same component serves both the small
  // in-app preview and the full-res off-screen capture.
  width: number;
};

// A premium, on-brand card built to be posted straight to Instagram / TikTok /
// Reels — real social aspect ratios, safe margins, and a curated layout (not a
// screenshot of the app UI). Everything scales off `u` (1 design unit = 1px on
// a 1080-wide canvas) so it stays crisp at any output size.
export default function SocialShareCard({
  total,
  meals,
  macros,
  streak,
  dateLabel,
  format,
  width,
}: Props) {
  const u = width / 1080;
  const height = width * FORMAT_RATIO[format];

  const maxMeals = format === "story" ? 6 : format === "post" ? 5 : 3;
  const shown = meals.slice(0, maxMeals);
  const more = meals.length - shown.length;

  const heroSize = (format === "square" ? 150 : format === "post" ? 186 : 210) * u;
  const pad = (format === "square" ? 64 : 84) * u;

  return (
    <LinearGradient
      colors={gradients.brandDeep}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={{ width, height, paddingHorizontal: pad, paddingVertical: pad, justifyContent: "space-between" }}
    >
      {/* Decorative glow rings — subtle, on-brand, keeps it from feeling flat. */}
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          right: -220 * u,
          top: -220 * u,
          width: 620 * u,
          height: 620 * u,
          borderRadius: 620 * u,
          backgroundColor: "rgba(255,255,255,0.06)",
        }}
      />
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: -260 * u,
          bottom: -260 * u,
          width: 680 * u,
          height: 680 * u,
          borderRadius: 680 * u,
          backgroundColor: "rgba(255,255,255,0.05)",
        }}
      />

      {/* Header */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 16 * u }}>
          <View
            style={{
              width: 64 * u,
              height: 64 * u,
              borderRadius: 20 * u,
              backgroundColor: "rgba(255,255,255,0.16)",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ fontSize: 34 * u }}>🥗</Text>
          </View>
          <Text style={{ color: "#EAF7F0", fontSize: 34 * u, fontWeight: "800", letterSpacing: 0.5 * u }}>
            {APP_NAME}
          </Text>
        </View>
        <Text style={{ color: "rgba(234,247,240,0.75)", fontSize: 28 * u, fontWeight: "700" }}>{dateLabel}</Text>
      </View>

      {/* Hero */}
      <View>
        <Text style={{ color: "#8FD6B4", fontSize: 30 * u, fontWeight: "800", letterSpacing: 4 * u }}>
          WHAT I ATE TODAY
        </Text>
        <View style={{ flexDirection: "row", alignItems: "flex-end" }}>
          <Text style={{ color: "#fff", fontSize: heroSize, fontWeight: "900", letterSpacing: -3 * u }}>
            {total.toLocaleString()}
          </Text>
          <Text style={{ color: "#CFEBDD", fontSize: 44 * u, fontWeight: "800", marginBottom: heroSize * 0.16 }}>
            {"  "}kcal
          </Text>
        </View>

        {/* Macro chips */}
        <View style={{ flexDirection: "row", gap: 16 * u, marginTop: 20 * u }}>
          <MacroChip u={u} label="Protein" value={macros.protein_g} tint="#8FD6B4" />
          <MacroChip u={u} label="Carbs" value={macros.carbs_g} tint="#F3D27A" />
          <MacroChip u={u} label="Fat" value={macros.fat_g} tint="#F0A98C" />
        </View>
      </View>

      {/* Meals */}
      <View
        style={{
          backgroundColor: "rgba(255,255,255,0.10)",
          borderRadius: 36 * u,
          padding: 40 * u,
          gap: 24 * u,
        }}
      >
        {shown.map((m, i) => (
          <View key={i} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Text
              numberOfLines={1}
              style={{ color: "#fff", fontSize: 34 * u, fontWeight: "600", flex: 1, marginRight: 24 * u }}
            >
              {m.dish}
            </Text>
            <Text style={{ color: "#CFEBDD", fontSize: 34 * u, fontWeight: "800" }}>{m.kcal}</Text>
          </View>
        ))}
        {shown.length === 0 && (
          <Text style={{ color: "#CFEBDD", fontSize: 32 * u, fontWeight: "600" }}>Nothing logged yet today</Text>
        )}
        {more > 0 && (
          <Text style={{ color: "rgba(207,235,221,0.8)", fontSize: 28 * u, fontWeight: "700" }}>+{more} more</Text>
        )}
      </View>

      {/* Footer */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10 * u,
            backgroundColor: "rgba(255,255,255,0.16)",
            borderRadius: 999,
            paddingHorizontal: 28 * u,
            paddingVertical: 16 * u,
          }}
        >
          <Text style={{ fontSize: 32 * u }}>🔥</Text>
          <Text style={{ color: "#fff", fontSize: 32 * u, fontWeight: "800" }}>{streak} day streak</Text>
        </View>
        <Text style={{ color: "rgba(234,247,240,0.7)", fontSize: 26 * u, fontWeight: "700" }}>
          tracked with {APP_NAME}
        </Text>
      </View>
    </LinearGradient>
  );
}

function MacroChip({ u, label, value, tint }: { u: number; label: string; value: number; tint: string }) {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: "rgba(255,255,255,0.12)",
        borderRadius: 24 * u,
        paddingVertical: 22 * u,
        paddingHorizontal: 12 * u,
        alignItems: "center",
      }}
    >
      <Text style={{ color: "#fff", fontSize: 40 * u, fontWeight: "900" }}>{Math.round(value)}g</Text>
      <Text style={{ color: tint, fontSize: 24 * u, fontWeight: "800", letterSpacing: 1 * u, marginTop: 4 * u }}>
        {label.toUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({});
