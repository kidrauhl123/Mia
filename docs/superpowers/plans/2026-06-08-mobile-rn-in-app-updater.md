# Mobile RN In-App Updater Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Mia Mobile's in-app update path for EAS JS updates, Android preview APK self-updates, and iOS/store guidance.

**Architecture:** Keep update decisions in pure TypeScript under `apps/mobile-rn/src/updates/`, use a small React provider/UI layer for prompts and Settings, and isolate Android installer behavior in an Android-only local Expo module. Cloud release tooling publishes a signed APK plus static JSON manifest into `/downloads/`.

**Tech Stack:** Expo SDK 56, React Native 0.85, EAS Update, `expo-application`, `expo-crypto`, `expo-file-system`, local Expo Modules API for Android/Kotlin, Node.js release helpers, Jest/ts-jest and `node:test`.

---

## File Structure

- Create: `apps/mobile-rn/src/updates/manifest.ts`
  Parses and validates `mia-mobile-update.json`.
- Create: `apps/mobile-rn/src/updates/versionPolicy.ts`
  Converts installed app info plus manifest data into update decisions.
- Create: `apps/mobile-rn/src/updates/runtimeInfo.ts`
  Reads native app version/build/channel/runtime from Expo modules.
- Create: `apps/mobile-rn/src/updates/checksum.ts`
  Hashes downloaded files and formats SHA-256 hex.
- Create: `apps/mobile-rn/src/updates/androidInstaller.ts`
  Downloads APKs, verifies SHA-256, checks package/version through native module, and starts installer.
- Create: `apps/mobile-rn/src/updates/otaUpdates.ts`
  Wraps `expo-updates` JS update checks/fetch/reload.
- Create: `apps/mobile-rn/src/updates/UpdateProvider.tsx`
  App-level orchestration and prompt state.
- Create: `apps/mobile-rn/src/updates/UpdatePrompt.tsx`
  Native modal UI for optional/mandatory updates.
- Create: `apps/mobile-rn/src/updates/UpdateSettingsCard.tsx`
  Settings section with current version and manual check.
- Create: `apps/mobile-rn/modules/mia-android-updater/...`
  Android-only local Expo module and config plugin.
- Create: `scripts/mobile-update-manifest.js`
  Node helper to publish APK plus manifest into web downloads.
- Modify: `apps/mobile-rn/App.tsx`
  Mount `UpdateProvider`.
- Modify: `apps/mobile-rn/src/screens/SettingsScreen.tsx`
  Render `UpdateSettingsCard`.
- Modify: `apps/mobile-rn/package.json`
  Add `expo-application` and `expo-crypto`.
- Modify: `apps/mobile-rn/app.config.ts`
  Add Android updater plugin.
- Modify: `apps/mobile-rn/eas.json`
  Enable preview build auto-increment.
- Modify: `scripts/build-cloud-release.js`
  Invoke mobile download publisher during Cloud release build.
- Modify: `tests/web-landing.test.js`
  Cover mobile update manifest release helper.

## Task 1: Manifest Parser

**Files:**
- Create: `apps/mobile-rn/src/updates/manifest.ts`
- Test: `apps/mobile-rn/__tests__/updateManifest.test.ts`

- [ ] **Step 1: Write the failing parser tests**

