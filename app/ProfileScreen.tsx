import React, { useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { APP_NAME } from "./config";
import {
  ACTIVITY_LABELS,
  BMI_CATEGORY_LABEL,
  computeBmi,
  Diet,
  Gender,
  Goal,
  GoalPace,
  GoalTargets,
  Profile,
  resolveGoalPace,
} from "./nutrition";
import { Account } from "./auth";
import { bestStreak, LogMap } from "./storage";
import { colors, radius, shadow, gradients } from "./theme";
import { LinearGradient } from "expo-linear-gradient";
import Icon, { IconName } from "./Icon";
import Avatar from "./Avatar";
import Feedback from "./Feedback";
import { openLegal, privacyUrl, termsUrl, downloadUrl } from "./legalLinks";

type Props = {
  profile: Profile;
  goal: GoalTargets;
  logs: LogMap;
  account: Account | null;
  // Server-computed when available (durable, not capped by the 30-day
  // log-retention window); bestStreak is null until that fetch resolves, in
  // which case we fall back to the local logs-derived value.
  streak: number;
  bestStreak: number | null;
  onEditProfile: () => void;
  onOpenCommunity: () => void;
  onOpenSubscription: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
  onRequireAuth: () => void;
};

const GOAL_LABEL: Record<Goal, string> = {
  lose: "Losing weight",
  maintain: "Maintaining weight",
  gain: "Gaining weight",
};
const GENDER_LABEL: Record<Gender, string> = {
  male: "Male",
  female: "Female",
  other: "Other",
};
const PACE_LABEL: Record<GoalPace, string> = {
  relaxed: "Relaxed",
  recommended: "Recommended",
  ambitious: "Ambitious",
};
const DIET_LABEL: Record<Diet, string> = {
  veg: "Vegetarian",
  nonveg: "Non-vegetarian",
  eggetarian: "Eggetarian",
  vegan: "Vegan",
  jain: "Jain",
  sattvic: "Sattvic",
};

export default function ProfileScreen({
  profile,
  goal,
  logs,
  account,
  streak,
  bestStreak: serverBestStreak,
  onEditProfile,
  onOpenCommunity,
  onOpenSubscription,
  onSignIn,
  onSignOut,
  onRequireAuth,
}: Props) {
  const [showFeedback, setShowFeedback] = useState(false);
  const bmi = useMemo(() => computeBmi(profile.heightCm, profile.weightKg), [profile.heightCm, profile.weightKg]);
  const localBest = useMemo(() => bestStreak(logs), [logs]);
  const best = serverBestStreak ?? localBest;
  const totalMeals = Object.values(logs).reduce((s, d) => s + d.meals.length, 0);
  const name = profile.name?.trim() || "You";
  const initials = name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <View style={styles.root}>
      <LinearGradient colors={gradients.brand} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.header}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials}</Text>
        </View>
        <Text style={styles.name}>{name}</Text>
        <Text style={styles.sub}>{GOAL_LABEL[profile.goal]}</Text>
      </LinearGradient>

      <ScrollView contentContainerStyle={styles.body}>
        {/* Quick stats */}
        <View style={styles.statRow}>
          <Stat value={`${streak}`} label="Streak" />
          <Stat value={`${best}`} label="Best" />
          <Stat value={`${totalMeals}`} label="Meals" />
        </View>

        {/* Goal card */}
        <View style={styles.goalCard}>
          <Text style={styles.goalLabel}>DAILY TARGET</Text>
          <View style={styles.goalTop}>
            <Text style={styles.goalKcal}>{goal.kcal}</Text>
            <Text style={styles.goalUnit}>kcal</Text>
          </View>
          <View style={styles.macroRow}>
            <Pill label="Protein" value={`${goal.protein_g}g`} />
            <Pill label="Carbs" value={`${goal.carbs_g}g`} />
            <Pill label="Fat" value={`${goal.fat_g}g`} />
          </View>
        </View>

        {/* Account */}
        <Text style={styles.section}>Account</Text>
        {account ? (
          <View style={styles.card}>
            <View style={styles.acctRow}>
              <Avatar value={account.avatar} size={40} style={{ marginRight: 2 }} />
              <View style={{ flex: 1 }}>
                <Text style={styles.acctName}>{account.name}</Text>
                <Text style={styles.acctHandle}>@{account.username}</Text>
              </View>
              <View style={styles.acctBadge}>
                <Icon name="check" size={13} color={colors.green} />
                <Text style={styles.acctBadgeText}>Synced</Text>
              </View>
            </View>
            <Text style={styles.planMeta}>
              {account.isPro ? "Pro active - billed monthly (30-day cycle)." : "Free plan - upgrade to Pro for unlimited scans."}
            </Text>
            <Pressable style={styles.signOutBtn} onPress={onSignOut}>
              <Text style={styles.signOutText}>Sign out</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable style={styles.signInCard} onPress={onSignIn}>
            <View style={styles.signInIcon}>
              <Icon name="user" size={22} color={colors.green} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.signInTitle}>Sign in or create an account</Text>
              <Text style={styles.signInSub}>
                Keep your streak & identity across devices, and post to the community.
              </Text>
            </View>
            <Icon name="chevronRight" size={18} color={colors.faint} />
          </Pressable>
        )}

        {/* Details */}
        <Text style={styles.section}>Your details</Text>
        <View style={styles.card}>
          <Row label="Gender" value={GENDER_LABEL[profile.gender]} />
          <Row label="Age" value={`${profile.age} yrs`} />
          <Row label="Height" value={`${profile.heightCm} cm`} />
          <Row label="Current weight" value={`${profile.weightKg} kg`} />
          <Row label="Target weight" value={`${profile.targetWeightKg} kg`} />
          {profile.goal !== "maintain" && (
            <Row label="Goal pace" value={PACE_LABEL[resolveGoalPace(profile)]} />
          )}
          <Row label="Activity" value={ACTIVITY_LABELS[profile.activity]} />
          <Row label="Diet" value={DIET_LABEL[profile.diet]} last />
        </View>

        {/* Body metrics */}
        <Text style={styles.section}>Metabolism</Text>
        <View style={styles.card}>
          <Row label="BMR (at rest)" value={`${goal.bmr} kcal`} />
          <Row label="Maintenance (TDEE)" value={`${goal.tdee} kcal`} last={!bmi} />
          {bmi && (
            <Row
              label="BMI"
              value={`${bmi.value} · ${BMI_CATEGORY_LABEL[bmi.category]}`}
              last
            />
          )}
        </View>

        {/* Actions */}
        <Text style={styles.section}>Settings</Text>
        <View style={styles.card}>
          <MenuItem icon="star" label="Subscription & Pro" onPress={onOpenSubscription} />
          <MenuItem icon="group" label="Community" onPress={onOpenCommunity} />
          <MenuItem icon="settings" label="Edit profile, settings & data" onPress={onEditProfile} last={Platform.OS !== "web"} />
          {Platform.OS === "web" && (
            <MenuItem icon="download" label="Get the Android app" onPress={() => void openLegal(downloadUrl())} last />
          )}
        </View>

        <Text style={styles.section}>Help us improve</Text>
        <View style={styles.card}>
          <MenuItem
            icon="comment"
            label="Send feedback or a feature idea"
            onPress={() => (account ? setShowFeedback(true) : onSignIn())}
            last
          />
        </View>

        <Text style={styles.section}>Legal</Text>
        <View style={styles.card}>
          <MenuItem icon="info" label="Privacy Policy" onPress={() => void openLegal(privacyUrl())} />
          <MenuItem icon="edit" label="Terms of Service" onPress={() => void openLegal(termsUrl())} last />
        </View>

        <Text style={styles.foot}>{APP_NAME} · v1.0.0</Text>
        <Text style={styles.disclaimer}>
          Estimates are for guidance only and are not medical advice.
        </Text>
      </ScrollView>

      {showFeedback && (
        <Feedback
          visible={showFeedback}
          onClose={() => setShowFeedback(false)}
          onRequireAuth={() => {
            setShowFeedback(false);
            onRequireAuth();
          }}
        />
      )}
    </View>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function Pill({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.pill}>
      <Text style={styles.pillVal}>{value}</Text>
      <Text style={styles.pillKey}>{label}</Text>
    </View>
  );
}

