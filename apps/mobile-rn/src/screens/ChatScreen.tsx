import { useEffect, useState } from "react";
import { View, FlatList, StyleSheet, KeyboardAvoidingView, Platform } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  useBotRuntime,
  useConversationMessages,
  useConversationMembers,
  useConversations,
  useModelCatalog,
  useSaveBotRuntimeConfig,
  useSaveUserSettings,
  useUserSettings,
} from "../state/queries";
import { useApi } from "../state/clientProvider";
import { useAuth } from "../state/auth";
import { buildPendingMessage } from "../logic/optimisticSend";
import { normalizeAttachments } from "../logic/attachments";
import { normalizeServerRow, mergeMessage } from "../logic/normalizeMessage";
import { lastSeenSeq } from "../logic/settings";
import MessageBubble from "../components/MessageBubble";
import MessageActions from "../components/MessageActions";
import ApprovalSheet from "../components/ApprovalSheet";
import RuntimeControls from "../components/RuntimeControls";
import Input from "../ui/Input";
import Button from "../ui/Button";
import { color, space, hairlineWidth } from "../theme";
import {
  botIdForRuntimeControls,
  modelEntriesFromCatalog,
  patchForRuntimeField,
  runtimeControlState,
  runtimeKindForControls,
} from "../logic/runtimeControls";
import type { ChatMessage } from "../api/types";
import type { MessagesStackParamList } from "../navigation/types";

type Props = NativeStackScreenProps<MessagesStackParamList, "Chat">;

export default function ChatScreen({ route }: Props) {
  const { conversationId } = route.params;
  const api = useApi();
  const qc = useQueryClient();
  const { session, apiBase } = useAuth();
  const insets = useSafeAreaInsets();
  const { data: conversations = [] } = useConversations();
  const activeConversation = conversations.find((c) => c.id === conversationId) || null;
  const botId = botIdForRuntimeControls(activeConversation);
  const runtimeKind = runtimeKindForControls(activeConversation);
  const showRuntimeControls = !!botId && runtimeKind === "cloud-hermes";
  const runtime = useBotRuntime(botId || undefined, runtimeKind);
  const modelCatalog = useModelCatalog();
  const saveRuntime = useSaveBotRuntimeConfig();
  const { data: messages = [] } = useConversationMessages(conversationId);
  const { data: members = [] } = useConversationMembers(conversationId);
  const { data: settings } = useUserSettings();
  const saveSettings = useSaveUserSettings();
  const [text, setText] = useState("");
  const [actionMsg, setActionMsg] = useState<ChatMessage | null>(null);
  const [savingField, setSavingField] = useState<"model" | "effort" | "permission" | "">("");
  const [runtimeError, setRuntimeError] = useState("");
  const modelEntries = modelEntriesFromCatalog(modelCatalog.data || runtime.data?.config?.modelEntries || []);
  const controls = runtimeControlState({ binding: runtime.data, modelEntries });
  const maxSeq = lastSeenSeq(messages);

  useEffect(() => {
    const current = Number(settings?.readMarks?.[conversationId]) || 0;
    if (maxSeq > current) saveSettings.mutate({ readMarks: { [conversationId]: maxSeq } });
  }, [conversationId, maxSeq, settings?.readMarks?.[conversationId]]);

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

  const saveRuntimeField = async (field: "model" | "effort" | "permission", value: string) => {
    if (!botId) return;
    setRuntimeError("");
    setSavingField(field);
    try {
      const patch = patchForRuntimeField(field, value, modelEntries);
      const nextConfig = { ...(runtime.data?.config || {}), ...patch };
      await saveRuntime.mutateAsync({ botId, runtimeKind, config: nextConfig });
    } catch (err) {
      setRuntimeError(String((err as Error).message || "设置保存失败"));
    } finally {
      setSavingField("");
    }
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
        {showRuntimeControls ? (
          <RuntimeControls
            modelEntries={modelEntries}
            modelValue={controls.modelValue}
            effortValue={controls.effortValue}
            permissionValue={controls.permissionValue}
            savingField={savingField}
            error={runtimeError}
            onChange={saveRuntimeField}
          />
        ) : null}
        <View style={styles.composerInputRow}>
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
    gap: space.sm,
    backgroundColor: color.surface,
    borderTopWidth: hairlineWidth,
    borderTopColor: color.line,
  },
  composerInputRow: {
    flexDirection: "row",
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
  },
  input: { flex: 1 },
  send: { paddingHorizontal: space.lg },
});
