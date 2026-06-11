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

export type DownloadProgress = (ratio: number) => void;

export interface AndroidInstallDeps {
  downloadApk: (target: AndroidUpdateManifest, onProgress?: DownloadProgress) => Promise<string>;
  sha256File: (uri: string) => Promise<string>;
  inspectApk: (uri: string) => Promise<AndroidApkInfo>;
  installedPackageName: string;
  installedVersionCode: number;
}

export async function downloadAndroidApk(
  target: AndroidUpdateManifest,
  onProgress?: DownloadProgress
): Promise<string> {
  // Use the legacy resumable download API: it is the only expo-file-system
  // path that reports byte-level progress, which the update modal renders as a
  // loading bar. The new File API downloads in one shot with no progress.
  const FileSystem = require("expo-file-system/legacy");
  const dir = `${FileSystem.cacheDirectory}mia-updates/`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
  const targetUri = `${dir}mia-update-${target.versionCode}.apk`;
  // Clear any partial leftover so a resumed-but-stale file can't corrupt the hash check.
  await FileSystem.deleteAsync(targetUri, { idempotent: true }).catch(() => {});
  const resumable = FileSystem.createDownloadResumable(
    target.apkUrl,
    targetUri,
    {},
    (p: { totalBytesWritten: number; totalBytesExpectedToWrite: number }) => {
      if (onProgress && p.totalBytesExpectedToWrite > 0) {
        onProgress(Math.max(0, Math.min(1, p.totalBytesWritten / p.totalBytesExpectedToWrite)));
      }
    }
  );
  const result = await resumable.downloadAsync();
  if (!result?.uri) throw new Error("下载失败");
  return result.uri;
}

export async function prepareAndroidApkInstall(
  target: AndroidUpdateManifest,
  deps: AndroidInstallDeps,
  onProgress?: DownloadProgress
): Promise<PreparedAndroidInstall> {
  const localUri = await deps.downloadApk(target, onProgress);
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
