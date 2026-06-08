# Mobile RN In-App Updater Design

Status: design approved on 2026-06-08. Implementation has not started.

## Goal

Mia Mobile should tell users when a newer mobile build is available and guide them through the correct update path for their platform and distribution channel.

The first updater release targets the current Android preview/self-hosted APK path. It must also preserve the future App Store / Google Play path: iOS cannot install an IPA from inside the app, and Google Play production builds should not depend on self-hosted APK installation.

## Product Behavior

The updater has three update paths:

1. EAS JS update for JavaScript, TypeScript, style, and bundled asset changes that are compatible with the installed native runtime.
2. Android self-hosted APK update for preview/internal Android builds distributed from Mia's website or CDN.
3. Store/TestFlight guidance for iOS and future store-distributed builds.

The app never silently installs a binary. Android always hands the downloaded APK to the system package installer, and the user must confirm the installation. If Android requires "install unknown apps" permission for Mia, the app explains the need and opens the system settings screen for that source.

The first APK that contains this updater still has to be installed manually. After that, Android preview users can receive in-app update prompts.

## Non-Goals

- No silent installation.
- No iOS IPA download or sideload flow.
- No replacement for App Store, TestFlight, or Google Play production update mechanisms.
- No blocking splash-screen update check. Startup should not wait on a slow network.
- No custom CDN implementation inside the app. The app consumes HTTPS URLs; Cloud/Web/CDN decides where the files live.

## Manifest

The app fetches a static JSON manifest from:

`<apiBase>/downloads/mia-mobile-update.json`

Default production preview base is currently `https://aiweb.buytb01.com`, so the first public manifest URL is:

`https://aiweb.buytb01.com/downloads/mia-mobile-update.json`

Proposed schema:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-06-08T12:00:00.000Z",
  "android": {
    "channel": "preview",
    "versionName": "1.3.2",
    "versionCode": 12,
    "runtimeVersion": "2",
    "minSupportedVersionCode": 1,
    "apkUrl": "https://aiweb.buytb01.com/downloads/mia-android-latest.apk",
    "apkSha256": "13bd217f0d51bed4c2c4b19b9bde3c6818d18181b6e565f6cde64cc7f8482322",
    "apkSizeBytes": 100663296,
    "mandatory": false,
    "notes": [
      "修复聊天输入框遮挡",
      "修复消息重复显示"
    ]
  },
  "ios": {
    "channel": "testflight",
    "versionName": "1.3.2",
    "buildNumber": "12",
    "runtimeVersion": "2",
    "storeUrl": "",
    "testFlightUrl": ""
  }
}
```

Rules:

- `schemaVersion` must be `1`; unknown schema versions are ignored with a user-visible error only in Settings.
- `apkUrl` must be HTTPS.
- `apkSha256` is required before Android starts the installer.
- `versionCode` must be greater than the installed Android build version before the binary update is offered.
- `minSupportedVersionCode` or `mandatory: true` makes the prompt blocking for Android preview builds.
- `runtimeVersion` is displayed and used for diagnostics. Native compatibility for EAS JS updates remains governed by Expo runtimeVersion.

## App Architecture

Add a mobile update feature under `apps/mobile-rn/src/updates/` with small, testable units:

- `manifest.ts`: parse and validate the JSON manifest.
- `versionPolicy.ts`: compare installed version/build/runtime with manifest entries and decide whether to show no update, an optional update, or a mandatory update.
- `otaUpdates.ts`: wrap `expo-updates` checks, fetches, and reloads.
- `androidInstaller.ts`: JS facade for Android APK download, checksum verification, unknown-source permission, and system installer launch.
- `UpdateProvider.tsx`: app-level orchestration, foreground checks, throttling, and state.
- `UpdatePrompt.tsx`: modal/sheet for optional and mandatory prompts.
- `UpdateSettingsCard.tsx`: settings row showing installed version, runtime, channel, check status, and manual "检查更新".

Mount `UpdateProvider` inside `App.tsx` below `ApiProvider` and above navigation so the app can check before or after login. Use `useAuth().apiBase` so custom server URLs work.

## Android Native Boundary

Android APK installation needs a native boundary because the app must hand a downloaded local APK to the Android package installer through a content URI and must check whether Mia is trusted to request package installs.

Use an Android-only local Expo module plus config plugin, kept inside `apps/mobile-rn/modules/mia-android-updater/`.

JS API:

```ts
export interface AndroidApkInfo {
  packageName: string;
  versionCode: number;
  versionName: string;
}

export async function canRequestPackageInstalls(): Promise<boolean>;
export async function openUnknownSourcesSettings(): Promise<void>;
export async function inspectApk(localUri: string): Promise<AndroidApkInfo>;
export async function installApk(localUri: string): Promise<void>;
```

Native responsibilities:

- Add `android.permission.REQUEST_INSTALL_PACKAGES` only for self-hosted Android build profiles.
- Add a `FileProvider` that can share the app cache download directory.
- Convert the local APK path to a `content://` URI.
- Grant read permission to the package installer intent.
- Launch the system installer with user confirmation.
- Inspect the APK before launch and reject if package name is not `app.mia.mobile` or versionCode is not greater than the installed build.

For store production profiles, the config should disable the APK installer permission/module behavior and use the store guidance path instead.