```ts
import { parseMobileUpdateManifest } from "../src/updates/manifest";

const validManifest = {
  schemaVersion: 1,
  generatedAt: "2026-06-08T12:00:00.000Z",
  android: {
    channel: "preview",
    versionName: "1.3.2",
    versionCode: 12,
    runtimeVersion: "2",
    minSupportedVersionCode: 1,
    apkUrl: "https://mia.gifgif.cn/downloads/mia-android-latest.apk",
    apkSha256: "13bd217f0d51bed4c2c4b19b9bde3c6818d18181b6e565f6cde64cc7f8482322",
    apkSizeBytes: 100663296,
    mandatory: false,
    notes: ["修复聊天输入框遮挡"],
  },
  ios: {
    channel: "testflight",
    versionName: "1.3.2",
    buildNumber: "12",
    runtimeVersion: "2",
    storeUrl: "",
    testFlightUrl: "https://testflight.apple.com/join/example",
  },
};

test("parses a valid v1 mobile update manifest", () => {
  const manifest = parseMobileUpdateManifest(validManifest);
  expect(manifest.schemaVersion).toBe(1);
  expect(manifest.android?.versionCode).toBe(12);
  expect(manifest.android?.apkSha256).toHaveLength(64);
  expect(manifest.ios?.channel).toBe("testflight");
});

test("rejects unknown schema versions", () => {
  expect(() => parseMobileUpdateManifest({ ...validManifest, schemaVersion: 2 })).toThrow(/schemaVersion/);
});

test("rejects Android APK URLs that are not HTTPS", () => {
  expect(() =>
    parseMobileUpdateManifest({
      ...validManifest,
      android: { ...validManifest.android, apkUrl: "http://example.com/mia.apk" },
    })
  ).toThrow(/apkUrl/);
});

test("rejects Android manifests without a SHA-256", () => {
  expect(() =>
    parseMobileUpdateManifest({
      ...validManifest,
      android: { ...validManifest.android, apkSha256: "" },
    })
  ).toThrow(/apkSha256/);
});

test("rejects non-positive Android version codes", () => {
  expect(() =>
    parseMobileUpdateManifest({
      ...validManifest,
      android: { ...validManifest.android, versionCode: 0 },
    })
  ).toThrow(/versionCode/);
});
```

- [ ] **Step 2: Run parser tests and verify RED**

Run: `cd apps/mobile-rn && npm test -- updateManifest.test.ts --runInBand`

Expected: FAIL because `src/updates/manifest.ts` does not exist.

- [ ] **Step 3: Implement the parser**

```ts
export interface AndroidUpdateManifest {
  channel: string;
  versionName: string;
  versionCode: number;
  runtimeVersion: string;
  minSupportedVersionCode: number;
  apkUrl: string;
  apkSha256: string;
  apkSizeBytes: number;
  mandatory: boolean;
  notes: string[];
}

export interface IosUpdateManifest {
  channel: string;
  versionName: string;
  buildNumber: string;
  runtimeVersion: string;
  storeUrl: string;
  testFlightUrl: string;
}

export interface MobileUpdateManifest {
  schemaVersion: 1;
  generatedAt: string;
  android?: AndroidUpdateManifest;
  ios?: IosUpdateManifest;
}

const SHA256_RE = /^[a-f0-9]{64}$/i;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

function stringField(source: Record<string, unknown>, key: string, required = true): string {
  const value = source[key];
  if (typeof value === "string") return value;
  if (!required && value === undefined) return "";
  throw new Error(`Invalid ${key}`);
}

function numberField(source: Record<string, unknown>, key: string, positive = true): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value) || (positive && value <= 0)) throw new Error(`Invalid ${key}`);
  return value;
}

function notesField(source: Record<string, unknown>): string[] {
  const value = source.notes;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("Invalid notes");
  return value;
}

function parseAndroid(value: unknown): AndroidUpdateManifest | undefined {
  if (value === undefined || value === null) return undefined;
  const source = asRecord(value, "android");
  const apkUrl = stringField(source, "apkUrl");
  const apkSha256 = stringField(source, "apkSha256").toLowerCase();
  if (!apkUrl.startsWith("https://")) throw new Error("Invalid apkUrl");
  if (!SHA256_RE.test(apkSha256)) throw new Error("Invalid apkSha256");
  return {
    channel: stringField(source, "channel", false),
    versionName: stringField(source, "versionName"),
    versionCode: numberField(source, "versionCode"),
    runtimeVersion: stringField(source, "runtimeVersion", false),
    minSupportedVersionCode: Math.max(0, Number(source.minSupportedVersionCode || 0)),
    apkUrl,
    apkSha256,
    apkSizeBytes: Math.max(0, Number(source.apkSizeBytes || 0)),
    mandatory: Boolean(source.mandatory),
    notes: notesField(source),
  };
}

function parseIos(value: unknown): IosUpdateManifest | undefined {
  if (value === undefined || value === null) return undefined;
  const source = asRecord(value, "ios");
  return {
    channel: stringField(source, "channel", false),
    versionName: stringField(source, "versionName"),
    buildNumber: stringField(source, "buildNumber"),
    runtimeVersion: stringField(source, "runtimeVersion", false),
    storeUrl: stringField(source, "storeUrl", false),
    testFlightUrl: stringField(source, "testFlightUrl", false),
  };
}

export function parseMobileUpdateManifest(value: unknown): MobileUpdateManifest {
  const source = asRecord(value, "manifest");
  if (source.schemaVersion !== 1) throw new Error("Invalid schemaVersion");
  return {
    schemaVersion: 1,
    generatedAt: stringField(source, "generatedAt", false),
    android: parseAndroid(source.android),
    ios: parseIos(source.ios),
  };
}
```

