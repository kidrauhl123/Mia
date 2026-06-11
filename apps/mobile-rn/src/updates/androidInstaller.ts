import type { AndroidUpdateManifest } from "./manifest";

declare const require: any;

export interface AndroidApkInfo {
  packageName: string;
  versionCode: number;
  versionName: string;
}

export interface PreparedAndroidInstall extends AndroidApkInfo {
  localUri: string;
}

export interface AndroidInstallDeps {
  downloadApk: (target: AndroidUpdateManifest) => Promise<string>;
  sha256File: (uri: string) => Promise<string>;
  inspectApk: (uri: string) => Promise<AndroidApkInfo>;
  installedPackageName: string;
  installedVersionCode: number;
}

export async function downloadAndroidApk(target: AndroidUpdateManifest): Promise<string> {
  const { Directory, File, Paths } = require("expo-file-system");
  const dir = new Directory(Paths.cache, "mia-updates");
  dir.create({ idempotent: true });
  const output = await File.downloadFileAsync(target.apkUrl, dir, { idempotent: true });
  return output.uri;
}

export async function prepareAndroidApkInstall(
  target: AndroidUpdateManifest,
  deps: AndroidInstallDeps
): Promise<PreparedAndroidInstall> {
  const localUri = await deps.downloadApk(target);
  const actualSha = (await deps.sha256File(localUri)).toLowerCase();
  if (actualSha !== target.apkSha256.toLowerCase()) throw new Error("安装包校验失败");
  const apk = await deps.inspectApk(localUri);
  if (apk.packageName !== deps.installedPackageName) throw new Error("安装包包名不匹配");
  if (apk.versionCode <= deps.installedVersionCode) throw new Error("安装包版本不是更新版本");
  return { ...apk, localUri };
}

function nativeUpdater() {
  return require("../../modules/mia-android-updater");
}

export function canRequestPackageInstalls(): Promise<boolean> {
  return nativeUpdater().canRequestPackageInstalls();
}

export function openUnknownSourcesSettings(): Promise<void> {
  return nativeUpdater().openUnknownSourcesSettings();
}

export function inspectDownloadedApk(localUri: string): Promise<AndroidApkInfo> {
  return nativeUpdater().inspectApk(localUri);
}

export function installDownloadedApk(localUri: string): Promise<void> {
  return nativeUpdater().installApk(localUri);
}
