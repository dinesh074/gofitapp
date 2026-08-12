import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { ApiNotification, getNotifications, markNotificationsRead } from "./api";
import { timeAgo } from "./format";
import Avatar from "./Avatar";
import { colors, radius } from "./theme";
import Icon from "./Icon";

type Props = {
  visible: boolean;
  onClose: () => void;
  onRead: () => void; // parent clears the unread badge
  onOpenActor: (actorId: string) => void;
};

export default function Notifications({ visible, onClose, onRead, onOpenActor }: Props) {
  const [items, setItems] = useState<ApiNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    setError(null);
    getNotifications()
      .then((res) => setItems(res.notifications))
      .catch(() => setError("Couldn't load notifications."))
      .finally(() => setLoading(false));
    // Opening the panel marks everything as read.
    markNotificationsRead()
      .then(onRead)
      .catch(() => {
        /* non-fatal */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  function line(n: ApiNotification): string {
    if (n.kind === "like") return "liked your post";
    return n.preview ? `commented: "${n.preview}"` : "commented on your post";
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.backdropTap} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.grabber} />
          <View style={styles.head}>
            <Text style={styles.title}>Notifications</Text>
            <Pressable style={styles.closeBtn} onPress={onClose} hitSlop={8}>
              <Icon name="close" size={18} color={colors.mute} />
            </Pressable>
          </View>

          <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 12 }}>
            {loading && <ActivityIndicator color={colors.green} style={{ marginTop: 20 }} />}
            {error && <Text style={styles.error}>{error}</Text>}
            {!loading && !error && items.length === 0 && (
              <Text style={styles.empty}>No notifications yet.{"\n"}Likes & comments will show up here.</Text>
            )}
            {items.map((n) => (
              <Pressable
                key={n.id}
                style={[styles.row, !n.read && styles.rowUnread]}
                onPress={() => onOpenActor(n.actor_id)}
              >
                <Avatar value={n.actor_avatar} size={38} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.text}>
                    <Text style={styles.actor}>{n.actor_name}</Text> {line(n)}
                  </Text>
                  <Text style={styles.time}>{timeAgo(n.created_at)}</Text>
                </View>
                <Icon name={n.kind === "like" ? "heart" : "comment"} size={17} color={n.kind === "like" ? colors.red : colors.protein} />
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  backdropTap: { flex: 1 },
  sheet: { backgroundColor: colors.bg, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 16, paddingBottom: 24, maxHeight: "80%" },
  grabber: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: "#CBD5D0", marginTop: 10, marginBottom: 8 },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  title: { fontSize: 20, fontWeight: "900", color: colors.ink },
  closeBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.card, alignItems: "center", justifyContent: "center" },
  closeText: { fontSize: 16, fontWeight: "800", color: colors.ink },

  list: { flexGrow: 0 },
  empty: { color: colors.mute, textAlign: "center", paddingVertical: 32, lineHeight: 20 },
  error: { color: colors.red, textAlign: "center", paddingVertical: 20, fontWeight: "700" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.card, borderRadius: radius.md, padding: 14, marginBottom: 8 },
  rowUnread: { backgroundColor: colors.greenTint2, borderWidth: 1, borderColor: colors.greenTint },
  avatar: { fontSize: 26 },
  text: { fontSize: 14, color: colors.ink, lineHeight: 19 },
  actor: { fontWeight: "800" },
  time: { fontSize: 12, color: colors.mute, marginTop: 2 },
  kindIcon: { fontSize: 16 },
});
