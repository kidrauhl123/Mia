import { Alert, View, FlatList, Pressable, StyleSheet } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useBots, useConversations, useFriends, useMe, useSaveUserSettings, useUserSettings } from "../state/queries";
import { useAuth } from "../state/auth";
import { buildConversationListItems, unreadCountsFromConversations } from "../logic/conversationList";
import { togglePinnedConversation } from "../logic/settings";
import ConversationAvatar from "../components/ConversationAvatar";
import ConnBanner from "../components/ConnBanner";
import StatusBadge from "../components/StatusBadge";
import { BodyStrong, Label, Sub } from "../ui/Text";
import { color, space } from "../theme";
import type { Member } from "../api/types";
import type { MessagesStackParamList } from "../navigation/types";

type Props = NativeStackScreenProps<MessagesStackParamList, "Conversations">;

export default function ConversationListScreen({ navigation }: Props) {
  const { session, apiBase } = useAuth();
  const { data: conversations = [], isLoading, refetch, isRefetching } = useConversations();
  const { data: bots = [] } = useBots();
  const { data: friends = [] } = useFriends();
  const { data: me } = useMe();
  const { data: settings } = useUserSettings();
  const saveSettings = useSaveUserSettings();

  const membersByConv: Record<string, Member[]> = {};
  conversations.forEach((c) => {
    if (Array.isArray(c.members)) membersByConv[c.id] = c.members;
  });
  const unreadByConversation = unreadCountsFromConversations(conversations, settings?.readMarks || {});

  // 自己:优先完整资料(带头像 + 裁剪),回退到会话里的精简 user。
  const self = me
    ? { id: me.id, username: me.username, avatarImage: me.avatarImage, avatarCrop: me.avatarCrop }
    : session?.user
      ? { id: session.user.id, username: session.user.username, avatarImage: session.user.avatarImage }
      : undefined;

  const pinnedIds = settings?.pins || [];
  const pinnedSet = new Set(pinnedIds);
  const items = buildConversationListItems({ conversations, bots, friends, self, membersByConv, unreadByConversation, pinnedIds });

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
                  <StatusBadge badge={item.statusBadge} apiBase={apiBase} size={20} />
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
  titleWithBadge: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 0 },
  title: { flex: 1, minWidth: 0 },
  time: { color: color.inkFaint, fontSize: 12 },
  sub: { marginTop: 1 },
  pin: { color: color.accent, maxWidth: 42 },
  badge: { backgroundColor: color.accent, minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" },
  badgeText: { color: color.accentText, fontSize: 12, fontWeight: "600" },
});
