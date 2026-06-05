const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { MessageCapability, defaultCapabilities, normalizeSpec } = require("../src/shared/message-spec");

const root = path.join(__dirname, "..");

test("MessageCapability has reply / copy / pin / delete", () => {
  assert.equal(MessageCapability.Reply, "reply");
  assert.equal(MessageCapability.Copy, "copy");
  assert.equal(MessageCapability.Pin, "pin");
  assert.equal(MessageCapability.Delete, "delete");
});

test("defaultCapabilities returns object with all flags false", () => {
  const cap = defaultCapabilities();
  assert.equal(cap.reply, false);
  assert.equal(cap.copy, false);
  assert.equal(cap.pin, false);
  assert.equal(cap.delete, false);
});

test("normalizeSpec fills missing fields with safe defaults", () => {
  const s = normalizeSpec({ source: "bot-session", conversationId: "botc_1", messageId: "m1", role: "user" });
  assert.equal(s.role, "user");
  assert.equal(s.bodyMd, "");
  assert.equal(s.attachments.length, 0);
  assert.equal(s.capabilities.copy, false);
  assert.equal(s.authorName, "");
});

test("normalizeSpec preserves provided fields", () => {
  const s = normalizeSpec({
    source: "cloud-conversation", conversationId: "dm:a:b", messageId: "msg_1",
    role: "user", authorName: "alice", bodyMd: "hi",
    capabilities: { reply: true, copy: true }
  });
  assert.equal(s.authorName, "alice");
  assert.equal(s.bodyMd, "hi");
  assert.equal(s.capabilities.reply, true);
  assert.equal(s.capabilities.delete, false);
});

test("normalizeSpec preserves authorIdentity and derives badge", () => {
  const s = normalizeSpec({
    source: "cloud-conversation",
    conversationId: "botc_1",
    messageId: "m1",
    role: "assistant",
    authorIdentity: {
      kind: "bot",
      id: "bot_mia",
      displayName: "Mia",
      statusBadge: { kind: "emoji", emoji: "⭐" }
    },
    bodyMd: "hi"
  });

  assert.equal(s.authorIdentity.kind, "bot");
  assert.equal(s.authorIdentity.id, "bot_mia");
  assert.equal(s.authorName, "Mia");
  assert.deepEqual(s.statusBadge, { kind: "emoji", emoji: "⭐" });
});

test("browser normalizeSpec preserves authorIdentity without miaIdentity preloaded", () => {
  const source = fs.readFileSync(path.join(root, "src/shared/message-spec.js"), "utf8");
  const context = { window: {} };
  context.globalThis = context.window;
  vm.runInNewContext(source, context, { filename: "src/shared/message-spec.js" });

  const s = context.window.miaMessageSpec.normalizeSpec({
    authorIdentity: {
      kind: "bot",
      id: "bot_mia",
      displayName: "Mia",
      statusBadge: { kind: "emoji", emoji: "⭐" }
    }
  });

  assert.equal(s.authorIdentity.kind, "bot");
  assert.equal(s.authorName, "Mia");
  assert.equal(s.statusBadge.kind, "emoji");
  assert.equal(s.statusBadge.emoji, "⭐");
});
