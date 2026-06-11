import { useState } from "react";
import { View, Image, StyleSheet, KeyboardAvoidingView, Platform } from "react-native";
import { createCloudClient } from "../api/client";
import { useAuth, DEFAULT_API_BASE } from "../state/auth";
import { color, space } from "../theme";
import { Brand, Sub, Label } from "../ui/Text";
import Input from "../ui/Input";
import Button from "../ui/Button";

export default function LoginScreen() {
  const { setSession } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (register: boolean) => {
    const apiBase = DEFAULT_API_BASE;
    setError("");
    setBusy(true);
    try {
      const client = createCloudClient({ apiBase, getToken: () => "" });
      const path = register ? "/api/auth/register" : "/api/auth/login";
      const data = await client.api(path, { method: "POST", body: { username: username.trim(), password } });
      setSession({ token: data.token, user: data.user || { username: username.trim() }, apiBase });
    } catch (e: any) {
      setError(e?.message || "登录失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.panel}>
        <View style={styles.brandRow}>
          <Image source={require("../../assets/icon.png")} style={styles.mark} resizeMode="contain" />
          <Brand>MIA</Brand>
        </View>
        <Sub style={styles.tagline}>多 AI 伙伴工作台</Sub>

        <View style={styles.field}>
          <Label>用户名</Label>
          <Input placeholder="用户名" autoCapitalize="none" value={username} onChangeText={setUsername} />
        </View>
        <View style={styles.field}>
          <Label>密码</Label>
          <Input placeholder="密码" secureTextEntry value={password} onChangeText={setPassword} />
        </View>

        {error ? <Sub style={styles.error}>{error}</Sub> : null}

        <View style={styles.actions}>
          <Button label="登录" busy={busy} onPress={() => submit(false)} />
          <Button label="创建账号" variant="outline" disabled={busy} onPress={() => submit(true)} />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg, justifyContent: "center", padding: space.xl },
  panel: { gap: space.md },
  brandRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  mark: { width: 32, height: 32 },
  tagline: { marginBottom: space.lg },
  field: { gap: space.xs },
  error: { color: color.danger },
  actions: { gap: space.sm, marginTop: space.sm },
});
