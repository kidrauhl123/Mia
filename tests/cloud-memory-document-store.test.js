const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const cases = require("../packages/shared/memory-document-cases.json");
const { createMemoryDocumentStore } = require("../src/cloud/memory-document-store.js");
const { createCloudStore } = require("../src/cloud/sqlite-store.js");
const { loginCloudUser } = require("./helpers/cloud-auth.js");

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-cloud-memory-documents-"));
  let tick = 0;
  const cloudStore = createCloudStore({ dataDir });
  const documentStore = createMemoryDocumentStore(cloudStore.getDb(), {
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick += 1)).toISOString()
  });
  t.after(() => {
    cloudStore.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { cloudStore, documentStore, dataDir };
}

test("cloud schema creates memory_documents idempotently and documents preserve canonical text", (t) => {
  const { cloudStore, documentStore, dataDir } = setup(t);
  const alice = loginCloudUser(cloudStore, "memory_document_alice").user;
  const bob = loginCloudUser(cloudStore, "memory_document_bob").user;
  const text = "甲\n§\n乙\n第二行";

  const pushed = documentStore.pushDocuments(alice.id, [{
    userId: alice.id,
    target: "memory",
    botId: "bot_1",
    text,
    revision: 1,
    updatedAt: "2026-01-01T00:00:01.000Z"
  }]);
  assert.equal(pushed.accepted.length, 1);
  assert.equal(pushed.accepted[0].document.text, text);
  assert.deepEqual(documentStore.listDocuments(alice.id).documents.map((item) => item.text), [text]);
  assert.deepEqual(documentStore.listDocuments(bob.id).documents, []);
  assert.throws(
    () => documentStore.getDocument(alice.id, {
      userId: bob.id,
      target: "memory",
      botId: "bot_1"
    }),
    (error) => error.code === "owner_mismatch" && error.status === 403
  );

  const reopened = createCloudStore({ dataDir });
  t.after(() => reopened.close());
  const table = reopened.getDb().prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_documents'"
  ).get();
  assert.equal(table.name, "memory_documents");
});

test("document revision CAS returns no-op or server conflicts without merging", (t) => {
  const { cloudStore, documentStore } = setup(t);
  const alice = loginCloudUser(cloudStore, "memory_document_cas").user;
  const identity = { target: "memory", botId: "bot_1" };

  let result = documentStore.pushDocuments(alice.id, [{
    ...identity,
    text: "第一版",
    revision: 2,
    updatedAt: "2026-01-01T00:00:02.000Z"
  }]);
  assert.equal(result.accepted[0].document.revision, 2);

  result = documentStore.pushDocuments(alice.id, [{ ...identity, text: "第一版", revision: 1 }]);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].noOp, true);
  assert.equal(result.accepted[0].document.revision, 2);

  result = documentStore.pushDocuments(alice.id, [{ ...identity, text: "旧正文", revision: 1 }]);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].document.text, "第一版");

  result = documentStore.pushDocuments(alice.id, [{ ...identity, text: "同 revision 异文", revision: 2 }]);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].document.text, "第一版");

  result = documentStore.pushDocuments(alice.id, [{
    ...identity,
    text: "第二版",
    revision: 3,
    updatedAt: "2026-01-01T00:00:03.000Z"
  }]);
  assert.equal(result.accepted[0].document.text, "第二版");

  result = documentStore.pushDocuments(alice.id, [{
    ...identity,
    text: "不得随 tombstone 保留",
    revision: 4,
    updatedAt: "2026-01-01T00:00:04.000Z",
    deletedAt: "2026-01-01T00:00:04.000Z"
  }]);
  assert.equal(result.accepted[0].document.text, "");
  assert.ok(result.accepted[0].document.deletedAt);

  const staleResurrection = documentStore.pushDocuments(alice.id, [{
    ...identity,
    text: "过期复活",
    revision: 3
  }]);
  assert.equal(staleResurrection.conflicts.length, 1);
  assert.ok(staleResurrection.conflicts[0].document.deletedAt);
});

