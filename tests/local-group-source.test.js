const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadSource() {
  const sharedSpec = fs.readFileSync(path.join(__dirname, "..", "src", "shared", "message-spec.js"), "utf8");
  const sharedContact = fs.readFileSync(path.join(__dirname, "..", "src", "shared", "contact.js"), "utf8");
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "message-sources", "local-group-source.js"), "utf8");
  const window = {};
  const ctx = vm.createContext({ window, globalThis: window, console });
  vm.runInContext("globalThis.aimashiMessageSpec = (function(){ const module = { exports: {} }; " + sharedSpec + "; return module.exports; })();", ctx);
  vm.runInContext("globalThis.aimashiContact = (function(){ const module = { exports: {} }; " + sharedContact + "; return module.exports; })();", ctx);
  vm.runInContext(src, ctx);
  return window.aimashiLocalGroupSource;
}

test("LocalGroupSource maps user + fellow messages with correct authors", () => {
  const src = loadSource();
  const group = {
    id: "g_local_1",
    name: "Test Group",
    members: [{ kind: "fellow", fellowId: "codex" }, { kind: "fellow", fellowId: "claude" }],
    hostMember: { fellowId: "codex" }
  };
  const messages = [
    { id: "m1", role: "user", content: "Hello team", createdAt: "2026-05-22T01:00:00.000Z" },
    { id: "m2", role: "assistant", content: "Hi!", senderFellowId: "codex", createdAt: "2026-05-22T01:00:30.000Z" }
  ];
  const ctx = {
    self: { id: "user_me", username: "me" },
    fellows: [
      { key: "codex", name: "Codex", avatarImage: "data:codex" },
      { key: "claude", name: "Claude", avatarImage: "data:claude" }
    ],
    friends: []
  };
  const source = src.createLocalGroupSource({ group, messages, ctx });
  const specs = source.listMessages();
  assert.equal(specs.length, 2);
  assert.equal(specs[0].authorName, "me");
  assert.equal(specs[0].isOwn, true);
  assert.equal(specs[1].authorName, "Codex");
  assert.equal(specs[1].avatar.image, "data:codex");
});

test("LocalGroupSource capabilities include reply/copy/pin/delete", () => {
  const src = loadSource();
  const group = { id: "g1", members: [] };
  const source = src.createLocalGroupSource({ group, messages: [{ id: "m", role: "user", content: "x", createdAt: "" }], ctx: { self: {}, fellows: [], friends: [] } });
  const cap = source.listMessages()[0].capabilities;
  assert.equal(cap.reply, true);
  assert.equal(cap.delete, true);
});
