import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useAuth } from "../state/auth";
import { usePush } from "../notifications/PushProvider";
import { useBridgeDevices, useMe, useSaveProfile, useUserSettings } from "../state/queries";
import { resolveAvatar } from "../logic/avatar";
import AvatarMedia from "../components/AvatarMedia";
import StatusBadge from "../components/StatusBadge";
import StatusBadgeEmptyIcon from "../components/StatusBadgeEmptyIcon";
import { STATUS_BADGE_CHOICES, statusBadgeForValue, statusBadgeValue } from "../logic/statusBadgeAssets";
import Button from "../ui/Button";
import StateBlock from "../ui/StateBlock";
import { Body, BodyStrong, Brand, Label, Sub } from "../ui/Text";
import { color, space, hairlineWidth } from "../theme";
import UpdateSettingsCard from "../updates/UpdateSettingsCard";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Label>{label}</Label>
      <Body style={styles.value}>{value}</Body>
    </View>
  );
}

export default function SettingsScreen() {
  const { session, apiBase } = useAuth();
  const { logout } = usePush();
  const me = useMe();
  const saveProfile = useSaveProfile();
  const [nameDraft, setNameDraft] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [badgeOpen, setBadgeOpen] = useState(false);
  const settings = useUserSettings();
  const devices = useBridgeDevices();
  const loading = me.isLoading || settings.isLoading;
  const error = me.error || settings.error;
  const appearance = settings.data?.appearance || {};
  const userId = me.data?.id || session?.user?.id || "";
  const username = me.data?.username || session?.user?.username || "未登录";
  const avatar = resolveAvatar(userId, username, me.data?.avatarImage || "", me.data?.avatarCrop || null);
  const badgeValue = statusBadgeValue(me.data?.statusBadge || null);

  useEffect(() => {
    setNameDraft(me.data?.displayName || me.data?.username || session?.user?.username || "");
  }, [me.data?.displayName, me.data?.username, session?.user?.username]);

  function saveName() {
    const displayName = nameDraft.trim();
    setEditingName(false);
    if (!displayName || displayName === (me.data?.displayName || me.data?.username || "")) return;
    saveProfile.mutate({ displayName });
  }

  if (loading) return <StateBlock title="加载设置…" />;
  if (error) return <StateBlock title="设置加载失败" detail={String((error as Error).message || error)} />;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.head}>
        <AvatarMedia tile={avatar} size={64} />
        <View style={styles.headText}>
          <Brand style={styles.name}>{username}</Brand>
          <Sub>{session?.apiBase || ""}</Sub>
        </View>
      </View>
      <View style={styles.section}>
        <BodyStrong>账号</BodyStrong>
        <Label>名字</Label>
        <View style={styles.identityLine}>
          {editingName ? (
            <TextInput
              value={nameDraft}
              onChangeText={setNameDraft}
              onBlur={saveName}
              onSubmitEditing={saveName}
              autoFocus
              style={styles.nameInput}
            />
          ) : (
            <Pressable style={styles.nameTextButton} onPress={() => setEditingName(true)}>
              <Brand style={styles.inlineName}>{nameDraft || username}</Brand>
            </Pressable>
          )}
          <Pressable style={[styles.badgeTrigger, !me.data?.statusBadge && styles.badgeTriggerEmpty]} onPress={() => setBadgeOpen((v) => !v)}>
            <StatusBadge badge={me.data?.statusBadge || null} apiBase={apiBase} size={24} />
            {!me.data?.statusBadge ? <StatusBadgeEmptyIcon size={24} strokeColor={color.inkMuted} /> : null}
          </Pressable>
        </View>
        {badgeOpen ? (
          <View style={styles.badgeChoices}>
            {STATUS_BADGE_CHOICES.map(({ value, label }) => (
              <Button
                key={value}
                label={label}
                variant={badgeValue === value ? "primary" : "outline"}
                disabled={saveProfile.isPending}
                style={styles.badgeButton}
                onPress={() => {
                  setBadgeOpen(false);
                  saveProfile.mutate({ statusBadge: statusBadgeForValue(value) });
                }}
              />
            ))}
          </View>
        ) : null}
        <Row label="用户名" value={username} />
        <Row label="用户 ID" value={userId} />
        <Button label="退出登录" variant="danger" onPress={() => { logout(); }} />
      </View>
      <UpdateSettingsCard />
      <View style={styles.section}>
        <BodyStrong>同步</BodyStrong>
        <Row label="设置版本" value={String(settings.data?.version || 0)} />
        <Row label="置顶会话" value={String(settings.data?.pins?.length || 0)} />
        <Row label="桌面设备" value={String(devices.data?.length || 0)} />
      </View>
      <View style={styles.section}>
        <BodyStrong>外观</BodyStrong>
        <Row label="主题" value={String(appearance.theme || "light")} />
        <Row label="列表样式" value={String(appearance.listStyle || "default")} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  content: { padding: space.lg, gap: space.lg },
  head: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.md },
  headText: { flex: 1, gap: 4 },
  name: { fontSize: 22 },
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
  identityLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  nameTextButton: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 4,
  },
  inlineName: {
    fontSize: 22,
  },
  nameInput: {
    flex: 1,
    minWidth: 0,
    borderRadius: 10,
    backgroundColor: color.surfaceMuted,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: color.ink,
    fontSize: 20,
    fontWeight: "700",
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
  badgeChoices: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.sm,
  },
  badgeButton: {
    minWidth: 92,
    height: 38,
  },
});