## EAS JS Updates

The updater should check EAS updates when `expo-updates` is enabled and the app is running a release build. If an update is available:

1. Show a lightweight prompt saying a small update is available.
2. Download with `Updates.fetchUpdateAsync()`.
3. Offer "立即重启" using `Updates.reloadAsync()`.

If an Android binary update is also available, binary update has priority because it can carry native changes that EAS cannot apply.

The app should keep Expo's native `runtimeVersion` boundary strict. Any change that adds native code, native dependencies, Android permissions, iOS entitlements, or config plugin output requires a new binary/runtime path, not EAS-only delivery.

## UI

Startup check:

- Run in the background after initial render.
- Do not block login or the main app unless the manifest marks the installed Android build as unsupported.
- Suppress optional prompts after the user taps "稍后" for the current target version during the current session.

Prompt content:

- Title: "发现新版本"
- Version/build line: `1.3.2 (12)`
- Notes list from the manifest.
- Primary action: "下载更新" for Android APK, "更新并重启" for EAS JS update, "打开 TestFlight/App Store" for iOS/store.
- Secondary action: "稍后" only when not mandatory.

Download states:

- Checking
- Downloading with bytes/progress when available
- Verifying SHA-256
- Waiting for install permission
- Opening installer
- Failed with retry

Settings:

- Add an "应用版本" section to `SettingsScreen`.
- Show installed app version, native build version, runtimeVersion, update channel, and last check result.
- Include manual "检查更新".

## Release Flow

Android preview builds must increment build version on every APK release. The current `preview` EAS profile should be changed to use `autoIncrement: true` or an equivalent explicit versionCode process. Without this, Android may refuse to treat a downloaded APK as a newer update.

Release steps for Android preview:

1. Build APK with EAS preview profile.
2. Download the APK artifact.
3. Compute SHA-256 and size.
4. Publish the APK to `/downloads/mia-android-latest.apk` or a CDN URL.
5. Publish `/downloads/mia-mobile-update.json` with matching versionCode, URL, SHA-256, size, runtimeVersion, notes, and mandatory flag.
6. Verify public URLs before announcing the build.

The implementation should update Cloud release tooling so a mobile release can publish the Android APK and manifest into the web downloads directory, similar to the existing desktop DMG download path. CDN can sit in front of the same `/downloads/` paths or replace the manifest URLs with CDN URLs.

## Security And Policy

- Only HTTPS APK URLs are accepted.
- The app verifies SHA-256 before launching the installer.
- The Android native module verifies package name and versionCode before launching the installer.
- Android system signature checks still enforce that an update APK is signed by the same key as the installed app.
- Google Play production builds should not include self-update APK behavior unless Mia has a valid Play policy reason and declaration. Store builds should use Google Play in-app updates when that distribution path is active.
- iOS builds never attempt binary self-update.

## Error Handling

- Manifest fetch failure during startup is silent except for a non-blocking Settings status.
- Invalid manifest is ignored and shown as "更新信息异常" in Settings.
- SHA mismatch deletes the downloaded APK and shows "安装包校验失败".
- Unknown-source permission denial keeps the prompt open with an action to reopen settings.
- If the installer is opened and the app resumes with the same build version, show the update as still available.
- If the manifest points to the current or older Android build, do not prompt.

## Testing

Automated tests:

- Manifest parser accepts valid v1 manifests and rejects missing SHA, non-HTTPS APK URLs, invalid versionCode, and wrong schema.
- Version policy chooses no update, optional Android update, mandatory Android update, iOS store guidance, and EAS-only states.
- Android installer facade rejects wrong package name, same/lower versionCode, and checksum mismatch before calling native install.
- Settings/card rendering handles current version, available update, checking, error, and unsupported build states.
- Cloud/Web release tests verify `/downloads/mia-mobile-update.json` is included when a mobile APK is present.

Manual verification:

- Android preview old APK detects a newer manifest.
- Optional update can be postponed.
- Mandatory update blocks normal use until update/install guidance is followed.
- Downloaded APK opens Android package installer.
- SHA mismatch never opens installer.
- Unknown-source settings path opens the correct Android settings page.
- After installing the new APK, Settings shows the new build version and no longer prompts for that version.
- EAS JS update prompt downloads and reloads on a compatible release build.

## References

- Expo Updates SDK 56: https://docs.expo.dev/versions/v56.0.0/sdk/updates/
- Expo runtime versions: https://docs.expo.dev/eas-update/runtime-versions/
- Expo app version management: https://docs.expo.dev/build-reference/app-versions/
- Android package install permission: https://developer.android.com/reference/android/Manifest.permission#REQUEST_INSTALL_PACKAGES
- Android install-source trust check: https://developer.android.com/reference/android/content/pm/PackageManager#canRequestPackageInstalls()
- Android unknown app sources settings: https://developer.android.com/reference/android/provider/Settings#ACTION_MANAGE_UNKNOWN_APP_SOURCES
- Android FileProvider: https://developer.android.com/reference/androidx/core/content/FileProvider
- Google Play in-app updates: https://developer.android.com/guide/playcore/in-app-updates
- Google Play REQUEST_INSTALL_PACKAGES policy: https://support.google.com/googleplay/android-developer/answer/12085295
