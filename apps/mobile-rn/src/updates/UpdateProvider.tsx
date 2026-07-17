import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Linking } from "react-native";
import { useAuth } from "../state/auth";
import {
  canRequestPackageInstalls,
  downloadAndroidApk,
  inspectDownloadedApk,
  installDownloadedApk,
  openUnknownSourcesSettings,
  prepareAndroidApkInstall,
  removeDownloadedAndroidApk,
  type PreparedAndroidInstall,
} from "./androidInstaller";
import { sha256File } from "./checksum";
import { parseMobileUpdateManifest } from "./manifest";
import { createMobileUpdateManifestRequest } from "./manifestRequest";
import { checkForOtaUpdate, fetchOtaUpdate, reloadIntoOtaUpdate } from "./otaUpdates";
import { getAppVariant, getApplicationId, getInstalledAppInfo, getUpdateChannel, type InstalledRuntimeInfo } from "./runtimeInfo";
import { shouldDisableProductionUpdateChecks } from "./updateEnvironment";
import { decideUpdate, type UpdateDecision } from "./versionPolicy";
import UpdatePrompt, { type UpdatePromptModel, type UpdatePromptPhase } from "./UpdatePrompt";

interface UpdateContextValue {
  installed: InstalledRuntimeInfo;
  channel: string;
  lastCheck: string;
  checking: boolean;
  prompt: UpdatePromptModel | null;
  checkNow: () => Promise<void>;
}

const Ctx = createContext<UpdateContextValue>(null as any);

async function fetchManifest(apiBase: string) {
  const request = createMobileUpdateManifestRequest(apiBase);
  const response = await fetch(request.url, { headers: request.headers });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parseMobileUpdateManifest(await response.json());
}

function promptFromDecision(decision: UpdateDecision): UpdatePromptModel | null {
  if (decision.kind === "android-binary") {
    return { kind: "android-binary", target: decision.target, mandatory: decision.mandatory, phase: "ready" };
  }
  if (decision.kind === "ios-store") {
    return { kind: "ios-store", target: decision.target, mandatory: false, phase: "ready" };
  }
  return null;
}

function promptKey(prompt: UpdatePromptModel): string {
  if (prompt.kind === "android-binary") return `android:${prompt.target.versionCode}`;
  if (prompt.kind === "ios-store") return `ios:${prompt.target.buildNumber}`;
  return "ota";
}

