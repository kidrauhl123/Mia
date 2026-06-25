import { FlatList, Pressable, StyleSheet, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useBots, useConversations, useCreateBotSessionConversation } from "../state/queries";
import {
  botId,
  canCreateSession,
  createBotSessionPayload,
  runtimeKind,
  sessionConversationsForConversation,
  sessionTitle,
} from "../logic/sessionHistory";
import { formatConversationTime } from "../logic/conversationList";
import Button from "../ui/Button";
import { BodyStrong, Sub } from "../ui/Text";
import { useTypography } from "../ui/TypographyProvider";
import { color, hairlineWidth, space } from "../theme";
import type { Conversation } from "../api/types";
import type { MessagesStackParamList } from "../navigation/types";

type Props = NativeStackScreenProps<MessagesStackParamList, "BotSessions">;

function randomSessionId() {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function conversationTime(c: Conversation): string {
  return formatConversationTime(c.last_activity_at || c.updated_at || c.created_at || "");
}

export default function BotSessionsScreen({ navigation, route }: Props) {
  const typography = useTypography();
  const { data: conversations = [] } = useConversations();
  const { data: bots = [] } = useBots();
  const createSession = useCreateBotSessionConversation();
  const active = conversations.find((c) => c.id === route.params.conversationId) || null;
  const sessions = sessionConversationsForConversation(active as any, conversations as any, { activeConversationId: route.params.conversationId });
  const canCreate = canCreateSession(active as any);

  const open = (conversation: Conversation) => {
    navigation.replace("Chat", {
      conversationId: conversation.id,
      title: sessionTitle(conversation as any, { bots: bots as any, defaultTitle: "新对话", groupTitle: "群聊", dmTitleFallback: "私聊" }),
    });
  };

  const create = async () => {
    if (!active) return;
    const payload = createBotSessionPayload(active as any, randomSessionId(), {
      title: "新对话",
      runtimeKindFallback: runtimeKind(active as any, "cloud-hermes"),
    });
    if (!payload.botId) return;
    const res = await createSession.mutateAsync({
      sessionId: payload.sessionId,
      botId: payload.botId,
      title: payload.title,
      runtimeKind: payload.runtimeKind,
    });
    const conversation = res?.conversation;
    if (conversation?.id) open(conversation);
  };

  return (
    <View style={styles.root}>
      {canCreate ? <Button label="新对话" onPress={create} busy={createSession.isPending} style={styles.create} /> : null}
      <FlatList
        data={sessions}
        keyExtractor={(item) => item.id}
        ListEmptyComponent={<Sub style={[styles.empty, typography.type.info]}>{botId(active as any) ? "暂无聊天记录" : "不是 Bot 会话"}</Sub>}
        renderItem={({ item }) => {
          const activeRow = item.id === route.params.conversationId;
          return (
            <Pressable style={({ pressed }) => [styles.row, activeRow && styles.active, pressed && styles.pressed]} onPress={() => open(item as Conversation)}>
              <View style={styles.textCol}>
                <BodyStrong numberOfLines={1} style={typography.type.listTitle}>{sessionTitle(item as any, { bots: bots as any, defaultTitle: "新对话" })}</BodyStrong>
                <Sub numberOfLines={1} style={typography.type.settingDetail}>{item.id}</Sub>
              </View>
              <Sub style={[styles.time, typography.type.listTime]}>{conversationTime(item as Conversation)}</Sub>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  create: { marginHorizontal: space.lg, marginTop: space.md, marginBottom: space.sm },
  empty: { textAlign: "center", marginTop: 48 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderTopWidth: hairlineWidth,
    borderTopColor: color.line,
  },
  active: { backgroundColor: color.accentSoft },
  pressed: { backgroundColor: color.surfaceMuted },
  textCol: { flex: 1, minWidth: 0, gap: 2 },
  time: { color: color.inkFaint },
});
