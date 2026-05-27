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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-cloud-agent-dispatcher-"));
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
  const { conversation } = ensureDefaultCloudFellow(baseContext, user.id);
  return {
    dir,
    cloudStore,
    socialStore,
    fellowsStore,
    messagesStore,
    runtimeBindingsStore,
    cloudAgentRunsStore,
    user,
    conversation,
    cleanup() {
      cloudStore.close?.();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("dispatcher only runs enabled cloud-hermes fellow conversations and appends fellow reply", async () => {
  const ctx = setup();
  const hermesCalls = [];
  const broadcasts = [];
  const transientEvents = [];
  const materializeCalls = [];
  try {
    ctx.runtimeBindingsStore.upsertBinding({
      userId: ctx.user.id,
      fellowId: "mia",
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
      conversationId: ctx.conversation.id,
      senderKind: "user",
      senderRef: ctx.user.id,
      bodyMd: "hello",
      attachments: [{ id: "file_1", url: "/api/files/file_1" }]
    });

    await dispatcher.handleUserMessage({ userId: ctx.user.id, conversationId: ctx.conversation.id, message });

    assert.equal(hermesCalls.length, 1);
    assert.equal(hermesCalls[0].userId, ctx.user.id);
    assert.equal(hermesCalls[0].fellow.id, "mia");
    assert.equal(hermesCalls[0].model, "hermes-agent");
    assert.equal(hermesCalls[0].effortLevel, "high");
    assert.equal(hermesCalls[0].permissionMode, "auto");
    assert.equal(materializeCalls.length, 1);
    assert.deepEqual(materializeCalls[0].attachments, [{ id: "file_1", url: "/api/files/file_1" }]);
    assert.match(hermesCalls[0].input, /附件上下文/);
    assert.deepEqual(hermesCalls[0].attachments, [{ id: "file_1", name: "a.txt", path: "/data/attachments/run/a.txt" }]);
    assert.deepEqual(hermesCalls[0].conversationHistory.map((m) => m.role), ["user"]);

    const messages = ctx.messagesStore.listMessagesSince(ctx.conversation.id, 0);
    assert.deepEqual(messages.map((m) => m.sender_kind), ["user", "fellow"]);
    assert.equal(messages[1].sender_ref, "mia");
    assert.equal(messages[1].sender_owner_id, ctx.user.id);
    assert.equal(messages[1].body_md, "cloud reply");
    assert.deepEqual(JSON.parse(messages[1].attachments_json), [{ id: "file_generated", type: "text", name: "out.txt", mimeType: "text/plain", size: 3, url: "/api/files/file_generated" }]);

    const runRows = ctx.cloudStore.getDb().prepare("SELECT status, hermes_run_id FROM cloud_agent_runs").all()
      .map((row) => ({ status: row.status, hermes_run_id: row.hermes_run_id }));
    assert.deepEqual(runRows, [{ status: "complete", hermes_run_id: "hr_1" }]);
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].payload.type, "conversation.message_appended");
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

test("dispatcher defaults cloud-hermes runs to the platform model alias", async () => {
  const ctx = setup();
  const hermesCalls = [];
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
          return { runId: "hr_default", content: "ok", events: [] };
        }
      },
      broadcastPersistedEvent() {},
      broadcastTransientEvent() {}
    });
    const message = ctx.messagesStore.appendMessage({
      conversationId: ctx.conversation.id,
      senderKind: "user",
      senderRef: ctx.user.id,
      bodyMd: "hello"
    });
    await dispatcher.handleUserMessage({ userId: ctx.user.id, conversationId: ctx.conversation.id, message });
    assert.equal(hermesCalls.length, 1);
    assert.equal(hermesCalls[0].model, "mia-default");
  } finally {
    ctx.cleanup();
  }
});

test("invokeFellow runs enabled cloud-hermes fellows in group conversations", async () => {
  const ctx = setup();
  const hermesCalls = [];
  const broadcasts = [];
  try {
    const group = ctx.socialStore.createConversation({
      id: "g_cloud",
      type: "group",
      name: "Cloud Group"
    });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "user", memberRef: ctx.user.id });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "fellow", memberRef: "mia", ownerId: ctx.user.id });
    ctx.runtimeBindingsStore.upsertBinding({
      userId: ctx.user.id,
      fellowId: "mia",
      runtimeKind: "cloud-hermes",
      enabled: true,
      config: { model: "hermes-agent" }
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
          return { runId: "hr_group", content: "group cloud reply", events: [] };
        }
      },
      broadcastPersistedEvent(userId, payload) {
        broadcasts.push({ userId, payload });
      },
      broadcastTransientEvent() {}
    });
    const message = ctx.messagesStore.appendMessage({
      conversationId: group.id,
      senderKind: "user",
      senderRef: ctx.user.id,
      bodyMd: "@mia hello"
    });

    const reply = await dispatcher.invokeFellow({
      userId: ctx.user.id,
      conversationId: group.id,
      fellowId: "mia",
      message
    });

    assert.equal(reply.sender_kind, "fellow");
    assert.equal(reply.sender_ref, "mia");
    assert.equal(reply.body_md, "group cloud reply");
    assert.equal(hermesCalls.length, 1);
    assert.equal(hermesCalls[0].conversationId, group.id);
    assert.equal(hermesCalls[0].fellow.id, "mia");
    assert.deepEqual(ctx.messagesStore.listMessagesSince(group.id, 0).map((m) => m.sender_kind), ["user", "fellow"]);
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].payload.type, "conversation.message_appended");
  } finally {
    ctx.cleanup();
  }
});

