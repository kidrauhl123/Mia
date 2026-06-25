import { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Image,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  AppState,
  Linking,
} from "react-native";
import { createCloudClient, type CloudClient } from "../api/client";
import { useAuth, DEFAULT_API_BASE } from "../state/auth";
import { color, space, radius } from "../theme";
import { BodyStrong, Brand, Sub, Label } from "../ui/Text";
import { useTypography } from "../ui/TypographyProvider";
import Button from "../ui/Button";

type Phase = "starting" | "waiting" | "expired" | "error";

interface QrSession {
  qrCodeUrl: string;
  state: string;
  expiresAt: number;
}

export default function LoginScreen() {
  const typography = useTypography();
  const { setSession } = useAuth();
  const apiBase = DEFAULT_API_BASE;
  const clientRef = useRef<CloudClient>(createCloudClient({ apiBase, getToken: () => "" }));

  const [phase, setPhase] = useState<Phase>("starting");
  const [error, setError] = useState("");
  const [qr, setQr] = useState<QrSession | null>(null);

  // Refs the interval/AppState callbacks read so they never go stale.
  const qrRef = useRef<QrSession | null>(null);
  const pollingRef = useRef(false);
  qrRef.current = qr;

  const start = useCallback(async () => {
    setPhase("starting");
    setError("");
    setQr(null);
    try {
      const started = await clientRef.current.api("/api/auth/wechat/start", {
        method: "POST",
        body: { client: "mobile-rn" },
      });
      if (!started?.qrCodeUrl || !started?.state) throw new Error("微信登录启动失败");
      const expiresAt = Date.parse(started.expiresAt) || Date.now() + 5 * 60 * 1000;
      setQr({ qrCodeUrl: started.qrCodeUrl, state: started.state, expiresAt });
      setPhase("waiting");
    } catch (e: any) {
      setError(e?.message || "微信登录未就绪，请稍后重试");
      setPhase("error");
    }
  }, []);

  // One poll of /complete. Guarded so AppState + interval can't overlap.
  const pollOnce = useCallback(async () => {
    const session = qrRef.current;
    if (!session || pollingRef.current) return;
    if (Date.now() > session.expiresAt) {
      setPhase("expired");
      return;
    }
    pollingRef.current = true;
    try {
      const next = await clientRef.current.api("/api/auth/wechat/complete", {
        method: "POST",
        body: { state: session.state },
      });
      if (next.status === "pending") return;
      if (next.status === "failed" || next.ok === false) {
        setError(next.error || "微信登录失败，请重试");
        setPhase("error");
        return;
      }
      if (next.token) {
        setSession({ token: next.token, user: next.user || null, apiBase });
      }
    } catch {
      // Transient network blip — the next tick retries.
    } finally {
      pollingRef.current = false;
    }
  }, [apiBase, setSession]);

  useEffect(() => {
    start();
  }, [start]);

  // Poll while waiting; stop on any other phase.
  useEffect(() => {
    if (phase !== "waiting") return;
    const timer = setInterval(pollOnce, 1500);
    return () => clearInterval(timer);
  }, [phase, pollOnce]);

  // Returning from WeChat: poll immediately so login completes the instant the
  // user switches back, instead of waiting for the next interval tick.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active" && phase === "waiting") pollOnce();
    });
    return () => sub.remove();
  }, [phase, pollOnce]);

  const openWeixin = () => {
    Linking.openURL("weixin://").catch(() => {
      setError("未检测到微信，请确认已安装微信");
    });
  };

  return (
    <ScrollView contentContainerStyle={styles.root} keyboardShouldPersistTaps="handled">
      <View style={styles.brandRow}>
        <Image source={require("../../assets/icon.png")} style={styles.mark} resizeMode="contain" />
        <Brand>MIA</Brand>
      </View>
      <Sub style={[styles.tagline, typography.type.info]}>多 AI 伙伴工作台 · 微信登录</Sub>

      <View style={styles.qrCard}>
        {phase === "waiting" && qr ? (
          <Image source={{ uri: qr.qrCodeUrl }} style={styles.qr} />
        ) : (
          <View style={[styles.qr, styles.qrPlaceholder]}>
            {phase === "starting" ? (
              <ActivityIndicator color={color.accent} />
            ) : (
              <Label style={[styles.placeholderText, typography.type.info]}>
                {phase === "expired" ? "二维码已过期" : "二维码加载失败"}
              </Label>
            )}
          </View>
        )}
      </View>

      {error ? <Sub style={[styles.error, typography.type.info]}>{error}</Sub> : null}

      <View style={styles.steps}>
        <BodyStrong style={[styles.stepsTitle, typography.type.settingHeader]}>用微信扫码登录</BodyStrong>
        <Sub style={[styles.step, typography.type.info]}>· 用另一台设备的微信「扫一扫」上方二维码即可</Sub>
        <Sub style={[styles.step, typography.type.info]}>
          · 就这一台手机：截屏保存二维码 → 打开微信「扫一扫」→ 右上角「相册」→ 选择刚才的截图
        </Sub>
        <Sub style={[styles.step, typography.type.info]}>· 在微信里确认授权后，回到 Mia 会自动登录</Sub>
      </View>

      <View style={styles.actions}>
        <Button label="打开微信" onPress={openWeixin} />
        {(phase === "expired" || phase === "error") && (
          <Button label="重新获取二维码" variant="outline" onPress={() => start()} />
        )}
      </View>

      <Label style={[styles.footnote, typography.type.settingDetail]}>登录后，消息、联系人和智能体会通过 Mia Cloud 同步。</Label>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flexGrow: 1, backgroundColor: color.bg, justifyContent: "center", padding: space.xl, gap: space.md },
  brandRow: { flexDirection: "row", alignItems: "center", gap: space.sm, justifyContent: "center" },
  mark: { width: 32, height: 32 },
  tagline: { textAlign: "center", marginBottom: space.sm },
  qrCard: {
    alignSelf: "center",
    padding: space.md,
    backgroundColor: "#fff",
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.line,
  },
  qr: { width: 240, height: 240, borderRadius: radius.sm },
  qrPlaceholder: { alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.03)" },
  placeholderText: { textAlign: "center" },
  error: { color: color.danger, textAlign: "center" },
  steps: { gap: space.xs, marginTop: space.sm },
  stepsTitle: {},
  step: {},
  actions: { gap: space.sm, marginTop: space.md },
  footnote: { textAlign: "center", marginTop: space.sm },
});