- [ ] **Step 4: Run parser tests and verify GREEN**

Run: `cd apps/mobile-rn && npm test -- updateManifest.test.ts --runInBand`

Expected: PASS.

## Task 2: Version Policy

**Files:**
- Create: `apps/mobile-rn/src/updates/versionPolicy.ts`
- Test: `apps/mobile-rn/__tests__/updatePolicy.test.ts`

- [ ] **Step 1: Write failing policy tests**

```ts
import { decideUpdate } from "../src/updates/versionPolicy";
import type { MobileUpdateManifest } from "../src/updates/manifest";

const manifest: MobileUpdateManifest = {
  schemaVersion: 1,
  generatedAt: "2026-06-08T12:00:00.000Z",
  android: {
    channel: "preview",
    versionName: "1.3.2",
    versionCode: 12,
    runtimeVersion: "2",
    minSupportedVersionCode: 8,
    apkUrl: "https://mia.gifgif.cn/downloads/mia-android-latest.apk",
    apkSha256: "13bd217f0d51bed4c2c4b19b9bde3c6818d18181b6e565f6cde64cc7f8482322",
    apkSizeBytes: 100,
    mandatory: false,
    notes: [],
  },
  ios: {
    channel: "testflight",
    versionName: "1.3.2",
    buildNumber: "12",
    runtimeVersion: "2",
    storeUrl: "",
    testFlightUrl: "https://testflight.apple.com/join/example",
  },
};

test("offers an optional Android binary update when manifest versionCode is newer", () => {
  const decision = decideUpdate({ platform: "android", buildVersion: "11", runtimeVersion: "2" }, manifest);
  expect(decision.kind).toBe("android-binary");
  if (decision.kind === "android-binary") expect(decision.mandatory).toBe(false);
});

test("makes Android update mandatory below minSupportedVersionCode", () => {
  const decision = decideUpdate({ platform: "android", buildVersion: "7", runtimeVersion: "2" }, manifest);
  expect(decision.kind).toBe("android-binary");
  if (decision.kind === "android-binary") expect(decision.mandatory).toBe(true);
});

test("does not offer Android update when installed build is current", () => {
  expect(decideUpdate({ platform: "android", buildVersion: "12", runtimeVersion: "2" }, manifest).kind).toBe("none");
});

test("offers iOS store guidance when TestFlight build is newer", () => {
  const decision = decideUpdate({ platform: "ios", buildVersion: "11", runtimeVersion: "2" }, manifest);
  expect(decision.kind).toBe("ios-store");
});

test("does not offer iOS guidance without a store or TestFlight URL", () => {
  const decision = decideUpdate(
    { platform: "ios", buildVersion: "11", runtimeVersion: "2" },
    { ...manifest, ios: { ...manifest.ios!, storeUrl: "", testFlightUrl: "" } }
  );
  expect(decision.kind).toBe("none");
});
```

- [ ] **Step 2: Run policy tests and verify RED**

Run: `cd apps/mobile-rn && npm test -- updatePolicy.test.ts --runInBand`

Expected: FAIL because `versionPolicy.ts` does not exist.

- [ ] **Step 3: Implement version decisions**

```ts
import type { AndroidUpdateManifest, IosUpdateManifest, MobileUpdateManifest } from "./manifest";

export interface InstalledAppInfo {
  platform: "android" | "ios" | "web" | "unknown";
  buildVersion: string;
  runtimeVersion: string;
}

export type UpdateDecision =
  | { kind: "none" }
  | { kind: "android-binary"; target: AndroidUpdateManifest; mandatory: boolean }
  | { kind: "ios-store"; target: IosUpdateManifest; url: string };

function numberFromBuild(value: string): number {
  const parsed = Number.parseInt(String(value || "0"), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function decideUpdate(installed: InstalledAppInfo, manifest: MobileUpdateManifest | null): UpdateDecision {
  if (!manifest) return { kind: "none" };
  const currentBuild = numberFromBuild(installed.buildVersion);
  if (installed.platform === "android" && manifest.android) {
    if (manifest.android.versionCode <= currentBuild) return { kind: "none" };
    return {
      kind: "android-binary",
      target: manifest.android,
      mandatory: manifest.android.mandatory || currentBuild < manifest.android.minSupportedVersionCode,
    };
  }
  if (installed.platform === "ios" && manifest.ios) {
    const targetBuild = numberFromBuild(manifest.ios.buildNumber);
    const url = manifest.ios.testFlightUrl || manifest.ios.storeUrl;
    if (!url || targetBuild <= currentBuild) return { kind: "none" };
    return { kind: "ios-store", target: manifest.ios, url };
  }
  return { kind: "none" };
}
```

