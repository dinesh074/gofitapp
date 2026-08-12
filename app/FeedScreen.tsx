import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import {
  analyzeImage,
  ApiPost,
  AuthRequiredError,
  createPost,
  deletePost,
  FeedMeal,
  getFeed,
  PaywallError,
  setPostLike,
  uploadPostImage,
} from "./api";
import { Account } from "./auth";
import { LogMap } from "./storage";
import { colors, radius, shadow } from "./theme";
import Icon from "./Icon";
import PostCard from "./PostCard";
import Avatar from "./Avatar";
import PostComments from "./PostComments";

type Props = {
  account: Account | null;
  deviceId: string;
  logs: LogMap;
  onRequireAuth: () => void;
  onOpenAuthor: (authorId: string) => void;
};

// The most recently logged meal across all days — offered as an attachment.
function lastMeal(logs: LogMap): FeedMeal | null {
  let best: { at: number; meal: FeedMeal } | null = null;
  for (const day of Object.values(logs)) {
    for (const m of day.meals) {
      if (!best || m.at > best.at) {
        best = {
          at: m.at,
          meal: {
            dish: m.dish,
            kcal: m.kcal,
            protein_g: Math.round(m.protein_g || 0),
            carbs_g: Math.round(m.carbs_g || 0),
            fat_g: Math.round(m.fat_g || 0),
          },
        };
      }
    }
  }
  return best?.meal ?? null;
}

