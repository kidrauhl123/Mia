const { test } = require("node:test");
const assert = require("node:assert/strict");
const { MessageCapability, defaultCapabilities, normalizeSpec } = require("../src/shared/message-spec");

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
  const s = normalizeSpec({ source: "fellow-session", conversationId: "c1", messageId: "m1", role: "user" });
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
