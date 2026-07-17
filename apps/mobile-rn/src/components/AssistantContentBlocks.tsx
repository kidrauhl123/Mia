import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Markdown from "react-native-markdown-display";
import { color, hairlineWidth, radius, space } from "../theme";
import { withAndroidTextFace } from "../ui/androidTextFace";
import { useTypography } from "../ui/TypographyProvider";
import type { AssistantContentBlock, ChatMessage } from "../api/types";

function processLabel(block: AssistantContentBlock): string {
  if (block.type === "thinking") return block.status === "running" ? "正在思考" : "思考过程";
  if (block.type === "tool") return `工具 · ${block.name || "运行"}`;
  if (block.type === "file_edit") return block.title || block.path || "文件变更";
  return "过程";
}

function processDetail(block: AssistantContentBlock): string {
  if (block.type === "thinking") return block.text || "";
  if (block.type === "tool") return block.preview || "";
  if (block.type === "file_edit") return block.diff || block.path || "";
  return "";
}

function ProcessBlock({ block }: { block: AssistantContentBlock }) {
  const typography = useTypography();
  const [open, setOpen] = useState(block.status === "running");
  const detail = processDetail(block);
  const failed = block.error || block.status === "error";
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => detail && setOpen((value) => !value)}
      style={[styles.process, failed && styles.processFailed]}
    >
      <View style={styles.processHead}>
        <Text allowFontScaling={false} style={withAndroidTextFace([styles.processLabel, typography.type.info], processLabel(block))}>
          {processLabel(block)}
        </Text>
        {detail ? (
          <Text allowFontScaling={false} style={withAndroidTextFace([styles.chevron, typography.type.caption], open ? "收起" : "展开")}>
            {open ? "收起" : "展开"}
          </Text>
        ) : null}
      </View>
      {open && detail ? (
        <Text selectable allowFontScaling={false} style={withAndroidTextFace([styles.processDetail, typography.type.code], detail)}>
          {detail}
        </Text>
      ) : null}
    </Pressable>
  );
}

export default function AssistantContentBlocks({
  blocks,
  message,
  onLongPress,
}: {
  blocks: AssistantContentBlock[];
  message: ChatMessage;
  onLongPress?: (message: ChatMessage) => void;
}) {
  const typography = useTypography();
  return (
    <View style={styles.wrap}>
      {blocks.map((block, index) => {
        const key = `${block.id || block.type}:${index}`;
        if (block.type === "text" || block.type === "recap") {
          const body = block.text || "";
          if (!body) return null;
          return (
            <Pressable
              key={key}
              delayLongPress={300}
              onLongPress={onLongPress ? () => onLongPress(message) : undefined}
              style={[styles.textBubble, block.type === "recap" && styles.recapBubble]}
            >
              {block.type === "recap" ? (
                <Text allowFontScaling={false} style={withAndroidTextFace([styles.recapLabel, typography.type.caption], "总结")}>总结</Text>
              ) : null}
              <Markdown
                style={{
                  body: { ...typography.type.chatMessage, color: color.ink, margin: 0 },
                  paragraph: { marginTop: 0, marginBottom: 0 },
                  code_inline: { ...typography.type.code, backgroundColor: "rgba(0,0,0,0.06)", color: color.ink, borderWidth: 0 },
                  fence: { ...typography.type.code, backgroundColor: color.codeBg, color: color.codeText, borderWidth: 0, borderRadius: 10, padding: 10 },
                  link: { color: color.accent },
                }}
              >
                {body}
              </Markdown>
            </Pressable>
          );
        }
        return <ProcessBlock key={key} block={block} />;
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: "100%", gap: 6 },
  textBubble: {
    maxWidth: "100%",
    paddingHorizontal: 15,
    paddingVertical: 10,
    borderRadius: radius.bubble,
    backgroundColor: color.bubbleOther,
  },
  recapBubble: { borderWidth: hairlineWidth, borderColor: color.line },
  recapLabel: { color: color.inkFaint, marginBottom: space.xs },
  process: {
    maxWidth: "100%",
    borderWidth: hairlineWidth,
    borderColor: color.line,
    borderRadius: radius.md,
    backgroundColor: color.surfaceMuted,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    gap: space.sm,
  },
  processFailed: { borderColor: color.danger },
  processHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md },
  processLabel: { color: color.inkMuted, flex: 1 },
  chevron: { color: color.inkFaint },
  processDetail: { color: color.inkMuted },
});
