import { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, KeyboardAvoidingView, Platform } from "react-native";
import { createCloudClient } from "../api/client";
import { useAuth, DEFAULT_API_BASE } from "../state/auth";
import { theme } from "../theme";

export default function LoginScreen() {
  const { setSession } = useAuth();
  const [server, setServer] = useState(DEFAULT_API_BASE);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (register: boolean) => {
    const apiBase = server.trim() || DEFAULT_API_BASE;
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
        <Text style={styles.h1}>Mia</Text>
        <TextInput
          style={styles.input}
          placeholder="服务器(默认生产)"
          autoCapitalize="none"
          inputMode="url"
          value={server}
          onChangeText={setServer}
        />
        <TextInput
          style={styles.input}
          placeholder="用户名"
          autoCapitalize="none"
          value={username}
          onChangeText={setUsername}
        />
        <TextInput
          style={styles.input}
          placeholder="密码"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />
        <Pressable style={[styles.btn, styles.primary]} disabled={busy} onPress={() => submit(false)}>
          <Text style={styles.primaryText}>{busy ? "…" : "登录"}</Text>
        </Pressable>
        <Pressable style={styles.btn} disabled={busy} onPress={() => submit(true)}>
          <Text style={styles.btnText}>创建账号</Text>
        </Pressable>
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg, justifyContent: "center", padding: 24 },
  panel: { gap: 12 },
  h1: { fontSize: 30, fontWeight: "700", textAlign: "center", marginBottom: 8, color: theme.text },
  input: { backgroundColor: theme.card, borderWidth: 1, borderColor: theme.line, borderRadius: 10, padding: 12, fontSize: 15 },
  btn: { borderWidth: 1, borderColor: theme.line, borderRadius: 10, padding: 12, alignItems: "center", backgroundColor: theme.card },
  btnText: { color: theme.text },
  primary: { backgroundColor: theme.accent, borderColor: theme.accent },
  primaryText: { color: "#fff", fontWeight: "600" },
  error: { color: theme.danger, fontSize: 13, minHeight: 18 },
});
