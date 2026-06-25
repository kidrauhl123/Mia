import { View, StyleSheet } from "react-native";
import { useAuth } from "../state/auth";
import { usePush } from "../notifications/PushProvider";
import { useMe } from "../state/queries";
import { resolveAvatar } from "../logic/avatar";
import { resolveMeProfile } from "../logic/meProfile";
import AvatarMedia from "../components/AvatarMedia";
import StatusBadge from "../components/StatusBadge";
import Button from "../ui/Button";
import { Brand, Label, Sub } from "../ui/Text";
import { color, space } from "../theme";

export default function MeScreen() {
  const { session } = useAuth();
  const { logout } = usePush();
  const { data: me } = useMe();
  const profile = resolveMeProfile(me, session?.user);
  const avatar = resolveAvatar(profile.uid, profile.displayName, profile.avatarImage, profile.avatarCrop);
  const apiBase = session?.apiBase || "";
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
        <Label>账号</Label>
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
  name: { fontSize: 22 },
  uid: { fontFamily: "monospace" },
  block: { gap: space.sm },
});
