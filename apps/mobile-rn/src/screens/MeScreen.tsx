import { View, Text, Pressable, StyleSheet } from "react-native";
import { useAuth } from "../state/auth";
import { theme } from "../theme";

export default function MeScreen() {
  const { session, setSession } = useAuth();
  return (
    <View style={styles.root}>
      <Text style={styles.name}>{session?.user?.username || "未登录"}</Text>
      <Text style={styles.server}>{session?.apiBase}</Text>
      <Pressable style={styles.btn} onPress={() => setSession(null)}>
        <Text style={styles.btnText}>退出登录</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg, padding: 18, gap: 14 },
  name: { fontSize: 20, fontWeight: "600", color: theme.text },
  server: { color: theme.muted, fontSize: 13 },
  btn: { borderWidth: 1, borderColor: theme.line, borderRadius: 10, padding: 12, alignItems: "center", backgroundColor: theme.card },
  btnText: { color: theme.danger },
});
