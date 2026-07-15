const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createEventLogStore } = require("../src/cloud/event-log-store.js");
const { createMemoryDocumentsApi } = require("../src/cloud/memory-documents-api.js");
const { createMemoryDocumentStore } = require("../src/cloud/memory-document-store.js");
const { createCloudStore } = require("../src/cloud/sqlite-store.js");
const { loginCloudUser } = require("./helpers/cloud-auth.js");

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-cloud-memory-documents-api-"));
  const cloudStore = createCloudStore({ dataDir });
  const documentStore = createMemoryDocumentStore(cloudStore.getDb(), {
    now: () => "2026-01-01T00:00:10.000Z"
  });
  const eventLog = createEventLogStore(cloudStore.getDb());
  const alice = loginCloudUser(cloudStore, "memory_documents_api_alice");
  const bob = loginCloudUser(cloudStore, "memory_documents_api_bob");
  const auth = new Map([[alice.token, alice], [bob.token, bob]]);
  const events = [];
  const conversations = new Map([
    ["conv_mia", { id: "conv_mia", decorations: { botId: "bot_1", memoryMode: "mia" } }],
    ["conv_native", { id: "conv_native", decorations: { botId: "bot_1", memoryMode: "native" } }],
    ["conv_missing_mode", { id: "conv_missing_mode", decorations: { botId: "bot_1" } }]
  ]);
  const api = createMemoryDocumentsApi({
    store: documentStore,
    authenticate: (request) => auth.get(request.token) || null,
    getConversation: (conversationId) => conversations.get(conversationId) || null,
    isConversationMember: (conversationId, userId) => conversationId && userId === alice.user.id,
    getCachedOp: eventLog.getCachedOp,
    cacheOp: eventLog.cacheOp,
    broadcast: (userId, event) => events.push({ userId, event }),
    now: () => "2026-01-01T00:00:10.000Z"
  });
  t.after(() => {
    cloudStore.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { api, alice, bob, events };
}

test("memory document API requires auth and isolates account lists", async (t) => {
  const { api, alice, bob } = setup(t);
  const unauthorized = await api.handle({
    method: "GET",
    pathname: "/api/me/memory-documents",
    query: new URLSearchParams()
  });
  assert.deepEqual(unauthorized, {
    handled: true,
    status: 401,
    body: { ok: false, error: "unauthorized" }
  });

  const pushed = await api.handle({
    method: "POST",
    pathname: "/api/me/memory-documents/push",
    token: alice.token,
    body: {
      clientOpId: "push_doc_1",
      documents: [{ target: "user", text: "Alice 偏好", revision: 1 }]
    }
  });
  assert.equal(pushed.status, 200);
  assert.equal(pushed.body.ok, true);

  const aliceList = await api.handle({
    method: "GET",
    pathname: "/api/me/memory-documents",
    token: alice.token,
    query: new URLSearchParams("limit=100000")
  });
  assert.equal(aliceList.body.documents.length, 1);
  const bobList = await api.handle({
    method: "GET",
    pathname: "/api/me/memory-documents",
    token: bob.token,
    query: new URLSearchParams()
  });
  assert.deepEqual(bobList.body.documents, []);

  const replay = await api.handle({
    method: "POST",
    pathname: "/api/me/memory-documents/push",
    token: alice.token,
    body: {
      clientOpId: "push_doc_1",
      documents: [{ target: "user", text: "不应执行", revision: 2 }]
    }
  });
  assert.deepEqual(replay, pushed);
});

test("memory mutate API enforces member, bot identity, and fixed Mia mode", async (t) => {
  const { api, alice, bob, events } = setup(t);
  const native = await api.handle({
    method: "POST",
    pathname: "/api/me/memory-documents/mutate",
    token: alice.token,
    body: {
      conversationId: "conv_native",
      action: "add",
      target: "memory",
      content: "不应写入"
    }
  });
  assert.equal(native.status, 409);
  assert.equal(native.body.error, "memory_mode_native");

  const missingMode = await api.handle({
    method: "POST",
    pathname: "/api/me/memory-documents/mutate",
    token: alice.token,
    body: {
      conversationId: "conv_missing_mode",
      action: "add",
      target: "memory",
      content: "不应写入"
    }
  });
  assert.equal(missingMode.status, 409);
  assert.equal(missingMode.body.error, "memory_mode_native");

  const nonMember = await api.handle({
    method: "POST",
    pathname: "/api/me/memory-documents/mutate",
    token: bob.token,
    body: {
      conversationId: "conv_mia",
      action: "add",
      target: "memory",
      content: "越权"
    }
  });
  assert.equal(nonMember.status, 403);
  assert.equal(nonMember.body.error, "conversation_forbidden");

  const mismatch = await api.handle({
    method: "POST",
    pathname: "/api/me/memory-documents/mutate",
    token: alice.token,
    body: {
      conversationId: "conv_mia",
      botId: "bot_other",
      action: "add",
      target: "memory",
      content: "错误 Bot"
    }
  });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.error, "bot_identity_mismatch");

  const saved = await api.handle({
    method: "POST",
    pathname: "/api/me/memory-documents/mutate",
    token: alice.token,
    body: {
      clientOpId: "mutate_doc_1",
      conversationId: "conv_mia",
      action: "add",
      target: "user",
      content: "双方约定简洁回答"
    }
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.success, true);
  assert.equal(saved.body.target, "memory");
  assert.deepEqual(saved.body.currentEntries, ["双方约定简洁回答"]);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    userId: alice.user.id,
    event: {
      type: "memory.document_updated",
      target: "memory",
      botId: "bot_1",
      revision: 1,
      deletedAt: ""
    }
  });
  assert.equal(JSON.stringify(events[0]).includes("双方约定"), false);
  assert.equal(Object.hasOwn(events[0].event, "text"), false);
});

test("memory document API returns stable JSON errors and ignores unrelated routes", async (t) => {
  const { api, alice } = setup(t);
  const invalid = await api.handle({
    method: "POST",
    pathname: "/api/me/memory-documents/push",
    token: alice.token,
    body: { documents: [{ target: "memory", botId: "", text: "bad", revision: 1 }] }
  });
  assert.equal(invalid.status, 200);
  assert.equal(invalid.body.ok, false);
  assert.deepEqual(invalid.body.errors, [{ target: "memory", botId: "", error: "bot_id_required" }]);

  const unrelated = await api.handle({ method: "GET", pathname: "/api/me/memory" });
  assert.deepEqual(unrelated, { handled: false });
});
