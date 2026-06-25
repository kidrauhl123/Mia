import { useEffect, useLayoutEffect, useState } from "react";
import { ActivityIndicator, View, FlatList, Pressable, StyleSheet, KeyboardAvoidingView, Platform, Text } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import Svg, { Path } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  useConversationMessages,
  useConversationMembers,
  useConversations,
  useSaveUserSettings,
  useUserSettings,
} from "../state/queries";
import { useApi } from "../state/clientProvider";
import { useAuth } from "../state/auth";
import { buildPendingMessage } from "../logic/optimisticSend";
import { MAX_COMPOSER_ATTACHMENTS, normalizeAttachments, pickedAssetAttachment } from "../logic/attachments";
import { normalizeServerRow, mergeMessage } from "../logic/normalizeMessage";
import { lastSeenSeq } from "../logic/settings";
import { conversationType } from "../logic/sessionHistory";
import { chatKeyboardAvoidingBehavior, chatKeyboardAvoidingEnabled } from "../logic/keyboardAvoidance";
import MessageBubble from "../components/MessageBubble";
import MessageActions from "../components/MessageActions";
import ApprovalSheet from "../components/ApprovalSheet";
import Input from "../ui/Input";
import { Sub } from "../ui/Text";
import { withAndroidTextFace } from "../ui/androidTextFace";
import { useTypography } from "../ui/TypographyProvider";
import { color, space, hairlineWidth } from "../theme";
import type { ChatMessage, MessageAttachment } from "../api/types";
import type { MessagesStackParamList } from "../navigation/types";

type Props = NativeStackScreenProps<MessagesStackParamList, "Chat">;

function PaperclipIcon({ tint }: { tint: string }) {
  return (
    <Svg width={23} height={23} viewBox="0 0 24 24">
      <Path
        d="M8.8 12.7 13.9 7.6a3.2 3.2 0 0 1 4.5 4.5l-6.2 6.2a5 5 0 0 1-7.1-7.1l6.7-6.7"
        stroke={tint}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <Path
        d="m9.6 12 5.1-5.1"
        stroke={tint}
        strokeWidth={2}
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  );
}

function SendIcon({ tint }: { tint: string }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24">
      <Path d="M4 11.7 20 4l-4.7 16-3.2-6.2L4 11.7Z" fill={tint} />
      <Path d="m12.1 13.8 3.2-3.3" stroke={color.accent} strokeWidth={1.8} strokeLinecap="round" />
    </Svg>
  );
}

