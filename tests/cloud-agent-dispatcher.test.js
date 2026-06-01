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

function makeDispatcher(ctx, overrides = {}) {
  return createCloudAgentDispatcher({
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
      async runChat() {
        return { runId: "hr_test", content: "reply", events: [] };
      }
    },
    broadcastPersistedEvent() {},
    broadcastTransientEvent() {},
    ...overrides
  });
}

test("cloud-hermes DM runs the fellow and appends a reply", async () => {
  const ctx = setup();
  const hermesCalls = [];
  try {
    ctx.runtimeBindingsStore.upsertBinding({
      userId: ctx.user.id,
      fellowId: "mia",
      runtimeKind: "cloud-hermes",
      enabled: true,
      config: { model: "hermes-agent" }
    });
    const dispatcher = makeDispatcher(ctx, {
      hermesRunsClient: {
        async runChat(args) {
          hermesCalls.push(args);
          return { runId: "hr_dm", content: "hi", events: [] };
        }
      }
    });
    const message = ctx.messagesStore.appendMessage({
      conversationId: ctx.conversation.id,
      senderKind: "user",
      senderRef: ctx.user.id,
      bodyMd: "hello"
    });
    const reply = await dispatcher.handleUserMessage({
      userId: ctx.user.id,
      conversationId: ctx.conversation.id,
      message
    });
    assert.equal(reply.sender_ref, "mia");
    assert.equal(reply.body_md, "hi");
    assert.equal(hermesCalls.length, 1);
  } finally {
    ctx.cleanup();
  }
});

test("desktop-local DM broadcasts a fellow invocation and does not run inline", async () => {
  const ctx = setup();
  const broadcasts = [];
  const hermesCalls = [];
  try {
    ctx.runtimeBindingsStore.upsertBinding({
      userId: ctx.user.id,
      fellowId: "mia",
      runtimeKind: "cloud-hermes",
      enabled: false,
      config: {}
    });
    ctx.runtimeBindingsStore.upsertBinding({
      userId: ctx.user.id,
      fellowId: "mia",
      runtimeKind: "desktop-local",
      enabled: true,
      config: { model: "claude-sonnet-4-6" }
    });
    const dispatcher = makeDispatcher(ctx, {
      broadcastPersistedEvent(userId, event) {
        broadcasts.push({ userId, event });
      },
      hermesRunsClient: {
        async runChat(args) {
          hermesCalls.push(args);
          return { runId: "hr_dm", content: "should not run", events: [] };
        }
      }
    });
    const message = ctx.messagesStore.appendMessage({
      conversationId: ctx.conversation.id,
      senderKind: "user",
      senderRef: ctx.user.id,
      bodyMd: "hello"
    });
    const reply = await dispatcher.handleUserMessage({
      userId: ctx.user.id,
      conversationId: ctx.conversation.id,
      message
    });
    assert.equal(reply, null);
    assert.equal(hermesCalls.length, 0);
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].userId, ctx.user.id);
    assert.equal(broadcasts[0].event.type, "conversation.fellow_invocation_requested");
    assert.equal(broadcasts[0].event.conversationId, ctx.conversation.id);
    assert.equal(broadcasts[0].event.fellowId, "mia");
    assert.equal(broadcasts[0].event.runtimeKind, "desktop-local");
    assert.equal(broadcasts[0].event.runtimeConfig.model, "claude-sonnet-4-6");
    assert.equal(broadcasts[0].event.triggeringMessage.id, message.id);
  } finally {
    ctx.cleanup();
  }
});

