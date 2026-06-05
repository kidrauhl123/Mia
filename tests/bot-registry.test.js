const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizedBotList,
  requireBot,
  resolveBot
} = require("../src/main/bot-registry.js");

const manifest = {
  bots: [
    { key: "alice", name: "Alice" },
    { key: "bob", name: "Bob" }
  ]
};

test("normalizedBotList accepts manifests and raw arrays", () => {
  assert.deepEqual(normalizedBotList(manifest).map((bot) => bot.key), ["alice", "bob"]);
  assert.deepEqual(normalizedBotList(manifest.bots).map((bot) => bot.key), ["alice", "bob"]);
  assert.deepEqual(normalizedBotList({ bots: [null, {}, { key: "  " }, { key: "ok" }] }).map((bot) => bot.key), ["ok"]);
});

test("resolveBot returns the requested bot when present", () => {
  const resolved = resolveBot(manifest, "bob");
  assert.equal(resolved.bot.key, "bob");
  assert.equal(resolved.requestedKey, "bob");
  assert.equal(resolved.usedFallback, false);
});

test("resolveBot falls back to first bot when request is missing", () => {
  assert.equal(resolveBot(manifest, "").bot.key, "alice");
  const resolved = resolveBot(manifest, "missing");
  assert.equal(resolved.bot.key, "alice");
  assert.equal(resolved.usedFallback, true);
});

test("resolveBot can disable fallback for strict lookups", () => {
  const resolved = resolveBot(manifest, "missing", { fallback: false });
  assert.equal(resolved.bot, null);
  assert.equal(resolved.usedFallback, false);
});

test("requireBot throws with caller-provided message when none exists", () => {
  assert.throws(
    () => requireBot({ bots: [] }, "", "no bot"),
    /no bot/
  );
});

test("requireBot throws when strict lookup misses", () => {
  assert.throws(
    () => requireBot(manifest, "missing", "missing bot", { fallback: false }),
    /missing bot/
  );
});
