import { View } from "react-native";
import { useAuth } from "../state/auth";
import Button from "../ui/Button";
import { Brand, Sub } from "../ui/Text";
import { color, space } from "../theme";

export default function SettingsScreen() {
  const { session, setSession } = useAuth();
  return (
    <View style={{ flex: 1, backgroundColor: color.bg, padding: space.lg, gap: space.sm }}>
      <Brand>Settings</Brand>
      <Sub>{session?.apiBase || "账号、同步、外观、模型、权限和 Bridge 状态会在这里。"}</Sub>
      <Button label="退出登录" variant="danger" onPress={() => setSession(null)} />
    </View>
  );
}
