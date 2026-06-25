import { StyleSheet, View } from "react-native";
import Button from "../ui/Button";
import { Body, BodyStrong, Label } from "../ui/Text";
import { useTypography } from "../ui/TypographyProvider";
import { color, hairlineWidth, space } from "../theme";
import { useUpdateStatus } from "./UpdateProvider";

function Row({ label, value }: { label: string; value: string }) {
  const typography = useTypography();
  return (
    <View style={styles.row}>
      <Body style={typography.type.settingTitle}>{label}</Body>
      <Body style={[styles.value, typography.type.settingTitle]}>{value}</Body>
    </View>
  );
}

export default function UpdateSettingsCard() {
  const typography = useTypography();
  const updates = useUpdateStatus();
  return (
    <View style={styles.section}>
      <BodyStrong style={typography.type.settingHeader}>应用版本</BodyStrong>
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
