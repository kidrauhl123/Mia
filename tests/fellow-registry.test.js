const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizedFellowList,
  requireFellow,
  resolveFellow
} = require("../src/main/fellow-registry.js");

const manifest = {
  fellows: [
    { key: "alice", name: "Alice" },
    { key: "bob", name: "Bob" }
  ]
};

test("normalizedFellowList accepts manifests and raw arrays", () => {
  assert.deepEqual(normalizedFellowList(manifest).map((fellow) => fellow.key), ["alice", "bob"]);
  assert.deepEqual(normalizedFellowList(manifest.fellows).map((fellow) => fellow.key), ["alice", "bob"]);
  assert.deepEqual(normalizedFellowList({ fellows: [null, {}, { key: "  " }, { key: "ok" }] }).map((fellow) => fellow.key), ["ok"]);
});

test("resolveFellow returns the requested fellow when present", () => {
  const resolved = resolveFellow(manifest, "bob");
  assert.equal(resolved.fellow.key, "bob");
  assert.equal(resolved.requestedKey, "bob");
  assert.equal(resolved.usedFallback, false);
});

test("resolveFellow falls back to first fellow when request is missing", () => {
  assert.equal(resolveFellow(manifest, "").fellow.key, "alice");
  const resolved = resolveFellow(manifest, "missing");
  assert.equal(resolved.fellow.key, "alice");
  assert.equal(resolved.usedFallback, true);
});

test("resolveFellow can disable fallback for strict lookups", () => {
  const resolved = resolveFellow(manifest, "missing", { fallback: false });
  assert.equal(resolved.fellow, null);
  assert.equal(resolved.usedFallback, false);
});

test("requireFellow throws with caller-provided message when none exists", () => {
  assert.throws(
    () => requireFellow({ fellows: [] }, "", "no fellow"),
    /no fellow/
  );
});

test("requireFellow throws when strict lookup misses", () => {
  assert.throws(
    () => requireFellow(manifest, "missing", "missing fellow", { fallback: false }),
    /missing fellow/
  );
});