export default function ChatScreen({ navigation, route }: Props) {
  const typography = useTypography();
  const { conversationId } = route.params;
  const api = useApi();
  const qc = useQueryClient();
  const { session, apiBase } = useAuth();
  const insets = useSafeAreaInsets();
  const { data: conversations = [] } = useConversations();
  const activeConversation = conversations.find((c) => c.id === conversationId) || null;
  const activeType = activeConversation ? conversationType(activeConversation) : "";
  const { data: messages = [] } = useConversationMessages(conversationId);
  const { data: members = [] } = useConversationMembers(conversationId);
  const { data: settings } = useUserSettings();
  const saveSettings = useSaveUserSettings();
  const [text, setText] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<MessageAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [actionMsg, setActionMsg] = useState<ChatMessage | null>(null);
  const [sending, setSending] = useState(false);
  const maxSeq = lastSeenSeq(messages);
  const canSend = Boolean(text.trim() || pendingAttachments.length) && !sending;

  useLayoutEffect(() => {
    navigation.setOptions({
      title: route.params.title || "",
      headerRight: () => {
        if (activeType === "group") {
          return (
            <Pressable hitSlop={10} onPress={() => navigation.navigate("GroupDetail", { conversationId, title: route.params.title })}>
              <Text allowFontScaling={false} style={withAndroidTextFace([styles.headerAction, typography.type.action], "详情")}>详情</Text>
            </Pressable>
          );
        }
        if (activeType === "bot") {
          return (
            <Pressable hitSlop={10} onPress={() => navigation.navigate("BotSessions", { conversationId, title: route.params.title })}>
              <Text allowFontScaling={false} style={withAndroidTextFace([styles.headerAction, typography.type.action], "聊天记录")}>聊天记录</Text>
            </Pressable>
          );
        }
        return null;
      },
    });
  }, [activeType, conversationId, navigation, route.params.title, typography.type.action]);

  useEffect(() => {
    const current = Number(settings?.readMarks?.[conversationId]) || 0;
    if (maxSeq > current) saveSettings.mutate({ readMarks: { [conversationId]: maxSeq } });
  }, [conversationId, maxSeq, settings?.readMarks?.[conversationId]]);

  const key = ["messages", conversationId];
  const setMsgs = (fn: (old: ChatMessage[]) => ChatMessage[]) =>
    qc.setQueryData<ChatMessage[]>(key, (old) => fn(old || []));
  const scheduleRefresh = () => {
    qc.invalidateQueries({ queryKey: ["conversations"] });
    setTimeout(() => qc.invalidateQueries({ queryKey: key }), 1200);
    setTimeout(() => qc.invalidateQueries({ queryKey: key }), 4200);
  };

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
      scheduleRefresh();
    } catch {
      setMsgs((old) => old.map((m) => (m.clientTraceId === payload.clientTraceId ? { ...m, isPending: false, failed: true } : m)));
    }
  };

  const pickAttachments = async () => {
    setAttachmentError("");
    try {
      const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true, type: "*/*" });
      if (result.canceled) return;
      const remaining = MAX_COMPOSER_ATTACHMENTS - (pendingAttachments?.length || 0);
      if (remaining <= 0) {
        setAttachmentError(`最多 ${MAX_COMPOSER_ATTACHMENTS} 个附件`);
        return;
      }
      const next: MessageAttachment[] = [];
      for (const asset of result.assets.slice(0, remaining)) {
        const base64 = await new File(asset.uri).base64();
        next.push(pickedAssetAttachment(asset, base64));
      }
      setPendingAttachments((old) => [...(old || []), ...next].slice(0, MAX_COMPOSER_ATTACHMENTS));
      if (result.assets.length > remaining) setAttachmentError(`最多 ${MAX_COMPOSER_ATTACHMENTS} 个附件`);
    } catch (err) {
      setAttachmentError(err instanceof Error ? err.message : "附件读取失败");
    }
  };

  const send = async () => {
    if (sending) return;
    let pending;
    try {
      pending = buildPendingMessage({ text, attachments: pendingAttachments }, { selfId: session?.user?.id, members });
    } catch {
      return; // 空消息忽略
    }
    setSending(true);
    const pendingMessage: ChatMessage = { ...pending, attachments: normalizeAttachments(pending.attachments) };
    setText("");
    setPendingAttachments([]);
    setAttachmentError("");
    setMsgs((old) => [...old, pendingMessage]);
    try {
      await postMessage({ bodyMd: pendingMessage.bodyMd, clientTraceId: pendingMessage.clientTraceId, mentions: pending.mentions, attachments: pendingMessage.attachments });
    } finally {
      setSending(false);
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
      behavior={chatKeyboardAvoidingBehavior(Platform.OS)}
      enabled={chatKeyboardAvoidingEnabled(Platform.OS)}
      keyboardVerticalOffset={90}
    >
      <FlatList
        style={styles.list}
        data={data}
        inverted
        keyExtractor={(m) => m.messageId}
        contentContainerStyle={{ padding: 12 }}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => <MessageBubble msg={item} apiBase={apiBase} members={members} onLongPress={setActionMsg} />}
      />
      <View style={[styles.composer, { paddingBottom: space.sm + insets.bottom }]}>
        {pendingAttachments?.length ? (
          <View style={styles.attachmentBar}>
            {pendingAttachments.map((attachment, index) => (
              <View key={`${attachment.id || attachment.name || "att"}:${index}`} style={styles.attachmentChip}>
                <Sub numberOfLines={1} style={[styles.attachmentName, typography.type.attachmentSubtitle]}>{attachment.name || "附件"}</Sub>
                <Pressable
                  hitSlop={8}
                  onPress={() => setPendingAttachments((old) => (old || []).filter((_, i) => i !== index))}
                  style={styles.attachmentRemove}
                >
                  <Sub style={[styles.attachmentRemoveText, typography.type.caption]}>×</Sub>
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}
        {attachmentError ? <Sub style={styles.attachmentError}>{attachmentError}</Sub> : null}
        <View style={styles.composerInputRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="添加附件"
            hitSlop={8}
            onPress={pickAttachments}
            style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
          >
            <PaperclipIcon tint={color.inkMuted} />
          </Pressable>
          <Input
            style={[styles.input, typography.type.composerInput]}
            placeholder="输入消息…"
            value={text}
            onChangeText={setText}
            onSubmitEditing={send}
            blurOnSubmit={false}
            multiline
            returnKeyType="send"
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="发送"
            onPress={send}
            disabled={!canSend}
            style={({ pressed }) => [
              styles.sendIconButton,
              !canSend && styles.sendIconButtonDisabled,
              pressed && styles.sendIconButtonPressed,
            ]}
          >
            {sending ? (
              <ActivityIndicator color={color.accentText} />
            ) : (
              <SendIcon tint={color.accentText} />
            )}
          </Pressable>
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
  headerAction: { color: color.accent },
  list: { flex: 1 },
  composer: {
    gap: space.sm,
    backgroundColor: color.surface,
    borderTopWidth: hairlineWidth,
    borderTopColor: color.line,
  },
  composerInputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
  },
  attachmentBar: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, paddingHorizontal: space.md, paddingTop: space.sm },
  attachmentChip: {
    maxWidth: "48%",
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    borderRadius: 999,
    borderWidth: hairlineWidth,
    borderColor: color.line,
    backgroundColor: color.surfaceMuted,
    paddingLeft: space.sm,
    paddingRight: space.xs,
    paddingVertical: 6,
  },
  attachmentName: { flex: 1, minWidth: 0 },
  attachmentRemove: { width: 20, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: color.field },
  attachmentRemoveText: { color: color.inkMuted },
  attachmentError: { color: color.danger, paddingHorizontal: space.md },
  iconButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.surfaceMuted,
  },
  iconButtonPressed: { backgroundColor: color.field, transform: [{ scale: 0.96 }] },
  input: { flex: 1, minHeight: 44, maxHeight: 118, paddingVertical: 10, borderRadius: 22 },
  sendIconButton: {
    width: 42,
    height: 42,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.accent,
  },
  sendIconButtonPressed: { opacity: 0.86, transform: [{ scale: 0.96 }] },
  sendIconButtonDisabled: { opacity: 0.38 },
});