test("single-fellow group skips the conductor and replies directly", async () => {
  const ctx = setup();
  const hermesCalls = [];
  try {
    const group = ctx.socialStore.createConversation({
      id: "g_single",
      type: "group",
      name: "Single fellow group"
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
    const dispatcher = makeDispatcher(ctx, {
      hermesRunsClient: {
        async runChat(args) {
          hermesCalls.push(args);
          return { runId: "hr_single", content: "got it", events: [] };
        }
      }
    });
    const message = ctx.messagesStore.appendMessage({
      conversationId: group.id,
      senderKind: "user",
      senderRef: ctx.user.id,
      bodyMd: "有人吗"
    });
    const reply = await dispatcher.handleUserMessage({
      userId: ctx.user.id,
      conversationId: group.id,
      message
    });
    assert.equal(reply.sender_ref, "mia");
    assert.equal(hermesCalls.length, 1, "no conductor turn for a one-fellow group");
    assert.match(hermesCalls[0].input, /群成员/);
  } finally {
    ctx.cleanup();
  }
});

test("multi-fellow group routes by name in the body", async () => {
  const ctx = setup();
  const hermesCalls = [];
  try {
    ctx.fellowsStore.upsertFellow(ctx.user.id, { id: "mia", name: "Mia", capabilities: ["chat"] });
    ctx.fellowsStore.upsertFellow(ctx.user.id, { id: "kongling", name: "空铃", capabilities: ["chat"] });
    const group = ctx.socialStore.createConversation({ id: "g_named", type: "group", name: "Group" });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "user", memberRef: ctx.user.id });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "fellow", memberRef: "mia", ownerId: ctx.user.id });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "fellow", memberRef: "kongling", ownerId: ctx.user.id });
    for (const fellowId of ["mia", "kongling"]) {
      ctx.runtimeBindingsStore.upsertBinding({
        userId: ctx.user.id,
        fellowId,
        runtimeKind: "cloud-hermes",
        enabled: true,
        config: { model: "hermes-agent" }
      });
    }
    const dispatcher = makeDispatcher(ctx, {
      hermesRunsClient: {
        async runChat(args) {
          hermesCalls.push(args);
          return { runId: "hr_named", content: "yes", events: [] };
        }
      }
    });
    const message = ctx.messagesStore.appendMessage({
      conversationId: group.id,
      senderKind: "user",
      senderRef: ctx.user.id,
      bodyMd: "空铃在吗"
    });
    const reply = await dispatcher.handleUserMessage({
      userId: ctx.user.id,
      conversationId: group.id,
      message
    });
    assert.equal(reply.sender_ref, "kongling");
    assert.equal(hermesCalls.length, 1, "no conductor turn when the message names a fellow");
  } finally {
    ctx.cleanup();
  }
});

test("multi-fellow group falls back to the conductor when no name matches", async () => {
  const ctx = setup();
  const hermesCalls = [];
  try {
    ctx.fellowsStore.upsertFellow(ctx.user.id, { id: "mia", name: "Mia", capabilities: ["chat"] });
    ctx.fellowsStore.upsertFellow(ctx.user.id, { id: "kongling", name: "空铃", capabilities: ["chat"] });
    const group = ctx.socialStore.createConversation({ id: "g_conductor", type: "group", name: "Group" });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "user", memberRef: ctx.user.id });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "fellow", memberRef: "mia", ownerId: ctx.user.id });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "fellow", memberRef: "kongling", ownerId: ctx.user.id });
    for (const fellowId of ["mia", "kongling"]) {
      ctx.runtimeBindingsStore.upsertBinding({
        userId: ctx.user.id,
        fellowId,
        runtimeKind: "cloud-hermes",
        enabled: true,
        config: { model: "hermes-agent" }
      });
    }
    const dispatcher = makeDispatcher(ctx, {
      hermesRunsClient: {
        async runChat(args) {
          hermesCalls.push(args);
          if (args.metadataRole === "group-conductor") {
            return { runId: "hr_c", content: '{"speak":["kongling"]}', events: [] };
          }
          return { runId: "hr_r", content: "ok", events: [] };
        }
      }
    });
    const message = ctx.messagesStore.appendMessage({
      conversationId: group.id,
      senderKind: "user",
      senderRef: ctx.user.id,
      bodyMd: "随便聊聊"
    });
    const reply = await dispatcher.handleUserMessage({
      userId: ctx.user.id,
      conversationId: group.id,
      message
    });
    assert.equal(reply.sender_ref, "kongling");
    assert.deepEqual(hermesCalls.map((call) => call.metadataRole || "reply"), ["group-conductor", "reply"]);
  } finally {
    ctx.cleanup();
  }
});

