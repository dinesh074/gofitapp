import React, { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { colors, elevation, radius } from "./theme";
import Icon from "./Icon";
import { HOME_MODULES, HomeModuleKey, moduleMeta } from "./homeModules";

type Props = {
  visible: boolean;
  order: HomeModuleKey[];
  hidden: Set<HomeModuleKey>;
  onClose: () => void;
  // Persist the new arrangement (parent handles the PUT + optimistic state).
  onSave: (order: HomeModuleKey[], hidden: HomeModuleKey[]) => Promise<void> | void;
};

// Lets the user reorder (up/down) and show/hide the Home dashboard modules. Kept
// to simple arrow controls rather than drag-and-drop so it behaves identically
// on web and native (no gesture-handler dependency, no platform quirks).
export default function CustomizeHomeSheet({ visible, order, hidden, onClose, onSave }: Props) {
  const [ord, setOrd] = useState<HomeModuleKey[]>(order);
  const [hid, setHid] = useState<Set<HomeModuleKey>>(new Set(hidden));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (visible) {
      setOrd(order);
      setHid(new Set(hidden));
    }
  }, [visible, order, hidden]);

  function move(index: number, dir: -1 | 1) {
    const to = index + dir;
    if (to < 0 || to >= ord.length) return;
    const next = [...ord];
    const [item] = next.splice(index, 1);
    next.splice(to, 0, item);
    setOrd(next);
  }

  function toggle(key: HomeModuleKey) {
    const meta = moduleMeta(key);
    if (meta?.lockedVisible) return; // can't hide the calorie summary
    const next = new Set(hid);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setHid(next);
  }

  async function save() {
    setBusy(true);
    try {
      await onSave(ord, [...hid]);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  if (!visible) return null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.backdropTap} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.grabber} />
          <Text style={styles.title}>Customize dashboard</Text>
          <Text style={styles.sub}>Reorder with the arrows, tap the eye to show or hide. Saved to your account.</Text>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 4 }}>
            {ord.map((key, i) => {
              const meta = moduleMeta(key);
              if (!meta) return null;
              const isHidden = hid.has(key);
              return (
                <View key={key} style={[styles.row, isHidden && styles.rowHidden]}>
                  <View style={styles.rowIcon}>
                    <Icon name={meta.icon} size={18} color={colors.green} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowTitle}>{meta.label}</Text>
                    <Text style={styles.rowSub} numberOfLines={1}>{meta.desc}</Text>
                  </View>

                  <Pressable
                    style={styles.iconBtn}
                    onPress={() => toggle(key)}
                    disabled={meta.lockedVisible}
                    hitSlop={6}
                  >
                    <Icon
                      name={isHidden ? "eyeOff" : "eye"}
                      size={20}
                      color={meta.lockedVisible ? colors.faint : isHidden ? colors.mute : colors.green}
                    />
                  </Pressable>
                  <View style={styles.moveCol}>
                    <Pressable
                      style={styles.moveBtn}
                      onPress={() => move(i, -1)}
                      disabled={i === 0}
                      hitSlop={4}
                    >
                      <Icon name="chevronUp" size={18} color={i === 0 ? colors.faint : colors.ink} />
                    </Pressable>
                    <Pressable
                      style={styles.moveBtn}
                      onPress={() => move(i, 1)}
                      disabled={i === ord.length - 1}
                      hitSlop={4}
                    >
                      <Icon name="chevronDown" size={18} color={i === ord.length - 1 ? colors.faint : colors.ink} />
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </ScrollView>

          <Pressable style={styles.saveBtn} onPress={save} disabled={busy}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>Save layout</Text>}
          </Pressable>
          <Pressable style={styles.cancel} onPress={onClose}>
            <Text style={styles.cancelText}>Cancel</Text>
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
  grabber: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: "#CBD5D0", marginTop: 10, marginBottom: 14 },
  title: { fontSize: 22, fontWeight: "900", color: colors.ink, letterSpacing: -0.3 },
  sub: { fontSize: 13, color: colors.mute, marginTop: 4, marginBottom: 14, lineHeight: 18 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 12,
    marginBottom: 10,
    ...elevation.sm,
  },
  rowHidden: { opacity: 0.55 },
  rowIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.greenTint,
    alignItems: "center",
    justifyContent: "center",
  },
  rowTitle: { color: colors.ink, fontWeight: "800", fontSize: 14.5 },
  rowSub: { color: colors.mute, fontWeight: "600", fontSize: 12, marginTop: 1 },
  iconBtn: { padding: 6 },
  moveCol: { flexDirection: "row", gap: 2 },
  moveBtn: { width: 34, height: 34, borderRadius: 10, backgroundColor: colors.greenTint, alignItems: "center", justifyContent: "center" },
  saveBtn: { backgroundColor: colors.green, borderRadius: radius.md, paddingVertical: 15, alignItems: "center", marginTop: 12, ...elevation.sm },
  saveText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  cancel: { alignItems: "center", paddingVertical: 12, marginTop: 2 },
  cancelText: { color: colors.mute, fontWeight: "700", fontSize: 14 },
});
