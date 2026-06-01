import { View, StyleSheet } from "react-native";
import Markdown from "react-native-markdown-display";
import { theme } from "../theme";
import TraceBlock from "./TraceBlock";
import type { ChatMessage } from "../api/types";

export default function MessageBubble({ msg }: { msg: ChatMessage }) {
  const own = msg.isOwn;
  return (
    <View
      style={[
        styles.bubble,
        own ? styles.own : styles.other,
        msg.isPending ? styles.pending : null,
        msg.failed ? styles.failed : null,
      ]}
    >
      {!own && msg.trace ? <TraceBlock trace={msg.trace} /> : null}
      <Markdown style={{ body: { color: own ? "#fff" : theme.text, margin: 0 } }}>{msg.bodyMd || ""}</Markdown>
    </View>
  );
}

const styles = StyleSheet.create({
  bubble: { maxWidth: "82%", paddingHorizontal: 11, paddingVertical: 8, borderRadius: 14, marginVertical: 4 },
  own: { alignSelf: "flex-end", backgroundColor: theme.accent },
  other: { alignSelf: "flex-start", backgroundColor: theme.card },
  pending: { opacity: 0.55 },
  failed: { borderWidth: 1, borderColor: theme.danger },
});