test("conductor garbage falls back to the first fellow member", async () => {
  const ctx = setup();
  try {
    ctx.fellowsStore.upsertFellow(ctx.user.id, { id: "mia", name: "Mia", capabilities: ["chat"] });
    ctx.fellowsStore.upsertFellow(ctx.user.id, { id: "kongling", name: "空铃", capabilities: ["chat"] });
    const group = ctx.socialStore.createConversation({ id: "g_garbage", type: "group", name: "Group" });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "user", memberRef: ctx.user.id });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "fellow", memberRef: "mia", ownerId: ctx.user.id });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "fellow", memberRef: "kongling", ownerId: ctx.user.id });
    for (const fellowId of ["mia", "kongling"]) {
      ctx.runtimeBindingsStore.upsertBinding({
        userId: ctx.user.id,
        fellowId,
        runtimeKind: "cloud-hermes",
        enabled: true,
        config: { model: "hermes-agent" }
      });
    }
    const dispatcher = makeDispatcher(ctx, {
      hermesRunsClient: {
        async runChat(args) {
          if (args.metadataRole === "group-conductor") return { runId: "hr_c", content: "not json", events: [] };
          return { runId: "hr_r", content: "fallback reply", events: [] };
        }
      }
    });
    const message = ctx.messagesStore.appendMessage({
      conversationId: group.id,
      senderKind: "user",
      senderRef: ctx.user.id,
      bodyMd: "随便聊聊"
    });
    const reply = await dispatcher.handleUserMessage({
      userId: ctx.user.id,
      conversationId: group.id,
      message
    });
    assert.ok(reply, "expected a fellow to fall back into replying");
    assert.match(reply.sender_ref, /mia|kongling/);
    assert.equal(reply.body_md, "fallback reply");
  } finally {
    ctx.cleanup();
  }
});

test("desktop-only fellow gets a fellow_invocation_requested broadcast and no inline run", async () => {
  const ctx = setup();
  const broadcasts = [];
  const hermesCalls = [];
  try {
    ctx.fellowsStore.upsertFellow(ctx.user.id, { id: "spec-master", name: "Spec Master", capabilities: ["chat"] });
    const group = ctx.socialStore.createConversation({ id: "g_local", type: "group", name: "Group" });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "user", memberRef: ctx.user.id });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "fellow", memberRef: "spec-master", ownerId: ctx.user.id });
    ctx.runtimeBindingsStore.upsertBinding({
      userId: ctx.user.id,
      fellowId: "spec-master",
      runtimeKind: "desktop-local",
      enabled: true,
      config: { model: "claude" }
    });
    const dispatcher = makeDispatcher(ctx, {
      broadcastPersistedEvent(userId, event) {
        broadcasts.push({ userId, event });
      },
      hermesRunsClient: {
        async runChat(args) {
          hermesCalls.push(args);
          return { runId: "hr_x", content: "nope", events: [] };
        }
      }
    });
    const message = ctx.messagesStore.appendMessage({
      conversationId: group.id,
      senderKind: "user",
      senderRef: ctx.user.id,
      bodyMd: "看下昨天的报告"
    });
    const reply = await dispatcher.handleUserMessage({
      userId: ctx.user.id,
      conversationId: group.id,
      message
    });
    assert.equal(reply, null);
    assert.equal(hermesCalls.length, 0);
    const invocation = broadcasts.find((entry) => entry.event.type === "conversation.fellow_invocation_requested");
    assert.ok(invocation, "expected a desktop invocation broadcast");
    assert.equal(invocation.event.fellowId, "spec-master");
    assert.equal(invocation.userId, ctx.user.id);
    assert.equal(invocation.event.runtimeConfig?.model, "claude");
  } finally {
    ctx.cleanup();
  }
});

test("@mention bypasses the conductor and picks only the mentioned fellow", async () => {
  const ctx = setup();
  const hermesCalls = [];
  try {
    ctx.fellowsStore.upsertFellow(ctx.user.id, { id: "mia", name: "Mia", capabilities: ["chat"] });
    ctx.fellowsStore.upsertFellow(ctx.user.id, { id: "kongling", name: "空铃", capabilities: ["chat"] });
    const group = ctx.socialStore.createConversation({ id: "g_mention", type: "group", name: "Group" });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "user", memberRef: ctx.user.id });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "fellow", memberRef: "mia", ownerId: ctx.user.id });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "fellow", memberRef: "kongling", ownerId: ctx.user.id });
    for (const fellowId of ["mia", "kongling"]) {
      ctx.runtimeBindingsStore.upsertBinding({
        userId: ctx.user.id,
        fellowId,
        runtimeKind: "cloud-hermes",
        enabled: true,
        config: { model: "hermes-agent" }
      });
    }
    const dispatcher = makeDispatcher(ctx, {
      hermesRunsClient: {
        async runChat(args) {
          hermesCalls.push(args);
          return { runId: "hr_mention", content: "reply", events: [] };
        }
      }
    });
    const message = ctx.messagesStore.appendMessage({
      conversationId: group.id,
      senderKind: "user",
      senderRef: ctx.user.id,
      bodyMd: "hey",
      mentions: [{ kind: "fellow", fellowId: "kongling" }]
    });
    const reply = await dispatcher.handleUserMessage({
      userId: ctx.user.id,
      conversationId: group.id,
      message
    });
    assert.equal(reply.sender_ref, "kongling");
    assert.deepEqual(hermesCalls.map((call) => call.metadataRole || "reply"), ["reply"]);
  } finally {
    ctx.cleanup();
  }
});

