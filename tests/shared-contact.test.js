const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveContact, IdentityKind, botAvatarIdentityId } = require("../src/shared/contact");
const avatarResolve = require("../src/shared/avatar-resolve");

const ctx = {
  self: { id: "user_me", username: "me", displayName: "Boss", avatarImage: "data:me", avatarCrop: { x: 50, y: 50, zoom: 1 }, avatarColor: "#111" },
  bots: [{ id: "bot_codex", ownerUserId: "user_me", displayName: "Codex", avatarImage: "./assets/avatars/02.png", avatarCrop: { x: 57, y: 8, zoom: 1.5 }, color: "#5e5ce6" }],
  friends: [{ id: "user_friend", username: "alice", avatarImage: "data:alice", avatarCrop: { x: 50, y: 50, zoom: 1 }, avatarColor: "#34c759" }]
};

test("resolveContact self", () => {
  const c = resolveContact({ kind: "self" }, ctx);
  assert.equal(c.kind, IdentityKind.User);
  assert.equal(c.displayName, "Boss");
  assert.equal(c.avatar.image, "data:me");
});

test("resolveContact self display prefers local profile displayName", () => {
  const c = resolveContact({ kind: "user", ref: "user_me" }, {
    self: {
      id: "user_me",
      username: "7",
      displayName: "Boss",
      avatarText: "B"
    },
    friends: []
  });
  assert.equal(c.kind, IdentityKind.User);
  assert.equal(c.displayName, "Boss");
});

test("resolveContact bot by id", () => {
  const c = resolveContact({ kind: "bot", ref: "bot_codex" }, ctx);
  assert.equal(c.kind, IdentityKind.Bot);
  assert.equal(c.id, "bot_codex");
  assert.equal(c.displayName, "Codex");
  assert.equal(c.ownerUserId, "user_me");
});

test("resolveContact bot avatar uses owner-scoped bot identity", () => {
  const c = resolveContact({ kind: "bot", ref: "bot_mia" }, {
    bots: [{ id: "bot_mia", ownerUserId: "user_me", displayName: "Mia" }]
  });
  const expected = avatarResolve.resolveAvatarForContact({
    id: "user_me:bot_mia",
    displayName: "Mia",
    avatarImage: "",
    avatarCrop: null
  });

  assert.equal(botAvatarIdentityId("bot_mia", { ownerUserId: "user_me" }), "user_me:bot_mia");
  assert.deepEqual(c.avatar, expected);
});

test("resolveContact friend by id", () => {
  const c = resolveContact({ kind: "user", ref: "user_friend" }, ctx);
  assert.equal(c.kind, IdentityKind.User);
  assert.equal(c.displayName, "alice");
  assert.equal(c.avatar.image, "data:alice");
});

test("resolveContact unknown returns stable fallback avatar", () => {
  const c = resolveContact({ kind: "user", ref: "user_ghost" }, ctx);
  assert.equal(c.displayName, "user_ghost");
  assert.equal(c.avatar.image, "");
  assert.equal(c.avatar.crop, null);
  assert.equal(c.avatar.text, "us");
});
