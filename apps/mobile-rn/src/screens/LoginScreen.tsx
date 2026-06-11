import { useState } from "react";
import { View, Image, StyleSheet, KeyboardAvoidingView, Platform, Linking } from "react-native";
import { createCloudClient } from "../api/client";
import { useAuth, DEFAULT_API_BASE } from "../state/auth";
import { color, space } from "../theme";
import { Brand, Sub, Label } from "../ui/Text";
import Button from "../ui/Button";

export default function LoginScreen() {
  const { setSession } = useAuth();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const apiBase = DEFAULT_API_BASE;
    setError("");
    setBusy(true);
    try {
      const client = createCloudClient({ apiBase, getToken: () => "" });
      const started = await client.api("/api/auth/wechat/start", { method: "POST", body: { client: "mobile-rn" } });
      if (!started?.authorizationUrl || !started?.state) throw new Error("微信登录启动失败");
      await Linking.openURL(started.authorizationUrl);
      const startedAt = Date.now();
      let result: any = null;
      while (Date.now() - startedAt < 5 * 60 * 1000) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const next = await client.api("/api/auth/wechat/complete", { method: "POST", body: { state: started.state } });
        if (next.status === "pending") continue;
        if (next.status === "failed" || next.ok === false) throw new Error(next.error || "微信登录失败");
        result = next;
        break;
      }
      if (!result?.token) throw new Error("微信登录超时，请重新扫码");
      setSession({ token: result.token, user: result.user || null, apiBase });
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
        <Label>使用微信登录后，消息、联系人和智能体会通过 Mia Cloud 同步。</Label>

        {error ? <Sub style={styles.error}>{error}</Sub> : null}

        <View style={styles.actions}>
          <Button label="微信登录" busy={busy} onPress={() => submit()} />
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
  error: { color: color.danger },
  actions: { gap: space.sm, marginTop: space.sm },
});
