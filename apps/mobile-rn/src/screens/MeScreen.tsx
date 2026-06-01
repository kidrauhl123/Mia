import { View, StyleSheet } from "react-native";
import { useAuth } from "../state/auth";
import { useMe } from "../state/queries";
import { resolveAvatar } from "../logic/avatar";
import AvatarMedia from "../components/AvatarMedia";
import Button from "../ui/Button";
import { Brand, Label, Sub } from "../ui/Text";
import { color, space } from "../theme";

export default function MeScreen() {
  const { session, setSession } = useAuth();
  const { data: me } = useMe();
  const id = me?.id || session?.user?.id || "";
  const username = me?.username || session?.user?.username || "未登录";
  const avatar = resolveAvatar(id, username, me?.avatarImage || "", me?.avatarCrop || null);
  return (
    <View style={styles.root}>
      <View style={styles.head}>
        <AvatarMedia tile={avatar} size={64} />
        <View style={styles.headText}>
          <Brand style={styles.name}>{username}</Brand>
          <Sub>{session?.apiBase}</Sub>
        </View>
      </View>

      <View style={styles.block}>
        <Label>账号</Label>
        <Button label="退出登录" variant="danger" onPress={() => setSession(null)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg, padding: space.lg, gap: space.xl },
  head: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.md },
  headText: { flex: 1, gap: 4 },
  name: { fontSize: 22 },
  block: { gap: space.sm },
});
