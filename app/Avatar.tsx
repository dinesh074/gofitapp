import React from "react";
import { Image, StyleProp, Text, View, ViewStyle } from "react-native";

// Renders a user avatar that may be EITHER an emoji (e.g. "🫵", the default) or
// a photo URL (Google sign-in returns a `picture` URL). URLs render as a
// circular image; anything else renders as centered emoji/text. This keeps
// avatars working consistently everywhere — leaderboard, feed, profile,
// notifications — regardless of which the account has.
type Props = {
  value?: string | null;
  size?: number;
  style?: StyleProp<ViewStyle>;
};

function isUrl(v: string): boolean {
  return /^https?:\/\//i.test(v);
}

export default function Avatar({ value, size = 32, style }: Props) {
  const v = (value ?? "").trim();
  return (
    <View
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        },
        style,
      ]}
    >
      {isUrl(v) ? (
        <Image source={{ uri: v }} style={{ width: size, height: size }} resizeMode="cover" />
      ) : (
        <Text style={{ fontSize: Math.round(size * 0.62) }}>{v || "🫵"}</Text>
      )}
    </View>
  );
}
