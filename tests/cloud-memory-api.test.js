const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createMiaCloudServer } = require("../scripts/serve-cloud.js");
const { loginCloudUser } = require("./helpers/cloud-auth.js");

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mia-cloud-memory-api-"));
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function jsonFetch(baseUrl, requestPath, token, options = {}) {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    },
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

test("cloud memory API syncs scoped memories with account isolation and tombstones", async () => {
  const dataDir = tempDataDir();
  const server = createMiaCloudServer({ dataDir });
  const baseUrl = await listen(server);
  try {
    const alice = loginCloudUser(server.mia.cloudStore, "memory_api_alice");
    const bob = loginCloudUser(server.mia.cloudStore, "memory_api_bob");

    const saved = await jsonFetch(baseUrl, "/api/me/memory/mem_api_pref", alice.token, {
      method: "PUT",
      body: {
        botId: "mei",
        sessionId: "s1",
        scope: "bot",
        text: "Mei should keep implementation plans compact",
        confidence: 0.9,
        updatedAt: "2026-01-01T00:00:10.000Z",
        revision: 1
      }
    });
    assert.equal(saved.memory.id, "mem_api_pref");
    assert.equal(saved.memory.userId, alice.user.id);
    assert.equal(Object.prototype.hasOwnProperty.call(saved.memory, "kind"), false);

    const listed = await jsonFetch(baseUrl, "/api/me/memory?botId=mei&q=implementation", alice.token);
    assert.equal(listed.memories.length, 1);
    assert.equal(listed.memories[0].scope, "bot");

    const bobList = await jsonFetch(baseUrl, "/api/me/memory?botId=mei&q=implementation", bob.token);
    assert.equal(bobList.memories.length, 0);

    const staleError = await jsonFetch(baseUrl, "/api/me/memory/mem_api_pref", alice.token, {
      method: "PUT",
      body: {
        botId: "mei",
        scope: "bot",
        text: "Mei should write very long implementation plans",
        updatedAt: "2025-12-31T00:00:00.000Z",
        revision: 1
      }
    }).then(
      () => null,
      (error) => error
    );
    assert.equal(staleError.status, 409);
    assert.equal(staleError.data.memory.text, "Mei should keep implementation plans compact");

    const deleted = await jsonFetch(baseUrl, "/api/me/memory/mem_api_pref", alice.token, {
      method: "DELETE",
      body: { clientOpId: "delete_mem_api_pref" }
    });
    assert.equal(deleted.ok, true);
    assert.equal(deleted.memory.text, "");
    assert.ok(deleted.memory.deletedAt);

    const hidden = await jsonFetch(baseUrl, "/api/me/memory?botId=mei&q=implementation", alice.token);
    assert.equal(hidden.memories.length, 0);

    const since = await jsonFetch(baseUrl, "/api/me/memory?since=2026-01-01T00:00:00.000Z", alice.token);
    assert.equal(since.memories.length, 1);
    assert.equal(since.memories[0].id, "mem_api_pref");
    assert.equal(since.memories[0].text, "");
    assert.ok(since.memories[0].deletedAt);

    const events = server.mia.eventLog.listEventsSince(alice.user.id, 0, 20);
    assert.ok(events.some((event) => event.kind === "memory.updated"));
    assert.ok(events.some((event) => event.kind === "memory.deleted"));
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud memory push API is idempotent and returns conflicts without overwriting", async () => {
  const dataDir = tempDataDir();
  const server = createMiaCloudServer({ dataDir });
  const baseUrl = await listen(server);
  try {
    const account = loginCloudUser(server.mia.cloudStore, "memory_api_push");

    const pushed = await jsonFetch(baseUrl, "/api/me/memory/push", account.token, {
      method: "POST",
      body: {
        clientOpId: "push_memory_batch_1",
        entries: [{
          id: "mem_push_1",
          botId: "mei",
          scope: "bot",
          text: "The user prefers short cloud sync summaries",
          updatedAt: "2026-01-02T00:00:00.000Z",
          revision: 2
        }]
      }
    });
    assert.equal(pushed.memories.length, 1);

    const replay = await jsonFetch(baseUrl, "/api/me/memory/push", account.token, {
      method: "POST",
      body: {
        clientOpId: "push_memory_batch_1",
        entries: [{
          id: "mem_push_1",
          botId: "mei",
          scope: "bot",
          text: "This body should not execute twice",
          updatedAt: "2026-01-03T00:00:00.000Z",
          revision: 3
        }]
      }
    });
    assert.deepEqual(replay.memories, pushed.memories);

    const conflict = await jsonFetch(baseUrl, "/api/me/memory/push", account.token, {
      method: "POST",
      body: {
        entries: [{
          id: "mem_push_1",
          botId: "mei",
          scope: "bot",
          text: "The user prefers verbose cloud sync summaries",
          updatedAt: "2026-01-01T00:00:00.000Z",
          revision: 1
        }]
      }
    });
    assert.equal(conflict.memories.length, 0);
    assert.equal(conflict.conflicts.length, 1);
    assert.equal(conflict.conflicts[0].text, "The user prefers short cloud sync summaries");
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