function Row({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <View style={[styles.row, !last && styles.rowDivider]}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function MenuItem({ icon, label, onPress, last }: { icon: IconName; label: string; onPress: () => void; last?: boolean }) {
  return (
    <Pressable style={[styles.menu, !last && styles.rowDivider]} onPress={onPress}>
      <View style={styles.menuIconWrap}>
        <Icon name={icon} size={18} color={colors.green} />
      </View>
      <Text style={styles.menuLabel}>{label}</Text>
      <Icon name="chevronRight" size={18} color={colors.faint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { paddingTop: 16, paddingBottom: 12, alignItems: "center", borderBottomLeftRadius: 24, borderBottomRightRadius: 24 },
  avatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "rgba(255,255,255,0.5)" },
  avatarText: { color: "#fff", fontSize: 19, fontWeight: "900" },
  name: { color: "#fff", fontSize: 18, fontWeight: "800", marginTop: 6 },
  sub: { color: "#CDEBD9", fontSize: 12.5, marginTop: 2 },
  body: { padding: 16, paddingBottom: 24 },

  statRow: { flexDirection: "row", gap: 10, marginTop: -16, marginBottom: 8 },
  stat: { flex: 1, backgroundColor: colors.card, borderRadius: radius.md, paddingVertical: 16, alignItems: "center", ...shadow.card },
  statValue: { fontSize: 22, fontWeight: "900", color: colors.ink },
  statLabel: { fontSize: 11, color: colors.mute, marginTop: 2 },

  goalCard: { backgroundColor: colors.green, borderRadius: radius.xl, padding: 20, marginTop: 12, alignItems: "center" },
  goalLabel: { color: "#9FD6BA", fontSize: 11, fontWeight: "700", letterSpacing: 1 },
  goalTop: { flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: 4 },
  goalKcal: { color: "#fff", fontSize: 46, fontWeight: "900" },
  goalUnit: { color: "#CDEBD9", fontSize: 15, fontWeight: "700" },
  macroRow: { flexDirection: "row", gap: 10, marginTop: 16, alignSelf: "stretch" },
  pill: { flex: 1, backgroundColor: "rgba(255,255,255,0.14)", borderRadius: 12, paddingVertical: 10, alignItems: "center" },
  pillVal: { color: "#fff", fontSize: 16, fontWeight: "800" },
  pillKey: { color: "#CDEBD9", fontSize: 11, marginTop: 2 },

  section: { fontSize: 13, fontWeight: "800", color: colors.mute, letterSpacing: 0.5, textTransform: "uppercase", marginTop: 20, marginBottom: 10 },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, paddingHorizontal: 16, ...shadow.card },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 14 },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.line },
  rowLabel: { color: colors.mute, fontSize: 14 },
  rowValue: { color: colors.ink, fontSize: 14, fontWeight: "700", flexShrink: 1, textAlign: "right", marginLeft: 12 },

  menu: { flexDirection: "row", alignItems: "center", paddingVertical: 14, gap: 12 },
  menuIconWrap: { width: 38, height: 38, borderRadius: 12, backgroundColor: colors.greenTint, alignItems: "center", justifyContent: "center" },
  menuLabel: { flex: 1, fontSize: 15, fontWeight: "700", color: colors.ink },

  acctRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.line },
  acctAvatar: { fontSize: 34 },
  acctName: { fontSize: 16, fontWeight: "800", color: colors.ink },
  acctHandle: { fontSize: 13, color: colors.mute, marginTop: 1 },
  acctBadge: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: colors.greenTint, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 5 },
  acctBadgeText: { color: colors.green, fontWeight: "800", fontSize: 12 },
  planMeta: { color: colors.mute, fontSize: 12, fontWeight: "600", paddingTop: 10 },
  signOutBtn: { paddingVertical: 15, alignItems: "center" },
  signOutText: { color: colors.red, fontWeight: "800", fontSize: 15 },

  signInCard: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, ...shadow.card },
  signInIcon: { width: 46, height: 46, borderRadius: 23, backgroundColor: colors.greenTint, alignItems: "center", justifyContent: "center" },
  signInTitle: { fontSize: 15, fontWeight: "800", color: colors.ink },
  signInSub: { fontSize: 12, color: colors.mute, marginTop: 2, lineHeight: 16 },

  foot: { textAlign: "center", color: colors.mute, fontSize: 12, marginTop: 24, fontWeight: "700" },
  disclaimer: { textAlign: "center", color: colors.mute, fontSize: 11, marginTop: 6, lineHeight: 16 },
});
