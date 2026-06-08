import {
  botDetailPath,
  botRuntimeSavePath,
  botRuntimePath,
  bridgeDevicesPath,
  bridgeRunsPath,
  friendRequestsPath,
  modelCatalogPath,
  settingsPath,
  skillDetailPath,
  skillsPath,
} from "../src/api/endpoints";

test("builds account and bridge endpoint paths", () => {
  expect(settingsPath()).toBe("/api/me/settings");
  expect(bridgeDevicesPath()).toBe("/api/bridge/devices");
  expect(bridgeRunsPath()).toBe("/api/bridge/runs");
});

test("builds social endpoint paths", () => {
  expect(friendRequestsPath("incoming")).toBe("/api/social/friend-requests?direction=incoming");
  expect(friendRequestsPath("outgoing")).toBe("/api/social/friend-requests?direction=outgoing");
});

test("builds bot endpoint paths and runtime query", () => {
  expect(botDetailPath("bot.one")).toBe("/api/me/bots/bot.one");
  expect(botRuntimePath("bot.one", "desktop-local")).toBe("/api/me/bots/bot.one/runtime?kind=desktop-local");
});

test("builds skill endpoint paths with escaping and optional filters", () => {
  expect(skillsPath({ q: "code review", category: "dev tools", limit: 25 })).toBe(
    "/api/skills?q=code+review&category=dev+tools&limit=25"
  );
  expect(skillsPath()).toBe("/api/skills");
  expect(skillDetailPath("hermes.code-review")).toBe("/api/skills/hermes.code-review");
});

test("builds runtime control endpoint paths", () => {
  expect(modelCatalogPath()).toBe("/api/me/model-catalog");
  expect(botRuntimeSavePath("bot.one")).toBe("/api/me/bots/bot.one/runtime");
});
