import React from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { colors, elevation } from "./theme";
import Icon, { IconName } from "./Icon";
import { SavedMeal } from "./storage";

type OptionKey = "camera" | "gallery" | "barcode" | "describe";

type Props = {
  visible: boolean;
  onClose: () => void;
  onPick: (option: OptionKey) => void;
  // Quick re-log: one-tap re-add of recent/favorite meals (no re-scan, no AI).
  recents?: SavedMeal[];
  onQuickLog?: (meal: SavedMeal) => void;
  onToggleFav?: (dish: string) => void;
};

const OPTIONS: { key: OptionKey; icon: IconName; title: string; sub: string }[] = [
  { key: "camera", icon: "camera", title: "Take a photo", sub: "Point your camera at the plate" },
  { key: "gallery", icon: "gallery", title: "Choose from gallery", sub: "Use a photo you already took" },
  { key: "barcode", icon: "barcode", title: "Scan a barcode", sub: "For packaged / branded food" },
  { key: "describe", icon: "edit", title: "Describe it", sub: "No photo? Just type or speak it" },
];

// Single entry point for "log a meal" -- replaces what used to be four
// separate buttons scattered down the Home screen (Scan food, Gallery, Scan
// barcode, Describe link). One tap now opens this sheet instead of asking
// you to pick the right button out of a row of near-identical ones. Shared
// by the Home screen's own "Add food" button and the TabBar's center
// button (see App.tsx's scanTrigger -> HomeScreen's showAddSheet).
export default function AddFoodSheet({
  visible,
  onClose,
  onPick,
  recents = [],
  onQuickLog,
  onToggleFav,
}: Props) {
  const hasRecents = recents.length > 0 && !!onQuickLog;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.backdropTap} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.grabber} />
          <Text style={styles.title}>Add a meal</Text>
          <Text style={styles.sub}>Choose how you'd like to log this.</Text>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 4 }}>
            {OPTIONS.map((opt) => (
              <Pressable
                key={opt.key}
                style={styles.row}
                onPress={() => onPick(opt.key)}
              >
                <View style={styles.rowIcon}>
                  <Icon name={opt.icon} size={20} color={colors.green} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle}>{opt.title}</Text>
                  <Text style={styles.rowSub}>{opt.sub}</Text>
                </View>
                <Icon name="chevronRight" size={18} color={colors.faint} />
              </Pressable>
            ))}

            {hasRecents && (
              <>
                <View style={styles.recentHead}>
                  <Icon name="time" size={14} color={colors.mute} />
                  <Text style={styles.recentTitle}>Recent &amp; favorites</Text>
                  <Text style={styles.recentHint}>Tap to log instantly</Text>
                </View>
                {recents.map((m) => (
                  <View key={m.dish} style={styles.recentRow}>
                    <Pressable
                      style={styles.recentMain}
                      onPress={() => onQuickLog?.(m)}
                    >
                      <View style={styles.recentPlus}>
                        <Icon name="plus" size={18} color={colors.green} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.recentName} numberOfLines={1}>
                          {m.dish}
                        </Text>
                        <Text style={styles.recentSub}>
                          {m.kcal} kcal · P {m.protein_g}g · C {m.carbs_g}g · F {m.fat_g}g
                        </Text>
                      </View>
                    </Pressable>
                    {onToggleFav && (
                      <Pressable
                        style={styles.favBtn}
                        hitSlop={8}
                        onPress={() => onToggleFav(m.dish)}
                      >
                        <Icon
                          name={m.fav ? "star" : "starOutline"}
                          size={20}
                          color={m.fav ? colors.gold : colors.faint}
                        />
                      </Pressable>
                    )}
                  </View>
                ))}
              </>
            )}
          </ScrollView>

          <Pressable style={styles.later} onPress={onClose}>
            <Text style={styles.laterText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" },
  backdropTap: { flex: 1 },
  sheet: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    paddingHorizontal: 20,
    paddingBottom: 26,
    maxHeight: "90%",
  },
  grabber: {
    alignSelf: "center",
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: "#CBD5D0",
    marginTop: 10,
    marginBottom: 14,
  },
  title: { fontSize: 22, fontWeight: "900", color: colors.ink, letterSpacing: -0.3 },
  sub: { fontSize: 13, color: colors.mute, marginTop: 4, marginBottom: 14, lineHeight: 18 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 14,
    marginBottom: 10,
    ...elevation.sm,
  },
  rowIcon: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: colors.greenTint,
    alignItems: "center",
    justifyContent: "center",
  },
  rowTitle: { color: colors.ink, fontWeight: "800", fontSize: 15 },
  rowSub: { color: colors.mute, fontWeight: "600", fontSize: 12, marginTop: 1 },
  recentHead: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6, marginBottom: 8 },
  recentTitle: { color: colors.ink, fontWeight: "800", fontSize: 13 },
  recentHint: { color: colors.faint, fontWeight: "600", fontSize: 11, marginLeft: "auto" },
  recentRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.card,
    borderRadius: 14,
    marginBottom: 8,
    ...elevation.sm,
  },
  recentMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12, padding: 12 },
  recentPlus: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: colors.greenTint,
    alignItems: "center",
    justifyContent: "center",
  },
  recentName: { color: colors.ink, fontWeight: "800", fontSize: 14 },
  recentSub: { color: colors.mute, fontWeight: "600", fontSize: 11.5, marginTop: 2 },
  favBtn: { paddingHorizontal: 14, paddingVertical: 16 },
  later: { alignItems: "center", paddingVertical: 14, marginTop: 4 },
  laterText: { color: colors.mute, fontWeight: "700", fontSize: 14 },
});

