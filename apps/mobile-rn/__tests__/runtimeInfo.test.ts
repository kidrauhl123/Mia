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
