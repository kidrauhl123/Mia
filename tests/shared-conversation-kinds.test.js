const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  ConversationKind,
  MemberKind,
  SenderKind,
  isGroup,
  isPrivate,
  isCloudBacked
} = require("../src/shared/conversation-kinds");

test("ConversationKind values match the literals used across the codebase", () => {
  assert.equal(ConversationKind.BotPrivate, "bot");
  assert.equal(ConversationKind.LocalGroup, "local-group");
  assert.equal(ConversationKind.CloudDM, "dm");
  assert.equal(ConversationKind.CloudGroup, "group");
});

test("MemberKind values match member_kind literals", () => {
  assert.equal(MemberKind.Bot, "bot");
  assert.equal(MemberKind.User, "user");
});

test("SenderKind values match sender_kind literals", () => {
  assert.equal(SenderKind.Bot, "bot");
  assert.equal(SenderKind.User, "user");
  assert.equal(SenderKind.System, "system");
});

test("enums are frozen", () => {
  assert.equal(Object.isFrozen(ConversationKind), true);
  assert.equal(Object.isFrozen(MemberKind), true);
  assert.equal(Object.isFrozen(SenderKind), true);
  assert.throws(() => { "use strict"; ConversationKind.BotPrivate = "x"; }, TypeError);
});

test("isGroup matches LocalGroup and CloudGroup only", () => {
  assert.equal(isGroup({ kind: "local-group" }), true);
  assert.equal(isGroup({ kind: "group" }), true);
  assert.equal(isGroup({ kind: "bot" }), false);
  assert.equal(isGroup({ kind: "dm" }), false);
  assert.equal(isGroup("local-group"), true);
  assert.equal(isGroup("group"), true);
  assert.equal(isGroup("bot"), false);
  assert.equal(isGroup(null), false);
  assert.equal(isGroup(undefined), false);
  assert.equal(isGroup({}), false);
});

test("isPrivate matches BotPrivate and CloudDM only", () => {
  assert.equal(isPrivate({ kind: "bot" }), true);
  assert.equal(isPrivate({ kind: "dm" }), true);
  assert.equal(isPrivate({ kind: "group" }), false);
  assert.equal(isPrivate({ kind: "local-group" }), false);
  assert.equal(isPrivate("bot"), true);
  assert.equal(isPrivate("dm"), true);
  assert.equal(isPrivate("group"), false);
  assert.equal(isPrivate(null), false);
});

test("isCloudBacked matches CloudDM and CloudGroup only", () => {
  assert.equal(isCloudBacked({ kind: "dm" }), true);
  assert.equal(isCloudBacked({ kind: "group" }), true);
  assert.equal(isCloudBacked({ kind: "bot" }), false);
  assert.equal(isCloudBacked({ kind: "local-group" }), false);
  assert.equal(isCloudBacked("dm"), true);
  assert.equal(isCloudBacked("group"), true);
  assert.equal(isCloudBacked("bot"), false);
  assert.equal(isCloudBacked("local-group"), false);
  assert.equal(isCloudBacked(null), false);
});

test("type guards handle unknown kinds without throwing", () => {
  assert.equal(isGroup({ kind: "broadcast" }), false);
  assert.equal(isPrivate({ kind: "channel" }), false);
  assert.equal(isCloudBacked({ kind: "" }), false);
});
