import React from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { colors, gradients, elevation, type as T } from "./theme";
import Icon, { IconName } from "./Icon";

export type TabKey = "home" | "progress" | "community" | "profile";

const LEFT_TABS: { key: TabKey; icon: IconName; iconOff: IconName; label: string }[] = [
  { key: "home", icon: "home", iconOff: "homeOutline", label: "Home" },
  { key: "progress", icon: "progress", iconOff: "progressOutline", label: "Progress" },
];
const RIGHT_TABS: { key: TabKey; icon: IconName; iconOff: IconName; label: string }[] = [
  { key: "community", icon: "community", iconOff: "communityOutline", label: "Community" },
  { key: "profile", icon: "profile", iconOff: "profileOutline", label: "Profile" },
];

type Props = {
  active: TabKey;
  onChange: (t: TabKey) => void;
  // Center action button -- jumps to Home and opens the camera immediately,
  // same as tapping "Scan food" there, but reachable from any tab in one tap.
  onScanPress: () => void;
};

function TabButton({
  t,
  active,
  onChange,
}: {
  t: { key: TabKey; icon: IconName; iconOff: IconName; label: string };
  active: TabKey;
  onChange: (t: TabKey) => void;
}) {
  const on = t.key === active;
  return (
    <Pressable style={styles.tab} onPress={() => onChange(t.key)} hitSlop={6}>
      <View style={[styles.iconWrap, on && styles.iconWrapActive]}>
        <Icon name={on ? t.icon : t.iconOff} size={22} color={on ? colors.green : colors.mute} />
      </View>
      <Text style={[styles.label, on && styles.labelActive]}>{t.label}</Text>
    </Pressable>
  );
}

export default function TabBar({ active, onChange, onScanPress }: Props) {
  return (
    <View style={styles.bar}>
      {LEFT_TABS.map((t) => (
        <TabButton key={t.key} t={t} active={active} onChange={onChange} />
      ))}

      <View style={styles.centerSlot}>
        <Pressable style={styles.centerBtn} onPress={onScanPress} hitSlop={8}>
          <LinearGradient
            colors={gradients.brand}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.centerGradient}
          >
            <Icon name="camera" size={26} color="#fff" />
          </LinearGradient>
        </Pressable>
        <Text style={styles.centerLabel}>Scan</Text>
      </View>

      {RIGHT_TABS.map((t) => (
        <TabButton key={t.key} t={t} active={active} onChange={onChange} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingTop: 10,
    paddingBottom: Platform.OS === "ios" ? 28 : 12,
    paddingHorizontal: 4,
  },
  tab: { flex: 1, alignItems: "center", gap: 4 },
  iconWrap: { paddingHorizontal: 18, paddingVertical: 5, borderRadius: 14 },
  iconWrapActive: { backgroundColor: colors.greenTint },
  label: { ...T.tiny, color: colors.mute, fontWeight: "600" },
  labelActive: { color: colors.green, fontWeight: "800" },

  centerSlot: { width: 68, alignItems: "center" },
  centerBtn: { marginTop: -30, ...elevation.md },
  centerGradient: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 4,
    borderColor: colors.card,
  },
  centerLabel: { ...T.tiny, color: colors.green, fontWeight: "800", marginTop: 4 },
});
