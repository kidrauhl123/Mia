import { View, Pressable, StyleSheet, Text } from "react-native";
import * as Haptics from "expo-haptics";
import Markdown from "react-native-markdown-display";
import { color, radius, space } from "../theme";
import { withAndroidTextFace } from "../ui/androidTextFace";
import { useTypography } from "../ui/TypographyProvider";
import AttachmentList from "./AttachmentList";
import TraceBlock from "./TraceBlock";
import StatusBadge from "./StatusBadge";
import AvatarMedia from "./AvatarMedia";
import AssistantContentBlocks from "./AssistantContentBlocks";
import { resolveMessageAuthor } from "../logic/messageAuthor";
import type { ChatMessage, Member } from "../api/types";

function formatMessageTime(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function deliveryText(msg: ChatMessage): string {
  if (msg.failed) return "发送失败";
  if (msg.isPending) return "发送中...";
  return "";
}

// 对齐桌面 .bubble:对方=浅灰深字、自己=靛蓝白字,圆角 18,padding 10/15。
export default function MessageBubble({
  msg,
  apiBase,
  members = [],
  conversationKind = "",
  onLongPress,
}: {
  msg: ChatMessage;
  apiBase: string;
  members?: Member[];
  conversationKind?: string;
  onLongPress?: (m: ChatMessage) => void;
}) {
  const typography = useTypography();
  if (msg.role === "system") {
    return (
      <View style={styles.systemRow}>
        <Text allowFontScaling={false} style={withAndroidTextFace([styles.systemText, typography.type.system], msg.bodyMd || "系统消息")}>{msg.bodyMd || "系统消息"}</Text>
      </View>
    );
  }

  const own = msg.isOwn;
  const groupMessage = conversationKind === "group";
  const textColor = own ? color.userBubbleText : color.ink;
  const author = groupMessage ? resolveMessageAuthor(msg, members) : null;
  const timeText = formatMessageTime(msg.createdAt);
  const statusText = deliveryText(msg);
  const orderedBlocks = !own && Array.isArray(msg.contentBlocks) ? msg.contentBlocks : [];
  const senderHeader = groupMessage && !own && author?.name ? (
    <View style={styles.senderRow}>
      <Text
        allowFontScaling={false}
        numberOfLines={1}
        style={withAndroidTextFace([styles.senderName, typography.type.messageName, { color: author.color }], author.name)}
      >
        {author.name}
      </Text>
      <StatusBadge badge={author.statusBadge} apiBase={apiBase} size={16} />
    </View>
  ) : null;
  return (
    <View style={[styles.row, own && styles.rowOwn, groupMessage && styles.groupRow]}>
      {groupMessage && author ? <AvatarMedia tile={author.avatar} size={36} /> : null}
      <View style={[styles.stack, own && styles.stackOwn, groupMessage ? styles.stackGroup : styles.stackSingle]}>
        {!own && !orderedBlocks.length && msg.trace ? <TraceBlock trace={msg.trace} /> : null}
        {orderedBlocks.length ? (
          <>
            {senderHeader}
            <AssistantContentBlocks blocks={orderedBlocks} message={msg} onLongPress={onLongPress} />
            <AttachmentList attachments={msg.attachments} apiBase={apiBase} own={own} />
          </>
        ) : (
          <Pressable
            onLongPress={
              onLongPress
                ? () => {
                    Haptics.selectionAsync();
                    onLongPress(msg);
                  }
                : undefined
            }
            delayLongPress={300}
            style={[
              styles.bubble,
              own ? styles.own : styles.other,
              msg.isPending ? styles.pending : null,
              msg.failed ? styles.failed : null,
            ]}
          >
            <AttachmentList attachments={msg.attachments} apiBase={apiBase} own={own} />
            {senderHeader}
            {msg.bodyMd ? (
              <Markdown
                style={{
                  body: { ...typography.type.chatMessage, color: textColor, margin: 0 },
                  paragraph: { marginTop: 0, marginBottom: 0 },
                  code_inline: { ...typography.type.code, backgroundColor: "rgba(0,0,0,0.06)", color: textColor, borderWidth: 0 },
                  fence: { ...typography.type.code, backgroundColor: color.codeBg, color: color.codeText, borderWidth: 0, borderRadius: 10, padding: 10 },
                  link: { color: color.accent },
                }}
              >
                {msg.bodyMd}
              </Markdown>
            ) : null}
          </Pressable>
        )}
        {timeText ? (
          <Text
            allowFontScaling={false}
            style={withAndroidTextFace([styles.meta, typography.type.messageMeta, own ? styles.metaOwn : styles.metaOther], timeText)}
          >
            {timeText}
          </Text>
        ) : null}
        {statusText ? (
          <Text
            allowFontScaling={false}
            style={withAndroidTextFace([styles.meta, styles.status, typography.type.messageMeta, own ? styles.metaOwn : styles.metaOther, msg.failed ? styles.metaFailed : null], statusText)}
          >
            {statusText}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { width: "100%", marginVertical: 3, paddingHorizontal: 0, flexDirection: "row", alignItems: "flex-end", gap: 6 },
  rowOwn: { flexDirection: "row-reverse" },
  groupRow: { gap: 6 },
  stack: { minWidth: 0, gap: 6, alignItems: "flex-start" },
  stackOwn: { alignItems: "flex-end" },
  stackSingle: { maxWidth: "88%" },
  stackGroup: { maxWidth: "78%" },
  bubble: { maxWidth: "100%", paddingHorizontal: 15, paddingVertical: 10, borderRadius: radius.bubble },
  own: { backgroundColor: color.userBubble },
  other: { backgroundColor: color.bubbleOther },
  pending: { opacity: 0.55 },
  failed: { borderWidth: 1, borderColor: color.danger },
  senderRow: { flexDirection: "row", alignItems: "center", gap: 0, marginBottom: 3, maxWidth: "100%" },
  senderName: { maxWidth: 180 },
  meta: { marginTop: -2, marginLeft: 6, color: color.floorFaint, fontWeight: "500" },
  status: { marginTop: -4 },
  metaOwn: { alignSelf: "flex-end", marginLeft: 0, marginRight: 6, color: color.floorFaint },
  metaOther: { alignSelf: "flex-start", color: color.floorFaint },
  metaFailed: { color: color.danger },
  systemRow: { alignItems: "center", marginVertical: space.sm },
  systemText: {
    maxWidth: "82%",
    overflow: "hidden",
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
    color: color.inkFaint,
    backgroundColor: "rgba(0,0,0,0.045)",
  },
});
