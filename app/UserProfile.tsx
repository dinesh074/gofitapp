import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  ApiPost,
  ApiUserProfile,
  deletePost,
  getUserProfile,
  setPostLike,
} from "./api";
import { Account } from "./auth";
import { colors, radius, shadow } from "./theme";
import PostCard from "./PostCard";
import PostComments from "./PostComments";

type Props = {
  visible: boolean;
  authorId: string | null;
  account: Account | null;
  deviceId: string;
  onClose: () => void;
  onRequireAuth: () => void;
};

// A read-only profile page for any community member: their stats + their posts.
export default function UserProfile({
  visible,
  authorId,
  account,
  deviceId,
  onClose,
  onRequireAuth,
}: Props) {
  const [profile, setProfile] = useState<ApiUserProfile | null>(null);
  const [posts, setPosts] = useState<ApiPost[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commentsFor, setCommentsFor] = useState<number | null>(null);

  useEffect(() => {
    if (!visible || !authorId) return;
    setProfile(null);
    setPosts([]);
    setError(null);
    setLoading(true);
    getUserProfile(authorId, deviceId || "anon")
      .then((res) => {
        setProfile(res.profile);
        setPosts(res.feed);
      })
      .catch(() => setError("Couldn't load this profile."))
      .finally(() => setLoading(false));
  }, [visible, authorId, deviceId]);

  async function toggleLike(p: ApiPost) {
    if (!account) return onRequireAuth();
    const like = !p.liked;
    setPosts((prev) =>
      prev.map((x) =>
        x.id === p.id ? { ...x, liked: like, likes: x.likes + (like ? 1 : -1) } : x
      )
    );
    try {
      const likes = await setPostLike(p.id, like);
      setPosts((prev) => prev.map((x) => (x.id === p.id ? { ...x, likes } : x)));
    } catch {
      setPosts((prev) =>
        prev.map((x) =>
          x.id === p.id ? { ...x, liked: !like, likes: x.likes + (like ? -1 : 1) } : x
        )
      );
    }
  }

  async function removePost(p: ApiPost) {
    const prev = posts;
    setPosts((cur) => cur.filter((x) => x.id !== p.id));
    try {
      await deletePost(p.id);
    } catch {
      setPosts(prev);
    }
  }

  const initials = (profile?.name || "")
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        <View style={styles.header}>
          <Pressable style={styles.back} onPress={onClose} hitSlop={8}>
            <Text style={styles.backText}>‹ Back</Text>
          </Pressable>
          <View style={styles.avatar}>
            {profile?.avatar && /^https?:\/\//i.test(profile.avatar) ? (
              <Image source={{ uri: profile.avatar }} style={styles.avatarImg} resizeMode="cover" />
            ) : (
              <Text style={styles.avatarEmoji}>{profile?.avatar || initials || "🫵"}</Text>
            )}
          </View>
          <Text style={styles.name}>{profile?.name || "Loading…"}</Text>
          {profile?.isMe && <Text style={styles.meBadge}>This is you</Text>}
          <View style={styles.statRow}>
            <View style={styles.stat}>
              <Text style={styles.statValue}>🔥 {profile?.streak ?? 0}</Text>
              <Text style={styles.statLabel}>Streak</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statValue}>{profile?.posts ?? 0}</Text>
              <Text style={styles.statLabel}>Posts</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statValue}>{profile?.kcal ?? 0}</Text>
              <Text style={styles.statLabel}>kcal today</Text>
            </View>
          </View>
        </View>

        <ScrollView contentContainerStyle={styles.body}>
          {loading && <ActivityIndicator color={colors.green} style={{ marginTop: 24 }} />}
          {error && <Text style={styles.error}>{error}</Text>}
          {!loading && !error && posts.length === 0 && (
            <Text style={styles.empty}>No posts yet.</Text>
          )}
          {posts.map((p) => (
            <PostCard
              key={p.id}
              post={p}
              hideAuthor
              onLike={toggleLike}
              onComment={(x) => setCommentsFor(x.id)}
              onDelete={p.mine ? removePost : undefined}
            />
          ))}
        </ScrollView>
      </View>

      <PostComments
        visible={commentsFor != null}
        postId={commentsFor}
        canComment={!!account}
        onClose={() => setCommentsFor(null)}
        onRequireAuth={onRequireAuth}
        onCommentAdded={(pid) =>
          setPosts((prev) =>
            prev.map((x) => (x.id === pid ? { ...x, comments: x.comments + 1 } : x))
          )
        }
      />
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { backgroundColor: colors.green, paddingTop: 52, paddingBottom: 20, alignItems: "center", paddingHorizontal: 16 },
  back: { position: "absolute", top: 52, left: 12, padding: 8 },
  backText: { color: "#fff", fontSize: 16, fontWeight: "800" },
  avatar: { width: 72, height: 72, borderRadius: 36, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "rgba(255,255,255,0.5)", overflow: "hidden" },
  avatarImg: { width: 72, height: 72 },
  avatarEmoji: { fontSize: 34, color: "#fff", fontWeight: "900" },
  name: { color: "#fff", fontSize: 22, fontWeight: "900", marginTop: 12 },
  meBadge: { color: "#CDEBD9", fontSize: 12, fontWeight: "700", marginTop: 2 },
  statRow: { flexDirection: "row", gap: 10, marginTop: 16, alignSelf: "stretch" },
  stat: { flex: 1, backgroundColor: "rgba(255,255,255,0.14)", borderRadius: radius.md, paddingVertical: 12, alignItems: "center" },
  statValue: { color: "#fff", fontSize: 17, fontWeight: "900" },
  statLabel: { color: "#CDEBD9", fontSize: 11, marginTop: 2 },

  body: { padding: 16, paddingBottom: 32 },
  error: { color: colors.red, fontSize: 13, fontWeight: "700", textAlign: "center", marginTop: 24 },
  empty: { color: colors.mute, textAlign: "center", marginTop: 28, fontSize: 14 },
});
