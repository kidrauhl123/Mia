const { test } = require("node:test");
const assert = require("node:assert/strict");
const { formatConversationTime, formatMessageTime } = require("../src/shared/time-format");

test("formatConversationTime today returns HH:MM", () => {
  const now = new Date();
  now.setHours(14, 5, 0, 0);
  assert.equal(formatConversationTime(now.toISOString()), "14:05");
});

test("formatConversationTime yesterday returns 昨天", () => {
  const y = new Date();
  y.setDate(y.getDate() - 1);
  assert.equal(formatConversationTime(y.toISOString()), "昨天");
});

test("formatConversationTime older returns M/D", () => {
  assert.equal(formatConversationTime("2026-04-12T03:00:00.000Z").endsWith("/12"), true);
});

test("formatConversationTime empty returns empty string", () => {
  assert.equal(formatConversationTime(""), "");
  assert.equal(formatConversationTime(null), "");
});

test("formatMessageTime returns HH:MM", () => {
  const d = new Date();
  d.setHours(9, 7, 0, 0);
  assert.equal(formatMessageTime(d.toISOString()), "09:07");
});
