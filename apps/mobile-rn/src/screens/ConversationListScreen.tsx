import { View, FlatList, Pressable, StyleSheet } from "react-native";
import { useQueries } from "@tanstack/react-query";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useBots, useConversations, useFriends, useMe } from "../state/queries";
import { useApi } from "../state/clientProvider";
import { useAuth } from "../state/auth";
import { buildConversationListItems } from "../logic/conversationList";
import { conversationType } from "../logic/sessionHistory";
import ConversationAvatar from "../components/ConversationAvatar";
import ConnBanner from "../components/ConnBanner";
import { BodyStrong, Sub } from "../ui/Text";
import { color, space } from "../theme";
import type { Member } from "../api/types";
import type { MessagesStackParamList } from "../navigation/types";

type Props = NativeStackScreenProps<MessagesStackParamList, "Conversations">;

export default function ConversationListScreen({ navigation }: Props) {
  const api = useApi();
  const { session } = useAuth();
  const { data: conversations = [], isLoading, refetch, isRefetching } = useConversations();
  const { data: bots = [] } = useBots();
  const { data: friends = [] } = useFriends();
  const { data: me } = useMe();

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

  // 自己:优先完整资料(带头像 + 裁剪),回退到会话里的精简 user。
  const self = me
    ? { id: me.id, username: me.username, avatarImage: me.avatarImage, avatarCrop: me.avatarCrop }
    : session?.user
      ? { id: session.user.id, username: session.user.username, avatarImage: session.user.avatarImage }
      : undefined;

  const items = buildConversationListItems({ conversations, bots, friends, self, membersByConv, unreadByConversation: {} });

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
            onPress={() => navigation.navigate("Chat", { conversationId: item.id, title: item.title })}
          >
            <ConversationAvatar tiles={item.tiles} />
            <View style={styles.textCol}>
              <BodyStrong numberOfLines={1}>{item.title}</BodyStrong>
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
  sub: { marginTop: 1 },
  badge: { backgroundColor: color.accent, minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" },
  badgeText: { color: color.accentText, fontSize: 12, fontWeight: "600" },
});
