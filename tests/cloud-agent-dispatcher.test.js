const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createCloudStore } = require("../src/cloud/sqlite-store.js");
const { createSocialStore } = require("../src/cloud/social-store.js");
const { createMessagesStore } = require("../src/cloud/messages-store.js");
const { createBotsStore } = require("../src/cloud/bots-store.js");
const { createRuntimeBindingsStore } = require("../src/cloud-agent/runtime-bindings-store.js");
const { createCloudAgentRunsStore } = require("../src/cloud-agent/cloud-agent-runs-store.js");
const { createCloudAgentDispatcher } = require("../src/cloud-agent/dispatcher.js");
const { createAttachmentMaterializer } = require("../src/cloud-agent/attachment-materializer.js");
const { createCloudUser } = require("./helpers/cloud-auth.js");

const BOT_ID = "alice_bot";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "generic-bot-cloud-agent-dispatcher-"));
  const cloudStore = createCloudStore({ dataDir: dir });
  const db = cloudStore.getDb();
  const socialStore = createSocialStore(db);
  const botsStore = createBotsStore(db);
  socialStore._attachBotsStore(botsStore);
  const messagesStore = createMessagesStore(db);
  const runtimeBindingsStore = createRuntimeBindingsStore(db);
  const cloudAgentRunsStore = createCloudAgentRunsStore(db);
  const user = createCloudUser(cloudStore, "alice");
  botsStore.upsertBot(user.id, {
    id: BOT_ID,
    displayName: "Alice Bot",
    bio: "ordinary bot",
    personaText: "You are Alice Bot."
  });
  runtimeBindingsStore.upsertBinding({
    userId: user.id,
    botId: BOT_ID,
    runtimeKind: "cloud-hermes",
    enabled: true,
    config: {}
  });
  const conversation = socialStore.createConversation({
    id: `botc_${user.id}_${BOT_ID}`,
    type: "bot",
    name: "Alice Bot",
    decorations: { botId: BOT_ID, runtimeKind: "cloud-hermes" }
  });
  socialStore.addConversationMember({ conversationId: conversation.id, memberKind: "user", memberRef: user.id });
  socialStore.addConversationMember({ conversationId: conversation.id, memberKind: "bot", memberRef: BOT_ID, ownerId: user.id });
  return {
    dir,
    cloudStore,
    socialStore,
    botsStore,
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
    botsStore: ctx.botsStore,
    runtimeBindingsStore: ctx.runtimeBindingsStore,
    cloudAgentRunsStore: ctx.cloudAgentRunsStore,
    workerManager: {
      async ensureWorker(userId) {
        return { userId, baseUrl: "http://worker", apiKey: "k", gatewayWsUrl: "ws://gateway" };
      }
    },
    hermesImClient: {
      async runChat() {
        return { runId: "hr_test", content: "reply", events: [] };
      }
    },
    broadcastPersistedEvent() {},
    broadcastTransientEvent() {},
    listBridgeDevices() {
      return [
        { id: "device_mac", deviceName: "Mac", status: "online" },
        { id: "device_windows", deviceName: "Windows", status: "online" }
      ];
    },
    ...overrides
  });
}

