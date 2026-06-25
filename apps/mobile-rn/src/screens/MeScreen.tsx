import { Pressable, View, StyleSheet } from "react-native";
import { useAuth } from "../state/auth";
import { usePush } from "../notifications/PushProvider";
import { useMe, useSaveUserSettings, useUserSettings } from "../state/queries";
import { resolveAvatar } from "../logic/avatar";
import { resolveMeProfile } from "../logic/meProfile";
import AvatarMedia from "../components/AvatarMedia";
import StatusBadge from "../components/StatusBadge";
import { useUpdateStatus } from "../updates/UpdateProvider";
import Button from "../ui/Button";
import { BodyStrong, Brand, Label, Sub } from "../ui/Text";
import { useTypography } from "../ui/TypographyProvider";
import {
  color,
  hairlineWidth,
  radius,
  space,
  normalizeTelegramFontSize,
  TELEGRAM_FONT_SIZE_OPTIONS,
} from "../theme";
import type { TelegramFontSize } from "../theme";

export default function MeScreen() {
  const typography = useTypography();
  const { session } = useAuth();
  const { logout } = usePush();
  const { data: me } = useMe();
  const settings = useUserSettings();
  const saveSettings = useSaveUserSettings();
  const updates = useUpdateStatus();
  const profile = resolveMeProfile(me, session?.user);
  const avatar = resolveAvatar(profile.uid, profile.displayName, profile.avatarImage, profile.avatarCrop);
  const apiBase = session?.apiBase || "";
  const fontSize = normalizeTelegramFontSize(settings.data?.appearance?.mobileFontSize);

  const setFontSize = (next: TelegramFontSize) => {
    if (next === fontSize) return;
    saveSettings.mutate({ appearance: { mobileFontSize: next } });
  };

  return (
    <View style={styles.root}>
      <View style={styles.head}>
        <AvatarMedia tile={avatar} size={64} />
        <View style={styles.headText}>
          <View style={styles.nameLine}>
            <Brand style={styles.name} numberOfLines={1}>{profile.displayName}</Brand>
            <StatusBadge badge={profile.statusBadge || null} apiBase={apiBase} size={24} />
          </View>
          <Sub style={styles.uid}>UID {profile.uid || "—"}</Sub>
        </View>
      </View>

      <View style={styles.block}>
        <Label style={typography.type.settingHeader}>显示</Label>
        <View style={styles.settingRow}>
          <BodyStrong style={[styles.settingTitle, typography.type.settingTitle]}>字体大小</BodyStrong>
          <View style={styles.segmented}>
            {TELEGRAM_FONT_SIZE_OPTIONS.map((option) => {
              const active = option.value === fontSize;
              return (
                <Pressable
                  key={option.value}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active, disabled: saveSettings.isPending }}
                  disabled={saveSettings.isPending}
                  onPress={() => setFontSize(option.value)}
                  style={({ pressed }) => [
                    styles.segment,
                    active && styles.segmentActive,
                    pressed && !active && styles.segmentPressed,
                  ]}
                >
                  <Label style={[typography.type.settingDetail, styles.segmentText, active && styles.segmentTextActive]}>{option.label}</Label>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>

      <View style={styles.block}>
        <Label style={typography.type.settingHeader}>账号</Label>
        <View style={styles.updateRow}>
          <View style={styles.updateText}>
            <BodyStrong style={typography.type.settingTitle}>应用更新</BodyStrong>
            <Label numberOfLines={1} style={typography.type.settingDetail}>{updates.lastCheck}</Label>
          </View>
          <Pressable
            accessibilityRole="button"
            disabled={updates.checking}
            onPress={() => { updates.checkNow(); }}
            style={({ pressed }) => [
              styles.updateButton,
              updates.checking && styles.updateButtonDisabled,
              pressed && !updates.checking && styles.updateButtonPressed,
            ]}
          >
            <Label style={[typography.type.settingDetail, styles.updateButtonText]}>
              {updates.checking ? "检查中" : "检查更新"}
            </Label>
          </Pressable>
        </View>
        <Button label="退出登录" variant="danger" onPress={() => { logout(); }} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg, padding: space.lg, gap: space.xl },
  head: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.md },
  headText: { flex: 1, gap: 4 },
  nameLine: { flexDirection: "row", alignItems: "center", gap: 4, minWidth: 0 },
  name: { flexShrink: 1 },
  uid: {},
  block: { gap: space.sm },
  settingRow: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
  },
  settingTitle: { flex: 1, minWidth: 0 },
  segmented: {
    flexDirection: "row",
    alignItems: "center",
    padding: 2,
    borderRadius: radius.sm,
    borderWidth: hairlineWidth,
    borderColor: color.line,
    backgroundColor: color.surfaceMuted,
  },
  segment: {
    minWidth: 48,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm - 2,
    paddingHorizontal: space.sm,
  },
  segmentActive: { backgroundColor: color.surface },
  segmentPressed: { backgroundColor: color.field },
  segmentText: { color: color.inkMuted },
  segmentTextActive: { color: color.ink },
  updateRow: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
  },
  updateText: { flex: 1, minWidth: 0, gap: 2 },
  updateButton: {
    height: 30,
    minWidth: 76,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    borderWidth: hairlineWidth,
    borderColor: color.line,
    backgroundColor: color.surface,
    paddingHorizontal: space.sm,
  },
  updateButtonPressed: { backgroundColor: color.field },
  updateButtonDisabled: { opacity: 0.52 },
  updateButtonText: { color: color.accent },
});
