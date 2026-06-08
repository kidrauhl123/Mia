import { prepareAndroidApkInstall } from "../src/updates/androidInstaller";
import { hexFromArrayBuffer } from "../src/updates/checksum";

const target = {
  channel: "preview",
  versionName: "1.3.2",
  versionCode: 12,
  runtimeVersion: "2",
  minSupportedVersionCode: 1,
  apkUrl: "https://aiweb.buytb01.com/downloads/mia-android-latest.apk",
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

test("rejects APKs that are not newer than the installed build", async () => {
  await expect(
    prepareAndroidApkInstall(target, {
      downloadApk: async () => "file:///cache/mia.apk",
      sha256File: async () => target.apkSha256,
      inspectApk: async () => ({ packageName: "app.mia.mobile", versionCode: 11, versionName: "1.3.1" }),
      installedPackageName: "app.mia.mobile",
      installedVersionCode: 11,
    })
  ).rejects.toThrow(/不是更新版本/);
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