test("cloud-hermes DM runs the bot and appends a reply", async () => {
  const ctx = setup();
  const hermesCalls = [];
  try {
    ctx.runtimeBindingsStore.upsertBinding({
      userId: ctx.user.id,
      botId: BOT_ID,
      runtimeKind: "cloud-hermes",
      enabled: true,
      config: { model: "hermes-agent" }
    });
    const dispatcher = makeDispatcher(ctx, {
      hermesImClient: {
        async runChat(args) {
          hermesCalls.push(args);
          args.onRunCreated?.("abc123");
          return { runId: "hr_dm", content: "hi", events: [] };
        }
      }
    });
    ctx.messagesStore.appendMessage({
      conversationId: ctx.conversation.id,
      senderKind: "bot",
      senderRef: BOT_ID,
      senderOwnerId: ctx.user.id,
      bodyMd: "earlier reply"
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
    assert.equal(reply.sender_ref, BOT_ID);
    assert.equal(reply.body_md, "hi");
    assert.equal(hermesCalls.length, 1);
    const storedRunId = ctx.cloudStore.getDb()
      .prepare("SELECT hermes_run_id FROM cloud_agent_runs ORDER BY created_at DESC LIMIT 1")
      .get()?.hermes_run_id;
    assert.equal(storedRunId, "gw:abc123");
    assert.equal(hermesCalls[0].gatewayWsUrl, "ws://gateway");
    assert.equal(hermesCalls[0].model, "mia-auto");
    assert.equal(hermesCalls[0].workerModel, "mia-auto");
    assert.equal(hermesCalls[0].modelProvider, "mia");
    assert.deepEqual(hermesCalls[0].seedMessages, [
      { role: "assistant", content: "earlier reply" }
    ]);
    assert.match(hermesCalls[0].input, /用户消息：\nhello/);
    assert.match(hermesCalls[0].input, /正在和用户私聊/);
    assert.doesNotMatch(hermesCalls[0].input, /群聊/);
    assert.doesNotMatch(hermesCalls[0].input, /群成员/);
    assert.match(hermesCalls[0].instructions, /Mia Runtime Context/);
    assert.doesNotMatch(hermesCalls[0].instructions, /schedule_create|cronjob/);
    assert.match(hermesCalls[0].instructions, /You are Alice Bot\./);
  } finally {
    ctx.cleanup();
  }
});

test("cloud-hermes prefixes gateway run ids when only the final result returns a runId", async () => {
  const ctx = setup();
  try {
    ctx.runtimeBindingsStore.upsertBinding({
      userId: ctx.user.id,
      botId: BOT_ID,
      runtimeKind: "cloud-hermes",
      enabled: true,
      config: { model: "hermes-agent" }
    });
    const dispatcher = makeDispatcher(ctx, {
      hermesImClient: {
        async runChat() {
          return { runId: "return_only_42", content: "hi", events: [] };
        }
      }
    });
    const message = ctx.messagesStore.appendMessage({
      conversationId: ctx.conversation.id,
      senderKind: "user",
      senderRef: ctx.user.id,
      bodyMd: "hello"
    });

    await dispatcher.handleUserMessage({
      userId: ctx.user.id,
      conversationId: ctx.conversation.id,
      message
    });

    const storedRunId = ctx.cloudStore.getDb()
      .prepare("SELECT hermes_run_id FROM cloud_agent_runs ORDER BY created_at DESC LIMIT 1")
      .get()?.hermes_run_id;
    assert.equal(storedRunId, "gw:return_only_42");
  } finally {
    ctx.cleanup();
  }
});

test("cloud-hermes without gatewayWsUrl appends the visible config error", async () => {
  const ctx = setup();
  try {
    const dispatcher = makeDispatcher(ctx, {
      workerManager: {
        async ensureWorker(userId) {
          return { userId, baseUrl: "http://worker", apiKey: "k", gatewayWsUrl: "" };
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

    assert.equal(reply.body_md, "云端 Hermes gateway 未启动，请检查 worker 配置。");
    assert.deepEqual(JSON.parse(reply.error_json), {
      type: "cloud_hermes_gateway_unavailable",
      message: "云端 Hermes gateway 未启动，请检查 worker 配置。"
    });
  } finally {
    ctx.cleanup();
  }
});

test("cloud-hermes archives generated worker file paths and hides server paths", async () => {
  const ctx = setup();
  const workerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mia-cloud-worker-files-"));
  const workerPaths = {
    root: workerRoot,
    home: path.join(workerRoot, "home"),
    workspace: path.join(workerRoot, "workspace"),
    attachments: path.join(workerRoot, "attachments"),
    hermesHome: path.join(workerRoot, "hermes-home")
  };
  try {
    fs.mkdirSync(workerPaths.home, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(workerPaths.home, "report.xlsx"), "xlsx bytes", { mode: 0o600 });
    const dispatcher = makeDispatcher(ctx, {
      workerManager: {
        async ensureWorker(userId) {
          return { userId, baseUrl: "http://worker", apiKey: "k", gatewayWsUrl: "ws://gateway", paths: workerPaths };
        }
      },
      attachmentMaterializer: createAttachmentMaterializer({ cloudStore: ctx.cloudStore }),
      hermesImClient: {
        async runChat(args) {
          args.onEvent?.({ type: "text_delta", text: "Excel 文件已生成！路径是：/data/home/report.xlsx" });
          return {
            runId: "hr_file",
            content: "Excel 文件已生成！路径是：/data/home/report.xlsx",
            events: []
          };
        }
      }
    });
    const message = ctx.messagesStore.appendMessage({
      conversationId: ctx.conversation.id,
      senderKind: "user",
      senderRef: ctx.user.id,
      bodyMd: "生成 xlsx"
    });

    const reply = await dispatcher.handleUserMessage({
      userId: ctx.user.id,
      conversationId: ctx.conversation.id,
      message
    });

    const attachments = JSON.parse(reply.attachments_json || "[]");
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].name, "report.xlsx");
    assert.match(attachments[0].url, /^\/api\/files\/file_/);
    assert.equal(reply.body_md, "Excel 文件已生成！路径是：附件「report.xlsx」");
    assert.doesNotMatch(reply.body_md, /\/data\/home/);
    assert.doesNotMatch(reply.content_blocks_json || "", /\/data\/home/);
  } finally {
    ctx.cleanup();
    fs.rmSync(workerRoot, { recursive: true, force: true });
  }
});

test("cloud-hermes archives generated files mentioned only in streamed events", async () => {
  const ctx = setup();
  const workerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mia-cloud-worker-stream-files-"));
  const workerPaths = {
    root: workerRoot,
    home: path.join(workerRoot, "home"),
    workspace: path.join(workerRoot, "workspace"),
    attachments: path.join(workerRoot, "attachments"),
    hermesHome: path.join(workerRoot, "hermes-home")
  };
  const transientEvents = [];
  try {
    fs.mkdirSync(workerPaths.home, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(workerPaths.home, "stream-only.xlsx"), "xlsx bytes", { mode: 0o600 });
    const dispatcher = makeDispatcher(ctx, {
      workerManager: {
        async ensureWorker(userId) {
          return { userId, baseUrl: "http://worker", apiKey: "k", gatewayWsUrl: "ws://gateway", paths: workerPaths };
        }
      },
      attachmentMaterializer: createAttachmentMaterializer({ cloudStore: ctx.cloudStore }),
      hermesImClient: {
        async runChat(args) {
          args.onEvent?.({ type: "text_delta", text: "Excel 文件已生成！路径是：/data/home/stream-only.xlsx" });
          return {
            runId: "hr_stream_file",
            content: "Excel 文件已生成。",
            events: []
          };
        }
      },
      broadcastTransientEvent(userId, event) {
        transientEvents.push({ userId, event });
      }
    });
    const message = ctx.messagesStore.appendMessage({
      conversationId: ctx.conversation.id,
      senderKind: "user",
      senderRef: ctx.user.id,
      bodyMd: "生成 xlsx"
    });

    const reply = await dispatcher.handleUserMessage({
      userId: ctx.user.id,
      conversationId: ctx.conversation.id,
      message
    });

    const attachments = JSON.parse(reply.attachments_json || "[]");
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].name, "stream-only.xlsx");
    assert.match(attachments[0].url, /^\/api\/files\/file_/);
    assert.equal(reply.body_md, "Excel 文件已生成。");
    assert.doesNotMatch(reply.content_blocks_json || "", /\/data\/home/);
    assert.doesNotMatch(JSON.stringify(transientEvents), /\/data\/home/);
  } finally {
    ctx.cleanup();
    fs.rmSync(workerRoot, { recursive: true, force: true });
  }
});

test("cloud-hermes attaches worker files requested directly by the user", async () => {
  const ctx = setup();
  const workerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mia-cloud-worker-request-files-"));
  const workerPaths = {
    root: workerRoot,
    home: path.join(workerRoot, "home"),
    workspace: path.join(workerRoot, "workspace"),
    attachments: path.join(workerRoot, "attachments"),
    hermesHome: path.join(workerRoot, "hermes-home")
  };
  try {
    fs.mkdirSync(workerPaths.home, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(workerPaths.home, "世界杯赛果汇总.xlsx"), "xlsx bytes", { mode: 0o600 });
    const dispatcher = makeDispatcher(ctx, {
      workerManager: {
        async ensureWorker(userId) {
          return { userId, baseUrl: "http://worker", apiKey: "k", gatewayWsUrl: "ws://gateway", paths: workerPaths };
        }
      },
      attachmentMaterializer: createAttachmentMaterializer({ cloudStore: ctx.cloudStore }),
      hermesImClient: {
        async runChat() {
          return {
            runId: "hr_requested_file",
            content: "文件存在。但我没法直接通过聊天把文件发给你。",
            events: []
          };
        }
      }
    });
    const message = ctx.messagesStore.appendMessage({
      conversationId: ctx.conversation.id,
      senderKind: "user",
      senderRef: ctx.user.id,
      bodyMd: "/data/home/世界杯赛果汇总.xlsx 把这个发给我"
    });

    const reply = await dispatcher.handleUserMessage({
      userId: ctx.user.id,
      conversationId: ctx.conversation.id,
      message
    });

    const attachments = JSON.parse(reply.attachments_json || "[]");
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].name, "世界杯赛果汇总.xlsx");
    assert.match(attachments[0].url, /^\/api\/files\/file_/);
    assert.equal(reply.body_md, "已附上文件「世界杯赛果汇总.xlsx」。");
    assert.doesNotMatch(reply.body_md, /没法|接收方式|S3|API/);
    assert.equal(ctx.cloudStore.getFileForUser(ctx.user.id, attachments[0].id)?.name, "世界杯赛果汇总.xlsx");
  } finally {
    ctx.cleanup();
    fs.rmSync(workerRoot, { recursive: true, force: true });
  }
});

