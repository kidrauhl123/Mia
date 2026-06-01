import { View, Text, FlatList, Pressable, StyleSheet } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useConversations } from "../state/queries";
import { buildConversationListItems } from "../logic/conversationList";
import Avatar from "../components/Avatar";
import ConnBanner from "../components/ConnBanner";
import { theme } from "../theme";
import type { MessagesStackParamList } from "../navigation/types";

type Props = NativeStackScreenProps<MessagesStackParamList, "Conversations">;

export default function ConversationListScreen({ navigation }: Props) {
  const { data: conversations = [], isLoading, refetch, isRefetching } = useConversations();
  const items = buildConversationListItems({ conversations, unreadByConversation: {} });

  return (
    <View style={styles.root}>
      <ConnBanner />
      <FlatList
        data={items}
        keyExtractor={(it) => it.id}
        onRefresh={refetch}
        refreshing={isRefetching}
        ListEmptyComponent={
          <Text style={styles.empty}>{isLoading ? "加载中…" : "还没有会话"}</Text>
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() => navigation.navigate("Chat", { conversationId: item.id, title: item.title })}
          >
            <Avatar title={item.title} />
            <View style={styles.textCol}>
              <Text style={styles.title} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={styles.sub} numberOfLines={1}>
                {item.subtitle}
              </Text>
            </View>
            {item.unread ? (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{item.unread}</Text>
              </View>
            ) : null}
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  empty: { textAlign: "center", color: theme.muted, marginTop: 40 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.line,
    backgroundColor: theme.card,
  },
  textCol: { flex: 1, minWidth: 0 },
  title: { fontWeight: "600", color: theme.text },
  sub: { color: theme.muted, fontSize: 13 },
  badge: { backgroundColor: theme.accent, borderRadius: 11, minWidth: 20, height: 20, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" },
  badgeText: { color: "#fff", fontSize: 12 },
});
