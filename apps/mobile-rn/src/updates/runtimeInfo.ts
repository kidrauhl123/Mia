import type { InstalledAppInfo } from "./versionPolicy";

declare const require: any;

export interface RawRuntimeInfo {
  platform: string;
  nativeApplicationVersion: string | null;
  nativeBuildVersion: string | null;
  runtimeVersion: string | null;
}

export interface InstalledRuntimeInfo extends InstalledAppInfo {
  versionName: string;
}

export function normalizeInstalledAppInfo(raw: RawRuntimeInfo): InstalledRuntimeInfo {
  const platform = raw.platform === "android" || raw.platform === "ios" || raw.platform === "web" ? raw.platform : "unknown";
  return {
    platform,
    versionName: raw.nativeApplicationVersion || "",
    buildVersion: raw.nativeBuildVersion || "0",
    runtimeVersion: raw.runtimeVersion || "",
  };
}

export function getInstalledAppInfo(): InstalledRuntimeInfo {
  const { Platform } = require("react-native");
  const Application = require("expo-application");
  const Updates = require("expo-updates");
  return normalizeInstalledAppInfo({
    platform: Platform.OS,
    nativeApplicationVersion: Application.nativeApplicationVersion,
    nativeBuildVersion: Application.nativeBuildVersion,
    runtimeVersion: Updates.runtimeVersion || "",
  });
}

export function getUpdateChannel(): string {
  const Updates = require("expo-updates");
  return Updates.channel || "";
}

export function getApplicationId(): string {
  const Application = require("expo-application");
  return Application.applicationId || "app.mia.mobile";
}
