import { useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import Avatar from "../components/Avatar";
import { resolveAvatar } from "../logic/conversationList";
import { useBotDetail, useBotRuntime, useDeleteBot, useSaveBotIdentity } from "../state/queries";
import Button from "../ui/Button";
import Input from "../ui/Input";
import StateBlock from "../ui/StateBlock";
import { Body, BodyStrong, Label, Sub, Title } from "../ui/Text";
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

export default function BotDetailScreen({ navigation, route }: Props) {
  const [name, setName] = useState(route.params.title || "");
  const [personaText, setPersonaText] = useState("");
  const [status, setStatus] = useState("");
  const bot = useBotDetail(route.params.botId);
  const runtime = useBotRuntime(route.params.botId);
  const saveIdentity = useSaveBotIdentity();
  const deleteBot = useDeleteBot();
  const data = bot.data;
  const title = data?.displayName || data?.display_name || data?.name || route.params.title;
  const persona = data?.personaText || data?.persona_text || data?.bio || data?.description || "";
  const avatar = resolveAvatar(route.params.botId, title, data?.avatarImage || data?.avatar_image || "", data?.avatarCrop || data?.avatar_crop || null);

  useEffect(() => {
    if (!data) return;
    setName(title);
    setPersonaText(persona);
  }, [data?.id, data?.key, title, persona]);

  async function save() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setStatus("请输入智能体名称");
      return;
    }
    setStatus("");
    try {
      await saveIdentity.mutateAsync({
        botId: route.params.botId,
        body: {
          name: trimmedName,
          bio: personaText,
          personaText,
          color: data?.color || "",
          avatarImage: data?.avatarImage || data?.avatar_image || "",
          avatarCrop: data?.avatarCrop || data?.avatar_crop || null,
          capabilities: data?.capabilities || { legacyCapabilities: ["chat", "files", "terminal", "code"] },
        },
      });
      setStatus("已保存");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "保存失败");
    }
  }

  function confirmDelete() {
    Alert.alert("删除智能体", "删除后会从当前账号的智能体列表移除。", [
      { text: "取消", style: "cancel" },
      {
        text: "删除",
        style: "destructive",
        onPress: async () => {
          setStatus("");
          try {
            await deleteBot.mutateAsync({ botId: route.params.botId });
            navigation.goBack();
          } catch (err) {
            setStatus(err instanceof Error ? err.message : "删除失败");
          }
        },
      },
    ]);
  }

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
      <View style={styles.section}>
        <Title>编辑</Title>
        <Input value={name} onChangeText={setName} placeholder="名称" />
        <Input
          value={personaText}
          onChangeText={setPersonaText}
          placeholder="人设"
          multiline
          textAlignVertical="top"
          style={styles.persona}
        />
        <Button label="保存" onPress={save} busy={saveIdentity.isPending} disabled={!name.trim()} />
        <Button label="删除智能体" variant="danger" onPress={confirmDelete} busy={deleteBot.isPending} />
        {status ? <Sub style={styles.status}>{status}</Sub> : null}
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
  persona: { minHeight: 110 },
  status: { color: color.inkMuted },
});
