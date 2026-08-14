import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Profile } from "./nutrition";
import { Account } from "./auth";
import {
  ApiChallenge,
  ApiGroup,
  ApiLeader,
  getChallenges,
  getGroups,
  getLeaderboard,
  getNotifications,
  setGroupMembership,
  syncStats,
} from "./api";
import {
  computeStreak,
  dayTotal,
  getDeviceId,
  loadJoinedGroups,
  LogMap,
  saveJoinedGroups,
} from "./storage";
import { colors, radius, shadow, gradients } from "./theme";
import { LinearGradient } from "expo-linear-gradient";
import Icon from "./Icon";
import Avatar from "./Avatar";
import FeedScreen from "./FeedScreen";
import Notifications from "./Notifications";
import UserProfile from "./UserProfile";

type Props = {
  profile: Profile;
  logs: LogMap;
  account: Account | null;
  // Server-computed current streak (durable, cross-device) when available;
  // falls back to the local logs-derived value if not yet loaded.
  streak?: number;
  onRequireAuth: () => void;
};

// Local fallback data used when the backend is unreachable.
const FALLBACK_GROUPS: ApiGroup[] = [
  { id: "veg-warriors", emoji: "🥗", name: "Veg Warriors", desc: "Plant-forward Indian eating", members: 4820, joined: false },
  { id: "highprotein", emoji: "💪", name: "High-Protein India", desc: "Hit your protein with desi food", members: 3110, joined: false },
  { id: "weightloss", emoji: "🔥", name: "Fat-Loss Journey", desc: "Sustainable deficits, together", members: 9740, joined: false },
  { id: "diabetes", emoji: "🩺", name: "Sugar-Smart", desc: "Low-GI meals & tips", members: 2560, joined: false },
  { id: "southindian", emoji: "🍛", name: "South Indian Foodies", desc: "Idli, dosa, sambar & macros", members: 5230, joined: false },
];
const FALLBACK_PEERS: ApiLeader[] = [
  { device_id: "p1", name: "Ananya", streak: 21, kcal: 1720, avatar: "🦋", isMe: false },
  { device_id: "p2", name: "Rohit", streak: 14, kcal: 1980, avatar: "🐯", isMe: false },
  { device_id: "p3", name: "Meera", streak: 9, kcal: 1650, avatar: "🌸", isMe: false },
  { device_id: "p4", name: "Karan", streak: 7, kcal: 2210, avatar: "⚡", isMe: false },
  { device_id: "p5", name: "Divya", streak: 5, kcal: 1440, avatar: "🌼", isMe: false },
];
const FALLBACK_CHALLENGES: ApiChallenge[] = [
  { id: "c1", emoji: "📸", title: "7-Day Log Streak", desc: "Log at least 1 meal daily", progress: 0.57, daysLeft: 3 },
  { id: "c2", emoji: "🥑", title: "Protein Push", desc: "Hit protein goal 5 days", progress: 0.4, daysLeft: 6 },
  { id: "c3", emoji: "🚫", title: "No-Fried Fortnight", desc: "Skip deep-fried for 14 days", progress: 0.25, daysLeft: 10 },
];

