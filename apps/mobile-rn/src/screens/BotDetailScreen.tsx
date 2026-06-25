import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import Avatar from "../components/Avatar";
import StatusBadge from "../components/StatusBadge";
import StatusBadgeEmptyIcon from "../components/StatusBadgeEmptyIcon";
import { resolveAvatar } from "../logic/conversationList";
import { STATUS_BADGE_CHOICES, statusBadgeForValue, statusBadgeValue as statusBadgeValueForBadge } from "../logic/statusBadgeAssets";
import { useAuth } from "../state/auth";
import { useBotDetail, useBotRuntime, useDeleteBot, useSaveBotIdentity } from "../state/queries";
import Button from "../ui/Button";
import Input from "../ui/Input";
import StateBlock from "../ui/StateBlock";
import { Body, BodyStrong, Label, Sub } from "../ui/Text";
import { useTypography } from "../ui/TypographyProvider";
import { color, space, hairlineWidth } from "../theme";
import type { ContactsStackParamList } from "../navigation/types";

type Props = NativeStackScreenProps<ContactsStackParamList, "BotDetail">;

function Row({ label, value }: { label: string; value: string }) {
  const typography = useTypography();
  return (
    <View style={styles.row}>
      <Body style={typography.type.settingTitle}>{label}</Body>
      <Body style={[styles.value, typography.type.settingTitle]}>{value}</Body>
    </View>
  );
}

export default function BotDetailScreen({ navigation, route }: Props) {
  const typography = useTypography();
  const { apiBase } = useAuth();
  const [name, setName] = useState(route.params.title || "");
  const [personaText, setPersonaText] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [badgeOpen, setBadgeOpen] = useState(false);
  const [statusBadgeValue, setStatusBadgeValue] = useState("");
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
    setStatusBadgeValue(statusBadgeValueForBadge(data?.statusBadge || data?.status_badge || null));
  }, [data?.id, data?.key, title, persona, data?.statusBadge, data?.status_badge]);

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
          statusBadge: statusBadgeForValue(statusBadgeValue),
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
          <BodyStrong style={typography.type.listTitle}>{title}</BodyStrong>
          <Sub style={typography.type.settingDetail}>{route.params.botId}</Sub>
        </View>
      </View>
      <View style={styles.section}>
        <Row label="运行时" value={runtime.data?.runtimeKind || "cloud-hermes"} />
        <Row label="启用" value={runtime.data?.enabled === false ? "否" : "是"} />
        <Row label="所有者" value={data.ownerUserId || data.owner_user_id || ""} />
      </View>
      <View style={styles.section}>
        <Label style={typography.type.settingHeader}>编辑</Label>
        <Label style={typography.type.settingDetail}>姓名</Label>
        <View style={styles.identityLine}>
          {editingName ? (
            <TextInput
              value={name}
              onChangeText={setName}
              onBlur={() => setEditingName(false)}
              onSubmitEditing={() => setEditingName(false)}
              autoFocus
              allowFontScaling={false}
              style={[styles.nameInput, typography.type.input]}
            />
          ) : (
            <Pressable style={styles.nameTextButton} onPress={() => setEditingName(true)}>
              <BodyStrong style={[styles.inlineName, typography.type.settingTitle]}>{name || title}</BodyStrong>
            </Pressable>
          )}
          <Pressable
            style={[styles.badgeTrigger, !statusBadgeForValue(statusBadgeValue) && styles.badgeTriggerEmpty]}
            onPress={() => setBadgeOpen((v) => !v)}
          >
            <StatusBadge badge={statusBadgeForValue(statusBadgeValue)} apiBase={apiBase} size={22} />
            {!statusBadgeForValue(statusBadgeValue) ? <StatusBadgeEmptyIcon size={22} strokeColor={color.inkMuted} /> : null}
          </Pressable>
        </View>
        {badgeOpen ? (
          <View style={styles.badgeChoices}>
            {STATUS_BADGE_CHOICES.map(({ value, label }) => (
              <Button
                key={value}
                label={label}
                variant={statusBadgeValue === value ? "primary" : "outline"}
                style={styles.badgeButton}
                onPress={() => {
                  setStatusBadgeValue(value);
                  setBadgeOpen(false);
                }}
              />
            ))}
          </View>
        ) : null}
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
  identityLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  nameTextButton: { flex: 1, minWidth: 0, paddingVertical: 4 },
  inlineName: {},
  nameInput: {
    flex: 1,
    minWidth: 0,
    borderRadius: 10,
    backgroundColor: color.surfaceMuted,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: color.ink,
  },
  badgeTrigger: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 15,
  },
  badgeTriggerEmpty: {
    opacity: 0.78,
  },
  badgeChoices: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  badgeButton: { minWidth: 92, height: 38 },
});
