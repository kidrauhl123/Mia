import { FlatList, StyleSheet, View } from "react-native";
import { useBridgeDevices, useBridgeRuns } from "../state/queries";
import StateBlock from "../ui/StateBlock";
import { BodyStrong, Label, Sub } from "../ui/Text";
import { color, space, hairlineWidth } from "../theme";

function statusText(value: unknown): string {
  if (value === true) return "online";
  if (value === false) return "offline";
  return String(value || "unknown");
}

export default function AgentsScreen() {
  const devices = useBridgeDevices();
  const runs = useBridgeRuns();
  const loading = devices.isLoading || runs.isLoading;
  const error = devices.error || runs.error;
  const items = [
    ...(devices.data || []).map((d, index) => ({
      key: `device:${d.id || d.deviceId || index}`,
      title: d.deviceName || d.name || d.deviceId || d.id || "Desktop device",
      subtitle: `${d.engine || d.platform || "desktop"} · ${statusText(d.connected ?? d.status)}`,
      meta: d.lastSeenAt || d.connectedAt || "",
    })),
    ...(runs.data || []).map((r, index) => ({
      key: `run:${r.id || r.runId || index}`,
      title: r.text || r.command || r.runId || r.id || "Bridge run",
      subtitle: statusText(r.status),
      meta: r.updatedAt || r.completedAt || r.createdAt || "",
    })),
  ];

  if (loading) return <StateBlock title="加载运行状态…" />;
  if (error) return <StateBlock title="运行状态加载失败" detail={String((error as Error).message || error)} />;
  if (!items.length) return <StateBlock title="暂无桌面运行状态" detail="登录同一账号的桌面端上线后会显示在这里。" />;

  return (
    <FlatList
      style={styles.root}
      data={items}
      keyExtractor={(item) => item.key}
      renderItem={({ item }) => (
        <View style={styles.row}>
          <View style={styles.dot} />
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

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: hairlineWidth,
    borderBottomColor: color.line,
  },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: color.accent },
  text: { flex: 1, minWidth: 0, gap: 3 },
  meta: { maxWidth: 120, textAlign: "right" },
});