test("explicit fellowId on invokeFellow runs that fellow regardless of routing", async () => {
  const ctx = setup();
  const hermesCalls = [];
  try {
    ctx.fellowsStore.upsertFellow(ctx.user.id, { id: "mia", name: "Mia", capabilities: ["chat"] });
    ctx.fellowsStore.upsertFellow(ctx.user.id, { id: "kongling", name: "空铃", capabilities: ["chat"] });
    const group = ctx.socialStore.createConversation({ id: "g_explicit", type: "group", name: "Group" });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "user", memberRef: ctx.user.id });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "fellow", memberRef: "mia", ownerId: ctx.user.id });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "fellow", memberRef: "kongling", ownerId: ctx.user.id });
    ctx.runtimeBindingsStore.upsertBinding({
      userId: ctx.user.id,
      fellowId: "kongling",
      runtimeKind: "cloud-hermes",
      enabled: true,
      config: { model: "hermes-agent" }
    });
    const dispatcher = makeDispatcher(ctx, {
      hermesRunsClient: {
        async runChat(args) {
          hermesCalls.push(args);
          return { runId: "hr_explicit", content: "explicit reply", events: [] };
        }
      }
    });
    const message = ctx.messagesStore.appendMessage({
      conversationId: group.id,
      senderKind: "user",
      senderRef: ctx.user.id,
      bodyMd: "anything"
    });
    const reply = await dispatcher.invokeFellow({
      userId: ctx.user.id,
      conversationId: group.id,
      fellowId: "kongling",
      message
    });
    assert.equal(reply.sender_ref, "kongling");
    assert.equal(hermesCalls.length, 1);
  } finally {
    ctx.cleanup();
  }
});

test("respondApproval routes the owner's decision to the run's Hermes worker", async () => {
  const ctx = setup();
  const approvalCalls = [];
  try {
    const run = ctx.cloudAgentRunsStore.createRun({
      userId: ctx.user.id,
      fellowId: "mia",
      conversationId: ctx.conversation.id,
      triggerMessageId: "m1"
    });
    ctx.cloudAgentRunsStore.markRunning(run.id, "hermes_run_9");
    const dispatcher = makeDispatcher(ctx, {
      hermesRunsClient: {
        async runChat() { return { runId: "hr", content: "", events: [] }; },
        async submitApproval(args) { approvalCalls.push(args); return { resolved: 1 }; }
      }
    });

    const ok = await dispatcher.respondApproval({ userId: ctx.user.id, runId: run.id, decision: "allow_always" });
    assert.equal(ok.ok, true);
    assert.equal(ok.choice, "always");
    assert.equal(approvalCalls.length, 1);
    assert.equal(approvalCalls[0].runId, "hermes_run_9");
    assert.equal(approvalCalls[0].choice, "always");
    assert.equal(approvalCalls[0].baseUrl, "http://worker");

    // Only the run owner may answer — a different member is refused without a worker call.
    const denied = await dispatcher.respondApproval({ userId: "someone_else", runId: run.id, decision: "deny" });
    assert.equal(denied.ok, false);
    assert.equal(approvalCalls.length, 1);

    // A run id from a different conversation is refused (no extra worker call).
    const mismatched = await dispatcher.respondApproval({
      userId: ctx.user.id,
      runId: run.id,
      conversationId: "some_other_conversation",
      decision: "allow_once"
    });
    assert.equal(mismatched.ok, false);
    assert.equal(approvalCalls.length, 1);
  } finally {
    ctx.cleanup();
  }
});