function installedVersionCode(info: InstalledRuntimeInfo): number {
  const parsed = Number.parseInt(info.buildVersion || "0", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function UpdateProvider({ children }: { children: React.ReactNode }) {
  const { apiBase } = useAuth();
  const [installed] = useState(() => getInstalledAppInfo());
  const [applicationId] = useState(() => getApplicationId());
  const [appVariant] = useState(() => getAppVariant());
  const [channel] = useState(() => getUpdateChannel());
  const updatesDisabled = shouldDisableProductionUpdateChecks(applicationId, appVariant);
  const [lastCheck, setLastCheck] = useState("未检查");
  const [checking, setChecking] = useState(false);
  const [prompt, setPrompt] = useState<UpdatePromptModel | null>(null);
  const [dismissedKey, setDismissedKey] = useState("");
  const preparedInstall = useRef<PreparedAndroidInstall | null>(null);
  const checkingRef = useRef(false);

  const setPromptPhase = useCallback((phase: UpdatePromptPhase, error = "") => {
    setPrompt((current) => (current ? { ...current, phase, error: error || undefined } : current));
  }, []);

  const setDownloadProgress = useCallback((ratio: number) => {
    setPrompt((current) => (current ? { ...current, progress: ratio } : current));
  }, []);

  const checkForUpdates = useCallback(
    async (manual = false) => {
      if (updatesDisabled) {
        preparedInstall.current = null;
        setPrompt(null);
        setChecking(false);
        setLastCheck("开发版不检查正式更新");
        return;
      }
      if (checkingRef.current) return;
      checkingRef.current = true;
      setChecking(true);
      setLastCheck("正在检查...");
      try {
        const manifest = await fetchManifest(apiBase);
        const decision = decideUpdate(installed, manifest);
        const nextPrompt = promptFromDecision(decision);
        if (nextPrompt) {
          const key = promptKey(nextPrompt);
          if (manual || nextPrompt.mandatory || dismissedKey !== key) {
            setPrompt(nextPrompt);
          }
          setLastCheck("发现新版本");
          return;
        }

        if (await checkForOtaUpdate()) {
          const otaPrompt: UpdatePromptModel = { kind: "ota", mandatory: false, phase: "ready" };
          if (manual || dismissedKey !== promptKey(otaPrompt)) setPrompt(otaPrompt);
          setLastCheck("发现小更新");
          return;
        }

        setLastCheck("已是最新版本");
      } catch (error: any) {
        setLastCheck(`检查失败: ${error?.message || "未知错误"}`);
      } finally {
        checkingRef.current = false;
        setChecking(false);
      }
    },
    [apiBase, dismissedKey, installed, updatesDisabled]
  );

  useEffect(() => {
    if (updatesDisabled) {
      setPrompt(null);
      setLastCheck("开发版不检查正式更新");
      return;
    }
    const timer = setTimeout(() => {
      checkForUpdates(false);
    }, 900);
    return () => clearTimeout(timer);
  }, [checkForUpdates, updatesDisabled]);

  const installPreparedApk = useCallback(
    async (localUri: string) => {
      if (!(await canRequestPackageInstalls())) {
        await openUnknownSourcesSettings();
        setPromptPhase("waiting_permission");
        return;
      }
      setPromptPhase("opening_installer");
      await installDownloadedApk(localUri);
      setLastCheck("等待系统安装");
    },
    [setPromptPhase]
  );

  const handlePrimary = useCallback(async () => {
    if (!prompt) return;
    try {
      if (prompt.kind === "ios-store") {
        const url = prompt.target.testFlightUrl || prompt.target.storeUrl;
        if (url) await Linking.openURL(url);
        return;
      }

      if (prompt.kind === "ota") {
        setPromptPhase("downloading");
        await fetchOtaUpdate();
        setPromptPhase("opening_installer");
        await reloadIntoOtaUpdate();
        return;
      }

      if (prompt.phase === "waiting_permission" && preparedInstall.current?.localUri) {
        await installPreparedApk(preparedInstall.current.localUri);
        return;
      }

      setDownloadProgress(0);
      setPromptPhase("downloading");
      const prepared = await prepareAndroidApkInstall(
        prompt.target,
        {
          downloadApk: downloadAndroidApk,
          sha256File,
          inspectApk: inspectDownloadedApk,
          removeApk: removeDownloadedAndroidApk,
          installedPackageName: applicationId,
          installedVersionCode: installedVersionCode(installed),
        },
        setDownloadProgress
      );
      preparedInstall.current = prepared;
      setPromptPhase("verifying");
      await installPreparedApk(prepared.localUri);
    } catch (error: any) {
      setPromptPhase("failed", error?.message || "更新失败");
    }
  }, [applicationId, installPreparedApk, installed, prompt, setPromptPhase, setDownloadProgress]);

  const handleDismiss = useCallback(() => {
    if (prompt) setDismissedKey(promptKey(prompt));
    setPrompt(null);
  }, [prompt]);

  const value = useMemo<UpdateContextValue>(
    () => ({
      installed,
      channel,
      lastCheck,
      checking,
      prompt,
      checkNow: () => checkForUpdates(true),
    }),
    [channel, checkForUpdates, checking, installed, lastCheck, prompt]
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <UpdatePrompt prompt={prompt} onPrimary={handlePrimary} onDismiss={handleDismiss} />
    </Ctx.Provider>
  );
}

export const useUpdateStatus = () => useContext(Ctx);
