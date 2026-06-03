import { Modal, Pressable, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { color, space, radius, hairlineWidth } from "../theme";
import { Body } from "../ui/Text";
import type { ChatMessage } from "../api/types";

// 长按消息弹出的置底动作表。复制对所有消息可用;重发仅失败消息;删除走云端微信式本地隐藏。
export default function MessageActions({
  msg,
  onClose,
  onCopy,
  onResend,
  onDelete,
}: {
  msg: ChatMessage | null;
  onClose: () => void;
  onCopy: (m: ChatMessage) => void;
  onResend: (m: ChatMessage) => void;
  onDelete: (m: ChatMessage) => void;
}) {
  const insets = useSafeAreaInsets();
  const actions: { key: string; label: string; danger?: boolean; run: (m: ChatMessage) => void }[] = [];
  if (msg) {
    actions.push({ key: "copy", label: "复制", run: onCopy });
    if (msg.failed) actions.push({ key: "resend", label: "重发", run: onResend });
    actions.push({ key: "delete", label: "删除", danger: true, run: onDelete });
  }

  return (
    <Modal visible={!!msg} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={[styles.sheet, { paddingBottom: space.lg + insets.bottom }]} onPress={() => {}}>
          {actions.map((a, i) => (
            <Pressable
              key={a.key}
              style={[styles.action, i > 0 ? styles.actionBorder : null]}
              onPress={() => {
                if (msg) a.run(msg);
                onClose();
              }}
            >
              <Body style={a.danger ? styles.danger : undefined}>{a.label}</Body>
            </Pressable>
          ))}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.18)" },
  sheet: {
    backgroundColor: color.surface,
    borderTopLeftRadius: radius.bubble,
    borderTopRightRadius: radius.bubble,
    paddingHorizontal: space.lg,
    shadowColor: "#141828",
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: -6 },
    elevation: 16,
  },
  action: { paddingVertical: space.md, alignItems: "center" },
  actionBorder: { borderTopWidth: hairlineWidth, borderTopColor: color.line },
  danger: { color: color.danger },
});