test("cloud-hermes DM pins the bot identity over a copied engine persona", async () => {
  const ctx = setup();
  const hermesCalls = [];
  try {
    ctx.botsStore.upsertBot(ctx.user.id, {
      id: "4020623",
      name: "？？",
      bio: "",
      personaText: "你是 Claude Code。专注代码任务、重构、解释和长上下文协作，保持清晰、稳健和可验证。"
    });
    ctx.runtimeBindingsStore.upsertBinding({
      userId: ctx.user.id,
      botId: "4020623",
      runtimeKind: "cloud-hermes",
      enabled: true,
      config: { model: "mia-auto" }
    });
    const conversation = ctx.socialStore.createConversation({
      id: "botc_4020623",
      type: "bot",
      name: "你还不",
      decorations: { botId: "4020623", runtimeKind: "cloud-hermes" }
    });
    ctx.socialStore.addConversationMember({ conversationId: conversation.id, memberKind: "user", memberRef: ctx.user.id });
    ctx.socialStore.addConversationMember({ conversationId: conversation.id, memberKind: "bot", memberRef: "4020623", ownerId: ctx.user.id });
    ctx.messagesStore.appendMessage({
      conversationId: conversation.id,
      senderKind: "bot",
      senderRef: "4020623",
      senderOwnerId: ctx.user.id,
      bodyMd: "我是 Claude Code，一个专注于代码任务的 AI 助手。"
    });
    const dispatcher = makeDispatcher(ctx, {
      hermesImClient: {
        async runChat(args) {
          hermesCalls.push(args);
          return { runId: "hr_identity", content: "我是 ？？。", events: [] };
        }
      }
    });
    const message = ctx.messagesStore.appendMessage({
      conversationId: conversation.id,
      senderKind: "user",
      senderRef: ctx.user.id,
      bodyMd: "你到底是谁"
    });

    await dispatcher.handleUserMessage({
      userId: ctx.user.id,
      conversationId: conversation.id,
      message
    });

    assert.equal(hermesCalls.length, 1);
    assert.match(hermesCalls[0].instructions, /专注代码任务/);
    assert.match(hermesCalls[0].instructions, /你是 ？？/);
    assert.doesNotMatch(hermesCalls[0].instructions, /你是 Claude Code/);
    assert.match(hermesCalls[0].instructions, /不要自称 Claude Code/);
    assert.ok(
      hermesCalls[0].instructions.lastIndexOf("你是 ？？") > hermesCalls[0].instructions.indexOf("专注代码任务"),
      "display-name identity should be the final identity instruction"
    );
  } finally {
    ctx.cleanup();
  }
});

test("cloud-hermes maps old managed aliases to the worker platform model", async () => {
  const ctx = setup();
  const hermesCalls = [];
  try {
    ctx.runtimeBindingsStore.upsertBinding({
      userId: ctx.user.id,
      botId: BOT_ID,
      runtimeKind: "cloud-hermes",
      enabled: true,
      config: { model: "mia-default" }
    });
    const dispatcher = makeDispatcher(ctx, {
      workerManager: {
        async ensureWorker(userId) {
          return { userId, baseUrl: "http://worker", apiKey: "k", gatewayWsUrl: "ws://gateway", model: "mia-auto" };
        }
      },
      hermesImClient: {
        async runChat(args) {
          hermesCalls.push(args);
          return { runId: "hr_alias", content: "ok", events: [] };
        }
      }
    });
    const message = ctx.messagesStore.appendMessage({
      conversationId: ctx.conversation.id,
      senderKind: "user",
      senderRef: ctx.user.id,
      bodyMd: "hello"
    });

    await dispatcher.handleUserMessage({
      userId: ctx.user.id,
      conversationId: ctx.conversation.id,
      message
    });

    assert.equal(hermesCalls.length, 1);
    assert.equal(hermesCalls[0].model, "mia-auto");
  } finally {
    ctx.cleanup();
  }
});

