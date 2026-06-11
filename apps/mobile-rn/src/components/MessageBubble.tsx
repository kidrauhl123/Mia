import { View, Pressable, StyleSheet, Text } from "react-native";
import * as Haptics from "expo-haptics";
import Markdown from "react-native-markdown-display";
import { color, radius, space } from "../theme";
import AttachmentList from "./AttachmentList";
import TraceBlock from "./TraceBlock";
import StatusBadge from "./StatusBadge";
import { resolveMessageAuthor } from "../logic/messageAuthor";
import type { ChatMessage, Member } from "../api/types";

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
  const own = msg.isOwn;
  const textColor = own ? color.userBubbleText : color.ink;
  const author = own ? null : resolveMessageAuthor(msg, members);
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
            <Text numberOfLines={1} style={styles.senderName}>{author.name}</Text>
            <StatusBadge badge={author.statusBadge} apiBase={apiBase} size={12} />
          </View>
        ) : null}
        <Markdown
          style={{
            body: { color: textColor, margin: 0, fontSize: 15, lineHeight: 23 },
            code_inline: { backgroundColor: own ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.06)", color: textColor, borderWidth: 0 },
            fence: { backgroundColor: color.codeBg, color: color.codeText, borderWidth: 0, borderRadius: 10, padding: 10 },
            link: { color: own ? "#fff" : color.accent },
          }}
        >
          {msg.bodyMd || ""}
        </Markdown>
        <AttachmentList attachments={msg.attachments} apiBase={apiBase} own={own} />
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
  senderRow: { flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 3, maxWidth: "100%" },
  senderName: { color: color.inkMuted, fontSize: 12, fontWeight: "600", maxWidth: 180 },
});
