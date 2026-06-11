import { StyleSheet, View } from "react-native";
import Button from "../ui/Button";
import { Body, BodyStrong, Label } from "../ui/Text";
import { color, hairlineWidth, space } from "../theme";
import { useUpdateStatus } from "./UpdateProvider";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Label>{label}</Label>
      <Body style={styles.value}>{value}</Body>
    </View>
  );
}

export default function UpdateSettingsCard() {
  const updates = useUpdateStatus();
  return (
    <View style={styles.section}>
      <BodyStrong>应用版本</BodyStrong>
      <Row label="版本" value={updates.installed.versionName || "未知"} />
      <Row label="构建号" value={updates.installed.buildVersion || "0"} />
      <Row label="运行时" value={updates.installed.runtimeVersion || "未知"} />
      <Row label="通道" value={updates.channel || "内置"} />
      <Row label="更新状态" value={updates.lastCheck} />
      <Button label="检查更新" variant="outline" busy={updates.checking} onPress={updates.checkNow} />
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: space.sm,
    paddingBottom: space.lg,
    borderBottomWidth: hairlineWidth,
    borderBottomColor: color.line,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: space.md,
  },
  value: {
    flex: 1,
    textAlign: "right",
    color: color.inkMuted,
  },
});