test("cloud-hermes persists ordered content blocks from streamed events", async () => {
  const ctx = setup();
  try {
    const dispatcher = makeDispatcher(ctx, {
      hermesImClient: {
        async runChat(args) {
          args.onEvent({ type: "reasoning_delta", id: "think_1", text: "检查上下文" });
          args.onEvent({ type: "text_delta", id: "text_1", text: "我先看目录。" });
          args.onEvent({ type: "tool_call_started", id: "tool_1", name: "shell", preview: "pwd" });
          args.onEvent({ type: "tool_call_completed", id: "tool_1", name: "shell", duration: 0.75 });
          args.onEvent({ type: "text_delta", id: "text_2", text: "结论是已确认。" });
          return { runId: "hr_blocks", content: "我先看目录。\n\n结论是已确认。", events: [] };
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

    assert.deepEqual(JSON.parse(reply.content_blocks_json), [
      { type: "thinking", id: "think_1", status: "running", duration: null, text: "检查上下文" },
      { type: "text", id: "text_1", text: "我先看目录。" },
      { type: "tool", id: "tool_1", name: "shell", preview: "pwd", status: "completed", duration: 0.75, error: false },
      { type: "text", id: "text_2", text: "结论是已确认。" }
    ]);
  } finally {
    ctx.cleanup();
  }
});

test("cloud-hermes preserves streamed process text when final text is returned separately", async () => {
  const ctx = setup();
  try {
    const dispatcher = makeDispatcher(ctx, {
      hermesImClient: {
        async runChat(args) {
          args.onEvent({ type: "text_delta", id: "text_1", text: "我先检查。" });
          args.onEvent({ type: "tool_call_started", id: "tool_1", name: "shell", preview: "pwd" });
          args.onEvent({ type: "tool_call_completed", id: "tool_1", name: "shell" });
          return { runId: "hr_final_only", content: "最终结论。", events: [] };
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

    assert.deepEqual(JSON.parse(reply.content_blocks_json), [
      { type: "text", id: "text_1", text: "我先检查。" },
      { type: "tool", id: "tool_1", name: "shell", preview: "pwd", status: "completed", duration: null, error: false },
      { type: "text", id: "text_final_2", text: "最终结论。" }
    ]);
  } finally {
    ctx.cleanup();
  }
});

test("cloud-hermes reminder requests run Hermes instead of direct app-side task creation", async () => {
  const ctx = setup();
  const hermesCalls = [];
  const taskCalls = [];
  const broadcasts = [];
  try {
    const dispatcher = makeDispatcher(ctx, {
      createScheduledTask(userId, input) {
        taskCalls.push({ userId, input });
        return { id: "t_cloud_1", ...input, nextFireAt: new Date(input.trigger.at).getTime() };
      },
      broadcastPersistedEvent(userId, event) {
        broadcasts.push({ userId, event });
      },
      hermesImClient: {
        async runChat(args) {
          hermesCalls.push(args);
          return { runId: "hr_scheduler", content: "我会通过 schedule_create 设置这个提醒。", events: [] };
        }
      }
    });
    const message = ctx.messagesStore.appendMessage({
      conversationId: ctx.conversation.id,
      senderKind: "user",
      senderRef: ctx.user.id,
      bodyMd: "1分钟后提醒我睡觉"
    });

    const reply = await dispatcher.handleUserMessage({
      userId: ctx.user.id,
      conversationId: ctx.conversation.id,
      message
    });

    assert.equal(hermesCalls.length, 1);
    assert.equal(taskCalls.length, 0);
    assert.match(hermesCalls[0].input, /1分钟后提醒我睡觉/);
    assert.doesNotMatch(hermesCalls[0].instructions, /schedule_create|cronjob/);
    assert.equal(reply.sender_ref, BOT_ID);
    assert.equal(reply.body_md, "我会通过 schedule_create 设置这个提醒。");
    assert.equal(reply.trace_json, null);
    assert.equal(broadcasts.some((entry) => entry.event.type === "conversation.message_appended" && entry.event.message.id === reply.id), true);
  } finally {
    ctx.cleanup();
  }
});

test("cloud-hermes scheduled fires use the delivery context instead of recreating tasks", async () => {
  const ctx = setup();
  const hermesCalls = [];
  try {
    const dispatcher = makeDispatcher(ctx, {
      hermesImClient: {
        async runChat(args) {
          hermesCalls.push(args);
          return { runId: "hr_task_fire", content: "该吃饭了", events: [] };
        }
      }
    });
    const message = {
      id: "task:t-1:r-1",
      conversation_id: ctx.conversation.id,
      sender_kind: "system",
      sender_ref: "mia.scheduler",
      body_md: "",
      task_prompt: "提醒我吃饭",
      turn_id: "task:t-1:r-1",
      status: "complete"
    };

    await dispatcher.invokeBot({
      userId: ctx.user.id,
      botId: BOT_ID,
      conversationId: ctx.conversation.id,
      message
    });

    assert.equal(hermesCalls.length, 1);
    assert.match(hermesCalls[0].input, /提醒我吃饭/);
    assert.match(hermesCalls[0].instructions, /Mia Runtime Context/);
    assert.doesNotMatch(hermesCalls[0].instructions, /schedule_create/);
    assert.match(hermesCalls[0].instructions, /You are Alice Bot\./);
  } finally {
    ctx.cleanup();
  }
});

test("desktop scheduled fires broadcast an internal task prompt instead of a visible user message", async () => {
  const ctx = setup();
  const broadcasts = [];
  try {
    ctx.runtimeBindingsStore.upsertBinding({
      userId: ctx.user.id,
      botId: BOT_ID,
      runtimeKind: "desktop-local",
      enabled: true,
      activate: true,
      config: { deviceId: "device_mac", agentEngine: "claude-code" }
    });
    const dispatcher = makeDispatcher(ctx, {
      broadcastPersistedEvent(userId, event) {
        broadcasts.push({ userId, event });
      }
    });
    const message = {
      id: "task:t-1:r-1",
      conversation_id: ctx.conversation.id,
      sender_kind: "system",
      sender_ref: "mia.scheduler",
      body_md: "",
      task_prompt: "提醒我吃饭",
      turn_id: "task:t-1:r-1",
      status: "complete"
    };

    const reply = await dispatcher.invokeBot({
      userId: ctx.user.id,
      botId: BOT_ID,
      conversationId: ctx.conversation.id,
      message
    });

    assert.equal(reply, null);
    const invocation = broadcasts.find((entry) => entry.event.type === "conversation.bot_invocation_requested");
    assert.ok(invocation, "expected desktop invocation broadcast");
    assert.equal(invocation.event.triggeringMessage.sender_kind, "system");
    assert.equal(invocation.event.triggeringMessage.sender_ref, "mia.scheduler");
    assert.equal(invocation.event.triggeringMessage.body_md, "");
    assert.equal(invocation.event.triggeringMessage.task_prompt, "提醒我吃饭");
    assert.deepEqual(ctx.messagesStore.listMessagesSince(ctx.conversation.id, 0, 20), []);
  } finally {
    ctx.cleanup();
  }
});

test("cloud-hermes writes scheduler MCP context before each bot run", async () => {
  const ctx = setup();
  const workerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mia-cloud-worker-"));
  const hermesHome = path.join(workerRoot, "hermes-home");
  fs.mkdirSync(hermesHome, { recursive: true });
  try {
    const dispatcher = makeDispatcher(ctx, {
      workerManager: {
        async ensureWorker(userId) {
          return { userId, baseUrl: "http://worker", apiKey: "k", gatewayWsUrl: "ws://gateway", paths: { hermesHome } };
        }
      }
    });
    const message = ctx.messagesStore.appendMessage({
      conversationId: ctx.conversation.id,
      senderKind: "user",
      senderRef: ctx.user.id,
      bodyMd: "2分钟后提醒我吃饭"
    });

    await dispatcher.invokeBot({
      userId: ctx.user.id,
      botId: BOT_ID,
      conversationId: ctx.conversation.id,
      message
    });

    const saved = JSON.parse(fs.readFileSync(path.join(hermesHome, "mia-scheduler-context.json"), "utf8"));
    assert.deepEqual(saved, {
      botId: BOT_ID,
      conversationId: ctx.conversation.id,
      sessionId: `conversation:${ctx.conversation.id}`,
      originMessageId: message.id
    });
  } finally {
    ctx.cleanup();
    fs.rmSync(workerRoot, { recursive: true, force: true });
  }
});

test("cloud-hermes DM injects selected message skill context into the run input", async () => {
  const ctx = setup();
  const hermesCalls = [];
  try {
    const dispatcher = makeDispatcher(ctx, {
      skillsCatalog: [{
        id: "flashcards",
        name: "Anki 记忆卡",
        body: "---\nname: generating-stem-flashcards\n---\n# STEM Flashcard Generation\nUse this for Anki cards."
      }],
      hermesImClient: {
        async runChat(args) {
          hermesCalls.push(args);
          return { runId: "hr_skills", content: "skill reply", events: [] };
        }
      }
    });
    const message = ctx.messagesStore.appendMessage({
      conversationId: ctx.conversation.id,
      senderKind: "user",
      senderRef: ctx.user.id,
      bodyMd: "咋用",
      skills: [{ id: "mia:flashcards", name: "Anki 记忆卡" }]
    });

    await dispatcher.handleUserMessage({
      userId: ctx.user.id,
      conversationId: ctx.conversation.id,
      message
    });

    assert.equal(hermesCalls.length, 1);
    assert.doesNotMatch(hermesCalls[0].input, /Available Mia Skills/);
    assert.match(hermesCalls[0].input, /Loaded Mia Skill Guides/);
    assert.match(hermesCalls[0].input, /=== Skill: Anki 记忆卡 ===/);
    assert.match(hermesCalls[0].input, /STEM Flashcard Generation/);
    assert.match(hermesCalls[0].input, /用户消息：\n咋用/);
  } finally {
    ctx.cleanup();
  }
});

test("cloud-hermes handles LOAD_SKILL requests as an internal skill-loading retry", async () => {
  const ctx = setup();
  const hermesCalls = [];
  const transientEvents = [];
  try {
    ctx.botsStore.upsertBot(ctx.user.id, {
      id: BOT_ID,
      displayName: "Alice Bot",
      personaText: "You are Alice Bot.",
      capabilities: { enabledSkills: ["flashcards"] }
    });
    const dispatcher = makeDispatcher(ctx, {
      skillsCatalog: [{
        id: "flashcards",
        name: "Anki 记忆卡",
        description: "生成记忆卡。",
        body: "---\nname: generating-stem-flashcards\n---\n# STEM Flashcard Generation\nUse this for Anki cards."
      }],
      hermesImClient: {
        async runChat(args) {
          hermesCalls.push(args);
          if (hermesCalls.length === 1) {
            args.onEvent?.({ type: "text_delta", text: "[LOAD_SKILL: flashcards]" });
            return { runId: "hr_skill_probe", content: "[LOAD_SKILL: flashcards]", events: [] };
          }
          args.onEvent?.({ type: "text_delta", text: "skill reply" });
          return { runId: "hr_skill_final", content: "skill reply", events: [] };
        }
      },
      broadcastTransientEvent(userId, event) {
        transientEvents.push({ userId, event });
      }
    });
    const message = ctx.messagesStore.appendMessage({
      conversationId: ctx.conversation.id,
      senderKind: "user",
      senderRef: ctx.user.id,
      bodyMd: "做几张卡片"
    });

    const reply = await dispatcher.handleUserMessage({
      userId: ctx.user.id,
      conversationId: ctx.conversation.id,
      message
    });

    assert.equal(reply.body_md, "skill reply");
    assert.equal(hermesCalls.length, 2);
    assert.match(hermesCalls[0].input, /Available Mia Skills/);
    assert.doesNotMatch(hermesCalls[0].input, /STEM Flashcard Generation/);
    assert.match(hermesCalls[1].input, /Loaded Mia Skill Guides/);
    assert.match(hermesCalls[1].input, /STEM Flashcard Generation/);
    const broadcastText = transientEvents
      .filter((item) => item.event.type === "cloud_agent_run_event")
      .map((item) => item.event.event?.text || "")
      .join("\n");
    assert.doesNotMatch(broadcastText, /LOAD_SKILL/);
    assert.match(broadcastText, /skill reply/);
  } finally {
    ctx.cleanup();
  }
});

test("cloud-hermes DM surfaces run failures as visible bot messages", async () => {
  const ctx = setup();
  const broadcasts = [];
  try {
    const dispatcher = makeDispatcher(ctx, {
      hermesImClient: {
        async runChat() {
          throw new Error("Error code: 402 - {'error': '模型余额不足，请先充值。'}");
        }
      },
      broadcastPersistedEvent(userId, event) {
        broadcasts.push({ userId, event });
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

    assert.equal(reply.sender_ref, BOT_ID);
    assert.match(reply.body_md, /模型调用失败：模型余额不足，请先充值。/);
    const run = ctx.cloudStore.getDb()
      .prepare("SELECT status, error_json FROM cloud_agent_runs ORDER BY created_at DESC LIMIT 1")
      .get();
    assert.equal(run.status, "error");
    assert.match(run.error_json, /402/);
    assert.equal(broadcasts.some((entry) => entry.event.type === "conversation.message_appended" && entry.event.message.id === reply.id), true);
  } finally {
    ctx.cleanup();
  }
});

test("cloud-hermes refuses a contaminated bot binding owned by another user", async () => {
  const ctx = setup();
  const hermesCalls = [];
  try {
    const bob = createCloudUser(ctx.cloudStore, "bob_contaminated");
    const conversation = ctx.socialStore.createConversation({
      id: `botc_${bob.id}_${BOT_ID}`,
      type: "bot",
      name: "Contaminated Bot",
      decorations: { botId: BOT_ID, runtimeKind: "cloud-hermes" }
    });
    ctx.socialStore.addConversationMember({ conversationId: conversation.id, memberKind: "user", memberRef: bob.id });
    ctx.socialStore.addConversationMember({ conversationId: conversation.id, memberKind: "bot", memberRef: BOT_ID, ownerId: bob.id });
    ctx.runtimeBindingsStore.upsertBinding({
      userId: bob.id,
      botId: BOT_ID,
      runtimeKind: "cloud-hermes",
      enabled: true,
      config: { model: "hermes-agent" }
    });
    const dispatcher = makeDispatcher(ctx, {
      hermesImClient: {
        async runChat(args) {
          hermesCalls.push(args);
          return { runId: "hr_contaminated", content: "wrong owner", events: [] };
        }
      }
    });
    const message = ctx.messagesStore.appendMessage({
      conversationId: conversation.id,
      senderKind: "user",
      senderRef: bob.id,
      bodyMd: "hello"
    });

    const reply = await dispatcher.handleUserMessage({
      userId: bob.id,
      conversationId: conversation.id,
      message
    });

    assert.equal(reply, null);
    assert.equal(hermesCalls.length, 0);
    const messages = ctx.messagesStore.listMessagesSince(conversation.id, 0, 20);
    assert.equal(messages.some((row) => row.sender_kind === "bot" && row.sender_owner_id === ctx.user.id), false);
  } finally {
    ctx.cleanup();
  }
});

test("desktop-local DM broadcasts a bot invocation and does not run inline", async () => {
  const ctx = setup();
  const broadcasts = [];
  const hermesCalls = [];
  try {
    ctx.runtimeBindingsStore.upsertBinding({
      userId: ctx.user.id,
      botId: BOT_ID,
      runtimeKind: "cloud-hermes",
      enabled: false,
      config: {}
    });
    ctx.runtimeBindingsStore.upsertBinding({
      userId: ctx.user.id,
      botId: BOT_ID,
      runtimeKind: "desktop-local",
      enabled: true,
      config: { model: "claude-sonnet-4-6", deviceId: "device_mac" }
    });
    const dispatcher = makeDispatcher(ctx, {
      broadcastPersistedEvent(userId, event) {
        broadcasts.push({ userId, event });
      },
      hermesImClient: {
        async runChat(args) {
          hermesCalls.push(args);
          return { runId: "hr_dm", content: "should not run", events: [] };
        }
      }
    });
    const previousUser = ctx.messagesStore.appendMessage({
      conversationId: ctx.conversation.id,
      senderKind: "user",
      senderRef: ctx.user.id,
      bodyMd: "前情：我们在讨论第七日演武"
    });
    const previousBot = ctx.messagesStore.appendMessage({
      conversationId: ctx.conversation.id,
      senderKind: "bot",
      senderRef: BOT_ID,
      senderOwnerId: ctx.user.id,
      bodyMd: "我建议先选 1"
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
    assert.equal(broadcasts[0].event.type, "conversation.bot_invocation_requested");
    assert.equal(broadcasts[0].event.conversationId, ctx.conversation.id);
    assert.equal(broadcasts[0].event.botId, BOT_ID);
    assert.equal(broadcasts[0].event.runtimeKind, "desktop-local");
    assert.equal(broadcasts[0].event.runtimeConfig.model, "claude-sonnet-4-6");
    assert.equal(broadcasts[0].event.targetDeviceId, "device_mac");
    assert.equal(broadcasts[0].event.triggeringMessage.id, message.id);
    assert.deepEqual(
      broadcasts[0].event.recentMessages.map((item) => item.id),
      [previousUser.id, previousBot.id, message.id]
    );
    assert.deepEqual(
      broadcasts[0].event.recentMessages.map((item) => item.body_md),
      ["前情：我们在讨论第七日演武", "我建议先选 1", "hello"]
    );
  } finally {
    ctx.cleanup();
  }
});

test("active desktop-local binding wins over stale cloud-hermes binding", async () => {
  const ctx = setup();
  const broadcasts = [];
  const hermesCalls = [];
  try {
    ctx.runtimeBindingsStore.upsertBinding({
      userId: ctx.user.id,
      botId: BOT_ID,
      runtimeKind: "cloud-hermes",
      enabled: true,
      config: { model: "mia-default" }
    });
    ctx.runtimeBindingsStore.upsertBinding({
      userId: ctx.user.id,
      botId: BOT_ID,
      runtimeKind: "desktop-local",
      activate: true,
      config: { agentEngine: "codex", deviceId: "device_windows" }
    });
    const dispatcher = makeDispatcher(ctx, {
      broadcastPersistedEvent(userId, event) {
        broadcasts.push({ userId, event });
      },
      hermesImClient: {
        async runChat(args) {
          hermesCalls.push(args);
          return { runId: "hr_stale", content: "wrong", events: [] };
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
    assert.equal(broadcasts[0].event.runtimeKind, "desktop-local");
    assert.equal(broadcasts[0].event.targetDeviceId, "device_windows");
  } finally {
    ctx.cleanup();
  }
});

test("desktop-local binding without a target device appends a visible error instead of broadcasting", async () => {
  const ctx = setup();
  const broadcasts = [];
  try {
    ctx.runtimeBindingsStore.upsertBinding({
      userId: ctx.user.id,
      botId: BOT_ID,
      runtimeKind: "cloud-hermes",
      enabled: false,
      config: {}
    });
    ctx.runtimeBindingsStore.upsertBinding({
      userId: ctx.user.id,
      botId: BOT_ID,
      runtimeKind: "desktop-local",
      activate: true,
      config: { agentEngine: "codex" }
    });
    const dispatcher = makeDispatcher(ctx, {
      broadcastPersistedEvent(userId, event) {
        broadcasts.push({ userId, event });
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

    assert.match(reply.body_md, /没有明确的运行设备/);
    assert.equal(reply.sender_ref, BOT_ID);
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].event.type, "conversation.message_appended");
  } finally {
    ctx.cleanup();
  }
});

test("desktop-local binding ignores stale device aliases when validating bridge devices", async () => {
  const ctx = setup();
  const broadcasts = [];
  try {
    ctx.runtimeBindingsStore.upsertBinding({
      userId: ctx.user.id,
      botId: BOT_ID,
      runtimeKind: "cloud-hermes",
      enabled: false,
      config: {}
    });
    ctx.runtimeBindingsStore.upsertBinding({
      userId: ctx.user.id,
      botId: BOT_ID,
      runtimeKind: "desktop-local",
      activate: true,
      config: { agentEngine: "codex", deviceId: "stale_device_alias" }
    });
    const dispatcher = makeDispatcher(ctx, {
      broadcastPersistedEvent(userId, event) {
        broadcasts.push({ userId, event });
      },
      listBridgeDevices() {
        return [
          { id: "device_mac", aliases: ["stale_device_alias"], deviceName: "Mac", status: "online" }
        ];
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

    assert.match(reply.body_md, /运行设备已失效/);
    assert.equal(reply.sender_ref, BOT_ID);
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].event.type, "conversation.message_appended");
  } finally {
    ctx.cleanup();
  }
});

test("desktop-local binding on an offline target appends a visible error instead of broadcasting", async () => {
  const ctx = setup();
  const broadcasts = [];
  try {
    ctx.runtimeBindingsStore.upsertBinding({
      userId: ctx.user.id,
      botId: BOT_ID,
      runtimeKind: "cloud-hermes",
      enabled: false,
      config: {}
    });
    ctx.runtimeBindingsStore.upsertBinding({
      userId: ctx.user.id,
      botId: BOT_ID,
      runtimeKind: "desktop-local",
      activate: true,
      config: { agentEngine: "codex", deviceId: "device_mac" }
    });
    const dispatcher = makeDispatcher(ctx, {
      broadcastPersistedEvent(userId, event) {
        broadcasts.push({ userId, event });
      },
      listBridgeDevices() {
        return [{ id: "device_mac", deviceName: "Mac", status: "offline" }];
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

    assert.match(reply.body_md, /Mac 当前离线/);
    assert.equal(reply.sender_ref, BOT_ID);
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].event.type, "conversation.message_appended");
  } finally {
    ctx.cleanup();
  }
});

test("desktop-local refuses a contaminated bot binding owned by another user", async () => {
  const ctx = setup();
  const broadcasts = [];
  try {
    const bob = createCloudUser(ctx.cloudStore, "bob_desktop_contaminated");
    const conversation = ctx.socialStore.createConversation({
      id: `botc_${bob.id}_${BOT_ID}`,
      type: "bot",
      name: "Contaminated Desktop Bot",
      decorations: { botId: BOT_ID, runtimeKind: "desktop-local" }
    });
    ctx.socialStore.addConversationMember({ conversationId: conversation.id, memberKind: "user", memberRef: bob.id });
    ctx.socialStore.addConversationMember({ conversationId: conversation.id, memberKind: "bot", memberRef: BOT_ID, ownerId: bob.id });
    ctx.runtimeBindingsStore.upsertBinding({
      userId: bob.id,
      botId: BOT_ID,
      runtimeKind: "desktop-local",
      enabled: true,
      config: { model: "claude" }
    });
    const dispatcher = makeDispatcher(ctx, {
      broadcastPersistedEvent(userId, event) {
        broadcasts.push({ userId, event });
      }
    });
    const message = ctx.messagesStore.appendMessage({
      conversationId: conversation.id,
      senderKind: "user",
      senderRef: bob.id,
      bodyMd: "hello"
    });

    const reply = await dispatcher.handleUserMessage({
      userId: bob.id,
      conversationId: conversation.id,
      message
    });

    assert.equal(reply, null);
    assert.equal(
      broadcasts.some((entry) => entry.event.type === "conversation.bot_invocation_requested"),
      false
    );
  } finally {
    ctx.cleanup();
  }
});

test("single-bot group skips the conductor and replies directly", async () => {
  const ctx = setup();
  const hermesCalls = [];
  try {
    const group = ctx.socialStore.createConversation({
      id: "g_single",
      type: "group",
      name: "Single bot group"
    });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "user", memberRef: ctx.user.id });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "bot", memberRef: BOT_ID, ownerId: ctx.user.id });
    ctx.runtimeBindingsStore.upsertBinding({
      userId: ctx.user.id,
      botId: BOT_ID,
      runtimeKind: "cloud-hermes",
      enabled: true,
      config: { model: "hermes-agent" }
    });
    const dispatcher = makeDispatcher(ctx, {
      hermesImClient: {
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
    assert.equal(reply.sender_ref, BOT_ID);
    assert.equal(hermesCalls.length, 1, "no conductor turn for a one-bot group");
    assert.match(hermesCalls[0].input, /群成员/);
  } finally {
    ctx.cleanup();
  }
});

test("multi-bot group routes by name in the body", async () => {
  const ctx = setup();
  const hermesCalls = [];
  try {
    ctx.botsStore.upsertBot(ctx.user.id, { id: "bot_mia", name: "Mia", capabilities: ["chat"] });
    ctx.botsStore.upsertBot(ctx.user.id, { id: "bot_kongling", name: "空铃", capabilities: ["chat"] });
    const group = ctx.socialStore.createConversation({ id: "g_named", type: "group", name: "Group" });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "user", memberRef: ctx.user.id });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "bot", memberRef: "bot_mia", ownerId: ctx.user.id });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "bot", memberRef: "bot_kongling", ownerId: ctx.user.id });
    for (const botId of ["bot_mia", "bot_kongling"]) {
      ctx.runtimeBindingsStore.upsertBinding({
        userId: ctx.user.id,
        botId,
        runtimeKind: "cloud-hermes",
        enabled: true,
        config: { model: "hermes-agent" }
      });
    }
    const dispatcher = makeDispatcher(ctx, {
      hermesImClient: {
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
    assert.equal(reply.sender_ref, "bot_kongling");
    assert.equal(hermesCalls.length, 1, "no conductor turn when the message names a bot");
  } finally {
    ctx.cleanup();
  }
});

test("multi-bot group falls back to the conductor when no name matches", async () => {
  const ctx = setup();
  const hermesCalls = [];
  try {
    ctx.botsStore.upsertBot(ctx.user.id, { id: "bot_mia", name: "Mia", capabilities: ["chat"] });
    ctx.botsStore.upsertBot(ctx.user.id, { id: "bot_kongling", name: "空铃", capabilities: ["chat"] });
    const group = ctx.socialStore.createConversation({ id: "g_conductor", type: "group", name: "Group" });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "user", memberRef: ctx.user.id });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "bot", memberRef: "bot_mia", ownerId: ctx.user.id });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "bot", memberRef: "bot_kongling", ownerId: ctx.user.id });
    for (const botId of ["bot_mia", "bot_kongling"]) {
      ctx.runtimeBindingsStore.upsertBinding({
        userId: ctx.user.id,
        botId,
        runtimeKind: "cloud-hermes",
        enabled: true,
        config: { model: "hermes-agent" }
      });
    }
    const dispatcher = makeDispatcher(ctx, {
      workerManager: {
        async ensureWorker(userId) {
          return { userId, baseUrl: "http://worker", apiKey: "k", gatewayWsUrl: "ws://gateway", model: "mia-pro" };
        }
      },
      hermesImClient: {
        async runChat(args) {
          hermesCalls.push(args);
          if (args.transient) {
            return { runId: "hr_c", content: '{"speak":["bot_kongling"]}', events: [] };
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
    assert.equal(reply.sender_ref, "bot_kongling");
    assert.equal(hermesCalls[0].transient, true);
    assert.equal(hermesCalls[0].gatewayWsUrl, "ws://gateway");
    assert.equal(hermesCalls[1].transient, undefined);
    assert.deepEqual(hermesCalls.map((call) => call.model), ["mia-pro", "mia-pro"]);
  } finally {
    ctx.cleanup();
  }
});

test("conductor garbage falls back to the first bot member", async () => {
  const ctx = setup();
  try {
    ctx.botsStore.upsertBot(ctx.user.id, { id: "bot_mia", name: "Mia", capabilities: ["chat"] });
    ctx.botsStore.upsertBot(ctx.user.id, { id: "bot_kongling", name: "空铃", capabilities: ["chat"] });
    const group = ctx.socialStore.createConversation({ id: "g_garbage", type: "group", name: "Group" });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "user", memberRef: ctx.user.id });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "bot", memberRef: "bot_mia", ownerId: ctx.user.id });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "bot", memberRef: "bot_kongling", ownerId: ctx.user.id });
    for (const botId of ["bot_mia", "bot_kongling"]) {
      ctx.runtimeBindingsStore.upsertBinding({
        userId: ctx.user.id,
        botId,
        runtimeKind: "cloud-hermes",
        enabled: true,
        config: { model: "hermes-agent" }
      });
    }
    const dispatcher = makeDispatcher(ctx, {
      hermesImClient: {
        async runChat(args) {
          if (args.transient) return { runId: "hr_c", content: "not json", events: [] };
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
    assert.ok(reply, "expected a bot to fall back into replying");
    assert.match(reply.sender_ref, /bot_mia|bot_kongling/);
    assert.equal(reply.body_md, "fallback reply");
  } finally {
    ctx.cleanup();
  }
});

test("desktop-only bot gets a bot_invocation_requested broadcast and no inline run", async () => {
  const ctx = setup();
  const broadcasts = [];
  const hermesCalls = [];
  try {
    ctx.botsStore.upsertBot(ctx.user.id, { id: "bot_spec_master", name: "Spec Master", capabilities: ["chat"] });
    const group = ctx.socialStore.createConversation({ id: "g_local", type: "group", name: "Group" });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "user", memberRef: ctx.user.id });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "bot", memberRef: "bot_spec_master", ownerId: ctx.user.id });
    ctx.runtimeBindingsStore.upsertBinding({
      userId: ctx.user.id,
      botId: "bot_spec_master",
      runtimeKind: "desktop-local",
      enabled: true,
      config: { model: "claude", deviceId: "device_mac" }
    });
    const dispatcher = makeDispatcher(ctx, {
      broadcastPersistedEvent(userId, event) {
        broadcasts.push({ userId, event });
      },
      hermesImClient: {
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
    const invocation = broadcasts.find((entry) => entry.event.type === "conversation.bot_invocation_requested");
    assert.ok(invocation, "expected a desktop invocation broadcast");
    assert.equal(invocation.event.botId, "bot_spec_master");
    assert.equal(invocation.userId, ctx.user.id);
    assert.equal(invocation.event.runtimeConfig?.model, "claude");
  } finally {
    ctx.cleanup();
  }
});

test("@mention bypasses the conductor and picks only the mentioned bot", async () => {
  const ctx = setup();
  const hermesCalls = [];
  try {
    ctx.botsStore.upsertBot(ctx.user.id, { id: "bot_mia", name: "Mia", capabilities: ["chat"] });
    ctx.botsStore.upsertBot(ctx.user.id, { id: "bot_kongling", name: "空铃", capabilities: ["chat"] });
    const group = ctx.socialStore.createConversation({ id: "g_mention", type: "group", name: "Group" });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "user", memberRef: ctx.user.id });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "bot", memberRef: "bot_mia", ownerId: ctx.user.id });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "bot", memberRef: "bot_kongling", ownerId: ctx.user.id });
    for (const botId of ["bot_mia", "bot_kongling"]) {
      ctx.runtimeBindingsStore.upsertBinding({
        userId: ctx.user.id,
        botId,
        runtimeKind: "cloud-hermes",
        enabled: true,
        config: { model: "hermes-agent" }
      });
    }
    const dispatcher = makeDispatcher(ctx, {
      hermesImClient: {
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
      mentions: [{ kind: "bot", botId: "bot_kongling" }]
    });
    const reply = await dispatcher.handleUserMessage({
      userId: ctx.user.id,
      conversationId: group.id,
      message
    });
    assert.equal(reply.sender_ref, "bot_kongling");
    assert.deepEqual(hermesCalls.map((call) => (call.transient ? "group-conductor" : "reply")), ["reply"]);
  } finally {
    ctx.cleanup();
  }
});

test("explicit botId on invokeBot runs that bot regardless of routing", async () => {
  const ctx = setup();
  const hermesCalls = [];
  try {
    ctx.botsStore.upsertBot(ctx.user.id, { id: "bot_mia", name: "Mia", capabilities: ["chat"] });
    ctx.botsStore.upsertBot(ctx.user.id, { id: "bot_kongling", name: "空铃", capabilities: ["chat"] });
    const group = ctx.socialStore.createConversation({ id: "g_explicit", type: "group", name: "Group" });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "user", memberRef: ctx.user.id });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "bot", memberRef: "bot_mia", ownerId: ctx.user.id });
    ctx.socialStore.addConversationMember({ conversationId: group.id, memberKind: "bot", memberRef: "bot_kongling", ownerId: ctx.user.id });
    ctx.runtimeBindingsStore.upsertBinding({
      userId: ctx.user.id,
      botId: "bot_kongling",
      runtimeKind: "cloud-hermes",
      enabled: true,
      config: { model: "hermes-agent" }
    });
    const dispatcher = makeDispatcher(ctx, {
      hermesImClient: {
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
    const reply = await dispatcher.invokeBot({
      userId: ctx.user.id,
      conversationId: group.id,
      botId: "bot_kongling",
      message
    });
    assert.equal(reply.sender_ref, "bot_kongling");
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
      botId: BOT_ID,
      conversationId: ctx.conversation.id,
      triggerMessageId: "m1"
    });
    ctx.cloudAgentRunsStore.markRunning(run.id, "gw:hermes_run_9");
    const dispatcher = makeDispatcher(ctx, {
      hermesImClient: {
        async runChat() { return { runId: "hr", content: "", events: [] }; },
        async submitApproval(args) { approvalCalls.push(args); return { resolved: 1 }; }
      }
    });

    const ok = await dispatcher.respondApproval({ userId: ctx.user.id, runId: run.id, decision: "allow_always" });
    assert.equal(ok.ok, true);
    assert.equal(ok.choice, "always");
    assert.equal(approvalCalls.length, 1);
    assert.equal(approvalCalls[0].sessionId, "hermes_run_9");
    assert.equal(approvalCalls[0].choice, "always");
    assert.equal(approvalCalls[0].gatewayWsUrl, "ws://gateway");

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

test("respondApproval refuses non-gateway hermes run ids", async () => {
  const ctx = setup();
  try {
    const run = ctx.cloudAgentRunsStore.createRun({
      userId: ctx.user.id,
      botId: BOT_ID,
      conversationId: ctx.conversation.id,
      triggerMessageId: "m1"
    });
    ctx.cloudAgentRunsStore.markRunning(run.id, "hermes_run_legacy");
    const dispatcher = makeDispatcher(ctx);

    const result = await dispatcher.respondApproval({
      userId: ctx.user.id,
      runId: run.id,
      decision: "allow_once"
    });

    assert.deepEqual(result, {
      ok: false,
      error: "run is not a Hermes gateway session"
    });
  } finally {
    ctx.cleanup();
  }
});