- [ ] **Step 4: Run parser and policy tests**

Run: `cd apps/mobile-rn && npm test -- updateManifest.test.ts updatePolicy.test.ts --runInBand`

Expected: PASS.

## Task 3: Runtime Info And Dependencies

**Files:**
- Modify: `apps/mobile-rn/package.json`
- Modify: `package-lock.json`
- Create: `apps/mobile-rn/src/updates/runtimeInfo.ts`
- Test: `apps/mobile-rn/__tests__/runtimeInfo.test.ts`

- [ ] **Step 1: Add failing runtime normalization tests**

```ts
import { normalizeInstalledAppInfo } from "../src/updates/runtimeInfo";

test("normalizes Android native build metadata", () => {
  expect(
    normalizeInstalledAppInfo({
      platform: "android",
      nativeApplicationVersion: "1.0.0",
      nativeBuildVersion: "12",
      runtimeVersion: "2",
    })
  ).toEqual({
    platform: "android",
    versionName: "1.0.0",
    buildVersion: "12",
    runtimeVersion: "2",
  });
});

test("falls back to safe empty strings when native metadata is unavailable", () => {
  expect(
    normalizeInstalledAppInfo({
      platform: "web",
      nativeApplicationVersion: null,
      nativeBuildVersion: null,
      runtimeVersion: null,
    })
  ).toEqual({
    platform: "web",
    versionName: "",
    buildVersion: "0",
    runtimeVersion: "",
  });
});
```

- [ ] **Step 2: Run runtime tests and verify RED**

Run: `cd apps/mobile-rn && npm test -- runtimeInfo.test.ts --runInBand`

Expected: FAIL because `runtimeInfo.ts` does not exist.

- [ ] **Step 3: Install Expo dependencies**

Run: `cd apps/mobile-rn && npx expo install expo-application expo-crypto`

Expected: `apps/mobile-rn/package.json` includes `expo-application` and `expo-crypto`; root `package-lock.json` updates.

- [ ] **Step 4: Implement runtime info**

```ts
import { Platform } from "react-native";
import * as Application from "expo-application";
import * as Updates from "expo-updates";
import type { InstalledAppInfo } from "./versionPolicy";

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
  return normalizeInstalledAppInfo({
    platform: Platform.OS,
    nativeApplicationVersion: Application.nativeApplicationVersion,
    nativeBuildVersion: Application.nativeBuildVersion,
    runtimeVersion: Updates.runtimeVersion || "",
  });
}

export function getUpdateChannel(): string {
  return Updates.channel || "";
}
```

- [ ] **Step 5: Run runtime tests**

Run: `cd apps/mobile-rn && npm test -- runtimeInfo.test.ts --runInBand`

Expected: PASS.

## Task 4: Checksum And Android Installer Facade

**Files:**
- Create: `apps/mobile-rn/src/updates/checksum.ts`
- Create: `apps/mobile-rn/src/updates/androidInstaller.ts`
- Test: `apps/mobile-rn/__tests__/androidInstaller.test.ts`

- [ ] **Step 1: Write failing facade tests**

