import { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Image,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  AppState,
  Linking,
  Platform,
  Pressable,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Device from "expo-device";
import { createCloudClient, type CloudClient } from "../api/client";
import { useAuth, DEFAULT_API_BASE } from "../state/auth";
import { color, space, radius, shadow } from "../theme";
import { BodyStrong, Brand, Sub, Label } from "../ui/Text";
import { useTypography } from "../ui/TypographyProvider";
import Button from "../ui/Button";
import { mobileScanErrorMessage, type MobileScanErrorCode, parseMobileScanQr } from "../logic/mobileScanLogin";

type WechatPhase = "idle" | "starting" | "waiting" | "expired" | "error";
type ScanMode = "scanner" | "waiting";

interface WechatQrSession {
  qrCodeUrl: string;
  state: string;
  expiresAt: number;
}

function statusToScanErrorCode(status: string): MobileScanErrorCode {
  if (status === "expired") return "expired";
  if (status === "denied") return "denied";
  if (status === "used") return "used";
  return "network";
}

export default function LoginScreen() {
  const typography = useTypography();
  const { setSession } = useAuth();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanMode, setScanMode] = useState<ScanMode>("scanner");
  const [scanError, setScanError] = useState("");
  const [scanApiBase, setScanApiBase] = useState(DEFAULT_API_BASE);
  const [scanRequestId, setScanRequestId] = useState("");
  const [otherLoginOpen, setOtherLoginOpen] = useState(false);
  const [wechatPhase, setWechatPhase] = useState<WechatPhase>("idle");
  const [wechatError, setWechatError] = useState("");
  const [wechatQr, setWechatQr] = useState<WechatQrSession | null>(null);
  const [wechatBusy, setWechatBusy] = useState(false);

  const wechatClientRef = useRef<CloudClient>(createCloudClient({ apiBase: DEFAULT_API_BASE, getToken: () => "" }));
  const scanBusyRef = useRef(false);
  const wechatQrRef = useRef<WechatQrSession | null>(null);
  const wechatPollingRef = useRef(false);
  wechatQrRef.current = wechatQr;

  useEffect(() => {
    if (!permission) requestPermission().catch(() => {});
  }, [permission, requestPermission]);

  useEffect(() => {
    if (scanMode === "scanner") scanBusyRef.current = false;
  }, [scanMode]);

  const resetScanFlow = useCallback((errorCode?: MobileScanErrorCode) => {
    scanBusyRef.current = false;
    setScanMode("scanner");
    setScanRequestId("");
    if (errorCode) setScanError(mobileScanErrorMessage(errorCode));
  }, []);

  const startWechat = useCallback(async () => {
    setWechatPhase("starting");
    setWechatBusy(true);
    setWechatError("");
    setWechatQr(null);
    try {
      const started = await wechatClientRef.current.api("/api/auth/wechat/start", {
        method: "POST",
        body: { client: "mobile-rn" },
      });
      if (!started?.qrCodeUrl || !started?.state) throw new Error("微信登录启动失败");
      const expiresAt = Date.parse(started.expiresAt) || Date.now() + 5 * 60 * 1000;
      setWechatQr({ qrCodeUrl: started.qrCodeUrl, state: started.state, expiresAt });
      setWechatPhase("waiting");
    } catch (e: any) {
      setWechatError(e?.message || "微信登录未就绪，请稍后重试");
      setWechatPhase("error");
    } finally {
      setWechatBusy(false);
    }
  }, []);

  const pollWechatOnce = useCallback(async () => {
    const session = wechatQrRef.current;
    if (!session || wechatPollingRef.current) return;
    if (Date.now() > session.expiresAt) {
      setWechatPhase("expired");
      return;
    }
    wechatPollingRef.current = true;
    try {
      const next = await wechatClientRef.current.api("/api/auth/wechat/complete", {
        method: "POST",
        body: { state: session.state },
      });
      if (next.status === "pending") return;
      if (next.status === "failed" || next.ok === false) {
        setWechatError(next.error || "微信登录失败，请重试");
        setWechatPhase("error");
        return;
      }
      if (next.token) {
        setSession({ token: next.token, user: next.user || null, apiBase: DEFAULT_API_BASE });
      }
    } catch {
      // Retry on next tick.
    } finally {
      wechatPollingRef.current = false;
    }
  }, [setSession]);

  useEffect(() => {
    if (wechatPhase !== "waiting") return;
    const timer = setInterval(() => {
      pollWechatOnce().catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [wechatPhase, pollWechatOnce]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active" && wechatPhase === "waiting") pollWechatOnce().catch(() => {});
    });
    return () => sub.remove();
  }, [wechatPhase, pollWechatOnce]);

  const submitScanResult = useCallback(async (rawValue: string) => {
    if (scanBusyRef.current || scanMode === "waiting") return;
    scanBusyRef.current = true;
    setScanError("");
    try {
      const parsed = parseMobileScanQr(rawValue);
      const client = createCloudClient({ apiBase: parsed.apiBase, getToken: () => "" });
      const requested = await client.api("/api/auth/mobile-scan/request", {
        method: "POST",
        body: {
          grant: parsed.grant,
          deviceLabel: Device.modelName || "手机",
          platform: Platform.OS,
          clientKind: "mia-app",
        },
      });
      if (requested?.ok === false || !requested?.requestId) {
        resetScanFlow(statusToScanErrorCode(String(requested?.status || "")));
        return;
      }
      setScanApiBase(parsed.apiBase);
      setScanRequestId(requested.requestId);
      setScanMode("waiting");
    } catch (error: any) {
      const message = String(error?.message || "");
      resetScanFlow(message === "invalid" ? "invalid" : "network");
    }
  }, [resetScanFlow, scanMode]);

  useEffect(() => {
    if (scanMode !== "waiting" || !scanRequestId) return;
    let cancelled = false;
    const client = createCloudClient({ apiBase: scanApiBase, getToken: () => "" });
    const poll = async () => {
      try {
        const next = await client.api("/api/auth/mobile-scan/complete", {
          method: "POST",
          body: { requestId: scanRequestId },
        });
        if (cancelled) return;
        if (next.status === "pending") return;
        if (next.status === "approved" && next.token) {
          setSession({ token: next.token, user: next.user || null, apiBase: scanApiBase });
          return;
        }
        resetScanFlow(statusToScanErrorCode(String(next.status || "")));
      } catch {
        if (!cancelled) resetScanFlow("network");
      }
    };
    poll().catch(() => {});
    const timer = setInterval(() => {
      poll().catch(() => {});
    }, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [resetScanFlow, scanApiBase, scanMode, scanRequestId, setSession]);

  const openWeixin = () => {
    Linking.openURL("weixin://").catch(() => {
      setWechatError("未检测到微信，请确认已安装微信");
    });
  };

  const toggleOtherLogin = () => {
    setOtherLoginOpen((open) => {
      const next = !open;
      if (next && wechatPhase === "idle") {
        startWechat().catch(() => {});
      }
      return next;
    });
  };

  const openCameraSettings = () => {
    Linking.openSettings().catch(() => {});
  };

  const cameraGranted = permission?.granted === true;
  const cameraDenied = permission?.granted === false;

  return (
    <ScrollView contentContainerStyle={styles.root} keyboardShouldPersistTaps="handled">
      <View style={styles.brandRow}>
        <Image source={require("../../assets/icon.png")} style={styles.mark} resizeMode="contain" />
        <Brand>Mia</Brand>
      </View>
      <Sub style={[styles.tagline, typography.type.info]}>多 AI 伙伴工作台 · 扫码登录</Sub>

      <View style={styles.cameraCard}>
        {scanMode === "waiting" ? (
          <View style={styles.waitingPanel}>
            <ActivityIndicator color={color.accent} />
            <BodyStrong style={[styles.waitingTitle, typography.type.settingHeader]}>等待电脑确认</BodyStrong>
            <Sub style={[styles.waitingCopy, typography.type.info]}>请回到电脑，在 Mia 的确认弹窗里点一次「允许」。</Sub>
            <Button label="返回扫码" variant="outline" onPress={() => resetScanFlow()} />
          </View>
        ) : cameraGranted ? (
          <View style={styles.cameraShell}>
            <CameraView
              style={styles.camera}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={({ data }) => {
                submitScanResult(String(data || "")).catch(() => {});
              }}
            />
            <View style={styles.cameraMask}>
              <View style={styles.scanFrame} />
            </View>
          </View>
        ) : cameraDenied ? (
          <View style={styles.permissionEmpty}>
            <BodyStrong style={[styles.permissionTitle, typography.type.settingHeader]}>请开启相机以扫描桌面二维码</BodyStrong>
            <Sub style={[styles.permissionCopy, typography.type.info]}>开启后，直接扫描电脑端的二维码即可登录。</Sub>
            <View style={styles.actions}>
              <Button label="去设置开启" onPress={openCameraSettings} />
            </View>
          </View>
        ) : (
          <View style={styles.permissionEmpty}>
            <ActivityIndicator color={color.accent} />
            <Sub style={[styles.permissionCopy, typography.type.info]}>正在请求相机权限…</Sub>
          </View>
        )}
      </View>

      <View style={styles.steps}>
        <BodyStrong style={[styles.stepsTitle, typography.type.settingHeader]}>扫码登录</BodyStrong>
        <Sub style={[styles.step, typography.type.info]}>· 打开电脑端 Mia，进入「设置 → 账号与同步」</Sub>
        <Sub style={[styles.step, typography.type.info]}>· 用手机直接扫描电脑上的二维码</Sub>
      </View>

      {scanError ? <Sub style={[styles.error, typography.type.info]}>{scanError}</Sub> : null}

      <Pressable onPress={toggleOtherLogin} style={styles.otherLoginTrigger}>
        <Label style={[styles.otherLoginText, typography.type.settingDetail]}>
          {otherLoginOpen ? "收起其他登录方式" : "其他登录方式"}
        </Label>
      </Pressable>

      {otherLoginOpen ? (
        <View style={styles.wechatPanel}>
          <BodyStrong style={[styles.stepsTitle, typography.type.settingHeader]}>微信登录</BodyStrong>
          <View style={styles.qrCard}>
            {wechatPhase === "waiting" && wechatQr ? (
              <Image source={{ uri: wechatQr.qrCodeUrl }} style={styles.qr} />
            ) : (
              <View style={[styles.qr, styles.qrPlaceholder]}>
                {wechatPhase === "starting" ? (
                  <ActivityIndicator color={color.accent} />
                ) : (
                  <Label style={[styles.placeholderText, typography.type.info]}>
                    {wechatPhase === "expired" ? "二维码已过期" : "点击下方按钮获取微信二维码"}
                  </Label>
                )}
              </View>
            )}
          </View>

          {wechatError ? <Sub style={[styles.error, typography.type.info]}>{wechatError}</Sub> : null}

          <View style={styles.actions}>
            <Button label="打开微信" onPress={openWeixin} />
            {(wechatPhase === "idle" || wechatPhase === "expired" || wechatPhase === "error") && (
              <Button
                label={wechatPhase === "idle" ? "获取微信二维码" : "重新获取二维码"}
                variant="outline"
                busy={wechatBusy}
                onPress={() => startWechat().catch(() => {})}
              />
            )}
          </View>
        </View>
      ) : null}

      <Label style={[styles.footnote, typography.type.settingDetail]}>登录后，消息、联系人和智能体会通过 Mia Cloud 同步。</Label>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flexGrow: 1, backgroundColor: color.bg, justifyContent: "center", padding: space.xl, gap: space.md },
  brandRow: { flexDirection: "row", alignItems: "center", gap: space.sm, justifyContent: "center" },
  mark: { width: 32, height: 32 },
  tagline: { textAlign: "center", marginBottom: space.sm },
  cameraCard: {
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.line,
    overflow: "hidden",
    ...shadow,
  },
  cameraShell: { height: 320, backgroundColor: "#0F172A" },
  camera: { flex: 1 },
  cameraMask: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(15,23,42,0.18)",
  },
  scanFrame: {
    width: 220,
    height: 220,
    borderRadius: 24,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.92)",
    backgroundColor: "transparent",
  },
  waitingPanel: {
    alignItems: "center",
    justifyContent: "center",
    gap: space.md,
    padding: space.xl,
    minHeight: 240,
  },
  waitingTitle: { textAlign: "center" },
  waitingCopy: { textAlign: "center" },
  permissionEmpty: {
    alignItems: "center",
    justifyContent: "center",
    gap: space.md,
    padding: space.xl,
    minHeight: 240,
  },
  permissionTitle: { textAlign: "center" },
  permissionCopy: { textAlign: "center" },
  steps: { gap: space.xs, marginTop: space.sm },
  stepsTitle: {},
  step: {},
  error: { color: color.danger, textAlign: "center" },
  otherLoginTrigger: { alignSelf: "center", paddingVertical: space.xs, paddingHorizontal: space.md },
  otherLoginText: { color: color.inkFaint },
  wechatPanel: {
    gap: space.sm,
    padding: space.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.surfaceMuted,
  },
  qrCard: {
    alignSelf: "center",
    padding: space.md,
    backgroundColor: "#fff",
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.line,
  },
  qr: { width: 220, height: 220, borderRadius: radius.sm },
  qrPlaceholder: { alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.03)" },
  placeholderText: { textAlign: "center" },
  actions: { gap: space.sm, marginTop: space.sm },
  footnote: { textAlign: "center", marginTop: space.sm },
});
