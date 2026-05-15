const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildHermesGroupHeader,
  injectGroupContextForSdk,
} = require("../src/main/group-adapters.js");

test("buildHermesGroupHeader returns base64-encoded JSON", () => {
  const header = buildHermesGroupHeader("[群上下文]\n群名：测试\n[/群上下文]");
  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  assert.equal(decoded.contextBlock, "[群上下文]\n群名：测试\n[/群上下文]");
  assert.equal(decoded.v, 1);
});

test("buildHermesGroupHeader empty block returns empty string", () => {
  assert.equal(buildHermesGroupHeader(""), "");
  assert.equal(buildHermesGroupHeader(null), "");
});

test("injectGroupContextForSdk prepends context block", () => {
  const out = injectGroupContextForSdk("帮我看下", "[群上下文]\n群名：x\n[/群上下文]");
  assert.match(out, /^\[群上下文\]/);
  assert.match(out, /帮我看下$/);
});

test("injectGroupContextForSdk no block returns original", () => {
  assert.equal(injectGroupContextForSdk("hello", ""), "hello");
  assert.equal(injectGroupContextForSdk("hello", null), "hello");
});