export default function FeedScreen({
  account,
  deviceId,
  logs,
  onRequireAuth,
  onOpenAuthor,
}: Props) {
  const [posts, setPosts] = useState<ApiPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [text, setText] = useState("");
  const [attach, setAttach] = useState(false);
  const [photo, setPhoto] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commentsFor, setCommentsFor] = useState<number | null>(null);

  // Auto-detected macros from the attached photo (via the food scanner).
  const [analyzing, setAnalyzing] = useState(false);
  const [detected, setDetected] = useState<FeedMeal | null>(null);
  const [useDetected, setUseDetected] = useState(true);
  const [detectNote, setDetectNote] = useState<string | null>(null);

  const meal = useMemo(() => lastMeal(logs), [logs]);

  const load = useCallback(async () => {
    try {
      const data = await getFeed(deviceId || "anon");
      setPosts(data);
      setError(null);
    } catch {
      setError("Couldn't load the feed. Pull to retry.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [deviceId]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  async function pickPhoto() {
    if (!account) return onRequireAuth();
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setError("Permission denied for photos.");
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({ quality: 0.6 });
    if (res.canceled || !res.assets?.length) return;
    const uri = res.assets[0].uri;
    setPhoto(uri);
    runDetect(uri);
  }

  // Reads calories/macros from the attached photo so a post can carry both the
  // image and its detected nutrition. Failures are non-fatal — the user can
  // still post the photo on its own.
  async function runDetect(uri: string) {
    setDetected(null);
    setDetectNote(null);
    setAnalyzing(true);
    try {
      const r = await analyzeImage(uri);
      setDetected({
        dish: r.dish,
        kcal: Math.round(r.totals?.kcal ?? r.calories_kcal ?? 0),
        protein_g: Math.round(r.totals?.protein_g ?? 0),
        carbs_g: Math.round(r.totals?.carbs_g ?? 0),
        fat_g: Math.round(r.totals?.fat_g ?? 0),
      });
      setUseDetected(true);
    } catch (e: any) {
      if (e instanceof PaywallError) {
        setDetectNote("Free scans used — posting the photo without macros.");
      } else if (e instanceof AuthRequiredError) {
        setDetectNote("Sign in to auto-detect macros.");
      } else {
        setDetectNote("Couldn't read macros from this photo.");
      }
    } finally {
      setAnalyzing(false);
    }
  }

  function clearPhoto() {
    setPhoto(null);
    setDetected(null);
    setDetectNote(null);
  }

  async function submit() {
    if (!account) return onRequireAuth();
    const body = text.trim();
    const detectedMeal = useDetected && detected ? detected : null;
    const attachedMeal = attach && meal ? meal : null;
    const mealToPost = detectedMeal ?? attachedMeal;
    if (!body && !mealToPost && !photo) return;
    setPosting(true);
    setError(null);
    try {
      let imageUrl: string | null = null;
      if (photo) imageUrl = await uploadPostImage(photo);
      const post = await createPost({
        text: body,
        meal: mealToPost,
        imageUrl,
      });
      setPosts((prev) => [post, ...prev]);
      setText("");
      setAttach(false);
      clearPhoto();
    } catch (e: any) {
      setError(e?.message || "Couldn't share your post.");
    } finally {
      setPosting(false);
    }
  }

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

  function openComments(p: ApiPost) {
    setCommentsFor(p.id);
  }

  function confirmDelete(p: ApiPost) {
    const doDelete = async () => {
      const prev = posts;
      setPosts((cur) => cur.filter((x) => x.id !== p.id));
      try {
        await deletePost(p.id);
      } catch {
        setPosts(prev);
      }
    };
    if (Platform.OS === "web") {
      doDelete();
    } else {
      Alert.alert("Delete post?", "This can't be undone.", [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: doDelete },
      ]);
    }
  }

  const canPost = !!account;

  return (
    <>
      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
            tintColor={colors.green}
          />
        }
      >
        {/* Composer */}
        <View style={styles.composer}>
          {canPost ? (
            <>
              <View style={styles.composerHead}>
                <Avatar value={account!.avatar} size={30} />
                <Text style={styles.composerName}>{account!.name}</Text>
              </View>
              <TextInput
                style={styles.composerInput}
                value={text}
                onChangeText={setText}
                placeholder="Share a win, a meal, or a tip…"
                placeholderTextColor={colors.mute}
                multiline
                maxLength={500}
              />

              {photo && (
                <View style={styles.previewWrap}>
                  <Image source={{ uri: photo }} style={styles.preview} resizeMode="cover" />
                  <Pressable style={styles.removePhoto} onPress={clearPhoto} hitSlop={6}>
                    <Icon name="close" size={16} color="#fff" />
                  </Pressable>
                </View>
              )}

              {analyzing && (
                <View style={styles.detectRow}>
                  <ActivityIndicator size="small" color={colors.green} />
                  <Text style={styles.detectText}>Reading calories & macros from your photo…</Text>
                </View>
              )}

              {detected && (
                <Pressable
                  style={[styles.detected, useDetected && styles.detectedOn]}
                  onPress={() => setUseDetected((v) => !v)}
                >
                  <Icon name={useDetected ? "check" : "scan"} size={14} color={useDetected ? colors.green : colors.mute} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.detectedTitle, useDetected && styles.detectedTitleOn]} numberOfLines={1}>
                      {detected.dish} · {detected.kcal} kcal
                    </Text>
                    <Text style={styles.detectedMacros}>
                      P {detected.protein_g}g · C {detected.carbs_g}g · F {detected.fat_g}g
                    </Text>
                  </View>
                </Pressable>
              )}

              {detectNote && <Text style={styles.detectNote}>{detectNote}</Text>}

              {meal && !photo && (
                <Pressable
                  style={[styles.attach, attach && styles.attachOn]}
                  onPress={() => setAttach((a) => !a)}
                >
                  <Icon name={attach ? "check" : "meal"} size={14} color={attach ? colors.green : colors.mute} />
                  <Text style={[styles.attachText, attach && styles.attachTextOn]}>
                    {meal.dish} · {meal.kcal} kcal
                  </Text>
                </Pressable>
              )}

              <View style={styles.composerActions}>
                <Pressable style={styles.photoBtn} onPress={pickPhoto}>
                  <Icon name="camera" size={16} color={colors.green} />
                  <Text style={styles.photoBtnText}>Photo</Text>
                </Pressable>
                <Pressable
                  style={[styles.postBtn, posting && styles.postBtnBusy]}
                  onPress={submit}
                  disabled={posting}
                >
                  {posting ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <Text style={styles.postBtnText}>Share</Text>
                  )}
                </Pressable>
              </View>
            </>
          ) : (
            <Pressable style={styles.signInPrompt} onPress={onRequireAuth}>
              <View style={styles.signInIcon}>
                <Icon name="lock" size={20} color={colors.green} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.signInTitle}>Join the conversation</Text>
                <Text style={styles.signInSub}>Sign in to post, like and comment.</Text>
              </View>
              <Icon name="chevronRight" size={18} color={colors.green} />
            </Pressable>
          )}
        </View>

        {error && <Text style={styles.error}>{error}</Text>}

        {loading && (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.green} />
            <Text style={styles.loadingText}>Loading feed…</Text>
          </View>
        )}

        {!loading && posts.length === 0 && (
          <Text style={styles.empty}>No posts yet — be the first to share!</Text>
        )}

        {posts.map((p) => (
          <PostCard
            key={p.id}
            post={p}
            onLike={toggleLike}
            onComment={openComments}
            onDelete={confirmDelete}
            onOpenAuthor={onOpenAuthor}
          />
        ))}
      </ScrollView>

      <PostComments
        visible={commentsFor != null}
        postId={commentsFor}
        canComment={canPost}
        onClose={() => setCommentsFor(null)}
        onRequireAuth={onRequireAuth}
        onCommentAdded={(pid) =>
          setPosts((prev) =>
            prev.map((x) => (x.id === pid ? { ...x, comments: x.comments + 1 } : x))
          )
        }
      />
    </>
  );
}

