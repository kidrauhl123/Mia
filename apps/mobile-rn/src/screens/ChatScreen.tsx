import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { ActivityIndicator, View, FlatList, Pressable, StyleSheet, KeyboardAvoidingView, Platform, Text } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import Svg, { Path } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect } from "@react-navigation/native";
import { useQueryClient } from "@tanstack/react-query";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  useConversationMessages,
  useConversationMembers,
  useBots,
  useConversations,
  useFriends,
  useMe,
  useSaveUserSettings,
  useUserSettings,
} from "../state/queries";
import { useApi } from "../state/clientProvider";
import { useAuth } from "../state/auth";
import { buildPendingMessage } from "../logic/optimisticSend";
import { MAX_COMPOSER_ATTACHMENTS, normalizeAttachments, pickedAssetAttachment } from "../logic/attachments";
import { normalizeServerRow, mergeMessage } from "../logic/normalizeMessage";
import { patchConversationListSummary } from "../logic/conversationCache";
import { lastSeenSeq, setConversationManualUnread } from "../logic/settings";
import { conversationType } from "../logic/sessionHistory";
import { chatKeyboardAvoidingBehavior, chatKeyboardAvoidingEnabled } from "../logic/keyboardAvoidance";
import {
  activeConversationIdQueryKey,
  clearUnreadCount,
  unreadCountsQueryKey,
  type UnreadCounts,
} from "../logic/unreadState";
import MessageBubble from "../components/MessageBubble";
import MessageActions from "../components/MessageActions";
import ApprovalSheet from "../components/ApprovalSheet";
import ConversationAvatar from "../components/ConversationAvatar";
import Input from "../ui/Input";
import { Sub } from "../ui/Text";
import { withAndroidTextFace } from "../ui/androidTextFace";
import { useTypography } from "../ui/TypographyProvider";
import { color, space, hairlineWidth } from "../theme";
import { conversationAvatarTiles } from "../logic/conversationAvatar";
import type { ChatMessage, Conversation, MessageAttachment } from "../api/types";
import type { MessagesStackParamList } from "../navigation/types";
import { deleteCachedMessage, upsertCachedConversation, upsertCachedMessage } from "../storage/sqliteCache";

type Props = NativeStackScreenProps<MessagesStackParamList, "Chat">;

function PlusIcon({ tint }: { tint: string }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24">
      <Path d="M12 5V19M5 12H19" stroke={tint} strokeWidth={2.1} strokeLinecap="round" />
    </Svg>
  );
}

function SendIcon({ tint }: { tint: string }) {
  return (
    <Svg width={30} height={30} viewBox="0 0 24 24">
      <Path d="M3.8 20.2L21 12L3.8 3.8L6.95 10.85L14.1 12L6.95 13.15L3.8 20.2Z" fill={tint} />
    </Svg>
  );
}

