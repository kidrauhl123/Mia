import {
  botDetailPath,
  botConversationPath,
  botRuntimeSavePath,
  botRuntimePath,
  bridgeDevicesPath,
  bridgeRunsPath,
  conversationsPath,
  friendPath,
  friendRequestCancelPath,
  friendRequestCreatePath,
  friendRequestRespondPath,
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
  expect(friendRequestCreatePath()).toBe("/api/social/friend-requests");
  expect(friendRequestRespondPath("req.1")).toBe("/api/social/friend-requests/req.1/respond");
  expect(friendRequestCancelPath("req.1")).toBe("/api/social/friend-requests/req.1");
  expect(friendPath("u.1")).toBe("/api/social/friends/u.1");
  expect(conversationsPath()).toBe("/api/conversations");
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
  expect(botConversationPath("bot.one")).toBe("/api/me/bot-conversations/bot.one");
});
