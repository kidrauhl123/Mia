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
