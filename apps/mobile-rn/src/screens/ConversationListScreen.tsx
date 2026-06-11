import { Alert, View, FlatList, Pressable, StyleSheet } from "react-native";
import { useQueries } from "@tanstack/react-query";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useBots, useConversations, useFriends, useMe, useSaveUserSettings, useUserSettings } from "../state/queries";
import { useApi } from "../state/clientProvider";
import { useAuth } from "../state/auth";
import { buildConversationListItems } from "../logic/conversationList";
import { normalizeServerRow } from "../logic/normalizeMessage";
import { togglePinnedConversation } from "../logic/settings";
import { conversationType } from "../logic/sessionHistory";
import ConversationAvatar from "../components/ConversationAvatar";
import ConnBanner from "../components/ConnBanner";
import StatusBadge from "../components/StatusBadge";
import { BodyStrong, Label, Sub } from "../ui/Text";
import { color, space } from "../theme";
import type { ChatMessage, Member, MessageRow } from "../api/types";
import type { MessagesStackParamList } from "../navigation/types";

type Props = NativeStackScreenProps<MessagesStackParamList, "Conversations">;

export default function ConversationListScreen({ navigation }: Props) {
  const api = useApi();
  const { session, apiBase } = useAuth();
  const { data: conversations = [], isLoading, refetch, isRefetching } = useConversations();
  const { data: bots = [] } = useBots();
  const { data: friends = [] } = useFriends();
  const { data: me } = useMe();
  const { data: settings } = useUserSettings();
  const saveSettings = useSaveUserSettings();

  // dm / group 需要成员才能解析对方头像 / 群拼贴 —— 按需补拉(react-query 缓存)。
  const memberConvs = conversations.filter((c) => {
    const t = conversationType(c);
    return t === "dm" || t === "group";
  });
  const memberResults = useQueries({
    queries: memberConvs.map((c) => ({
      queryKey: ["members", c.id],
      queryFn: () => api.api(`/api/conversations/${encodeURIComponent(c.id)}`).then((d) => (d.members || []) as Member[]),
      staleTime: 60_000,
    })),
  });
  const membersByConv: Record<string, Member[]> = {};
  memberConvs.forEach((c, i) => {
    const m = memberResults[i]?.data;
    if (m) membersByConv[c.id] = m;
  });

  const messageResults = useQueries({
    queries: conversations.map((c) => ({
      queryKey: ["messages", c.id],
      queryFn: () =>
        api
          .api(`/api/conversations/${c.id}/messages?limit=200`)
          .then((d) => (d.messages || []).map((r: MessageRow, i: number) => normalizeServerRow(r, session?.user?.id, i))),
      staleTime: 30_000,
    })),
  });
  const messagesByConv: Record<string, ChatMessage[]> = {};
  conversations.forEach((c, i) => {
    const m = messageResults[i]?.data as ChatMessage[] | undefined;
    if (m) messagesByConv[c.id] = m;
  });

  // 自己:优先完整资料(带头像 + 裁剪),回退到会话里的精简 user。
  const self = me
    ? { id: me.id, username: me.username, avatarImage: me.avatarImage, avatarCrop: me.avatarCrop }
    : session?.user
      ? { id: session.user.id, username: session.user.username, avatarImage: session.user.avatarImage }
      : undefined;

  const pinnedIds = settings?.pins || [];
  const pinnedSet = new Set(pinnedIds);
  const items = buildConversationListItems({ conversations, bots, friends, self, membersByConv, messagesByConv, unreadByConversation: {}, pinnedIds });

  function openConversationActions(item: (typeof items)[number]) {
    const pinned = pinnedSet.has(item.id);
    Alert.alert(item.title, "", [
      {
        text: pinned ? "取消置顶" : "置顶",
        onPress: () => saveSettings.mutate({ pins: togglePinnedConversation(settings, item.id) }),
      },
      { text: "取消", style: "cancel" },
    ]);
  }

  return (
    <View style={styles.root}>
      <ConnBanner />
      <FlatList
        data={items}
        keyExtractor={(it) => it.id}
        onRefresh={refetch}
        refreshing={isRefetching}
        ListEmptyComponent={<Sub style={styles.empty}>{isLoading ? "加载中…" : "还没有会话"}</Sub>}
        renderItem={({ item }) => (
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            onLongPress={() => openConversationActions(item)}
            onPress={() => navigation.navigate("Chat", { conversationId: item.id, title: item.title })}
          >
            <ConversationAvatar tiles={item.tiles} />
            <View style={styles.textCol}>
              <View style={styles.titleRow}>
                <View style={styles.titleWithBadge}>
                  <BodyStrong numberOfLines={1} style={styles.title}>{item.title}</BodyStrong>
                  <StatusBadge badge={item.statusBadge} apiBase={apiBase} size={15} />
                </View>
                {pinnedSet.has(item.id) ? <Label style={styles.pin}>置顶</Label> : null}
                {item.timeText ? <Sub numberOfLines={1} style={styles.time}>{item.timeText}</Sub> : null}
              </View>
              <Sub numberOfLines={1} style={styles.sub}>{item.subtitle}</Sub>
            </View>
            {item.unread ? (
              <View style={styles.badge}>
                <Sub style={styles.badgeText}>{item.unread}</Sub>
              </View>
            ) : null}
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  empty: { textAlign: "center", marginTop: 48 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    backgroundColor: color.bg,
  },
  pressed: { backgroundColor: color.surfaceMuted },
  textCol: { flex: 1, minWidth: 0, gap: 2 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  titleWithBadge: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 4 },
  title: { flex: 1, minWidth: 0 },
  time: { color: color.inkFaint, fontSize: 12 },
  sub: { marginTop: 1 },
  pin: { color: color.accent, maxWidth: 42 },
  badge: { backgroundColor: color.accent, minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" },
  badgeText: { color: color.accentText, fontSize: 12, fontWeight: "600" },
});
