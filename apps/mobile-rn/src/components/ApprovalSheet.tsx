import { View, Text, Pressable, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { theme } from "../theme";
import { useApi } from "../state/clientProvider";
import { useEvents } from "../state/events";
import { PermissionDecision, decisionToHermesChoice, type PermissionDecisionT } from "../api/types";

// MVP:固定置底的审批卡(拇指区,不被划走)。@gorhom/bottom-sheet 已装,
// 后续要拖拽手势再换;当前用绝对定位 View 以求行为可靠、零手势依赖。
export default function ApprovalSheet() {
  const api = useApi();
  const { activeApproval, resolveApproval } = useEvents();
  const insets = useSafeAreaInsets();
  if (!activeApproval) return null;

  const decide = async (decision: PermissionDecisionT) => {
    const { conversationId, runId } = activeApproval;
    resolveApproval(runId); // 乐观推进到下一条
    try {
      await api.api(
        `/api/conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(runId)}/approval`,
        { method: "POST", body: { decision, choice: decisionToHermesChoice(decision) } }
      );
    } catch {
      // run 可能已失效:静默,sheet 已前进
    }
  };

  return (
    <View style={[styles.sheet, { paddingBottom: 14 + insets.bottom }]}>
      <Text style={styles.title}>⚠ 请求权限</Text>
      <Text style={styles.preview}>{activeApproval.preview}</Text>
      <View style={styles.actions}>
        <Pressable style={[styles.btn, styles.ghost]} onPress={() => decide(PermissionDecision.Deny)}>
          <Text style={styles.ghostText}>拒绝</Text>
        </Pressable>
        <Pressable style={[styles.btn, styles.primary]} onPress={() => decide(PermissionDecision.AllowOnce)}>
          <Text style={styles.primaryText}>允许</Text>
        </Pressable>
        <Pressable style={[styles.btn, styles.ghost]} onPress={() => decide(PermissionDecision.AllowAlways)}>
          <Text style={styles.ghostText}>始终</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.card,
    borderTopWidth: 2,
    borderTopColor: "#f0c89a",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 14,
    paddingTop: 14,
    shadowColor: "#000",
    shadowOpacity: 0.1,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -4 },
    elevation: 12,
  },
  title: { fontWeight: "600", color: theme.warn, marginBottom: 6 },
  preview: { color: "#555", fontSize: 13, marginBottom: 12 },
  actions: { flexDirection: "row", gap: 8 },
  btn: { flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: "center" },
  ghost: { borderWidth: 1, borderColor: theme.line },
  ghostText: { color: theme.text },
  primary: { backgroundColor: theme.accent },
  primaryText: { color: "#fff", fontWeight: "600" },
});