```ts
import { hexFromArrayBuffer } from "../src/updates/checksum";
import { prepareAndroidApkInstall } from "../src/updates/androidInstaller";

const target = {
  channel: "preview",
  versionName: "1.3.2",
  versionCode: 12,
  runtimeVersion: "2",
  minSupportedVersionCode: 1,
  apkUrl: "https://mia.gifgif.cn/downloads/mia-android-latest.apk",
  apkSha256: "13bd217f0d51bed4c2c4b19b9bde3c6818d18181b6e565f6cde64cc7f8482322",
  apkSizeBytes: 100,
  mandatory: false,
  notes: [],
};

test("formats SHA bytes as lowercase hex", () => {
  expect(hexFromArrayBuffer(new Uint8Array([0, 15, 16, 255]).buffer)).toBe("000f10ff");
});

test("rejects checksum mismatch before native install", async () => {
  await expect(
    prepareAndroidApkInstall(target, {
      downloadApk: async () => "file:///cache/mia.apk",
      sha256File: async () => "bad",
      inspectApk: async () => ({ packageName: "app.mia.mobile", versionCode: 12, versionName: "1.3.2" }),
      installedPackageName: "app.mia.mobile",
      installedVersionCode: 11,
    })
  ).rejects.toThrow(/校验失败/);
});

test("rejects APKs for a different package", async () => {
  await expect(
    prepareAndroidApkInstall(target, {
      downloadApk: async () => "file:///cache/mia.apk",
      sha256File: async () => target.apkSha256,
      inspectApk: async () => ({ packageName: "evil.app", versionCode: 12, versionName: "1.3.2" }),
      installedPackageName: "app.mia.mobile",
      installedVersionCode: 11,
    })
  ).rejects.toThrow(/包名不匹配/);
});

test("returns install info for a valid newer APK", async () => {
  await expect(
    prepareAndroidApkInstall(target, {
      downloadApk: async () => "file:///cache/mia.apk",
      sha256File: async () => target.apkSha256,
      inspectApk: async () => ({ packageName: "app.mia.mobile", versionCode: 12, versionName: "1.3.2" }),
      installedPackageName: "app.mia.mobile",
      installedVersionCode: 11,
    })
  ).resolves.toEqual({
    localUri: "file:///cache/mia.apk",
    packageName: "app.mia.mobile",
    versionCode: 12,
    versionName: "1.3.2",
  });
});
```

- [ ] **Step 2: Run facade tests and verify RED**

Run: `cd apps/mobile-rn && npm test -- androidInstaller.test.ts --runInBand`

Expected: FAIL because checksum and installer modules do not exist.

- [ ] **Step 3: Implement checksum helper**

```ts
import { File } from "expo-file-system";
import * as Crypto from "expo-crypto";

export function hexFromArrayBuffer(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256File(uri: string): Promise<string> {
  const bytes = await new File(uri).bytes();
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
  return hexFromArrayBuffer(digest).toLowerCase();
}
```

- [ ] **Step 4: Implement Android installer facade**

```ts
import { Directory, File, Paths } from "expo-file-system";
import type { AndroidUpdateManifest } from "./manifest";

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
```

- [ ] **Step 5: Run facade tests**

Run: `cd apps/mobile-rn && npm test -- androidInstaller.test.ts --runInBand`

Expected: PASS.

## Task 5: Android Local Expo Module And Config Plugin

**Files:**
- Create: `apps/mobile-rn/modules/mia-android-updater/expo-module.config.json`
- Create: `apps/mobile-rn/modules/mia-android-updater/index.ts`
- Create: `apps/mobile-rn/modules/mia-android-updater/src/MiaAndroidUpdaterModule.ts`
- Create: `apps/mobile-rn/modules/mia-android-updater/plugin/withMiaAndroidUpdater.js`
- Create: `apps/mobile-rn/modules/mia-android-updater/android/build.gradle`
- Create: `apps/mobile-rn/modules/mia-android-updater/android/src/main/AndroidManifest.xml`
- Create: `apps/mobile-rn/modules/mia-android-updater/android/src/main/java/app/mia/updater/MiaAndroidUpdaterModule.kt`
- Modify: `apps/mobile-rn/app.config.ts`

- [ ] **Step 1: Create JS module wrapper**

```ts
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

export function canRequestPackageInstalls() {
  return requireAndroidModule().canRequestPackageInstalls();
}

export function openUnknownSourcesSettings() {
  return requireAndroidModule().openUnknownSourcesSettings();
}

export function inspectApk(localUri: string) {
  return requireAndroidModule().inspectApk(localUri);
}

export function installApk(localUri: string) {
  return requireAndroidModule().installApk(localUri);
}
```

- [ ] **Step 2: Create config plugin**

Use `withAndroidManifest` to add `android.permission.REQUEST_INSTALL_PACKAGES` and a `FileProvider`, and `withDangerousMod` to write `android/app/src/main/res/xml/mia_update_file_paths.xml`.

