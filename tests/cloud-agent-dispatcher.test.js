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
  const transientEvents = [];
  const materializeCalls = [];
  try {
    ctx.runtimeBindingsStore.upsertBinding({
      userId: ctx.user.id,
      fellowId: "aimashi",
      runtimeKind: "cloud-hermes",
      enabled: true,
      config: {
        model: "hermes-agent",
        effortLevel: "high",
        permissionMode: "auto"
      }
    });
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
          args.onRunCreated?.("hr_1");
          args.onEvent?.({ type: "message.delta", delta: "cloud " });
          args.onEvent?.({ type: "tool.started", tool: "shell" });
          return { runId: "hr_1", content: "cloud reply", events: [{ artifacts: [{ path: "/data/workspace/out.txt" }] }] };
        }
      },
      attachmentMaterializer: {
        materialize(args) {
          materializeCalls.push(args);
          return {
            input: `${args.text}\n\n附件上下文：/data/attachments/run/a.txt`,
            attachments: [{ id: "file_1", name: "a.txt", path: "/data/attachments/run/a.txt" }]
          };
        },
        archiveGeneratedAttachments(args) {
          assert.deepEqual(args.result.events, [{ artifacts: [{ path: "/data/workspace/out.txt" }] }]);
          return [{ id: "file_generated", type: "text", name: "out.txt", mimeType: "text/plain", size: 3, url: "/api/files/file_generated" }];
        }
      },
      broadcastPersistedEvent(userId, payload) {
        broadcasts.push({ userId, payload });
      },
      broadcastTransientEvent(userId, payload) {
        transientEvents.push({ userId, payload });
      }
    });

    const message = ctx.messagesStore.appendMessage({
      roomId: ctx.room.id,
      senderKind: "user",
      senderRef: ctx.user.id,
      bodyMd: "hello",
      attachments: [{ id: "file_1", url: "/api/files/file_1" }]
    });

    await dispatcher.handleUserMessage({ userId: ctx.user.id, roomId: ctx.room.id, message });

    assert.equal(hermesCalls.length, 1);
    assert.equal(hermesCalls[0].userId, ctx.user.id);
    assert.equal(hermesCalls[0].fellow.id, "aimashi");
    assert.equal(hermesCalls[0].model, "hermes-agent");
    assert.equal(hermesCalls[0].effortLevel, "high");
    assert.equal(hermesCalls[0].permissionMode, "auto");
    assert.equal(materializeCalls.length, 1);
    assert.deepEqual(materializeCalls[0].attachments, [{ id: "file_1", url: "/api/files/file_1" }]);
    assert.match(hermesCalls[0].input, /附件上下文/);
    assert.deepEqual(hermesCalls[0].attachments, [{ id: "file_1", name: "a.txt", path: "/data/attachments/run/a.txt" }]);
    assert.deepEqual(hermesCalls[0].conversationHistory.map((m) => m.role), ["user"]);

    const messages = ctx.messagesStore.listMessagesSince(ctx.room.id, 0);
    assert.deepEqual(messages.map((m) => m.sender_kind), ["user", "fellow"]);
    assert.equal(messages[1].sender_ref, "aimashi");
    assert.equal(messages[1].sender_owner_id, ctx.user.id);
    assert.equal(messages[1].body_md, "cloud reply");
    assert.deepEqual(JSON.parse(messages[1].attachments_json), [{ id: "file_generated", type: "text", name: "out.txt", mimeType: "text/plain", size: 3, url: "/api/files/file_generated" }]);

    const runRows = ctx.cloudStore.getDb().prepare("SELECT status, hermes_run_id FROM cloud_agent_runs").all()
      .map((row) => ({ status: row.status, hermes_run_id: row.hermes_run_id }));
    assert.deepEqual(runRows, [{ status: "complete", hermes_run_id: "hr_1" }]);
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].payload.type, "room.message_appended");
    assert.deepEqual(transientEvents.map((item) => item.payload.type), [
      "cloud_agent_run_started",
      "cloud_agent_run_event",
      "cloud_agent_run_event"
    ]);
    assert.equal(transientEvents[0].payload.hermesRunId, "hr_1");
    assert.deepEqual(transientEvents.slice(1).map((item) => item.payload.event.type), ["message.delta", "tool.started"]);
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

test("dispatcher skips desktop-local and legacy fellow rooms even when a cloud binding exists", async () => {
  for (const decorations of [
    { fellowKey: "aimashi", sessionId: "aimashi", runtimeKind: "desktop-local" },
    { fellowKey: "aimashi", sessionId: "aimashi" }
  ]) {
    const ctx = setup();
    try {
      ctx.socialStore.updateRoom(ctx.room.id, { decorations });
      ctx.runtimeBindingsStore.upsertBinding({
        userId: ctx.user.id,
        fellowId: "aimashi",
        runtimeKind: "cloud-hermes",
        enabled: true,
        config: { model: "hermes-agent" }
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
  }
});
