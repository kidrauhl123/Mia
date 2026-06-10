const { test } = require("node:test");
const assert = require("node:assert/strict");

const ids = require("../src/shared/ids.js");

test("shared ids generate untyped public identifiers", () => {
  const generated = ids.generatePrincipalId((size) => Buffer.from(Array.from({ length: size }, (_, index) => index)));
  assert.equal(generated, "1123456789");
  assert.equal(ids.isPublicId(generated), true);
  assert.doesNotMatch(generated, /^(user|bot|g)_/);
  assert.equal(generated.length, 10);
  assert.match(generated, /^[1-9][0-9]{9}$/);
});

test("public id validation accepts legacy ids", () => {
  assert.equal(ids.isPublicId("23456789abcd"), true);
  assert.equal(ids.isPublicId("0123456789abcdef0123"), true);
});

test("group public ids stay separate from routed conversation ids", () => {
  assert.equal(ids.groupConversationId("1234567890"), "g_1234567890");
  assert.equal(ids.publicIdFromConversationId("g_1234567890"), "1234567890");
  assert.equal(ids.publicIdFromConversationId("dm:a:b"), "");
});
