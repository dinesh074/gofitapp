import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import Screen from "./Screen";
import Icon from "./Icon";
import PressableScale from "./PressableScale";
import { colors, elevation } from "./theme";
import { goBackOrTabs } from "./nav";

type MoveMeal = {
  name: string;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
};

type Params = {
  category?: string;
  slot?: string;
  reason?: string;
  biggestGap?: string;
  selected?: MoveMeal | null;
  alternatives?: MoveMeal[];
};

export default function NextMoveScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const params = (route.params ?? {}) as Params;
  const initial = params.selected ?? null;
  const [selected, setSelected] = useState<MoveMeal | null>(initial);
  const alternatives = useMemo(
    () => (params.alternatives ?? []).filter((m) => !selected || m.name !== selected.name),
    [params.alternatives, selected],
  );

  return (
    <Screen edgeTop>
      <ScrollView style={styles.root} contentContainerStyle={styles.body}>
        <View style={styles.headRow}>
          <Pressable style={styles.backBtn} onPress={() => goBackOrTabs(navigation)}>
            <Icon name="chevronLeft" size={16} color={colors.green} />
            <Text style={styles.backText}>Back</Text>
          </Pressable>
        </View>

        <View style={styles.card}>
          <View style={styles.titleRow}>
            <Icon name="sparkles" size={16} color={colors.green} />
            <Text style={styles.kicker}>What should I do next?</Text>
          </View>
          <Text style={styles.title}>Your next best move</Text>
          {!!params.category && (
            <View style={styles.categoryPill}>
              <Text style={styles.categoryText}>{params.category.replace(/_/g, " ")}</Text>
            </View>
          )}

          {!!selected && (
            <View style={styles.mainCard}>
              <Text style={styles.mealName}>{selected.name}</Text>
              <Text style={styles.mealMeta}>
                ~{Math.round(selected.kcal)} kcal · P {Math.round(selected.protein_g)}g · C{" "}
                {Math.round(selected.carbs_g)}g · F {Math.round(selected.fat_g)}g
              </Text>
            </View>
          )}

          {alternatives.length > 0 && (
            <>
              <Text style={styles.altHead}>Swap options</Text>
              {alternatives.map((alt) => (
                <Pressable key={alt.name} style={styles.altRow} onPress={() => setSelected(alt)}>
                  <Text style={styles.altName}>{alt.name}</Text>
                  <Text style={styles.altMeta}>~{Math.round(alt.kcal)} kcal</Text>
                </Pressable>
              ))}
            </>
          )}

          {!!params.biggestGap && <Text style={styles.gap}>{params.biggestGap}</Text>}
          {!!params.reason && <Text style={styles.reason}>{params.reason}</Text>}

          <PressableScale
            style={[styles.logBtn]}
            onPress={() => {
              navigation.navigate("Tabs", { screen: "ScanHub" });
            }}
          >
            <Icon name="plus" size={16} color="#fff" />
            <Text style={styles.logBtnText}>Log this now</Text>
          </PressableScale>
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { padding: 16, paddingBottom: 24 },
  headRow: { flexDirection: "row", marginBottom: 10 },
  backBtn: { flexDirection: "row", alignItems: "center", gap: 4 },
  backText: { color: colors.green, fontSize: 13, fontWeight: "800" },
  card: { backgroundColor: colors.greenTint, borderRadius: 18, padding: 16, gap: 10, ...elevation.sm },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  kicker: { color: colors.green, fontSize: 14, fontWeight: "900" },
  title: { color: colors.ink, fontSize: 20, fontWeight: "900" },
  categoryPill: {
    alignSelf: "flex-start",
    backgroundColor: colors.card,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.line,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  categoryText: { color: colors.inkSoft, fontSize: 11, fontWeight: "800", textTransform: "uppercase" },
  mainCard: { backgroundColor: colors.card, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 12 },
  mealName: { color: colors.ink, fontSize: 16, fontWeight: "800" },
  mealMeta: { color: colors.mute, fontSize: 12.5, fontWeight: "700", marginTop: 2 },
  altHead: { color: colors.ink, fontSize: 13.5, fontWeight: "800", marginTop: 2 },
  altRow: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingVertical: 9,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  altName: { color: colors.ink, fontSize: 13, fontWeight: "700", flex: 1 },
  altMeta: { color: colors.mute, fontSize: 11.5, fontWeight: "700" },
  gap: { color: colors.inkSoft, fontSize: 13, fontWeight: "700", marginTop: 2 },
  reason: { color: colors.mute, fontSize: 12, fontWeight: "600", lineHeight: 17 },
  logBtn: {
    marginTop: 2,
    backgroundColor: colors.green,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  logBtnText: { color: "#fff", fontSize: 14, fontWeight: "800" },
});
