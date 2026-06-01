import { useState } from "react";
import { View, TextInput, Pressable, Text, FlatList, StyleSheet, KeyboardAvoidingView, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useConversationMessages, useConversationMembers } from "../state/queries";
import { useApi } from "../state/clientProvider";
import { useAuth } from "../state/auth";
import { buildPendingMessage } from "../logic/optimisticSend";
import { normalizeServerRow, mergeMessage } from "../logic/normalizeMessage";
import MessageBubble from "../components/MessageBubble";
import ApprovalSheet from "../components/ApprovalSheet";
import { theme } from "../theme";
import type { ChatMessage } from "../api/types";
import type { MessagesStackParamList } from "../navigation/types";

type Props = NativeStackScreenProps<MessagesStackParamList, "Chat">;

export default function ChatScreen({ route }: Props) {
  const { conversationId } = route.params;
  const api = useApi();
  const qc = useQueryClient();
  const { session } = useAuth();
  const insets = useSafeAreaInsets();
  const { data: messages = [] } = useConversationMessages(conversationId);
  const { data: members = [] } = useConversationMembers(conversationId);
  const [text, setText] = useState("");

  const key = ["messages", conversationId];
  const setMsgs = (fn: (old: ChatMessage[]) => ChatMessage[]) =>
    qc.setQueryData<ChatMessage[]>(key, (old) => fn(old || []));

  const send = async () => {
    let pending;
    try {
      pending = buildPendingMessage({ text }, { selfId: session?.user?.id, members });
    } catch {
      return; // 空消息忽略
    }
    setText("");
    setMsgs((old) => [...old, pending]);
    try {
      const res = await api.api(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
        method: "POST",
        body: {
          body_md: pending.bodyMd,
          client_trace_id: pending.clientTraceId,
          mentions: pending.mentions,
          attachments: pending.attachments,
        },
      });
      const row = res.message || res;
      const norm = normalizeServerRow({ ...row, client_trace_id: row.client_trace_id || pending.clientTraceId }, session?.user?.id);
      setMsgs((old) => mergeMessage(old, norm));
    } catch {
      setMsgs((old) => old.map((m) => (m.clientTraceId === pending!.clientTraceId ? { ...m, failed: true } : m)));
    }
  };

  // inverted 列表:倒序数据,最新在底部
  const data = [...messages].reverse();

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={90}
    >
      <FlatList
        style={styles.list}
        data={data}
        inverted
        keyExtractor={(m) => m.messageId}
        contentContainerStyle={{ padding: 12 }}
        renderItem={({ item }) => <MessageBubble msg={item} />}
      />
      <View style={[styles.composer, { paddingBottom: 8 + insets.bottom }]}>
        <TextInput
          style={styles.input}
          placeholder="输入消息…"
          value={text}
          onChangeText={setText}
          onSubmitEditing={send}
          returnKeyType="send"
        />
        <Pressable style={styles.send} onPress={send}>
          <Text style={styles.sendText}>发送</Text>
        </Pressable>
      </View>
      <ApprovalSheet />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  list: { flex: 1 },
  composer: { flexDirection: "row", gap: 8, paddingHorizontal: 10, paddingTop: 8, backgroundColor: theme.card, borderTopWidth: 1, borderTopColor: theme.line },
  input: { flex: 1, backgroundColor: theme.bg, borderWidth: 1, borderColor: theme.line, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  send: { backgroundColor: theme.accent, borderRadius: 10, paddingHorizontal: 16, justifyContent: "center" },
  sendText: { color: "#fff", fontWeight: "600" },
});
