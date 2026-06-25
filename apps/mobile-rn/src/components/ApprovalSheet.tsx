import { useEffect, useState } from "react";
import { View, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { color, space, radius, hairlineWidth } from "../theme";
import { Label, Body } from "../ui/Text";
import { useTypography } from "../ui/TypographyProvider";
import Button from "../ui/Button";
import { useApi } from "../state/clientProvider";
import { useEvents } from "../state/events";
import { approvalDecisionErrorText, approvalQueueLabel } from "../logic/approvalUi";
import { PermissionDecision, decisionToHermesChoice, type PermissionDecisionT } from "../api/types";

// Swiss:固定置底审批卡 —— 白底 + 顶部强黑规则线 + 橙色「允许」。
export default function ApprovalSheet() {
  const typography = useTypography();
  const api = useApi();
  const { activeApproval, pendingApprovalCount, resolveApproval } = useEvents();
  const insets = useSafeAreaInsets();
  const [error, setError] = useState("");

  useEffect(() => {
    setError("");
  }, [activeApproval?.runId]);

  if (!activeApproval) return null;

  const decide = async (decision: PermissionDecisionT) => {
    const { conversationId, runId } = activeApproval;
    setError("");
    try {
      await api.api(
        `/api/conversations/${conversationId}/runs/${encodeURIComponent(runId)}/approval`,
        { method: "POST", body: { decision, choice: decisionToHermesChoice(decision) } }
      );
      resolveApproval(runId);
    } catch (err) {
      setError(approvalDecisionErrorText(err));
    }
  };

  const dismissFailed = () => {
    if (activeApproval?.runId) {
      resolveApproval(activeApproval.runId);
      setError("");
    }
  };

  return (
    <View style={[styles.sheet, { paddingBottom: space.lg + insets.bottom }]}>
      <View style={styles.markRow}>
        <View style={styles.mark} />
        <Label style={typography.type.settingHeader}>{approvalQueueLabel(pendingApprovalCount)}</Label>
      </View>
      <Body style={styles.preview}>{activeApproval.preview}</Body>
      {error ? <Body style={styles.error}>{error}</Body> : null}
      <View style={styles.actions}>
        <Button label="拒绝" variant="outline" style={styles.btn} onPress={() => decide(PermissionDecision.Deny)} />
        <Button label="允许" style={styles.btn} onPress={() => decide(PermissionDecision.AllowOnce)} />
        <Button label="始终" variant="outline" style={styles.btn} onPress={() => decide(PermissionDecision.AllowAlways)} />
      </View>
      {error ? <Button label="忽略此请求" variant="ghost" onPress={dismissFailed} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: color.surface,
    borderTopLeftRadius: radius.bubble,
    borderTopRightRadius: radius.bubble,
    borderTopWidth: hairlineWidth,
    borderColor: color.line,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    shadowColor: "#141828",
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: -6 },
    elevation: 16,
  },
  markRow: { flexDirection: "row", alignItems: "center", gap: space.sm, marginBottom: space.sm },
  mark: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.warn },
  preview: { marginBottom: space.lg },
  error: { color: color.danger, marginBottom: space.md },
  actions: { flexDirection: "row", gap: space.sm },
  btn: { flex: 1, paddingHorizontal: space.xs },
});
