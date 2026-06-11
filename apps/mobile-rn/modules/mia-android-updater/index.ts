import { Platform } from "react-native";
import { requireNativeModule } from "expo-modules-core";

export interface AndroidApkInfo {
  packageName: string;
  versionCode: number;
  versionName: string;
}

interface MiaAndroidUpdaterNative {
  canRequestPackageInstalls(): Promise<boolean>;
  openUnknownSourcesSettings(): Promise<void>;
  inspectApk(localUri: string): Promise<AndroidApkInfo>;
  installApk(localUri: string): Promise<void>;
}

const nativeModule: MiaAndroidUpdaterNative | null =
  Platform.OS === "android" ? requireNativeModule<MiaAndroidUpdaterNative>("MiaAndroidUpdater") : null;

function requireAndroidModule(): MiaAndroidUpdaterNative {
  if (!nativeModule) throw new Error("Android updater is only available on Android builds.");
  return nativeModule;
}

export function canRequestPackageInstalls(): Promise<boolean> {
  return requireAndroidModule().canRequestPackageInstalls();
}

export function openUnknownSourcesSettings(): Promise<void> {
  return requireAndroidModule().openUnknownSourcesSettings();
}

export function inspectApk(localUri: string): Promise<AndroidApkInfo> {
  return requireAndroidModule().inspectApk(localUri);
}

export function installApk(localUri: string): Promise<void> {
  return requireAndroidModule().installApk(localUri);
}