function ChatHeaderTitle({ tiles, title, meta }: { tiles: ReturnType<typeof conversationAvatarTiles>; title: string; meta: string }) {
  const typography = useTypography();
  return (
    <View style={styles.headerTitleWrap}>
      <ConversationAvatar tiles={tiles} size={32} />
      <View style={styles.headerTitleCopy}>
        <Text allowFontScaling={false} numberOfLines={1} style={withAndroidTextFace([styles.headerTitleText, typography.type.listTitle], title)}>
          {title}
        </Text>
        <Text allowFontScaling={false} numberOfLines={1} style={withAndroidTextFace([styles.headerMetaText, typography.type.caption], meta)}>
          {meta}
        </Text>
      </View>
    </View>
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
  const { data: bots = [] } = useBots();
  const { data: friends = [] } = useFriends();
  const { data: me } = useMe();
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
  const self = useMemo(
    () => me
      ? { id: me.id, username: me.username, avatarImage: me.avatarImage, avatarCrop: me.avatarCrop }
      : session?.user
        ? { id: session.user.id, username: session.user.username, avatarImage: session.user.avatarImage }
        : undefined,
    [me, session?.user]
  );
  const membersByConv = useMemo(() => ({ [conversationId]: members }), [conversationId, members]);
  const headerTiles = useMemo(
    () => activeConversation
      ? conversationAvatarTiles(activeConversation, { self, bots, friends, membersByConv })
      : [{ image: "", crop: null, color: color.accent, text: "?" }],
    [activeConversation, bots, friends, membersByConv, self]
  );
  const headerTitle = route.params.title || activeConversation?.name || activeConversation?.title || "对话";
  const headerMeta = activeType === "group" ? (members.length ? `群聊 · ${members.length} 人` : "群聊") : "私聊";

  const clearCurrentUnread = useCallback(() => {
    qc.setQueryData<UnreadCounts>(unreadCountsQueryKey, (old) => clearUnreadCount(old, conversationId));
  }, [conversationId, qc]);

  useFocusEffect(
    useCallback(() => {
      qc.setQueryData(activeConversationIdQueryKey, conversationId);
      clearCurrentUnread();
      return () => {
        qc.setQueryData<string>(activeConversationIdQueryKey, (current) => current === conversationId ? "" : current || "");
      };
    }, [clearCurrentUnread, conversationId, qc])
  );

  useLayoutEffect(() => {
    navigation.setOptions({
      title: "",
      headerTitleAlign: "left",
      headerStyle: { backgroundColor: color.chatBg },
      headerTitle: () => <ChatHeaderTitle tiles={headerTiles} title={headerTitle} meta={headerMeta} />,
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
  }, [activeType, conversationId, headerMeta, headerTiles, headerTitle, navigation, route.params.title, typography.type.action]);

  useEffect(() => {
    const current = Number(settings?.readMarks?.[conversationId]) || 0;
    const manualUnread = settings?.unreadOverrides?.[conversationId] === true;
    clearCurrentUnread();
    if (maxSeq > current || manualUnread) {
      saveSettings.mutate({
        readMarks: maxSeq > current ? { [conversationId]: maxSeq } : undefined,
        unreadOverrides: manualUnread ? setConversationManualUnread(settings, conversationId, false) : undefined,
      });
    }
  }, [clearCurrentUnread, conversationId, maxSeq, settings?.readMarks?.[conversationId], settings?.unreadOverrides?.[conversationId]]);

  const key = ["messages", conversationId];
  const setMsgs = (fn: (old: ChatMessage[]) => ChatMessage[]) =>
    qc.setQueryData<ChatMessage[]>(key, (old) => fn(old || []));
  const scheduleMessageReconcile = () => {
    setTimeout(() => qc.invalidateQueries({ queryKey: key, refetchType: "active" }), 1800);
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
      void upsertCachedMessage(session?.user?.id, conversationId, norm);
      qc.setQueryData<Conversation[]>(["conversations"], (old) => patchConversationListSummary(old, conversationId, row));
      const conversation = qc.getQueryData<Conversation[]>(["conversations"])?.find((item) => item.id === conversationId);
      if (conversation) void upsertCachedConversation(session?.user?.id, conversation);
      scheduleMessageReconcile();
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
      void deleteCachedMessage(session?.user?.id, conversationId, m.messageId);
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
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <MessageBubble
            msg={item}
            apiBase={apiBase}
            members={members}
            conversationKind={activeType}
            onLongPress={setActionMsg}
          />
        )}
      />
      <View style={[styles.composer, { paddingBottom: space.sm + insets.bottom }]}>
        <View style={styles.composerCard}>
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
          <View style={styles.composerInputRow}>
            <Input
              style={[styles.input, typography.type.composerInput]}
              placeholder="输入消息"
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
                <ActivityIndicator color={color.accent} />
              ) : (
                <SendIcon tint={canSend ? color.accent : color.inkFaint} />
              )}
            </Pressable>
          </View>
          <View style={styles.composerToolbar}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="添加附件"
              hitSlop={8}
              onPress={pickAttachments}
              style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
            >
              <PlusIcon tint={color.inkMuted} />
            </Pressable>
          </View>
        </View>
        {attachmentError ? <Sub style={styles.attachmentError}>{attachmentError}</Sub> : null}
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
  listContent: { paddingHorizontal: 10, paddingTop: 8, paddingBottom: 12 },
  headerTitleWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    minWidth: 0,
    maxWidth: 226,
    paddingVertical: 4,
    paddingLeft: 5,
    paddingRight: 12,
    borderRadius: 20,
    backgroundColor: color.surfaceSoft,
  },
  headerTitleCopy: { minWidth: 0, flex: 1 },
  headerTitleText: { color: color.ink, fontSize: 14, lineHeight: 17, fontWeight: "500" },
  headerMetaText: { color: color.inkMuted, fontSize: 11, lineHeight: 15 },
  composer: {
    gap: 6,
    paddingHorizontal: 12,
    paddingTop: 8,
    backgroundColor: color.surfaceSoft,
  },
  composerCard: {
    gap: 2,
    paddingLeft: 16,
    paddingRight: 8,
    paddingTop: 8,
    paddingBottom: 7,
    borderRadius: 22,
    backgroundColor: color.surface,
    shadowColor: "#0F1428",
    shadowOpacity: 0.07,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 3,
  },
  composerInputRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    minWidth: 0,
  },
  composerToolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    minWidth: 0,
    marginTop: 1,
  },
  attachmentBar: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginBottom: 4 },
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
    width: 30,
    height: 30,
    marginLeft: -6,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  iconButtonPressed: { backgroundColor: color.field },
  input: {
    flex: 1,
    minHeight: 32,
    maxHeight: 156,
    paddingHorizontal: 0,
    paddingVertical: 6,
    borderWidth: 0,
    borderRadius: 0,
    backgroundColor: "transparent",
  },
  sendIconButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  sendIconButtonPressed: { transform: [{ scale: 0.96 }] },
  sendIconButtonDisabled: { opacity: 1 },
});