test("handleUserMessage runs the single owned cloud-hermes fellow in a group conversation", async () => {
  const ctx = setup();
  const hermesCalls = [];
  try {
    const group = ctx.socialStore.createConversation({
      id: "g_cloud_auto",
      type: "group",
      name: "Cloud Group"
    });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "user", memberRef: ctx.user.id });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "fellow", memberRef: "mia", ownerId: ctx.user.id });
    ctx.runtimeBindingsStore.upsertBinding({
      userId: ctx.user.id,
      fellowId: "mia",
      runtimeKind: "cloud-hermes",
      enabled: true,
      config: { model: "hermes-agent" }
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
          return { runId: "hr_group_auto", content: "single fellow reply", events: [] };
        }
      },
      broadcastPersistedEvent() {},
      broadcastTransientEvent() {}
    });
    const message = ctx.messagesStore.appendMessage({
      conversationId: group.id,
      senderKind: "user",
      senderRef: ctx.user.id,
      bodyMd: "谁能总结一下"
    });

    const reply = await dispatcher.handleUserMessage({
      userId: ctx.user.id,
      conversationId: group.id,
      message
    });

    assert.equal(reply.sender_ref, "mia");
    assert.equal(reply.body_md, "single fellow reply");
    assert.equal(hermesCalls.length, 1);
    assert.equal(hermesCalls[0].conversationId, group.id);
  } finally {
    ctx.cleanup();
  }
});

test("handleUserMessage routes multi-fellow cloud groups by the named fellow", async () => {
  const ctx = setup();
  const hermesCalls = [];
  try {
    ctx.fellowsStore.upsertFellow(ctx.user.id, { id: "alice", name: "爱丽丝", capabilities: ["chat"] });
    ctx.fellowsStore.upsertFellow(ctx.user.id, { id: "xiaoli", name: "小栗", capabilities: ["chat"] });
    const group = ctx.socialStore.createConversation({
      id: "g_cloud_named",
      type: "group",
      name: "Cloud Group"
    });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "user", memberRef: ctx.user.id });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "fellow", memberRef: "alice", ownerId: ctx.user.id });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "fellow", memberRef: "xiaoli", ownerId: ctx.user.id });
    for (const fellowId of ["alice", "xiaoli"]) {
      ctx.runtimeBindingsStore.upsertBinding({
        userId: ctx.user.id,
        fellowId,
        runtimeKind: "cloud-hermes",
        enabled: true,
        config: { model: "hermes-agent" }
      });
    }
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
          return { runId: "hr_group_named", content: "alice cloud reply", events: [] };
        }
      },
      broadcastPersistedEvent() {},
      broadcastTransientEvent() {}
    });
    const message = ctx.messagesStore.appendMessage({
      conversationId: group.id,
      senderKind: "user",
      senderRef: ctx.user.id,
      bodyMd: "爱丽丝你说一下"
    });

    const reply = await dispatcher.handleUserMessage({
      userId: ctx.user.id,
      conversationId: group.id,
      message
    });

    assert.equal(reply.sender_ref, "alice");
    assert.equal(hermesCalls.length, 1);
    assert.equal(hermesCalls[0].fellow.id, "alice");
  } finally {
    ctx.cleanup();
  }
});

test("handleUserMessage routes cloud group search requests to a search-capable fellow", async () => {
  const ctx = setup();
  const hermesCalls = [];
  try {
    ctx.fellowsStore.upsertFellow(ctx.user.id, { id: "alice", name: "爱丽丝", capabilities: ["chat"] });
    ctx.fellowsStore.upsertFellow(ctx.user.id, {
      id: "blackcat",
      name: "黑猫",
      capabilities: { webSearch: true }
    });
    const group = ctx.socialStore.createConversation({
      id: "g_cloud_search",
      type: "group",
      name: "Cloud Group"
    });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "user", memberRef: ctx.user.id });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "fellow", memberRef: "alice", ownerId: ctx.user.id });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "fellow", memberRef: "blackcat", ownerId: ctx.user.id });
    for (const fellowId of ["alice", "blackcat"]) {
      ctx.runtimeBindingsStore.upsertBinding({
        userId: ctx.user.id,
        fellowId,
        runtimeKind: "cloud-hermes",
        enabled: true,
        config: { model: "hermes-agent" }
      });
    }
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
          return { runId: "hr_group_search", content: "search cloud reply", events: [] };
        }
      },
      broadcastPersistedEvent() {},
      broadcastTransientEvent() {}
    });
    const message = ctx.messagesStore.appendMessage({
      conversationId: group.id,
      senderKind: "user",
      senderRef: ctx.user.id,
      bodyMd: "爱丽丝你帮我找下AI领域最新新闻"
    });

    const reply = await dispatcher.handleUserMessage({
      userId: ctx.user.id,
      conversationId: group.id,
      message
    });

    assert.equal(reply.sender_ref, "blackcat");
    assert.equal(hermesCalls.length, 1);
    assert.equal(hermesCalls[0].fellow.id, "blackcat");
  } finally {
    ctx.cleanup();
  }
});

