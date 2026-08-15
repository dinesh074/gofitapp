import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import Screen from "./Screen";
import Icon from "./Icon";
import { colors, elevation } from "./theme";

export default function ScanHubScreen() {
  const navigation = useNavigation<any>();

  return (
    <Screen edgeTop>
      <ScrollView style={styles.root} contentContainerStyle={styles.body}>
        <Text style={styles.title}>Add / Track</Text>
        <Text style={styles.sub}>Use full-screen scan flows for camera, barcode, and tracking.</Text>

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

        <Pressable style={styles.actionCard} onPress={() => navigation.navigate("BarcodeLookup")}>
          <View style={styles.actionIcon}>
            <Icon name="barcode" size={18} color={colors.green} />
          </View>
          <View style={styles.actionBody}>
            <Text style={styles.actionTitle}>Barcode lookup</Text>
            <Text style={styles.actionSub}>Scan or type barcode for packaged foods.</Text>
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

        <Pressable style={styles.actionCard} onPress={() => navigation.navigate("DescribeMeal")}>
          <View style={styles.actionIcon}>
            <Icon name="mic" size={18} color={colors.green} />
          </View>
          <View style={styles.actionBody}>
            <Text style={styles.actionTitle}>Voice log</Text>
            <Text style={styles.actionSub}>Speak your meal and edit before adding.</Text>
          </View>
          <Icon name="chevronRight" size={16} color={colors.mute} />
        </Pressable>

        <Pressable style={styles.actionCard} onPress={() => navigation.navigate("ExerciseLog")}>
          <View style={styles.actionIcon}>
            <Icon name="dumbbell" size={18} color={colors.green} />
          </View>
          <View style={styles.actionBody}>
            <Text style={styles.actionTitle}>Workout log</Text>
            <Text style={styles.actionSub}>Track exercises, duration, and calories burned.</Text>
          </View>
          <Icon name="chevronRight" size={16} color={colors.mute} />
        </Pressable>

        <Pressable style={styles.actionCard} onPress={() => navigation.navigate("WaterLog")}>
          <View style={styles.actionIcon}>
            <Icon name="water" size={18} color={colors.green} />
          </View>
          <View style={styles.actionBody}>
            <Text style={styles.actionTitle}>Water</Text>
            <Text style={styles.actionSub}>Add hydration quickly to today.</Text>
          </View>
          <Icon name="chevronRight" size={16} color={colors.mute} />
        </Pressable>

        <Pressable style={styles.actionCard} onPress={() => navigation.navigate("WeightLog")}>
          <View style={styles.actionIcon}>
            <Icon name="scale" size={18} color={colors.green} />
          </View>
          <View style={styles.actionBody}>
            <Text style={styles.actionTitle}>Weight</Text>
            <Text style={styles.actionSub}>Log your weight with 100g precision.</Text>
          </View>
          <Icon name="chevronRight" size={16} color={colors.mute} />
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
});