test("document identities and bounded mutation match the shared cross-language cases", (t) => {
  const { cloudStore, documentStore } = setup(t);
  const alice = loginCloudUser(cloudStore, "memory_document_mutate").user;

  assert.throws(
    () => documentStore.getDocument(alice.id, { target: "memory", botId: "" }),
    (error) => error.code === "bot_id_required"
  );
  assert.throws(
    () => documentStore.getDocument(alice.id, { target: "user", botId: "bot_1" }),
    (error) => error.code === "bot_id_not_allowed"
  );

  for (const [index, item] of cases.mutationCases.entries()) {
    const botId = `bot_case_${index}`;
    if (item.entries.length > 0) {
      const seeded = documentStore.pushDocuments(alice.id, [{
        target: "memory",
        botId,
        text: item.entries.join(cases.limits.separator),
        revision: 1
      }]);
      assert.equal(seeded.accepted.length, 1);
    }
    const result = documentStore.mutate(alice.id, botId, {
      action: item.action,
      target: "memory",
      oldText: item.oldText,
      content: item.content
    });
    assert.equal(result.success, true);
    assert.deepEqual(result.currentEntries, item.result);
    assert.equal(result.noOp, item.noOp === true);
  }

  for (const policyCase of cases.policyCases.filter((item) => item.code)) {
    const before = documentStore.getDocument(alice.id, { target: "memory", botId: "bot_policy" });
    const rejected = documentStore.mutate(alice.id, "bot_policy", {
      action: "add",
      target: "memory",
      content: policyCase.text
    });
    assert.equal(rejected.success, false);
    assert.equal(rejected.error, policyCase.code);
    assert.deepEqual(
      documentStore.getDocument(alice.id, { target: "memory", botId: "bot_policy" }),
      before
    );
  }

  for (const [index, policyCase] of cases.policyCases.filter((item) => !item.code).entries()) {
    const accepted = documentStore.mutate(alice.id, `bot_safe_${index}`, {
      action: "add",
      target: "memory",
      content: policyCase.text
    });
    assert.equal(accepted.success, true);
    assert.deepEqual(accepted.currentEntries, [policyCase.text]);
  }

  const sameReplacement = documentStore.mutate(alice.id, "bot_safe_0", {
    action: "replace",
    target: "memory",
    oldText: cases.policyCases.find((item) => !item.code).text,
    content: cases.policyCases.find((item) => !item.code).text
  });
  assert.equal(sameReplacement.success, true);
  assert.equal(sameReplacement.noOp, true);
});

test("document listing clamps limits and always carries tombstones for sync", (t) => {
  const { cloudStore, documentStore } = setup(t);
  const alice = loginCloudUser(cloudStore, "memory_document_limit").user;
  const db = cloudStore.getDb();
  const insert = db.prepare(
    "INSERT INTO memory_documents " +
    "(user_id, bot_id, target, text, revision, updated_at, deleted_at) " +
    "VALUES (?, ?, 'memory', ?, 1, ?, '')"
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < 520; index += 1) {
      insert.run(alice.id, `bot_${String(index).padStart(3, "0")}`, `正文 ${index}`, `2026-01-01T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`);
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  assert.equal(documentStore.listDocuments(alice.id, { limit: 99999 }).documents.length, 500);

  const tombstone = documentStore.pushDocuments(alice.id, [{
    target: "memory",
    botId: "bot_519",
    text: "ignored",
    revision: 2,
    updatedAt: "2026-01-02T00:00:00.000Z",
    deletedAt: "2026-01-02T00:00:00.000Z"
  }]);
  assert.equal(tombstone.accepted[0].document.text, "");
  const incremental = documentStore.listDocuments(alice.id, {
    since: "2026-01-01T23:59:59.000Z",
    limit: 10
  });
  assert.equal(incremental.documents.length, 1);
  assert.equal(incremental.documents[0].botId, "bot_519");
  assert.ok(incremental.documents[0].deletedAt);
});
