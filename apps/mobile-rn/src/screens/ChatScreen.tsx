import { useState } from "react";
import { View, FlatList, StyleSheet, KeyboardAvoidingView, Platform } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useConversationMessages, useConversationMembers } from "../state/queries";
import { useApi } from "../state/clientProvider";
import { useAuth } from "../state/auth";
import { buildPendingMessage } from "../logic/optimisticSend";
import { normalizeAttachments } from "../logic/attachments";
import { normalizeServerRow, mergeMessage } from "../logic/normalizeMessage";
import MessageBubble from "../components/MessageBubble";
import MessageActions from "../components/MessageActions";
import ApprovalSheet from "../components/ApprovalSheet";
import Input from "../ui/Input";
import Button from "../ui/Button";
import { color, space, hairlineWidth } from "../theme";
import type { ChatMessage } from "../api/types";
import type { MessagesStackParamList } from "../navigation/types";

type Props = NativeStackScreenProps<MessagesStackParamList, "Chat">;

export default function ChatScreen({ route }: Props) {
  const { conversationId } = route.params;
  const api = useApi();
  const qc = useQueryClient();
  const { session, apiBase } = useAuth();
  const insets = useSafeAreaInsets();
  const { data: messages = [] } = useConversationMessages(conversationId);
  const { data: members = [] } = useConversationMembers(conversationId);
  const [text, setText] = useState("");
  const [actionMsg, setActionMsg] = useState<ChatMessage | null>(null);

  const key = ["messages", conversationId];
  const setMsgs = (fn: (old: ChatMessage[]) => ChatMessage[]) =>
    qc.setQueryData<ChatMessage[]>(key, (old) => fn(old || []));

  // 投递一条已乐观入列的消息;成功并入服务端行,失败标 failed 供重发。
  const postMessage = async (payload: { bodyMd: string; clientTraceId: string; mentions?: unknown[]; attachments?: unknown[] }) => {
    try {
      const res = await api.api(`/api/conversations/${conversationId}/messages`, {
        method: "POST",
        body: { bodyMd: payload.bodyMd, turnId: payload.clientTraceId, mentions: payload.mentions, attachments: payload.attachments },
      });
      const row = res.message || res;
      const norm = normalizeServerRow({ ...row, client_trace_id: row.client_trace_id || payload.clientTraceId }, session?.user?.id);
      setMsgs((old) => mergeMessage(old, norm));
    } catch {
      setMsgs((old) => old.map((m) => (m.clientTraceId === payload.clientTraceId ? { ...m, isPending: false, failed: true } : m)));
    }
  };

  const send = async () => {
    let pending;
    try {
      pending = buildPendingMessage({ text }, { selfId: session?.user?.id, members });
    } catch {
      return; // 空消息忽略
    }
    const pendingMessage: ChatMessage = { ...pending, attachments: normalizeAttachments(pending.attachments) };
    setText("");
    setMsgs((old) => [...old, pendingMessage]);
    await postMessage({ bodyMd: pendingMessage.bodyMd, clientTraceId: pendingMessage.clientTraceId, mentions: pending.mentions, attachments: pendingMessage.attachments });
  };

  const copyMessage = (m: ChatMessage) => {
    Clipboard.setStringAsync(m.bodyMd || "");
  };

  // 重发:把失败消息标回 pending,用原 clientTraceId(turnId 幂等)重投。
  const resendMessage = async (m: ChatMessage) => {
    setMsgs((old) => old.map((x) => (x.messageId === m.messageId ? { ...x, failed: false, isPending: true } : x)));
    await postMessage({ bodyMd: m.bodyMd, clientTraceId: m.clientTraceId, attachments: m.attachments });
  };

  // 删除:未送达的(pending/failed)只本地移除;已送达的走云端微信式本地隐藏,失败则还原。
  const deleteMessage = async (m: ChatMessage) => {
    const localOnly = m.isPending || m.failed;
    const snapshot = qc.getQueryData<ChatMessage[]>(key);
    setMsgs((old) => old.filter((x) => x.messageId !== m.messageId));
    if (localOnly) return;
    try {
      await api.api(`/api/conversations/${conversationId}/messages/${m.messageId}`, { method: "DELETE" });
    } catch {
      if (snapshot) qc.setQueryData<ChatMessage[]>(key, snapshot);
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
        renderItem={({ item }) => <MessageBubble msg={item} apiBase={apiBase} onLongPress={setActionMsg} />}
      />
      <View style={[styles.composer, { paddingBottom: space.sm + insets.bottom }]}>
        <Input
          style={styles.input}
          placeholder="输入消息…"
          value={text}
          onChangeText={setText}
          onSubmitEditing={send}
          returnKeyType="send"
        />
        <Button label="发送" style={styles.send} onPress={send} />
      </View>
      <MessageActions
        msg={actionMsg}
        onClose={() => setActionMsg(null)}
        onCopy={copyMessage}
        onResend={resendMessage}
        onDelete={deleteMessage}
      />
      <ApprovalSheet />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.chatBg },
  list: { flex: 1 },
  composer: {
    flexDirection: "row",
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    backgroundColor: color.surface,
    borderTopWidth: hairlineWidth,
    borderTopColor: color.line,
  },
  input: { flex: 1 },
  send: { paddingHorizontal: space.lg },
});
