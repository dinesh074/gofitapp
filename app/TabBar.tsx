import React from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, type as T } from "./theme";
import Icon, { IconName } from "./Icon";

export type TabKey = "home" | "progress" | "community" | "profile";

const TABS: { key: TabKey; icon: IconName; iconOff: IconName; label: string }[] = [
  { key: "home", icon: "home", iconOff: "homeOutline", label: "Home" },
  { key: "progress", icon: "progress", iconOff: "progressOutline", label: "Progress" },
  { key: "community", icon: "community", iconOff: "communityOutline", label: "Community" },
  { key: "profile", icon: "profile", iconOff: "profileOutline", label: "Profile" },
];

type Props = { active: TabKey; onChange: (t: TabKey) => void };

export default function TabBar({ active, onChange }: Props) {
  return (
    <View style={styles.bar}>
      {TABS.map((t) => {
        const on = t.key === active;
        return (
          <Pressable key={t.key} style={styles.tab} onPress={() => onChange(t.key)} hitSlop={6}>
            <View style={[styles.iconWrap, on && styles.iconWrapActive]}>
              <Icon name={on ? t.icon : t.iconOff} size={22} color={on ? colors.green : colors.mute} />
            </View>
            <Text style={[styles.label, on && styles.labelActive]}>{t.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingTop: 10,
    paddingBottom: Platform.OS === "ios" ? 28 : 12,
    paddingHorizontal: 8,
  },
  tab: { flex: 1, alignItems: "center", gap: 4 },
  iconWrap: { paddingHorizontal: 18, paddingVertical: 5, borderRadius: 14 },
  iconWrapActive: { backgroundColor: colors.greenTint },
  label: { ...T.tiny, color: colors.mute, fontWeight: "600" },
  labelActive: { color: colors.green, fontWeight: "800" },
});
