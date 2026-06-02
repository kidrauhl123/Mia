const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveContact, ContactKind, fellowAvatarIdentityId } = require("../src/shared/contact");
const avatarResolve = require("../src/shared/avatar-resolve");

const ctx = {
  self: { id: "user_me", username: "me", avatarImage: "data:me", avatarCrop: {x:50,y:50,zoom:1}, avatarColor: "#111" },
  fellows: [{ key: "codex", id: "codex", name: "Codex", avatarImage: "./assets/avatars/02.png", avatarCrop: { x: 57, y: 8, zoom: 1.5 }, color: "#5e5ce6" }],
  friends: [{ id: "user_friend", username: "alice", avatarImage: "data:alice", avatarCrop: { x: 50, y: 50, zoom: 1 }, avatarColor: "#34c759" }]
};

test("resolveContact self", () => {
  const c = resolveContact({ kind: "self" }, ctx);
  assert.equal(c.kind, ContactKind.Self);
  assert.equal(c.displayName, "me");
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
  assert.equal(c.kind, ContactKind.Self);
  assert.equal(c.displayName, "Boss");
});

test("resolveContact fellow by key", () => {
  const c = resolveContact({ kind: "fellow", ref: "codex" }, ctx);
  assert.equal(c.kind, ContactKind.Fellow);
  assert.equal(c.displayName, "Codex");
  assert.equal(c.avatar.image, "");
  assert.equal(c.avatar.crop, null);
  assert.equal(c.avatar.text, "Co");
});

test("resolveContact fellow avatar hashes canonical global fellow identity", () => {
  const c = resolveContact({ kind: "fellow", ref: "mia" }, {
    fellows: [{ key: "mia", id: "mia", ownerUserId: "user_me", name: "Mia" }]
  });
  const expected = avatarResolve.resolveAvatarForContact({
    id: "fellow:user_me:mia",
    displayName: "Mia",
    avatarImage: "",
    avatarCrop: null
  });

  assert.equal(fellowAvatarIdentityId("mia", { ownerUserId: "user_me" }), "fellow:user_me:mia");
  assert.deepEqual(c.avatar, expected);
});

test("resolveContact fellow avatar honors server-provided globalId over owner fallback", () => {
  const c = resolveContact({ kind: "fellow", ref: "mia" }, {
    fellows: [{ key: "mia", id: "mia", ownerUserId: "stale_owner", globalId: "fellow:user_live:mia", name: "Mia" }]
  });

  assert.equal(fellowAvatarIdentityId("mia", {
    ownerUserId: "stale_owner",
    globalId: "fellow:user_live:mia"
  }), "fellow:user_live:mia");
  assert.deepEqual(c.avatar, avatarResolve.resolveAvatarForContact({
    id: "fellow:user_live:mia",
    displayName: "Mia",
    avatarImage: "",
    avatarCrop: null
  }));
});

test("resolveContact friend by id", () => {
  const c = resolveContact({ kind: "user", ref: "user_friend" }, ctx);
  assert.equal(c.kind, ContactKind.User);
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