test("handleUserMessage uses a cloud conductor when a multi-fellow cloud group has no direct route", async () => {
  const ctx = setup();
  const hermesCalls = [];
  try {
    ctx.fellowsStore.upsertFellow(ctx.user.id, { id: "alice", name: "爱丽丝", capabilities: ["chat"] });
    ctx.fellowsStore.upsertFellow(ctx.user.id, { id: "xiaoli", name: "小栗", capabilities: ["chat"] });
    const group = ctx.socialStore.createConversation({
      id: "g_cloud_conductor",
      type: "group",
      name: "Cloud Group",
      decorations: {
        responseMode: "conductor",
        hostMember: { kind: "fellow", fellowId: "alice" }
      }
    });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "user", memberRef: ctx.user.id });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "fellow", memberRef: "alice", ownerId: ctx.user.id });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "fellow", memberRef: "xiaoli", ownerId: ctx.user.id });
    for (const fellowId of ["alice", "xiaoli"]) {
      ctx.runtimeBindingsStore.upsertBinding({
        userId: ctx.user.id,
        fellowId,
        runtimeKind: "cloud-hermes",
        enabled: true,
        config: { model: "hermes-agent" }
      });
    }
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
          if (args.metadataRole === "group-conductor") {
            assert.equal(args.fellow.id, "alice");
            assert.match(args.input, /爱丽丝/);
            assert.match(args.input, /小栗/);
            assert.match(args.sessionId, /^cloud:[^:]+:conductor:g_cloud_conductor:/);
            return { runId: "hr_dispatch", content: JSON.stringify({ speak: ["xiaoli"] }), events: [] };
          }
          return { runId: "hr_reply", content: "xiaoli reply", events: [] };
        }
      },
      loadPrompts: async () => ({
        dispatch: "members:\n{{members}}\nrecent:\n{{recent}}\nuser: {{userMessage}}\n输出 JSON：{\"speak\": []}"
      }),
      broadcastPersistedEvent() {},
      broadcastTransientEvent() {}
    });
    const message = ctx.messagesStore.appendMessage({
      conversationId: group.id,
      senderKind: "user",
      senderRef: ctx.user.id,
      bodyMd: "大家怎么看"
    });

    const reply = await dispatcher.handleUserMessage({
      userId: ctx.user.id,
      conversationId: group.id,
      message
    });

    assert.equal(reply.sender_ref, "xiaoli");
    assert.equal(reply.body_md, "xiaoli reply");
    assert.deepEqual(hermesCalls.map((call) => [call.metadataRole || "reply", call.fellow.id]), [
      ["group-conductor", "alice"],
      ["reply", "xiaoli"]
    ]);
    assert.deepEqual(ctx.messagesStore.listMessagesSince(group.id, 0).map((row) => row.body_md), [
      "大家怎么看",
      "xiaoli reply"
    ]);
  } finally {
    ctx.cleanup();
  }
});

test("dispatcher skips fellow conversations without enabled cloud-hermes binding", async () => {
  const ctx = setup();
  try {
    ctx.runtimeBindingsStore.upsertBinding({
      userId: ctx.user.id,
      fellowId: "mia",
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
      conversationId: ctx.conversation.id,
      senderKind: "user",
      senderRef: ctx.user.id,
      bodyMd: "hello"
    });
    await dispatcher.handleUserMessage({ userId: ctx.user.id, conversationId: ctx.conversation.id, message });
    assert.equal(called, false);
    assert.equal(ctx.messagesStore.listMessagesSince(ctx.conversation.id, 0).length, 1);
  } finally {
    ctx.cleanup();
  }
});

test("dispatcher skips desktop-local and legacy fellow conversations even when a cloud binding exists", async () => {
  for (const decorations of [
    { fellowKey: "mia", sessionId: "mia", runtimeKind: "desktop-local" },
    { fellowKey: "mia", sessionId: "mia" }
  ]) {
    const ctx = setup();
    try {
      ctx.socialStore.updateConversation(ctx.conversation.id, { decorations });
      ctx.runtimeBindingsStore.upsertBinding({
        userId: ctx.user.id,
        fellowId: "mia",
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
        conversationId: ctx.conversation.id,
        senderKind: "user",
        senderRef: ctx.user.id,
        bodyMd: "hello"
      });
      await dispatcher.handleUserMessage({ userId: ctx.user.id, conversationId: ctx.conversation.id, message });
      assert.equal(called, false);
      assert.equal(ctx.messagesStore.listMessagesSince(ctx.conversation.id, 0).length, 1);
    } finally {
      ctx.cleanup();
    }
  }
});