export default function CommunityScreen({ profile, logs, account, streak, onRequireAuth }: Props) {
  const [view, setView] = useState<"feed" | "ranks">("feed");
  const [groups, setGroups] = useState<ApiGroup[]>(FALLBACK_GROUPS);
  const [board, setBoard] = useState<ApiLeader[]>(FALLBACK_PEERS);
  const [challenges, setChallenges] = useState<ApiChallenge[]>(FALLBACK_CHALLENGES);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [deviceId, setDeviceId] = useState<string>("");
  const [unread, setUnread] = useState(0);
  const [showNotifs, setShowNotifs] = useState(false);
  const [openAuthor, setOpenAuthor] = useState<string | null>(null);

  const myStreak = useMemo(() => streak ?? computeStreak(logs), [streak, logs]);
  const myKcal = dayTotal(logs);
  const myName = account?.name?.trim() || profile.name?.trim() || "You";
  const myAvatar = account?.avatar || "🫵";

  // A signed-in account owns a stable identity ("acct-<id>"); otherwise fall
  // back to the per-device id so anonymous users still get a leaderboard slot.
  const identity = account?.communityId || deviceId;

  async function refresh(id: string) {
    setLoading(true);
    try {
      // Push my latest stats first so the leaderboard reflects them.
      await syncStats({ device_id: id, name: myName, kcal: myKcal, streak: myStreak, avatar: myAvatar });
      const [g, lb, ch] = await Promise.all([
        getGroups(id),
        getLeaderboard(id),
        getChallenges(),
      ]);
      setGroups(g);
      setBoard(lb.sort((a, b) => b.streak - a.streak || a.kcal - b.kcal));
      setChallenges(ch);
      setOffline(false);
    } catch {
      // Backend unreachable — fall back to local mock + locally-joined groups.
      const joinedIds = await loadJoinedGroups();
      const me: ApiLeader = { device_id: "me", name: myName, streak: myStreak, kcal: myKcal, avatar: myAvatar, isMe: true };
      setGroups(FALLBACK_GROUPS.map((g) => ({ ...g, joined: joinedIds.includes(g.id) })));
      setBoard([...FALLBACK_PEERS, me].sort((a, b) => b.streak - a.streak || a.kcal - b.kcal));
      setChallenges(FALLBACK_CHALLENGES);
      setOffline(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let alive = true;
    getDeviceId().then((id) => {
      if (!alive) return;
      setDeviceId(id);
      refresh(account?.communityId || id);
    });
    return () => {
      alive = false;
    };
    // Re-sync when the signed-in account changes (login / logout).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.communityId]);

  // Poll the unread notification count for signed-in users.
  useEffect(() => {
    if (!account) {
      setUnread(0);
      return;
    }
    let alive = true;
    const tick = () =>
      getNotifications()
        .then((res) => alive && setUnread(res.unread))
        .catch(() => {});
    tick();
    const iv = setInterval(tick, 30000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [account?.communityId]);

  async function toggle(g: ApiGroup) {
    const join = !g.joined;
    // optimistic update
    setGroups((prev) =>
      prev.map((x) =>
        x.id === g.id ? { ...x, joined: join, members: x.members + (join ? 1 : -1) } : x
      )
    );
    try {
      if (offline || !identity) throw new Error("offline");
      await setGroupMembership(g.id, identity, join);
    } catch {
      // persist locally when backend isn't available
      const ids = await loadJoinedGroups();
      const next = join ? [...new Set([...ids, g.id])] : ids.filter((x) => x !== g.id);
      saveJoinedGroups(next);
    }
  }

  return (
    <View style={styles.root}>
      <LinearGradient colors={gradients.brand} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.header}>
        <View style={styles.hTop}>
          <Text style={styles.hTitle}>Community</Text>
          {account && (
            <Pressable style={styles.bell} onPress={() => setShowNotifs(true)} hitSlop={8}>
              <Icon name="bell" size={20} color="#fff" />
              {unread > 0 && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{unread > 9 ? "9+" : unread}</Text>
                </View>
              )}
            </Pressable>
          )}
        </View>
        <Text style={styles.hSub}>
          {view === "feed"
            ? account
              ? `Posting as ${account.name}`
              : "See what everyone's eating"
            : offline
            ? "Offline · showing sample data"
            : "Stay accountable with people like you"}
        </Text>
        <View style={styles.seg}>
          <Pressable
            style={[styles.segBtn, view === "feed" && styles.segActive]}
            onPress={() => setView("feed")}
          >
            <Text style={[styles.segText, view === "feed" && styles.segTextActive]}>Feed</Text>
          </Pressable>
          <Pressable
            style={[styles.segBtn, view === "ranks" && styles.segActive]}
            onPress={() => setView("ranks")}
          >
            <Text style={[styles.segText, view === "ranks" && styles.segTextActive]}>
              Groups & Ranks
            </Text>
          </Pressable>
        </View>
      </LinearGradient>

      {view === "feed" ? (
        <FeedScreen
          account={account}
          deviceId={identity}
          logs={logs}
          onRequireAuth={onRequireAuth}
          onOpenAuthor={setOpenAuthor}
        />
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          {loading && (
            <View style={styles.loadingRow}>
              <ActivityIndicator color={colors.green} />
              <Text style={styles.loadingText}>Syncing community…</Text>
            </View>
          )}

        {/* Challenges */}
        <Text style={styles.section}>Active challenges</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.challengeRow}>
          {challenges.map((c) => (
            <View key={c.id} style={styles.challengeCard}>
              <Text style={styles.challengeEmoji}>{c.emoji}</Text>
              <Text style={styles.challengeTitle}>{c.title}</Text>
              <Text style={styles.challengeDesc}>{c.desc}</Text>
              <View style={styles.cTrack}>
                <View style={[styles.cFill, { width: `${Math.round(c.progress * 100)}%` }]} />
              </View>
              <Text style={styles.challengeMeta}>
                {Math.round(c.progress * 100)}% · {c.daysLeft}d left
              </Text>
            </View>
          ))}
        </ScrollView>

        {/* Leaderboard */}
        <Text style={styles.section}>Weekly leaderboard</Text>
        <View style={styles.card}>
          {board.map((p, i) => (
            <Pressable
              key={p.device_id + i}
              style={[styles.boardRow, i < board.length - 1 && styles.boardDivider, p.isMe && styles.boardMe]}
              onPress={() => !offline && setOpenAuthor(p.device_id)}
            >
              <Text style={styles.rank}>{i + 1}</Text>
              <Avatar value={p.avatar} size={34} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.boardName, p.isMe && styles.boardNameMe]}>{p.name}</Text>
                <Text style={styles.boardSub}>{p.kcal} kcal today</Text>
              </View>
              <View style={styles.streakBadge}>
                <Icon name="flame" size={12} color={colors.orange} />
                <Text style={styles.streakBadgeText}>{p.streak}</Text>
              </View>
            </Pressable>
          ))}
        </View>

        {/* Groups */}
        <Text style={styles.section}>Groups for you</Text>
        {groups.map((g) => (
          <View key={g.id} style={styles.groupCard}>
            <Text style={styles.groupEmoji}>{g.emoji}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.groupName}>{g.name}</Text>
              <Text style={styles.groupDesc}>{g.desc}</Text>
              <Text style={styles.groupMembers}>{g.members.toLocaleString()} members</Text>
            </View>
            <Pressable style={[styles.joinBtn, g.joined && styles.joinedBtn]} onPress={() => toggle(g)}>
              <Text style={[styles.joinText, g.joined && styles.joinedText]}>
                {g.joined ? "Joined" : "Join"}
              </Text>
            </Pressable>
          </View>
        ))}

        <Text style={styles.footNote}>
          {offline
            ? "Connect to the server to sync groups & the live leaderboard."
            : "Your stats sync automatically each time you open this tab."}
        </Text>
        </ScrollView>
      )}

      <Notifications
        visible={showNotifs}
        onClose={() => setShowNotifs(false)}
        onRead={() => setUnread(0)}
        onOpenActor={(actorId) => {
          setShowNotifs(false);
          setOpenAuthor(actorId);
        }}
      />
      <UserProfile
        visible={openAuthor != null}
        authorId={openAuthor}
        account={account}
        deviceId={identity}
        onClose={() => setOpenAuthor(null)}
        onRequireAuth={onRequireAuth}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { paddingTop: 56, paddingBottom: 20, paddingHorizontal: 20, borderBottomLeftRadius: 24, borderBottomRightRadius: 24 },
  hTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  hTitle: { color: "#fff", fontSize: 26, fontWeight: "800", letterSpacing: -0.3 },
  bell: { width: 40, height: 40, borderRadius: 20, backgroundColor: "rgba(255,255,255,0.16)", alignItems: "center", justifyContent: "center" },
  badge: { position: "absolute", top: -2, right: -2, minWidth: 18, height: 18, borderRadius: 9, backgroundColor: colors.red, alignItems: "center", justifyContent: "center", paddingHorizontal: 4, borderWidth: 2, borderColor: colors.green },
  badgeText: { color: "#fff", fontSize: 10, fontWeight: "900" },
  hSub: { color: "#CDEBD9", fontSize: 13, marginTop: 2 },
  seg: { flexDirection: "row", backgroundColor: "rgba(255,255,255,0.16)", borderRadius: 12, padding: 3, marginTop: 14 },
  segBtn: { flex: 1, paddingVertical: 9, borderRadius: 10, alignItems: "center" },
  segActive: { backgroundColor: "#fff" },
  segText: { fontWeight: "800", fontSize: 13, color: "#EAF4EE" },
  segTextActive: { color: colors.green },
  body: { padding: 16, paddingBottom: 24 },

  loadingRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 },
  loadingText: { color: colors.mute, fontSize: 13 },

  section: { fontSize: 13, fontWeight: "800", color: colors.mute, letterSpacing: 0.5, textTransform: "uppercase", marginTop: 20, marginBottom: 10 },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 8, ...shadow.card },

  challengeRow: { gap: 12, paddingRight: 4 },
  challengeCard: { width: 180, backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, ...shadow.card },
  challengeEmoji: { fontSize: 26 },
  challengeTitle: { fontSize: 15, fontWeight: "800", color: colors.ink, marginTop: 8 },
  challengeDesc: { fontSize: 12, color: colors.mute, marginTop: 2, lineHeight: 16 },
  cTrack: { height: 6, borderRadius: 3, backgroundColor: colors.track, overflow: "hidden", marginTop: 12 },
  cFill: { height: 6, borderRadius: 3, backgroundColor: colors.green },
  challengeMeta: { fontSize: 11, color: colors.mute, marginTop: 8, fontWeight: "700" },

  boardRow: { flexDirection: "row", alignItems: "center", paddingVertical: 12, paddingHorizontal: 10, gap: 12, borderRadius: radius.md },
  boardDivider: { borderBottomWidth: 1, borderBottomColor: colors.line },
  boardMe: { backgroundColor: colors.greenTint2 },
  rank: { width: 20, textAlign: "center", fontWeight: "900", color: colors.mute, fontSize: 14 },
  avatar: { fontSize: 24 },
  boardName: { fontSize: 15, fontWeight: "700", color: colors.ink },
  boardNameMe: { color: colors.green },
  boardSub: { fontSize: 12, color: colors.mute, marginTop: 1 },
  streakBadge: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: colors.greenTint, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 5 },
  streakBadgeText: { color: colors.green, fontWeight: "800", fontSize: 13 },

  groupCard: { flexDirection: "row", alignItems: "center", gap: 14, backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, marginBottom: 12, ...shadow.card },
  groupEmoji: { fontSize: 30 },
  groupName: { fontSize: 16, fontWeight: "800", color: colors.ink },
  groupDesc: { fontSize: 12, color: colors.mute, marginTop: 1 },
  groupMembers: { fontSize: 11, color: colors.green, fontWeight: "700", marginTop: 4 },
  joinBtn: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 12, backgroundColor: colors.green },
  joinedBtn: { backgroundColor: colors.greenTint, borderWidth: 1, borderColor: colors.green },
  joinText: { color: "#fff", fontWeight: "800", fontSize: 14 },
  joinedText: { color: colors.green },

  footNote: { color: colors.mute, fontSize: 12, textAlign: "center", marginTop: 20, lineHeight: 18 },
});
