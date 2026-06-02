const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadSource() {
  const sharedSpec = fs.readFileSync(path.join(__dirname, "..", "src", "shared", "message-spec.js"), "utf8");
  const sharedContact = fs.readFileSync(path.join(__dirname, "..", "packages", "shared", "contact.js"), "utf8");
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "message-sources", "fellow-session-source.js"), "utf8");
  const window = {};
  const ctx = vm.createContext({ window, globalThis: window, module: { exports: {} }, require, console });
  vm.runInContext("globalThis.miaMessageSpec = (function(){ const module = { exports: {} }; " + sharedSpec + "; return module.exports; })();", ctx);
  vm.runInContext("globalThis.miaContact = (function(){ const module = { exports: {} }; " + sharedContact + "; return module.exports; })();", ctx);
  vm.runInContext(src, ctx);
  return window.miaFellowSessionSource;
}

test("FellowSessionSource maps user message to spec", () => {
  const src = loadSource();
  const session = { id: "s1", personaKey: "codex", messages: [
    { role: "user", content: "hi", createdAt: "2026-05-22T01:00:00.000Z", attachments: [] }
  ]};
  const ctx = {
    self: { id: "user_me", username: "me", avatarImage: "data:me" },
    fellows: [{ key: "codex", name: "Codex", avatarImage: "data:codex" }],
    friends: []
  };
  const source = src.createFellowSessionSource({ session, persona: ctx.fellows[0], ctx });
  const specs = source.listMessages();
  assert.equal(specs.length, 1);
  assert.equal(specs[0].source, "fellow-session");
  assert.equal(specs[0].role, "user");
  assert.equal(specs[0].isOwn, true);
  assert.equal(specs[0].authorName, "me");
});

test("FellowSessionSource maps assistant message with fellow avatar", () => {
  const src = loadSource();
  const session = { id: "s1", personaKey: "codex", messages: [
    { role: "assistant", content: "hello", createdAt: "2026-05-22T01:01:00.000Z" }
  ]};
  const ctx = {
    self: { id: "user_me", username: "me" },
    fellows: [{ key: "codex", name: "Codex", avatarImage: "data:codex" }],
    friends: []
  };
  const source = src.createFellowSessionSource({ session, persona: ctx.fellows[0], ctx });
  const spec = source.listMessages()[0];
  assert.equal(spec.role, "assistant");
  assert.equal(spec.isOwn, false);
  assert.equal(spec.authorName, "Codex");
  assert.equal(spec.avatar.image, "data:codex");
});

test("FellowSessionSource exposes capabilities reply+copy+pin+delete", () => {
  const src = loadSource();
  const session = { id: "s1", personaKey: "codex", messages: [{ role: "user", content: "x", createdAt: "" }] };
  const ctx = { self: {}, fellows: [{ key: "codex" }], friends: [] };
  const source = src.createFellowSessionSource({ session, persona: ctx.fellows[0], ctx });
  const cap = source.listMessages()[0].capabilities;
  assert.equal(cap.reply, true);
  assert.equal(cap.copy, true);
  assert.equal(cap.pin, true);
  assert.equal(cap.delete, true);
});
