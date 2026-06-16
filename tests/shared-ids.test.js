const { test } = require("node:test");
const assert = require("node:assert/strict");

const ids = require("../src/shared/ids.js");

test("shared ids generate untyped public identifiers", () => {
  const generated = ids.generatePrincipalId((size) => Buffer.from(Array.from({ length: size }, (_, index) => index)));
  assert.equal(generated, "1123456");
  assert.equal(ids.isPublicId(generated), true);
  assert.doesNotMatch(generated, /^(user|bot|g)_/);
  assert.equal(generated.length, 7);
  assert.match(generated, /^[1-9][0-9]{6}$/);
});

test("public id validation accepts short current ids and legacy ids", () => {
  assert.equal(ids.isPublicId("100001"), true);
  assert.equal(ids.isPublicId("1123456"), true);
  assert.equal(ids.isPublicId("1234567890"), true);
  assert.equal(ids.isPublicId("12345"), false);
  assert.equal(ids.isPublicId("012345"), false);
  assert.equal(ids.isPublicId("23456789abcd"), true);
  assert.equal(ids.isPublicId("0123456789abcdef0123"), true);
});

test("group public ids stay separate from routed conversation ids", () => {
  assert.equal(ids.groupConversationId("1123456"), "g_1123456");
  assert.equal(ids.publicIdFromConversationId("g_100001"), "100001");
  assert.equal(ids.publicIdFromConversationId("dm:a:b"), "");
});
