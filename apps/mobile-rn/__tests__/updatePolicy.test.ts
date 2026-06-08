import type { MobileUpdateManifest } from "../src/updates/manifest";
import { decideUpdate } from "../src/updates/versionPolicy";

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
