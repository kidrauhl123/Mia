import { SectionList, StyleSheet, View } from "react-native";
import { useBridgeDevices, useBridgeRuns } from "../state/queries";
import { bridgeStatusText, bridgeStatusTone, formatBridgeTime, type BridgeStatusTone } from "../logic/bridgeStatus";
import StateBlock from "../ui/StateBlock";
import { BodyStrong, Label, Sub } from "../ui/Text";
import { color, space, hairlineWidth } from "../theme";

export default function AgentsScreen() {
  const devices = useBridgeDevices();
  const runs = useBridgeRuns();
  const loading = devices.isLoading || runs.isLoading;
  const error = devices.error || runs.error;
  const deviceRows = (devices.data || []).map((d, index) => ({
    key: `device:${d.id || d.deviceId || index}`,
    title: d.deviceName || d.name || d.deviceId || d.id || "桌面设备",
    subtitle: `${d.engine || d.platform || "桌面"} · ${bridgeStatusText(d.connected ?? d.status)}`,
    meta: formatBridgeTime(d.lastSeenAt || d.connectedAt || ""),
    tone: bridgeStatusTone(d.connected ?? d.status),
  }));
  const runRows = (runs.data || []).map((r, index) => ({
    key: `run:${r.id || r.runId || index}`,
    title: r.text || r.command || r.runId || r.id || "运行记录",
    subtitle: bridgeStatusText(r.status),
    meta: formatBridgeTime(r.updatedAt || r.completedAt || r.createdAt || ""),
    tone: bridgeStatusTone(r.status),
  }));
  const sections = [
    { title: "桌面设备", data: deviceRows },
    { title: "最近运行", data: runRows },
  ].filter((section) => section.data.length);

  if (loading) return <StateBlock title="加载运行状态…" />;
  if (error) return <StateBlock title="运行状态加载失败" detail={String((error as Error).message || error)} />;
  if (!sections.length) return <StateBlock title="暂无桌面运行状态" detail="登录同一账号的桌面端上线后会显示在这里。" />;

  return (
    <SectionList
      style={styles.root}
      sections={sections}
      keyExtractor={(item) => item.key}
      renderSectionHeader={({ section }) => <Label style={styles.sectionTitle}>{section.title}</Label>}
      renderItem={({ item }) => (
        <View style={styles.row}>
          <View style={[styles.dot, toneStyle(item.tone)]} />
          <View style={styles.text}>
            <BodyStrong numberOfLines={1}>{item.title}</BodyStrong>
            <Sub numberOfLines={1}>{item.subtitle}</Sub>
          </View>
          {item.meta ? <Label style={styles.meta}>{item.meta}</Label> : null}
        </View>
      )}
    />
  );
}

function toneStyle(tone: BridgeStatusTone) {
  if (tone === "online") return styles.dotOnline;
  if (tone === "running") return styles.dotRunning;
  if (tone === "success") return styles.dotSuccess;
  if (tone === "danger") return styles.dotDanger;
  return styles.dotIdle;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  sectionTitle: {
    backgroundColor: color.bg,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.sm,
    color: color.inkFaint,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: hairlineWidth,
    borderBottomColor: color.line,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  dotOnline: { backgroundColor: color.accent2 },
  dotRunning: { backgroundColor: color.accent },
  dotSuccess: { backgroundColor: color.inkFaint },
  dotDanger: { backgroundColor: color.danger },
  dotIdle: { backgroundColor: color.lineStrong },
  text: { flex: 1, minWidth: 0, gap: 3 },
  meta: { maxWidth: 120, textAlign: "right" },
});
