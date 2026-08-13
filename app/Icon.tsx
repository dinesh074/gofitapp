import React from "react";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "./theme";

// Curated icon set — semantic names map to Ionicons glyphs so screens never
// hard-code emoji. Swapping an icon in one place updates the whole app.
export const ICONS = {
  home: "home",
  homeOutline: "home-outline",
  progress: "stats-chart",
  progressOutline: "stats-chart-outline",
  community: "people",
  communityOutline: "people-outline",
  profile: "person",
  profileOutline: "person-outline",
  camera: "camera",
  gallery: "images-outline",
  scan: "scan-outline",
  flame: "flame",
  share: "share-social-outline",
  bell: "notifications-outline",
  bellActive: "notifications",
  heart: "heart",
  heartOutline: "heart-outline",
  comment: "chatbubble-outline",
  trash: "trash-outline",
  close: "close",
  chevronRight: "chevron-forward",
  chevronLeft: "chevron-back",
  chevronUp: "chevron-up",
  chevronDown: "chevron-down",
  eye: "eye-outline",
  eyeOff: "eye-off-outline",
  playCircle: "play-circle-outline",
  settings: "settings-outline",
  logout: "log-out-outline",
  check: "checkmark-circle",
  checkOutline: "checkmark-circle-outline",
  plus: "add",
  minus: "remove",
  star: "star",
  starOutline: "star-outline",
  search: "search",
  swap: "swap-horizontal",
  time: "time-outline",
  trophy: "trophy-outline",
  target: "flag-outline",
  edit: "create-outline",
  photo: "image-outline",
  send: "send",
  lock: "lock-closed-outline",
  user: "person-circle-outline",
  group: "people-circle-outline",
  info: "information-circle-outline",
  warning: "alert-circle-outline",
  meal: "restaurant-outline",
  protein: "egg-outline",
  carbs: "leaf-outline",
  fat: "water-outline",
  mic: "mic-outline",
  micActive: "mic",
  barcode: "barcode-outline",
  water: "water",
  walk: "walk-outline",
  dumbbell: "barbell-outline",
  scale: "scale-outline",
  sparkles: "sparkles-outline",
  bicycle: "bicycle-outline",
  moon: "moon-outline",
  music: "musical-notes-outline",
  nutrition: "nutrition-outline",
  pulse: "pulse-outline",
  refresh: "refresh",
} as const;

export type IconName = keyof typeof ICONS;

type Props = {
  name: IconName;
  size?: number;
  color?: string;
  style?: any;
};

export default function Icon({ name, size = 22, color = colors.ink, style }: Props) {
  return <Ionicons name={ICONS[name] as any} size={size} color={color} style={style} />;
}
