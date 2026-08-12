import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { addComment, ApiComment, getComments } from "./api";
import { colors, radius } from "./theme";
import { timeAgo } from "./format";
import Avatar from "./Avatar";

type Props = {
  visible: boolean;
  postId: number | null;
  canComment: boolean;
  onClose: () => void;
  onCommentAdded: (postId: number) => void;
  onRequireAuth: () => void;
};

export default function PostComments({
  visible,
  postId,
  canComment,
  onClose,
  onCommentAdded,
  onRequireAuth,
}: Props) {
  const [comments, setComments] = useState<ApiComment[]>([]);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible || postId == null) return;
    setComments([]);
    setError(null);
    setLoading(true);
    getComments(postId)
      .then(setComments)
      .catch(() => setError("Couldn't load comments."))
      .finally(() => setLoading(false));
  }, [visible, postId]);

  async function send() {
    if (postId == null) return;
    if (!canComment) return onRequireAuth();
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      const c = await addComment(postId, body);
      setComments((prev) => [...prev, c]);
      setText("");
      onCommentAdded(postId);
    } catch (e: any) {
      setError(e?.message || "Couldn't post your comment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.backdropTap} onPress={onClose} />
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={styles.sheet}>
            <View style={styles.grabber} />
            <View style={styles.head}>
              <Text style={styles.title}>Comments</Text>
              <Pressable style={styles.closeBtn} onPress={onClose} hitSlop={8}>
                <Text style={styles.closeText}>✕</Text>
              </Pressable>
            </View>

            <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 8 }}>
              {loading && <ActivityIndicator color={colors.green} style={{ marginTop: 20 }} />}
              {!loading && comments.length === 0 && (
                <Text style={styles.empty}>No comments yet. Be the first!</Text>
              )}
              {comments.map((c) => (
                <View key={c.id} style={styles.row}>
                  <Avatar value={c.author_avatar} size={28} />
                  <View style={{ flex: 1 }}>
                    <View style={styles.rowTop}>
                      <Text style={styles.author}>{c.author_name}</Text>
                      <Text style={styles.time}>{timeAgo(c.created_at)}</Text>
                    </View>
                    <Text style={styles.body}>{c.text}</Text>
                  </View>
                </View>
              ))}
            </ScrollView>

            {error && <Text style={styles.error}>{error}</Text>}

            <View style={styles.composer}>
              <TextInput
                style={styles.input}
                value={text}
                onChangeText={setText}
                placeholder={canComment ? "Add a comment…" : "Sign in to comment"}
                placeholderTextColor={colors.mute}
                editable={canComment && !busy}
                onFocus={() => !canComment && onRequireAuth()}
                maxLength={300}
              />
              <Pressable
                style={[styles.sendBtn, (!text.trim() || busy) && styles.sendBtnDisabled]}
                onPress={send}
                disabled={busy || !text.trim()}
              >
                {busy ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.sendText}>Post</Text>
                )}
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  backdropTap: { flex: 1 },
  sheet: { backgroundColor: colors.bg, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 16, paddingBottom: 20, maxHeight: "80%" },
  grabber: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: "#CBD5D0", marginTop: 10, marginBottom: 8 },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  title: { fontSize: 18, fontWeight: "900", color: colors.ink },
  closeBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.card, alignItems: "center", justifyContent: "center" },
  closeText: { fontSize: 16, fontWeight: "800", color: colors.ink },

  list: { flexGrow: 0 },
  empty: { color: colors.mute, textAlign: "center", paddingVertical: 28 },
  row: { flexDirection: "row", gap: 10, backgroundColor: colors.card, borderRadius: radius.md, padding: 12, marginBottom: 8 },
  avatar: { fontSize: 24 },
  rowTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  author: { fontSize: 14, fontWeight: "800", color: colors.ink },
  time: { fontSize: 11, color: colors.mute },
  body: { fontSize: 14, color: colors.ink, marginTop: 2, lineHeight: 19 },

  error: { color: colors.red, fontSize: 12, fontWeight: "700", marginBottom: 6, paddingHorizontal: 4 },

  composer: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 6 },
  input: { flex: 1, backgroundColor: colors.card, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12, fontSize: 14, color: colors.ink, borderWidth: 1, borderColor: colors.line },
  sendBtn: { backgroundColor: colors.green, borderRadius: radius.md, paddingHorizontal: 18, paddingVertical: 12, alignItems: "center", justifyContent: "center", minWidth: 64 },
  sendBtnDisabled: { opacity: 0.5 },
  sendText: { color: "#fff", fontWeight: "800", fontSize: 14 },
});