Expected provider authority: `${android.package}.mia_update_file_provider`.

- [ ] **Step 3: Create Kotlin module**

Implement:

- `canRequestPackageInstalls()`: `packageManager.canRequestPackageInstalls()` on API 26+, `true` on older Android.
- `openUnknownSourcesSettings()`: `Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES` with `package:<currentPackage>`.
- `inspectApk(localUri)`: `PackageManager.getPackageArchiveInfo()` and long versionCode handling.
- `installApk(localUri)`: `FileProvider.getUriForFile()`, `Intent.ACTION_INSTALL_PACKAGE`, `FLAG_GRANT_READ_URI_PERMISSION`, and `FLAG_ACTIVITY_NEW_TASK`.

- [ ] **Step 4: Register plugin in app config**

Modify `apps/mobile-rn/app.config.ts`:

```ts
plugins: [
  "expo-secure-store",
  "expo-video",
  "./modules/mia-android-updater/plugin/withMiaAndroidUpdater",
],
```

- [ ] **Step 5: Typecheck native module wrapper**

Run: `cd apps/mobile-rn && npm run typecheck`

Expected: PASS. Native Kotlin compile is verified by EAS/prebuild in the final verification task.

## Task 6: OTA Updates And Provider/UI

**Files:**
- Create: `apps/mobile-rn/src/updates/otaUpdates.ts`
- Create: `apps/mobile-rn/src/updates/UpdateProvider.tsx`
- Create: `apps/mobile-rn/src/updates/UpdatePrompt.tsx`
- Modify: `apps/mobile-rn/App.tsx`

- [ ] **Step 1: Add OTA wrapper**

```ts
import * as Updates from "expo-updates";

export async function checkForOtaUpdate(): Promise<boolean> {
  if (!Updates.isEnabled) return false;
  const result = await Updates.checkForUpdateAsync();
  return Boolean(result.isAvailable);
}

export async function fetchOtaUpdate(): Promise<void> {
  await Updates.fetchUpdateAsync();
}

export async function reloadIntoOtaUpdate(): Promise<void> {
  await Updates.reloadAsync();
}
```

- [ ] **Step 2: Add `UpdateProvider`**

Provider responsibilities:

- Fetch `<apiBase>/downloads/mia-mobile-update.json` after initial render.
- Parse manifest with `parseMobileUpdateManifest`.
- Decide binary/store update with `decideUpdate`.
- If no binary/store update, check EAS OTA.
- Keep optional dismiss state in memory by target version/build.
- Expose manual check for Settings.

- [ ] **Step 3: Add `UpdatePrompt`**

Use `Modal`, existing `Button`, `Body`, `BodyStrong`, `Sub`, and theme tokens. States:

- `checking`
- `downloading`
- `verifying`
- `waiting_permission`
- `opening_installer`
- `failed`

- [ ] **Step 4: Mount provider**

Modify `apps/mobile-rn/App.tsx`:

```tsx
<ApiProvider>
  <UpdateProvider>
    <EventsProvider>
      <StatusBar style="dark" />
      <RootNavigator />
    </EventsProvider>
  </UpdateProvider>
</ApiProvider>
```

- [ ] **Step 5: Typecheck**

Run: `cd apps/mobile-rn && npm run typecheck`

Expected: PASS.

## Task 7: Settings Update Card

**Files:**
- Create: `apps/mobile-rn/src/updates/UpdateSettingsCard.tsx`
- Modify: `apps/mobile-rn/src/screens/SettingsScreen.tsx`

- [ ] **Step 1: Add settings card**

The card should show:

- App version name
- Native build version
- Runtime version
- Update channel
- Last check state
- Manual "检查更新" button

- [ ] **Step 2: Render card in Settings**

Place it after the account section and before sync settings:

```tsx
<UpdateSettingsCard />
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/mobile-rn && npm run typecheck`

Expected: PASS.

## Task 8: Cloud/Web Mobile Release Manifest

**Files:**
- Create: `scripts/mobile-update-manifest.js`
- Modify: `scripts/build-cloud-release.js`
- Modify: `tests/web-landing.test.js`

- [ ] **Step 1: Write failing Node tests**

Add a `node:test` case that creates a temp APK file, calls `publishMobileAndroidDownload()`, and asserts:

