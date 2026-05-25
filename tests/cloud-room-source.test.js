const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadSource() {
  const sharedSpec = fs.readFileSync(path.join(__dirname, "..", "src", "shared", "message-spec.js"), "utf8");
  const sharedContact = fs.readFileSync(path.join(__dirname, "..", "src", "shared", "contact.js"), "utf8");
  const sharedKinds = fs.readFileSync(path.join(__dirname, "..", "src", "shared", "conversation-kinds.js"), "utf8");
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "message-sources", "cloud-room-source.js"), "utf8");
  const window = {};
  const ctx = vm.createContext({ window, globalThis: window, console });
  vm.runInContext("globalThis.miaMessageSpec = (function(){ const module = { exports: {} }; " + sharedSpec + "; return module.exports; })();", ctx);
  vm.runInContext("globalThis.miaContact = (function(){ const module = { exports: {} }; " + sharedContact + "; return module.exports; })();", ctx);
  vm.runInContext(sharedKinds, ctx);
  vm.runInContext(src, ctx);
  return window.miaCloudRoomSource;
}

test("CloudRoomSource DM friend message uses friend avatar", () => {
  const src = loadSource();
  const room = { id: "dm:user_me:user_friend", name: null };
  const messages = [
    { id: "msg1", sender_kind: "user", sender_ref: "user_friend", body_md: "hi", created_at: "2026-05-22T01:00:00.000Z", seq: 1 }
  ];
  const ctx = {
    self: { id: "user_me", username: "me" },
    fellows: [],
    friends: [{ id: "user_friend", username: "alice", avatarImage: "data:alice" }]
  };
  const source = src.createCloudRoomSource({ room, messages, members: [], ctx });
  const spec = source.listMessages()[0];
  assert.equal(spec.source, "cloud-room");
  assert.equal(spec.role, "user");
  assert.equal(spec.authorName, "alice");
  assert.equal(spec.avatar.image, "data:alice");
  assert.equal(spec.isOwn, false);
});

test("CloudRoomSource own message marks isOwn=true", () => {
  const src = loadSource();
  const room = { id: "dm:user_me:user_friend" };
  const messages = [{ id: "msg2", sender_kind: "user", sender_ref: "user_me", body_md: "ok", created_at: "", seq: 2 }];
  const ctx = { self: { id: "user_me", username: "me" }, fellows: [], friends: [] };
  const source = src.createCloudRoomSource({ room, messages, members: [], ctx });
  const spec = source.listMessages()[0];
  assert.equal(spec.isOwn, true);
  assert.equal(spec.authorName, "me");
});

test("CloudRoomSource group fellow message resolves fellow contact via members", () => {
  const src = loadSource();
  const room = { id: "g_room1", name: "Mixed" };
  const messages = [{ id: "msg3", sender_kind: "fellow", sender_ref: "codex", body_md: "yo", created_at: "", seq: 3 }];
  const members = [
    { member_kind: "fellow", member_ref: "codex", owner_id: "user_friend" },
    { member_kind: "user", member_ref: "user_friend" }
  ];
  const ctx = {
    self: { id: "user_me", username: "me" },
    fellows: [],
    friends: [{ id: "user_friend", username: "alice" }]
  };
  const source = src.createCloudRoomSource({ room, messages, members, ctx });
  const spec = source.listMessages()[0];
  assert.equal(spec.role, "assistant");
  // Owner suffix dropped per UX — display the AI's name only.
  assert.equal(spec.authorName, "codex");
});

test("CloudRoomSource hydrates own fellow avatar from ctx.fellows", () => {
  const src = loadSource();
  const room = { id: "g_room2" };
  const messages = [{ id: "msg4", sender_kind: "fellow", sender_ref: "codex", body_md: "yo", created_at: "", seq: 1 }];
  const members = [{ member_kind: "fellow", member_ref: "codex", owner_id: "user_me" }];
  const ctx = {
    self: { id: "user_me", username: "me" },
    fellows: [{ key: "codex", name: "Codex", avatarImage: "data:codex-pic", color: "#5e5ce6" }],
    friends: []
  };
  const source = src.createCloudRoomSource({ room, messages, members, ctx });
  const spec = source.listMessages()[0];
  assert.equal(spec.avatar.image, "data:codex-pic");
});

test("CloudRoomSource system message gets role=system", () => {
  const src = loadSource();
  const room = { id: "g_room3" };
  const messages = [{ id: "sys1", sender_kind: "system", sender_ref: "sys", body_md: "user joined", created_at: "", seq: 1 }];
  const source = src.createCloudRoomSource({ room, messages, members: [], ctx: { self: {}, fellows: [], friends: [] } });
  const spec = source.listMessages()[0];
  assert.equal(spec.role, "system");
  assert.equal(spec.authorName, "系统");
});

test("CloudRoomSource capabilities: copy + reply + delete true, pin false", () => {
  const src = loadSource();
  const room = { id: "dm:a:b" };
  const messages = [{ id: "m", sender_kind: "user", sender_ref: "a", body_md: "x", created_at: "", seq: 1 }];
  const source = src.createCloudRoomSource({ room, messages, members: [], ctx: { self: {}, fellows: [], friends: [] } });
  const cap = source.listMessages()[0].capabilities;
  assert.equal(cap.copy, true);
  assert.equal(cap.reply, true);
  assert.equal(cap.pin, false);
  // Delete is WeChat-style local-hide, available on every cloud-room message
  // (DELETE /api/rooms/:id/messages/:msgId hides it for the requesting user).
  assert.equal(cap.delete, true);
});
