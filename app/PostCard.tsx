import React from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { ApiPost, mediaUrl } from "./api";
import { timeAgo } from "./format";
import { colors, radius, shadow } from "./theme";
import Icon from "./Icon";
import Avatar from "./Avatar";

type Props = {
  post: ApiPost;
  onLike: (p: ApiPost) => void;
  onComment: (p: ApiPost) => void;
  onDelete?: (p: ApiPost) => void;
  onOpenAuthor?: (authorId: string) => void;
  hideAuthor?: boolean;
};

// A single feed post — author header, text, optional meal card + image, and
// like/comment actions. Shared by the main feed and user profile pages.
export default function PostCard({
  post: p,
  onLike,
  onComment,
  onDelete,
  onOpenAuthor,
  hideAuthor,
}: Props) {
  const img = mediaUrl(p.image);
  return (
    <View style={styles.post}>
      {!hideAuthor && (
        <View style={styles.postHead}>
          <Pressable
            style={styles.authorTap}
            onPress={() => onOpenAuthor?.(p.author_id)}
            hitSlop={6}
          >
            <Avatar value={p.author_avatar} size={40} />
            <View style={{ flex: 1 }}>
              <Text style={styles.postAuthor}>{p.author_name}</Text>
              <Text style={styles.postTime}>{timeAgo(p.created_at)}</Text>
            </View>
          </Pressable>
          {p.mine && onDelete && (
            <Pressable onPress={() => onDelete(p)} hitSlop={8} style={styles.postDel}>
              <Icon name="trash" size={17} color={colors.mute} />
            </Pressable>
          )}
        </View>
      )}

      {hideAuthor && <Text style={styles.postTimeSolo}>{timeAgo(p.created_at)}</Text>}

      {!!p.text && <Text style={styles.postText}>{p.text}</Text>}

      {img && <Image source={{ uri: img }} style={styles.image} resizeMode="cover" />}

      {p.meal && (
        <View style={styles.mealCard}>
          <View style={styles.mealDishRow}>
            <Icon name="meal" size={15} color={colors.green} />
            <Text style={styles.mealDish}>{p.meal.dish}</Text>
          </View>
          <View style={styles.mealMacros}>
            <Text style={styles.mealKcal}>{p.meal.kcal} kcal</Text>
            <Text style={styles.mealChip}>P {Math.round(p.meal.protein_g)}g</Text>
            <Text style={styles.mealChip}>C {Math.round(p.meal.carbs_g)}g</Text>
            <Text style={styles.mealChip}>F {Math.round(p.meal.fat_g)}g</Text>
          </View>
        </View>
      )}

      <View style={styles.actions}>
        <Pressable style={styles.action} onPress={() => onLike(p)} hitSlop={6}>
          <Icon name={p.liked ? "heart" : "heartOutline"} size={19} color={p.liked ? colors.red : colors.mute} />
          <Text style={[styles.actionText, p.liked && styles.actionTextOn]}>{p.likes}</Text>
        </Pressable>
        <Pressable style={styles.action} onPress={() => onComment(p)} hitSlop={6}>
          <Icon name="comment" size={18} color={colors.mute} />
          <Text style={styles.actionText}>{p.comments}</Text>
        </Pressable>
        {hideAuthor && p.mine && onDelete && (
          <Pressable style={styles.actionRight} onPress={() => onDelete(p)} hitSlop={6}>
            <Icon name="trash" size={17} color={colors.mute} />
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  post: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, marginTop: 12, ...shadow.card },
  postHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  authorTap: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  postAvatar: { fontSize: 30 },
  postAuthor: { fontSize: 15, fontWeight: "800", color: colors.ink },
  postTime: { fontSize: 12, color: colors.mute, marginTop: 1 },
  postTimeSolo: { fontSize: 12, color: colors.mute, marginBottom: 2 },
  postDel: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.cardMuted, alignItems: "center", justifyContent: "center" },
  postDelText: { fontSize: 14 },
  postText: { fontSize: 15, color: colors.ink, marginTop: 10, lineHeight: 21 },

  image: { width: "100%", height: 220, borderRadius: radius.md, marginTop: 12, backgroundColor: colors.track },

  mealCard: { backgroundColor: colors.bg, borderRadius: radius.md, padding: 12, marginTop: 10 },
  mealDishRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  mealDish: { fontSize: 14, fontWeight: "800", color: colors.ink },
  mealMacros: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" },
  mealKcal: { fontSize: 13, fontWeight: "900", color: colors.green },
  mealChip: { fontSize: 11, fontWeight: "700", color: colors.mute, backgroundColor: colors.card, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, overflow: "hidden" },

  actions: { flexDirection: "row", gap: 20, marginTop: 14, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 12, alignItems: "center" },
  action: { flexDirection: "row", alignItems: "center", gap: 6 },
  actionRight: { marginLeft: "auto" },
  actionIcon: { fontSize: 16 },
  actionText: { fontSize: 14, fontWeight: "700", color: colors.mute },
  actionTextOn: { color: colors.red },
});
