const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createMiaCloudServer } = require("../scripts/serve-cloud.js");
const { createUserModelProxyToken } = require("../src/cloud/model-proxy-auth.js");
const { loginCloudUser } = require("./helpers/cloud-auth.js");

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mia-cloud-tasks-"));
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
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function setupTaskOwner(server, account) {
  const { socialStore, botsStore, runtimeBindingsStore } = server.mia;
  const user = account.user;
  botsStore.upsertBot(user.id, {
    id: "bot_tasker",
    displayName: "Tasker",
    personaText: "You handle scheduled tasks."
  });
  runtimeBindingsStore.upsertBinding({
    userId: user.id,
    botId: "bot_tasker",
    runtimeKind: "cloud-claude-code",
    activate: true,
    config: { model: "mia-default" }
  });
  const conversation = socialStore.createConversation({
    id: `botc_${user.id}_bot_tasker`,
    type: "bot",
    name: "Tasker",
    decorations: { botId: "bot_tasker" }
  });
  socialStore.addConversationMember({ conversationId: conversation.id, memberKind: "user", memberRef: user.id });
  socialStore.addConversationMember({ conversationId: conversation.id, memberKind: "bot", memberRef: "bot_tasker", ownerId: user.id });
  return { user, conversation };
}

test("cloud tasks API creates account-scoped tasks and records run history", async () => {
  const dataDir = tempDataDir();
  const hermesCalls = [];
  const server = createMiaCloudServer({
    dataDir,
    cloudAgentWorkerManager: {
      async ensureWorker(userId) {
        return { userId, baseUrl: "http://worker", apiKey: "worker-key", gatewayWsUrl: "ws://worker/api/ws" };
      }
    },
    cloudAgentClient: {
      async runChat(args) {
        hermesCalls.push(args);
        return { runId: "hr_task", content: "任务完成", events: [] };
      }
    }
  });
  const baseUrl = await listen(server);
  try {
    const account = loginCloudUser(server.mia.cloudStore, "task_user");
    const { conversation } = setupTaskOwner(server, account);

    const created = await jsonFetch(baseUrl, "/api/tasks", account.token, {
      method: "POST",
      body: {
        title: "每日检查",
        botId: "bot_tasker",
        conversationId: conversation.id,
        prompt: "检查状态",
        trigger: { type: "cron", cron: "0 9 * * *" },
        timezone: "UTC"
      }
    });
    assert.match(created.task.id, /^t-/);
    assert.equal(created.task.runtimeKind, "cloud-claude-code");
    assert.equal(created.task.runs.length, 0);

    const listed = await jsonFetch(baseUrl, "/api/tasks", account.token);
    assert.deepEqual(listed.tasks.map((task) => task.id), [created.task.id]);

    const run = await jsonFetch(baseUrl, `/api/tasks/${created.task.id}/run-now`, account.token, {
      method: "POST",
      body: {}
    });
    assert.match(run.runId, /^r-/);
    assert.equal(hermesCalls.length, 1);
    assert.equal(hermesCalls[0].bot.id, "bot_tasker");

    const after = await jsonFetch(baseUrl, `/api/tasks/${created.task.id}`, account.token);
    assert.equal(after.task.runs.length, 1);
    assert.equal(after.task.runs[0].status, "ok");
    assert.equal(after.task.runs[0].outputText, "任务完成");
    const messageBodies = server.mia.messagesStore
      .listMessagesSince(conversation.id, 0, 20)
      .map((message) => message.body_md);
    assert.deepEqual(messageBodies, ["任务完成"]);

    const kinds = server.mia.eventLog
      .listEventsSince(account.user.id, 0, 20)
      .map((event) => event.kind);
    assert.ok(kinds.includes("task.created"));
    assert.ok(kinds.includes("task.finished"));
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("internal cloud task API accepts worker-scoped user tokens", async () => {
  const dataDir = tempDataDir();
  const server = createMiaCloudServer({
    dataDir,
    internalModelProxyKey: "internal-task-secret",
    cloudAgentWorkerManager: {
      async ensureWorker(userId) {
        return { userId, baseUrl: "http://worker", apiKey: "worker-key", gatewayWsUrl: "ws://worker/api/ws" };
      }
    },
    cloudAgentClient: {
      async runChat() {
        return { runId: "hr_internal", content: "ok", events: [] };
      }
    }
  });
  const baseUrl = await listen(server);
  try {
    const account = loginCloudUser(server.mia.cloudStore, "internal_task_user");
    const { conversation } = setupTaskOwner(server, account);
    const token = createUserModelProxyToken("internal-task-secret", account.user.id);

    const created = await jsonFetch(baseUrl, "/api/internal/tasks", token, {
      method: "POST",
      body: {
        title: "吃饭提醒",
        botId: "bot_tasker",
        conversationId: conversation.id,
        prompt: "提醒我吃饭。",
        trigger: { type: "oneshot", at: new Date(Date.now() + 60_000).toISOString() },
        timezone: "Asia/Shanghai"
      }
    });

    assert.match(created.task.id, /^t-/);
    assert.equal(created.task.conversationId, conversation.id);
    const listed = await jsonFetch(baseUrl, "/api/internal/tasks", token);
    assert.deepEqual(listed.tasks.map((task) => task.id), [created.task.id]);
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud task scheduler fires persisted due tasks and advances cron cursor", async () => {
  const dataDir = tempDataDir();
  const server = createMiaCloudServer({
    dataDir,
    cloudAgentWorkerManager: {
      async ensureWorker(userId) {
        return { userId, baseUrl: "http://worker", apiKey: "worker-key", gatewayWsUrl: "ws://worker/api/ws" };
      }
    },
    cloudAgentClient: {
      async runChat() {
        return { runId: "hr_due", content: "到点执行", events: [] };
      }
    }
  });
  const baseUrl = await listen(server);
  try {
    const account = loginCloudUser(server.mia.cloudStore, "task_due_user");
    const { conversation } = setupTaskOwner(server, account);
    const created = await jsonFetch(baseUrl, "/api/tasks", account.token, {
      method: "POST",
      body: {
        title: "每分钟检查",
        botId: "bot_tasker",
        conversationId: conversation.id,
        prompt: "自动检查",
        trigger: { type: "cron", cron: "* * * * *" },
        timezone: "UTC"
      }
    });
    server.mia.cloudStore.getDb()
      .prepare("UPDATE scheduled_tasks SET next_fire_at = ? WHERE id = ?")
      .run(Date.now() - 1000, created.task.id);

    await server.mia.cloudTasksService.fireDue();

    const after = await jsonFetch(baseUrl, `/api/tasks/${created.task.id}`, account.token);
    assert.equal(after.task.runs.length, 1);
    assert.equal(after.task.runs[0].status, "ok");
    assert.equal(after.task.runs[0].outputText, "到点执行");
    assert.ok(after.task.nextFireAt > Date.now(), `expected future nextFireAt, got ${after.task.nextFireAt}`);
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud task fire does not append a visible user trigger message", async () => {
  const dataDir = tempDataDir();
  const hermesCalls = [];
  const server = createMiaCloudServer({
    dataDir,
    cloudAgentWorkerManager: {
      async ensureWorker(userId) {
        return { userId, baseUrl: "http://worker", apiKey: "worker-key", gatewayWsUrl: "ws://worker/api/ws" };
      }
    },
    cloudAgentClient: {
      async runChat(args) {
        hermesCalls.push(args);
        return { runId: "hr_reminder", content: "该睡觉了", events: [] };
      }
    }
  });
  const baseUrl = await listen(server);
  try {
    const account = loginCloudUser(server.mia.cloudStore, "task_visible_user");
    const { conversation } = setupTaskOwner(server, account);
    const created = await jsonFetch(baseUrl, "/api/tasks", account.token, {
      method: "POST",
      body: {
        title: "提醒：睡觉",
        botId: "bot_tasker",
        conversationId: conversation.id,
        prompt: "请在 Mia 会话里提醒用户：睡觉",
        trigger: { type: "oneshot", at: new Date(Date.now() + 60_000).toISOString() },
        timezone: "Asia/Shanghai"
      }
    });

    await jsonFetch(baseUrl, `/api/tasks/${created.task.id}/run-now`, account.token, {
      method: "POST",
      body: {}
    });

    assert.equal(hermesCalls.length, 1);
    assert.match(hermesCalls[0].input, /请在 Mia 会话里提醒用户：睡觉/);
    const messageBodies = server.mia.messagesStore
      .listMessagesSince(conversation.id, 0, 20)
      .map((message) => message.body_md);
    assert.deepEqual(messageBodies, ["该睡觉了"]);
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("direct delivery tasks append a bot message without running Hermes", async () => {
  const dataDir = tempDataDir();
  const hermesCalls = [];
  const server = createMiaCloudServer({
    dataDir,
    cloudAgentWorkerManager: {
      async ensureWorker(userId) {
        return { userId, baseUrl: "http://worker", apiKey: "worker-key", gatewayWsUrl: "ws://worker/api/ws" };
      }
    },
    cloudAgentClient: {
      async runChat(args) {
        hermesCalls.push(args);
        return { runId: "hr_should_not_run", content: "wrong", events: [] };
      }
    }
  });
  const baseUrl = await listen(server);
  try {
    const account = loginCloudUser(server.mia.cloudStore, "task_direct_user");
    const { conversation } = setupTaskOwner(server, account);
    const created = await jsonFetch(baseUrl, "/api/tasks", account.token, {
      method: "POST",
      body: {
        title: "发布新版本提醒",
        botId: "bot_tasker",
        conversationId: conversation.id,
        fireMode: "deliver",
        deliveryText: "该发布新版本了",
        prompt: "提醒我发布新版本",
        trigger: { type: "oneshot", at: new Date(Date.now() + 60_000).toISOString() },
        timezone: "Asia/Shanghai"
      }
    });

    const run = await jsonFetch(baseUrl, `/api/tasks/${created.task.id}/run-now`, account.token, {
      method: "POST",
      body: {}
    });

    assert.match(run.runId, /^r-/);
    assert.equal(hermesCalls.length, 0);
    const messages = server.mia.messagesStore.listMessagesSince(conversation.id, 0, 20);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].sender_kind, "bot");
    assert.equal(messages[0].sender_ref, "bot_tasker");
    assert.equal(messages[0].body_md, "该发布新版本了");
    const after = await jsonFetch(baseUrl, `/api/tasks/${created.task.id}`, account.token);
    assert.equal(after.task.runs.length, 1);
    assert.equal(after.task.runs[0].status, "ok");
    assert.equal(after.task.runs[0].outputMessageId, messages[0].id);
    assert.equal(after.task.runs[0].outputText, "该发布新版本了");
    const events = server.mia.eventLog.listEventsSince(account.user.id, 0, 20);
    assert.equal(
      events.some((event) => event.kind === "conversation.message_appended" && event.payload?.message?.id === messages[0].id),
      true
    );
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
