const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createCloudStore } = require("../src/cloud/sqlite-store.js");
const { createSocialStore } = require("../src/cloud/social-store.js");
const { createMessagesStore } = require("../src/cloud/messages-store.js");
const { createFellowsStore } = require("../src/cloud/fellows-store.js");
const { createRuntimeBindingsStore } = require("../src/cloud-agent/runtime-bindings-store.js");
const { createCloudAgentRunsStore } = require("../src/cloud-agent/cloud-agent-runs-store.js");
const { ensureDefaultCloudFellow } = require("../src/cloud-agent/default-fellow.js");
const { createCloudAgentDispatcher } = require("../src/cloud-agent/dispatcher.js");

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimashi-cloud-agent-dispatcher-"));
  const cloudStore = createCloudStore({ dataDir: dir });
  const db = cloudStore.getDb();
  const socialStore = createSocialStore(db);
  const fellowsStore = createFellowsStore(db);
  socialStore._attachFellowsStore(fellowsStore);
  const messagesStore = createMessagesStore(db);
  const runtimeBindingsStore = createRuntimeBindingsStore(db);
  const cloudAgentRunsStore = createCloudAgentRunsStore(db);
  const user = cloudStore.registerUser({ username: "alice", password: "123456" }).user;
  const baseContext = { socialStore, fellowsStore, runtimeBindingsStore };
  const { room } = ensureDefaultCloudFellow(baseContext, user.id);
  return {
    dir,
    cloudStore,
    socialStore,
    fellowsStore,
    messagesStore,
    runtimeBindingsStore,
    cloudAgentRunsStore,
    user,
    room,
    cleanup() {
      cloudStore.close?.();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("dispatcher only runs enabled cloud-hermes fellow rooms and appends fellow reply", async () => {
  const ctx = setup();
  const hermesCalls = [];
  const broadcasts = [];
  try {
    const dispatcher = createCloudAgentDispatcher({
      socialStore: ctx.socialStore,
      messagesStore: ctx.messagesStore,
      fellowsStore: ctx.fellowsStore,
      runtimeBindingsStore: ctx.runtimeBindingsStore,
      cloudAgentRunsStore: ctx.cloudAgentRunsStore,
      workerManager: {
        async ensureWorker(userId) {
          return { userId, baseUrl: "http://worker", apiKey: "k" };
        }
      },
      hermesRunsClient: {
        async runChat(args) {
          hermesCalls.push(args);
          return { runId: "hr_1", content: "cloud reply", events: [] };
        }
      },
      broadcastPersistedEvent(userId, payload) {
        broadcasts.push({ userId, payload });
      }
    });

    const message = ctx.messagesStore.appendMessage({
      roomId: ctx.room.id,
      senderKind: "user",
      senderRef: ctx.user.id,
      bodyMd: "hello"
    });

    await dispatcher.handleUserMessage({ userId: ctx.user.id, roomId: ctx.room.id, message });

    assert.equal(hermesCalls.length, 1);
    assert.equal(hermesCalls[0].userId, ctx.user.id);
    assert.equal(hermesCalls[0].fellow.id, "aimashi");
    assert.equal(hermesCalls[0].input, "hello");
    assert.deepEqual(hermesCalls[0].conversationHistory.map((m) => m.role), ["user"]);

    const messages = ctx.messagesStore.listMessagesSince(ctx.room.id, 0);
    assert.deepEqual(messages.map((m) => m.sender_kind), ["user", "fellow"]);
    assert.equal(messages[1].sender_ref, "aimashi");
    assert.equal(messages[1].sender_owner_id, ctx.user.id);
    assert.equal(messages[1].body_md, "cloud reply");

    const runRows = ctx.cloudStore.getDb().prepare("SELECT status, hermes_run_id FROM cloud_agent_runs").all()
      .map((row) => ({ status: row.status, hermes_run_id: row.hermes_run_id }));
    assert.deepEqual(runRows, [{ status: "complete", hermes_run_id: "hr_1" }]);
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].payload.type, "room.message_appended");
  } finally {
    ctx.cleanup();
  }
});

test("dispatcher skips fellow rooms without enabled cloud-hermes binding", async () => {
  const ctx = setup();
  try {
    ctx.runtimeBindingsStore.upsertBinding({
      userId: ctx.user.id,
      fellowId: "aimashi",
      runtimeKind: "cloud-hermes",
      enabled: false
    });
    let called = false;
    const dispatcher = createCloudAgentDispatcher({
      socialStore: ctx.socialStore,
      messagesStore: ctx.messagesStore,
      fellowsStore: ctx.fellowsStore,
      runtimeBindingsStore: ctx.runtimeBindingsStore,
      cloudAgentRunsStore: ctx.cloudAgentRunsStore,
      workerManager: { async ensureWorker() { called = true; } },
      hermesRunsClient: { async runChat() { called = true; return { content: "" }; } },
      broadcastPersistedEvent() {}
    });
    const message = ctx.messagesStore.appendMessage({
      roomId: ctx.room.id,
      senderKind: "user",
      senderRef: ctx.user.id,
      bodyMd: "hello"
    });
    await dispatcher.handleUserMessage({ userId: ctx.user.id, roomId: ctx.room.id, message });
    assert.equal(called, false);
    assert.equal(ctx.messagesStore.listMessagesSince(ctx.room.id, 0).length, 1);
  } finally {
    ctx.cleanup();
  }
});