- `downloads/mia-android-latest.apk` exists
- `downloads/mia-mobile-update.json` exists
- manifest SHA-256 equals the temp APK hash
- manifest URL uses `/downloads/mia-android-latest.apk`

- [ ] **Step 2: Run web landing tests and verify RED**

Run: `node --test tests/web-landing.test.js`

Expected: FAIL because `scripts/mobile-update-manifest.js` does not exist.

- [ ] **Step 3: Implement release helper**

Exports:

```js
function sha256File(filePath) {}
function createMobileAndroidManifest(options) {}
function publishMobileAndroidDownload(options) {}
module.exports = { sha256File, createMobileAndroidManifest, publishMobileAndroidDownload };
```

Inputs should include source APK path, downloads dir, public base URL, versionName, versionCode, runtimeVersion, minSupportedVersionCode, mandatory, and notes.

- [ ] **Step 4: Wire Cloud release builder**

In `scripts/build-cloud-release.js`, call the helper from `copyMobileDownloadArtifacts()` after `copyDesktopDownloadArtifacts()`.

Use environment variables:

- `MIA_MOBILE_ANDROID_APK`
- `MIA_MOBILE_ANDROID_VERSION_NAME`
- `MIA_MOBILE_ANDROID_VERSION_CODE`
- `MIA_MOBILE_ANDROID_RUNTIME_VERSION`
- `MIA_MOBILE_ANDROID_MIN_SUPPORTED_VERSION_CODE`
- `MIA_MOBILE_ANDROID_MANDATORY`
- `MIA_MOBILE_ANDROID_NOTES`

If `MIA_MOBILE_ANDROID_APK` is absent, skip mobile downloads without failing.

- [ ] **Step 5: Run release tests**

Run: `node --test tests/web-landing.test.js`

Expected: PASS.

## Task 9: Build Version Policy

**Files:**
- Modify: `apps/mobile-rn/eas.json`
- Test: `tests/mobile-updater-config.test.js`

- [ ] **Step 1: Add failing config test**

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

test("mobile preview APK builds auto-increment Android versionCode", () => {
  const eas = JSON.parse(fs.readFileSync(path.join(root, "apps/mobile-rn/eas.json"), "utf8"));
  assert.equal(eas.build.preview.autoIncrement, true);
  assert.equal(eas.build.preview.android.buildType, "apk");
});
```

- [ ] **Step 2: Run config test and verify RED**

Run: `node --test tests/mobile-updater-config.test.js`

Expected: FAIL because preview profile does not have `autoIncrement`.

- [ ] **Step 3: Enable preview autoIncrement**

Modify `apps/mobile-rn/eas.json`:

```json
"preview": {
  "distribution": "internal",
  "channel": "preview",
  "autoIncrement": true,
  "android": { "buildType": "apk" }
}
```

- [ ] **Step 4: Run config test**

Run: `node --test tests/mobile-updater-config.test.js`

Expected: PASS.

## Task 10: Final Verification And Release Build

**Files:**
- All implementation files.

- [ ] **Step 1: Run mobile Jest**

Run: `cd apps/mobile-rn && npm test -- --runInBand`

Expected: PASS.

- [ ] **Step 2: Run mobile typecheck**

Run: `cd apps/mobile-rn && npm run typecheck`

Expected: PASS.

- [ ] **Step 3: Run targeted root tests**

Run: `node --test tests/web-landing.test.js tests/mobile-updater-config.test.js tests/project-structure-check.test.js`

Expected: PASS.

- [ ] **Step 4: Run whitespace check**

Run: `git diff --check`

Expected: no output.

- [ ] **Step 5: Build Android preview APK**

Run: `cd apps/mobile-rn && npx eas build --platform android --profile preview --non-interactive`

Expected: EAS build succeeds and produces an APK. This build is necessary because the updater adds native Android behavior.

- [ ] **Step 6: Publish preview APK metadata**

After EAS build completes, download the APK artifact and compute SHA-256. Use the Cloud release helper or GitHub release notes to publish:

- APK URL
- SHA-256
- versionCode
- runtimeVersion

- [ ] **Step 7: Commit implementation**

Commit message:

```bash
git add apps/mobile-rn scripts tests package-lock.json
git commit -m "feat(mobile): 添加应用内更新器"
```
