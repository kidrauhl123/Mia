import {
  resolveStatusBadgeAssetUrl,
  safeStatusBadgeAssetId,
  statusBadgeAssetPath,
  statusBadgeAssetsPath,
  statusBadgeCacheFileName,
  statusBadgeForValue,
  statusBadgeValue,
} from "../src/logic/statusBadgeAssets";

test("status badge asset helpers build safe cloud paths", () => {
  expect(statusBadgeAssetsPath()).toBe("/api/status-badge-assets");
  expect(safeStatusBadgeAssetId("rainbow_1")).toBe("rainbow_1");
  expect(safeStatusBadgeAssetId("../rainbow")).toBe("");
  expect(statusBadgeAssetPath("rainbow")).toBe("/api/status-badge-assets/rainbow.json");
  expect(resolveStatusBadgeAssetUrl("rainbow", "https://mia.example.com/")).toBe("https://mia.example.com/api/status-badge-assets/rainbow.json");
});

test("status badge cache filenames include manifest hashes", () => {
  expect(statusBadgeCacheFileName({ assetId: "rainbow", sha256: "abcdef0123456789ff" })).toBe("rainbow-abcdef0123456789.json");
  expect(statusBadgeCacheFileName({ id: "rainbow" })).toBe("rainbow.json");
  expect(statusBadgeCacheFileName({ id: "../bad" })).toBe("");
});

test("status badge catalog maps UI values to stored badge descriptors", () => {
  expect(statusBadgeForValue("surprised-cat")).toEqual({ kind: "lottie", assetId: "surprised-cat", label: "惊讶猫", loop: "always" });
  expect(statusBadgeValue({ kind: "emoji", emoji: "🔥" })).toBe("fire");
  expect(statusBadgeValue({ kind: "lottie", assetId: "rainbow" })).toBe("rainbow");
  expect(statusBadgeForValue("../bad")).toBeNull();
});
