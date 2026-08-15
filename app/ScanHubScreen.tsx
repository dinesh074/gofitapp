import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import Screen from "./Screen";
import Icon from "./Icon";
import { useApp } from "./AppContext";
import { colors, elevation } from "./theme";

export default function ScanHubScreen() {
  const navigation = useNavigation<any>();
  const { triggerScan } = useApp();

  return (
    <Screen edgeTop>
      <ScrollView style={styles.root} contentContainerStyle={styles.body}>
        <Text style={styles.title}>Scan</Text>
        <Text style={styles.sub}>Choose how you want to log food.</Text>

        <Pressable style={styles.actionCard} onPress={() => navigation.navigate("Scan", { mode: "camera" })}>
          <View style={styles.actionIcon}>
            <Icon name="camera" size={18} color={colors.green} />
          </View>
          <View style={styles.actionBody}>
            <Text style={styles.actionTitle}>Scan with camera</Text>
            <Text style={styles.actionSub}>Take a photo and get an itemized nutrition estimate.</Text>
          </View>
          <Icon name="chevronRight" size={16} color={colors.mute} />
        </Pressable>

        <Pressable style={styles.actionCard} onPress={() => navigation.navigate("Scan", { mode: "gallery" })}>
          <View style={styles.actionIcon}>
            <Icon name="gallery" size={18} color={colors.green} />
          </View>
          <View style={styles.actionBody}>
            <Text style={styles.actionTitle}>Use a gallery photo</Text>
            <Text style={styles.actionSub}>Upload a meal photo you already captured.</Text>
          </View>
          <Icon name="chevronRight" size={16} color={colors.mute} />
        </Pressable>

        <Pressable
          style={styles.moreCard}
          onPress={() => {
            navigation.navigate("Home");
            triggerScan();
          }}
        >
          <Icon name="plus" size={15} color={colors.green} />
          <Text style={styles.moreText}>More options: voice, barcode, manual, workout, water and weight</Text>
        </Pressable>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { padding: 16, paddingBottom: 24 },
  title: { color: colors.ink, fontSize: 24, fontWeight: "900" },
  sub: { color: colors.mute, fontSize: 12.5, fontWeight: "600", marginTop: 2, marginBottom: 14 },
  actionCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 10,
    ...elevation.sm,
  },
  actionIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.greenTint,
    alignItems: "center",
    justifyContent: "center",
  },
  actionBody: { flex: 1 },
  actionTitle: { color: colors.ink, fontSize: 14, fontWeight: "800" },
  actionSub: { color: colors.mute, fontSize: 12, fontWeight: "600", marginTop: 2, lineHeight: 16 },
  moreCard: {
    marginTop: 4,
    backgroundColor: colors.greenTint,
    borderRadius: 14,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  moreText: { flex: 1, color: colors.green, fontSize: 12.5, fontWeight: "700", lineHeight: 17 },
});
