const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveContact, ContactKind } = require("../src/shared/contact");

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
