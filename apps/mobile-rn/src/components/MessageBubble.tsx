import { View, Pressable, StyleSheet, Text } from "react-native";
import * as Haptics from "expo-haptics";
import Markdown from "react-native-markdown-display";
import { color, radius, space } from "../theme";
import { withAndroidTextFace } from "../ui/androidTextFace";
import { useTypography } from "../ui/TypographyProvider";
import AttachmentList from "./AttachmentList";
import TraceBlock from "./TraceBlock";
import StatusBadge from "./StatusBadge";
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
  if (msg.isPending) return "发送中";
  return "";
}

// 对齐桌面 .bubble:对方=浅灰深字、自己=靛蓝白字,圆角 18,padding 10/15。
export default function MessageBubble({
  msg,
  apiBase,
  members = [],
  onLongPress,
}: {
  msg: ChatMessage;
  apiBase: string;
  members?: Member[];
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
  const textColor = own ? color.userBubbleText : color.ink;
  const author = own ? null : resolveMessageAuthor(msg, members);
  const timeText = formatMessageTime(msg.createdAt);
  const statusText = deliveryText(msg);
  const metaText = [timeText, statusText].filter(Boolean).join(" · ");
  return (
    <View style={[styles.row, own ? styles.rowOwn : styles.rowOther]}>
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
        {!own && msg.trace ? <TraceBlock trace={msg.trace} /> : null}
        {!own && author?.name ? (
          <View style={styles.senderRow}>
            <Text allowFontScaling={false} numberOfLines={1} style={withAndroidTextFace([styles.senderName, typography.type.messageName], author.name)}>{author.name}</Text>
            <StatusBadge badge={author.statusBadge} apiBase={apiBase} size={16} />
          </View>
        ) : null}
        {msg.bodyMd ? (
          <Markdown
            style={{
              body: { ...typography.type.chatMessage, color: textColor, margin: 0 },
              paragraph: { marginTop: 0, marginBottom: 0 },
              code_inline: { ...typography.type.code, backgroundColor: own ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.06)", color: textColor, borderWidth: 0 },
              fence: { ...typography.type.code, backgroundColor: color.codeBg, color: color.codeText, borderWidth: 0, borderRadius: 10, padding: 10 },
              link: { color: own ? "#fff" : color.accent },
            }}
          >
            {msg.bodyMd}
          </Markdown>
        ) : null}
        <AttachmentList attachments={msg.attachments} apiBase={apiBase} own={own} />
        {metaText ? (
          <Text
            allowFontScaling={false}
            style={withAndroidTextFace([styles.meta, typography.type.messageMeta, own ? styles.metaOwn : styles.metaOther, msg.failed ? styles.metaFailed : null], metaText)}
          >
            {metaText}
          </Text>
        ) : null}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { width: "100%", marginVertical: 3 },
  rowOwn: { alignItems: "flex-end" },
  rowOther: { alignItems: "flex-start" },
  bubble: { maxWidth: "78%", paddingHorizontal: 15, paddingVertical: 10, borderRadius: radius.bubble },
  own: { backgroundColor: color.userBubble },
  other: { backgroundColor: color.bubbleOther },
  pending: { opacity: 0.55 },
  failed: { borderWidth: 1, borderColor: color.danger },
  senderRow: { flexDirection: "row", alignItems: "center", gap: 0, marginBottom: 3, maxWidth: "100%" },
  senderName: { color: color.inkMuted, maxWidth: 180 },
  meta: { alignSelf: "flex-end", marginTop: 3 },
  metaOwn: { color: "rgba(255,255,255,0.72)" },
  metaOther: { color: color.inkFaint },
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
