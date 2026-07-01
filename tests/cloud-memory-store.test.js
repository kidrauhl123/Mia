const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createCloudStore } = require("../src/cloud/sqlite-store.js");
const { createCloudMemoryStore } = require("../src/cloud/memory-store.js");
const { loginCloudUser } = require("./helpers/cloud-auth.js");

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-cloud-memory-store-"));
  let tick = 0;
  const cloudStore = createCloudStore({ dataDir });
  const memoryStore = createCloudMemoryStore(cloudStore.getDb(), {
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick += 1)).toISOString(),
    idFactory: () => `mem_test_${tick + 1}`,
    eventIdFactory: () => `event_test_${tick + 1}`
  });
  t.after(() => {
    cloudStore.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { cloudStore, memoryStore };
}

test("cloud memory store isolates entries by user and scoped filters", (t) => {
  const { cloudStore, memoryStore } = setup(t);
  const alice = loginCloudUser(cloudStore, "memory_alice").user;
  const bob = loginCloudUser(cloudStore, "memory_bob").user;

  const created = memoryStore.upsertMemory(alice.id, {
    id: "mem_mei_pref",
    botId: "mei",
    sessionId: "s1",
    scope: "bot",
    kind: "preference",
    text: "Mei should answer architecture questions compactly",
    confidence: 0.9,
    updatedAt: "2026-01-01T00:00:10.000Z"
  });

  assert.equal(created.ok, true);
  assert.equal(created.memory.userId, alice.id);
  assert.equal(memoryStore.listMemories(alice.id, { botId: "mei", query: "architecture" }).length, 1);
  assert.equal(memoryStore.listMemories(alice.id, { botId: "other", query: "architecture" }).length, 0);
  assert.equal(memoryStore.listMemories(bob.id, { query: "architecture" }).length, 0);
});

test("cloud memory store rejects stale updates and accepts newer revisions", (t) => {
  const { cloudStore, memoryStore } = setup(t);
  const alice = loginCloudUser(cloudStore, "memory_conflict").user;

  const original = memoryStore.upsertMemory(alice.id, {
    id: "mem_conflict",
    botId: "mei",
    scope: "bot",
    text: "The user likes short summaries",
    updatedAt: "2026-01-02T00:00:00.000Z",
    revision: 2
  });
  assert.equal(original.ok, true);

  const stale = memoryStore.upsertMemory(alice.id, {
    id: "mem_conflict",
    botId: "mei",
    scope: "bot",
    text: "The user likes long summaries",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 1
  });
  assert.equal(stale.conflict, true);
  assert.equal(stale.memory.text, "The user likes short summaries");

  const newer = memoryStore.upsertMemory(alice.id, {
    id: "mem_conflict",
    botId: "mei",
    scope: "bot",
    text: "The user likes concise summaries",
    updatedAt: "2026-01-03T00:00:00.000Z",
    revision: 3
  });
  assert.equal(newer.ok, true);
  assert.equal(newer.memory.text, "The user likes concise summaries");
  assert.equal(newer.memory.revision, 3);
});

test("cloud memory store keeps deletion tombstones for incremental sync without retaining text", (t) => {
  const { cloudStore, memoryStore } = setup(t);
  const alice = loginCloudUser(cloudStore, "memory_delete").user;

  memoryStore.upsertMemory(alice.id, {
    id: "mem_delete",
    botId: "mei",
    scope: "bot",
    text: "Temporary memory should disappear",
    updatedAt: "2026-01-01T00:00:10.000Z"
  });
  const deleted = memoryStore.deleteMemory(alice.id, "mem_delete");

  assert.equal(deleted.ok, true);
  assert.equal(deleted.memory.text, "");
  assert.ok(deleted.memory.deletedAt);
  assert.equal(memoryStore.listMemories(alice.id, { query: "Temporary" }).length, 0);

  const incremental = memoryStore.listMemories(alice.id, {
    since: "2026-01-01T00:00:00.000Z"
  });
  assert.equal(incremental.length, 1);
  assert.equal(incremental[0].id, "mem_delete");
  assert.equal(incremental[0].text, "");
  assert.ok(incremental[0].deletedAt);
});
