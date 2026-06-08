import { ScrollView, StyleSheet, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import Avatar from "../components/Avatar";
import { resolveAvatar } from "../logic/conversationList";
import { useBotDetail, useBotRuntime } from "../state/queries";
import StateBlock from "../ui/StateBlock";
import { Body, BodyStrong, Label, Sub } from "../ui/Text";
import { color, space, hairlineWidth } from "../theme";
import type { ContactsStackParamList } from "../navigation/types";

type Props = NativeStackScreenProps<ContactsStackParamList, "BotDetail">;

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Label>{label}</Label>
      <Body style={styles.value}>{value}</Body>
    </View>
  );
}

export default function BotDetailScreen({ route }: Props) {
  const bot = useBotDetail(route.params.botId);
  const runtime = useBotRuntime(route.params.botId);
  const data = bot.data;
  const title = data?.displayName || data?.display_name || data?.name || route.params.title;
  const avatar = resolveAvatar(route.params.botId, title, data?.avatarImage || data?.avatar_image || "", data?.avatarCrop || data?.avatar_crop || null);

  if (bot.isLoading) return <StateBlock title="加载 Bot…" />;
  if (bot.error) return <StateBlock title="Bot 加载失败" detail={String((bot.error as Error).message || bot.error)} />;
  if (!data) return <StateBlock title="Bot 不存在" detail={route.params.botId} />;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.head}>
        <Avatar title={title} avatar={avatar} />
        <View style={styles.headText}>
          <BodyStrong>{title}</BodyStrong>
          <Sub>{route.params.botId}</Sub>
        </View>
      </View>
      <View style={styles.section}>
        <Row label="运行时" value={runtime.data?.runtimeKind || "cloud-hermes"} />
        <Row label="启用" value={runtime.data?.enabled === false ? "否" : "是"} />
        <Row label="所有者" value={data.ownerUserId || data.owner_user_id || ""} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  content: { padding: space.lg, gap: space.lg },
  head: { flexDirection: "row", alignItems: "center", gap: space.md },
  headText: { flex: 1, gap: 4 },
  section: { gap: space.sm, borderTopWidth: hairlineWidth, borderTopColor: color.line, paddingTop: space.lg },
  row: { flexDirection: "row", justifyContent: "space-between", gap: space.md },
  value: { flex: 1, textAlign: "right", color: color.inkMuted },
});