const styles = StyleSheet.create({
  body: { padding: 16, paddingBottom: 24 },

  composer: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 14, ...shadow.card },
  composerHead: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  composerAvatar: { fontSize: 22 },
  composerName: { fontSize: 14, fontWeight: "800", color: colors.ink },
  composerInput: { minHeight: 44, maxHeight: 120, fontSize: 15, color: colors.ink, textAlignVertical: "top", paddingVertical: 4 },

  previewWrap: { marginTop: 10, position: "relative" },
  preview: { width: "100%", height: 180, borderRadius: radius.md, backgroundColor: colors.track },
  removePhoto: { position: "absolute", top: 8, right: 8, width: 30, height: 30, borderRadius: 15, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center" },
  removePhotoText: { color: "#fff", fontWeight: "800", fontSize: 14 },

  attach: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", backgroundColor: colors.bg, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, marginTop: 8, borderWidth: 1, borderColor: colors.line },
  attachOn: { backgroundColor: colors.greenTint, borderColor: colors.green },
  attachText: { fontSize: 12, fontWeight: "700", color: colors.mute },
  attachTextOn: { color: colors.green },

  detectRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 },
  detectText: { color: colors.mute, fontSize: 12.5, fontWeight: "600" },
  detected: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.bg, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, marginTop: 10, borderWidth: 1, borderColor: colors.line },
  detectedOn: { backgroundColor: colors.greenTint, borderColor: colors.green },
  detectedTitle: { fontSize: 13, fontWeight: "800", color: colors.mute },
  detectedTitleOn: { color: colors.green },
  detectedMacros: { fontSize: 11, fontWeight: "600", color: colors.mute, marginTop: 2 },
  detectNote: { fontSize: 11.5, color: colors.mute, fontWeight: "600", marginTop: 8 },

  composerActions: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 12 },
  photoBtn: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.bg, borderRadius: radius.md, paddingVertical: 12, paddingHorizontal: 16, borderWidth: 1, borderColor: colors.line },
  photoBtnText: { color: colors.ink, fontWeight: "800", fontSize: 14 },
  postBtn: { flex: 1, backgroundColor: colors.green, borderRadius: radius.md, paddingVertical: 12, alignItems: "center" },
  postBtnBusy: { opacity: 0.8 },
  postBtnText: { color: "#fff", fontWeight: "800", fontSize: 15 },

  signInPrompt: { flexDirection: "row", alignItems: "center", gap: 12 },
  signInIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.greenTint, alignItems: "center", justifyContent: "center" },
  signInTitle: { fontSize: 15, fontWeight: "800", color: colors.ink },
  signInSub: { fontSize: 12, color: colors.mute, marginTop: 1 },

  error: { color: colors.red, fontSize: 13, fontWeight: "700", marginTop: 12, textAlign: "center" },
  loadingRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 20, justifyContent: "center" },
  loadingText: { color: colors.mute, fontSize: 13 },
  empty: { color: colors.mute, textAlign: "center", marginTop: 28, fontSize: 14 },
});
