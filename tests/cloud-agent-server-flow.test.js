const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");

const { createMiaCloudServer } = require("../scripts/serve-cloud.js");
const { createCloudStore } = require("../src/cloud/sqlite-store.js");
const { createModelGatewayStore } = require("../src/cloud/model-gateway-store.js");
const { loginCloudUser } = require("./helpers/cloud-auth.js");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

async function jsonFetch(baseUrl, requestPath, options = {}) {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function wsTokenProtocol(token) {
  return [`mia-token.${token}`];
}

function eventsWsUrl(baseUrl) {
  return `${baseUrl.replace(/^http:/, "ws:")}/api/events`;
}

function bridgeWsUrl(baseUrl, params = {}) {
  const url = new URL(`${baseUrl.replace(/^http:/, "ws:")}/api/bridge`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function createAccount(server, name) {
  return loginCloudUser(server.mia.cloudStore, name);
}

function waitForMessage(ws, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for websocket message.")), 2000);
    ws.on("message", function onMessage(raw) {
      const message = JSON.parse(String(raw));
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(message);
    });
    ws.on("error", reject);
  });
}

function assertNoMessage(ws, predicate, durationMs = 150) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      resolve();
    }, durationMs);
    function onMessage(raw) {
      const message = JSON.parse(String(raw));
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      reject(new Error(`Unexpected websocket message: ${message.type}`));
    }
    ws.on("message", onMessage);
    ws.on("error", reject);
  });
}

function closeWs(ws) {
  if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) return;
  try { ws.close(); } catch { /* test cleanup */ }
}

async function upsertCloudClaudeCodeBot(baseUrl, authHeaders, botId, displayName = botId, personaText = "") {
  await jsonFetch(baseUrl, `/api/me/bots/${encodeURIComponent(botId)}`, {
    method: "PUT",
    headers: authHeaders,
    body: {
      displayName,
      capabilities: ["chat"],
      personaText: personaText || `You are ${displayName}.`
    }
  });
  await jsonFetch(baseUrl, `/api/me/bots/${encodeURIComponent(botId)}/runtime`, {
    method: "PUT",
    headers: authHeaders,
    body: {
      runtimeKind: "cloud-claude-code",
      enabled: true,
      config: { model: "mia-default" }
    }
  });
}

async function upsertDesktopLocalBot(baseUrl, authHeaders, botId, displayName = botId, runtimeConfig = {}) {
  await jsonFetch(baseUrl, `/api/me/bots/${encodeURIComponent(botId)}`, {
    method: "PUT",
    headers: authHeaders,
    body: {
      displayName,
      capabilities: ["chat"],
      personaText: `You are ${displayName}.`
    }
  });
  await jsonFetch(baseUrl, `/api/me/bots/${encodeURIComponent(botId)}/runtime`, {
    method: "PUT",
    headers: authHeaders,
    body: {
      runtimeKind: "desktop-local",
      enabled: true,
      config: { agentEngine: "codex", ...runtimeConfig }
    }
  });
}

test("authenticated cloud bootstrap seeds the default Mia starter bot immediately", async () => {
  const dataDir = tempDir("mia-cloud-agent-starter-bootstrap-");
  const server = createMiaCloudServer({
    dataDir,
    cloudAgentMode: "claude-code",
    platformModelId: "mia-default",
    cloudAgentWorkerManager: {
      async ensureWorker(userId) {
        return {
          userId,
          baseUrl: "http://worker",
          apiKey: "k",
          gatewayWsUrl: "ws://worker/api/ws",
          paths: { attachments: path.join(dataDir, "agent-users", userId, "attachments") }
        };
      }
    },
    cloudAgentClient: {}
  });
  const baseUrl = await listen(server);
  try {
    const account = createAccount(server, "alice");
    const authHeaders = { authorization: `Bearer ${account.token}` };
    const expectedBotId = `starter_${account.user.id}_mia`;
    const expectedConversationId = `botc_${expectedBotId}`;

    const bots = await jsonFetch(baseUrl, "/api/me/bots", { headers: authHeaders });
    const mia = bots.bots.find((bot) => bot.id === expectedBotId);
    assert.equal(mia.displayName || mia.name, "Mia");
    assert.equal(mia.avatarImage, "./assets/mia-logo.png");
    assert.deepEqual(mia.statusBadge, { kind: "lottie", assetId: "rainbow-fire", label: "七彩火焰", loop: "always" });

    const conversations = await jsonFetch(baseUrl, "/api/conversations?include=members", { headers: authHeaders });
    const conversation = conversations.conversations.find((item) => item.id === expectedConversationId);
    assert.equal(conversation.name, "Mia");
    assert.equal(conversation.decorations.botId, expectedBotId);
    assert.equal(conversation.members.some((member) => member.member_kind === "bot" && member.member_ref === expectedBotId), true);

    const binding = await jsonFetch(baseUrl, `/api/me/bots/${encodeURIComponent(expectedBotId)}/runtime?kind=active`, { headers: authHeaders });
    assert.equal(binding.binding.runtimeKind, "cloud-claude-code");
    assert.equal(binding.binding.config.agentEngine, "claude-code");
    assert.equal(binding.binding.config.model, "mia-default");

    const settings = await jsonFetch(baseUrl, "/api/me/settings", { headers: authHeaders });
    assert.deepEqual(settings.settings.starterEngineBots.engineIds, ["cloud-claude-code"]);
    const cloudTag = settings.settings.tags.items.find((tag) => tag.name === "云端");
    assert.ok(cloudTag);
    assert.deepEqual(settings.settings.tags.assignments[expectedConversationId], [cloudTag.id]);

    const second = await jsonFetch(baseUrl, "/api/conversations", { headers: authHeaders });
    assert.equal(second.conversations.filter((item) => item.id === expectedConversationId).length, 1);
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("bot DM falls back to targeted desktop invocation when cloud dispatcher is not configured", async () => {
  const dataDir = tempDir("mia-cloud-agent-desktop-fallback-");
  const server = createMiaCloudServer({ dataDir });
  const baseUrl = await listen(server);
  let eventsWs = null;
  let bridgeWs = null;
  try {
    const account = createAccount(server, "alice");
    const authHeaders = { authorization: `Bearer ${account.token}` };
    bridgeWs = new WebSocket(bridgeWsUrl(baseUrl, {
      deviceId: "desktop-codex",
      deviceName: "Office Mac",
      engine: "codex"
    }), wsTokenProtocol(account.token));
    const ready = await waitForMessage(bridgeWs, (message) => message.type === "bridge_ready");
    await upsertDesktopLocalBot(baseUrl, authHeaders, "codex", "Codex", { deviceId: ready.deviceId });
    const ensured = await jsonFetch(baseUrl, "/api/me/bot-conversations/codex", {
      method: "PUT",
      headers: authHeaders,
      body: { botId: "codex", title: "Codex", runtimeKind: "desktop-local" }
    });
    const conversationId = ensured.conversation.id;
    eventsWs = new WebSocket(eventsWsUrl(baseUrl), wsTokenProtocol(account.token));
    await waitForMessage(eventsWs, (message) => message.type === "events_ready");

    const invocationPromise = waitForMessage(eventsWs, (message) => (
      message.type === "conversation.bot_invocation_requested"
        && message.conversationId === conversationId
        && message.botId === "codex"
    ));
    await jsonFetch(baseUrl, `/api/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: { bodyMd: "hi desktop", clientOpId: "op_desktop_fallback_1" }
    });
    const invocation = await invocationPromise;
    assert.equal(invocation.runtimeKind, "desktop-local");
    assert.equal(invocation.runtimeConfig.agentEngine, "codex");
    assert.equal(invocation.targetDeviceId, ready.deviceId);
    assert.equal(invocation.triggeringMessage.body_md, "hi desktop");
    assert.equal(invocation.invokedBy.id, account.user.id);
    assert.ok(Array.isArray(invocation.members));
  } finally {
    closeWs(eventsWs);
    closeWs(bridgeWs);
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("POST /api/conversations/:id/messages appends cloud bot reply through existing conversation messages", async () => {
  const dataDir = tempDir("mia-cloud-agent-server-");
  const hermesCalls = [];
  const server = createMiaCloudServer({
    dataDir,
    cloudAgentWorkerManager: {
      async ensureWorker(userId) {
        return {
          userId,
          baseUrl: "http://worker",
          apiKey: "k",
          gatewayWsUrl: "ws://worker/api/ws",
          paths: { attachments: path.join(dataDir, "agent-users", userId, "attachments") }
        };
      }
    },
    cloudAgentClient: {
      async runChat(args) {
        hermesCalls.push(args);
        args.onRunCreated?.("hr_server_1");
        args.onEvent?.({ type: "message.delta", delta: "server " });
        return { runId: "hr_server_1", content: "server cloud reply", events: [] };
      }
    }
  });
  const baseUrl = await listen(server);
  let eventsWs = null;
  try {
    const account = createAccount(server, "alice");
    const authHeaders = { authorization: `Bearer ${account.token}` };
    await upsertCloudClaudeCodeBot(baseUrl, authHeaders, "mia", "Mia");
    const ensured = await jsonFetch(baseUrl, "/api/me/bot-conversations/mia", {
      method: "PUT",
      headers: authHeaders,
      body: { botId: "mia", title: "Mia", runtimeKind: "cloud-claude-code" }
    });
    const conversationId = ensured.conversation.id;
    eventsWs = new WebSocket(eventsWsUrl(baseUrl), wsTokenProtocol(account.token));
    await waitForMessage(eventsWs, (message) => message.type === "events_ready");

    const runStarted = waitForMessage(eventsWs, (message) => message.type === "cloud_agent_run_started" && message.conversationId === conversationId);
    const sent = await jsonFetch(baseUrl, `/api/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: {
        bodyMd: "hi cloud",
        clientOpId: "op_cloud_1",
        attachments: [{
          name: "pixel.png",
          dataUrl: `data:image/png;base64,${Buffer.from("png").toString("base64")}`
        }]
      }
    });
    assert.equal(sent.message.sender_kind, "user");
    const sentAttachments = JSON.parse(sent.message.attachments_json);
    assert.equal(sentAttachments.length, 1);
    assert.match(sentAttachments[0].url, /^\/api\/files\/file_/);
    assert.equal(sentAttachments[0].dataUrl, undefined);

    await server.mia.cloudAgentDispatcher.idle();
    const started = await runStarted;
    assert.equal(started.hermesRunId, "hr_server_1");

    const listed = await jsonFetch(baseUrl, `/api/conversations/${conversationId}/messages`, {
      headers: authHeaders
    });
    assert.deepEqual(listed.messages.map((m) => m.sender_kind), ["user", "bot"]);
    assert.equal(listed.messages[1].sender_ref, "mia");
    assert.equal(listed.messages[1].body_md, "server cloud reply");
    assert.equal(hermesCalls.length, 1);
    assert.match(hermesCalls[0].input, /附件上下文/);
    assert.equal(hermesCalls[0].attachments.length, 1);
    assert.equal(hermesCalls[0].attachments[0].path.startsWith("/data/attachments/"), true);
  } finally {
    closeWs(eventsWs);
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud server workers use the active platform model alias", async () => {
  const dataDir = tempDir("mia-cloud-agent-platform-model-");
  const cloudAgentCalls = [];
  const server = createMiaCloudServer({
    dataDir,
    platformModelId: "mia-auto",
    cloudAgentWorkerManager: {
      defaultModel: "mia-auto",
      async ensureWorker(userId) {
        return {
          userId,
          baseUrl: "http://worker",
          apiKey: "mia-cloud",
          model: "mia-auto",
          workerModel: "mia-auto",
          modelProvider: "mia"
        };
      }
    },
    cloudAgentClient: {
      requiresGateway: false,
      async runChat(args) {
        cloudAgentCalls.push(args);
        return { runId: "hr_platform_model", content: "ok", events: [] };
      }
    }
  });
  const baseUrl = await listen(server);
  try {
    const account = createAccount(server, "platform_model_alice");
    const authHeaders = { authorization: `Bearer ${account.token}` };
    await upsertCloudClaudeCodeBot(baseUrl, authHeaders, "mia", "Mia");
    const runtime = await jsonFetch(baseUrl, "/api/me/bots/mia/runtime?kind=cloud-claude-code", { headers: authHeaders });
    assert.equal(runtime.binding.config.model, "mia-auto");
    const ensured = await jsonFetch(baseUrl, "/api/me/bot-conversations/mia", {
      method: "PUT",
      headers: authHeaders,
      body: { botId: "mia", title: "Mia", runtimeKind: "cloud-claude-code" }
    });

    await jsonFetch(baseUrl, `/api/conversations/${ensured.conversation.id}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: { bodyMd: "hi cloud", clientOpId: "op_platform_model_1" }
    });
    await server.mia.cloudAgentDispatcher.idle();

    assert.equal(cloudAgentCalls.length, 1);
    assert.equal(cloudAgentCalls[0].model, "mia-auto");
    assert.equal(cloudAgentCalls[0].modelProvider, "mia");
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud Claude Code workers use the saved DeepSeek gateway key", async () => {
  const dataDir = tempDir("mia-cloud-agent-db-key-");
  const previousAgentRoot = process.env.MIA_CLOUD_AGENT_ROOT;
  const previousDeepSeekKey = process.env.MIA_DEEPSEEK_API_KEY;
  const previousCloudClaudeKey = process.env.MIA_CLOUD_CLAUDE_CODE_API_KEY;
  process.env.MIA_CLOUD_AGENT_ROOT = path.join(dataDir, "agent-users");
  delete process.env.MIA_DEEPSEEK_API_KEY;
  delete process.env.MIA_CLOUD_CLAUDE_CODE_API_KEY;
  const preStore = createCloudStore({ dataDir });
  try {
    createModelGatewayStore(preStore.getDb()).saveSettings({
      mode: "deepseek",
      provider: "deepseek",
      modelId: "mia-auto",
      upstreamModel: "deepseek-chat",
      apiBase: "https://api.deepseek.com/v1",
      apiKey: "sk-from-db"
    });
  } finally {
    preStore.close();
  }
  const server = createMiaCloudServer({
    dataDir,
    cloudAgentMode: "claude-code"
  });
  await listen(server);
  try {
    const worker = await server.mia.cloudAgentWorkerManager.ensureWorker("db-key-user");
    assert.equal(worker.runtimeKind, "cloud-claude-code");
    assert.equal(worker.hasApiKey, true);
    assert.equal(worker.env.ANTHROPIC_API_KEY, "sk-from-db");
    assert.equal(worker.env.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (previousAgentRoot === undefined) delete process.env.MIA_CLOUD_AGENT_ROOT;
    else process.env.MIA_CLOUD_AGENT_ROOT = previousAgentRoot;
    if (previousDeepSeekKey === undefined) delete process.env.MIA_DEEPSEEK_API_KEY;
    else process.env.MIA_DEEPSEEK_API_KEY = previousDeepSeekKey;
    if (previousCloudClaudeKey === undefined) delete process.env.MIA_CLOUD_CLAUDE_CODE_API_KEY;
    else process.env.MIA_CLOUD_CLAUDE_CODE_API_KEY = previousCloudClaudeKey;
  }
});

test("POST bot reminder message is handed to cloud Claude Code without app-side reminder parsing", async () => {
  const dataDir = tempDir("mia-cloud-agent-reminder-");
  const hermesCalls = [];
  const server = createMiaCloudServer({
    dataDir,
    cloudAgentWorkerManager: {
      async ensureWorker(userId) {
        return { userId, baseUrl: "http://worker", apiKey: "k", gatewayWsUrl: "ws://worker/api/ws" };
      }
    },
    cloudAgentClient: {
      async runChat(args) {
        hermesCalls.push(args);
        return { runId: "hr_scheduler", content: "我会通过 schedule_create 设置这个提醒。", events: [] };
      }
    }
  });
  const baseUrl = await listen(server);
  try {
    const account = createAccount(server, "reminder_alice");
    const authHeaders = { authorization: `Bearer ${account.token}` };
    await upsertCloudClaudeCodeBot(baseUrl, authHeaders, "mia", "Mia");
    const ensured = await jsonFetch(baseUrl, "/api/me/bot-conversations/mia", {
      method: "PUT",
      headers: authHeaders,
      body: { botId: "mia", title: "Mia", runtimeKind: "cloud-claude-code" }
    });
    const conversationId = ensured.conversation.id;

    await jsonFetch(baseUrl, `/api/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: {
        bodyMd: "1分钟后提醒我睡觉",
        clientOpId: "op_cloud_reminder_1"
      }
    });
    await server.mia.cloudAgentDispatcher.idle();

    assert.equal(hermesCalls.length, 1);
    assert.match(hermesCalls[0].input, /1分钟后提醒我睡觉/);
    assert.doesNotMatch(hermesCalls[0].instructions, /schedule_create|cronjob/);
    const tasks = await jsonFetch(baseUrl, "/api/tasks", { headers: authHeaders });
    assert.equal(tasks.tasks.length, 0);
    const listed = await jsonFetch(baseUrl, `/api/conversations/${conversationId}/messages`, {
      headers: authHeaders
    });
    assert.deepEqual(listed.messages.map((m) => m.sender_kind), ["user", "bot"]);
    assert.equal(listed.messages[1].body_md, "我会通过 schedule_create 设置这个提醒。");
    assert.equal(listed.messages[1].trace_json, null);
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("POST group mention invokes cloud-claude-code bot without desktop-local event fallback", async () => {
  const dataDir = tempDir("mia-cloud-agent-group-");
  const hermesCalls = [];
  const server = createMiaCloudServer({
    dataDir,
    cloudAgentWorkerManager: {
      async ensureWorker(userId) {
        return {
          userId,
          baseUrl: "http://worker",
          apiKey: "k",
          gatewayWsUrl: "ws://worker/api/ws",
          paths: { attachments: path.join(dataDir, "agent-users", userId, "attachments") }
        };
      }
    },
    cloudAgentClient: {
      async runChat(args) {
        hermesCalls.push(args);
        args.onRunCreated?.("hr_group_1");
        return { runId: "hr_group_1", content: "group cloud reply", events: [] };
      }
    }
  });
  const baseUrl = await listen(server);
  let eventsWs = null;
  try {
    const account = createAccount(server, "alice");
    const authHeaders = { authorization: `Bearer ${account.token}` };
    await upsertCloudClaudeCodeBot(baseUrl, authHeaders, "mia", "Mia");
    const group = await jsonFetch(baseUrl, "/api/conversations", {
      method: "POST",
      headers: authHeaders,
      body: { name: "Cloud Group", memberBots: [{ botId: "mia", runtimeKind: "cloud-claude-code" }] }
    });
    const conversationId = group.conversation.id;
    eventsWs = new WebSocket(eventsWsUrl(baseUrl), wsTokenProtocol(account.token));
    await waitForMessage(eventsWs, (message) => message.type === "events_ready");
    const runStarted = waitForMessage(eventsWs, (message) => message.type === "cloud_agent_run_started" && message.conversationId === conversationId);

    await jsonFetch(baseUrl, `/api/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: {
        bodyMd: "@mia 看看这个",
        mentions: [{ kind: "bot", botId: "mia" }],
        clientOpId: "op_cloud_group_1"
      }
    });

    await server.mia.cloudAgentDispatcher.idle();
    const started = await runStarted;
    assert.equal(started.botId, "mia");
    const listed = await jsonFetch(baseUrl, `/api/conversations/${conversationId}/messages`, {
      headers: authHeaders
    });
    assert.deepEqual(listed.messages.map((m) => m.sender_kind), ["user", "bot"]);
    assert.equal(listed.messages[1].sender_ref, "mia");
    assert.equal(listed.messages[1].body_md, "group cloud reply");
    assert.equal(hermesCalls.length, 1);
    assert.equal(hermesCalls[0].conversationId, conversationId);
  } finally {
    closeWs(eventsWs);
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("POST group mention does not invoke deleted bots from stale group membership", async () => {
  const dataDir = tempDir("mia-cloud-agent-deleted-bot-");
  const server = createMiaCloudServer({ dataDir });
  const baseUrl = await listen(server);
  let eventsWs = null;
  try {
    const account = createAccount(server, "alice");
    const authHeaders = { authorization: `Bearer ${account.token}` };
    await upsertDesktopLocalBot(baseUrl, authHeaders, "codex", "Codex");
    const group = await jsonFetch(baseUrl, "/api/conversations", {
      method: "POST",
      headers: authHeaders,
      body: { name: "Stale Bot Group", memberBots: [{ botId: "codex", runtimeKind: "desktop-local" }] }
    });
    eventsWs = new WebSocket(eventsWsUrl(baseUrl), wsTokenProtocol(account.token));
    await waitForMessage(eventsWs, (message) => message.type === "events_ready");

    await jsonFetch(baseUrl, "/api/me/bots/codex", {
      method: "DELETE",
      headers: authHeaders
    });

    const noInvocation = assertNoMessage(
      eventsWs,
      (message) => message.type === "conversation.bot_invocation_requested" && message.botId === "codex"
    );

    await jsonFetch(baseUrl, `/api/conversations/${group.conversation.id}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: {
        bodyMd: "@codex should not run",
        mentions: [{ kind: "bot", botId: "codex" }],
        clientOpId: "op_deleted_bot_mention"
      }
    });

    await noInvocation;
  } finally {
    closeWs(eventsWs);
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("POST group message routes named bot only and gives the agent group identity", async () => {
  const dataDir = tempDir("mia-cloud-agent-named-group-");
  const hermesCalls = [];
  const server = createMiaCloudServer({
    dataDir,
    cloudAgentWorkerManager: {
      async ensureWorker(userId) {
        return {
          userId,
          baseUrl: "http://worker",
          apiKey: "k",
          gatewayWsUrl: "ws://worker/api/ws",
          paths: { attachments: path.join(dataDir, "agent-users", userId, "attachments") }
        };
      }
    },
    cloudAgentClient: {
      async runChat(args) {
        hermesCalls.push(args);
        args.onRunCreated?.(`hr_${args.bot.id}`);
        return { runId: `hr_${args.bot.id}`, content: `${args.bot.displayName || args.bot.name} reply`, events: [] };
      }
    }
  });
  const baseUrl = await listen(server);
  try {
    const account = createAccount(server, "alice");
    const authHeaders = { authorization: `Bearer ${account.token}` };
    await upsertCloudClaudeCodeBot(baseUrl, authHeaders, "mia", "Mia");
    await upsertCloudClaudeCodeBot(baseUrl, authHeaders, "kongling", "空铃", "你是空铃，群聊里的 Bot。");
    const group = await jsonFetch(baseUrl, "/api/conversations", {
      method: "POST",
      headers: authHeaders,
      body: {
        name: "Cloud Group",
        memberBots: [
          { botId: "mia", runtimeKind: "cloud-claude-code" },
          { botId: "kongling", runtimeKind: "cloud-claude-code" }
        ]
      }
    });

    await jsonFetch(baseUrl, `/api/conversations/${group.conversation.id}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: {
        bodyMd: "空铃在干啥",
        clientOpId: "op_cloud_named_group_1"
      }
    });
    await server.mia.cloudAgentDispatcher.idle();

    assert.equal(hermesCalls.length, 1);
    assert.equal(hermesCalls[0].bot.id, "kongling");
    assert.match(hermesCalls[0].input, /你是 空铃/);
    assert.match(hermesCalls[0].input, /群成员/);
    assert.match(hermesCalls[0].input, /Mia/);
    assert.match(hermesCalls[0].input, /空铃/);
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("POST cloud Claude Code run cancel routes only through the cloud agent dispatcher", async () => {
  const dataDir = tempDir("mia-cloud-agent-cancel-");
  const interruptCalls = [];
  let releaseRun;
  const server = createMiaCloudServer({
    dataDir,
    cloudAgentWorkerManager: {
      async ensureWorker(userId) {
        return { userId, baseUrl: "http://worker", apiKey: "k", gatewayWsUrl: "ws://worker/api/ws" };
      }
    },
    cloudAgentClient: {
      async runChat(args) {
        args.onRunCreated?.("hr_cancel");
        return new Promise((resolve) => {
          releaseRun = () => resolve({ runId: "hr_cancel", content: "late reply", events: [] });
        });
      },
      async interruptSession(args) {
        interruptCalls.push(args);
        return { status: "interrupted" };
      }
    }
  });
  const baseUrl = await listen(server);
  try {
    const account = createAccount(server, "cancel_alice");
    const authHeaders = { authorization: `Bearer ${account.token}` };
    await upsertCloudClaudeCodeBot(baseUrl, authHeaders, "mia", "Mia");
    const ensured = await jsonFetch(baseUrl, "/api/me/bot-conversations/mia", {
      method: "PUT",
      headers: authHeaders,
      body: { botId: "mia", title: "Mia", runtimeKind: "cloud-claude-code" }
    });

    await jsonFetch(baseUrl, `/api/conversations/${ensured.conversation.id}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: { bodyMd: "please stop", clientOpId: "op_cancel_1" }
    });
    for (let i = 0; i < 20 && !releaseRun; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const row = server.mia.cloudStore.getDb()
      .prepare("SELECT id, status, hermes_run_id FROM cloud_agent_runs ORDER BY created_at DESC LIMIT 1")
      .get();
    assert.equal(row.hermes_run_id, "gw:hr_cancel");

    const cancelled = await jsonFetch(baseUrl, `/api/conversations/${ensured.conversation.id}/runs/${row.id}/cancel`, {
      method: "POST",
      headers: authHeaders
    });

    assert.equal(cancelled.ok, true);
    assert.equal(interruptCalls.length, 1);
    assert.equal(interruptCalls[0].sessionId, "hr_cancel");
    assert.equal(server.mia.cloudAgentRunsStore.getRun(row.id).status, "cancelled");

    releaseRun();
    await server.mia.cloudAgentDispatcher.idle();
    const messages = await jsonFetch(baseUrl, `/api/conversations/${ensured.conversation.id}/messages`, { headers: authHeaders });
    assert.equal(messages.messages.filter((message) => message.sender_kind === "bot").length, 0);
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("POST group short message reaches the single-bot handler through the HTTP entrypoint", async () => {
  const dataDir = tempDir("mia-cloud-agent-ack-group-");
  const hermesCalls = [];
  const server = createMiaCloudServer({
    dataDir,
    cloudAgentWorkerManager: {
      async ensureWorker(userId) {
        return {
          userId,
          baseUrl: "http://worker",
          apiKey: "k",
          gatewayWsUrl: "ws://worker/api/ws",
          paths: { attachments: path.join(dataDir, "agent-users", userId, "attachments") }
        };
      }
    },
    cloudAgentClient: {
      async runChat(args) {
        hermesCalls.push(args);
        return { runId: "hr_ok", content: "good", events: [] };
      }
    }
  });
  const baseUrl = await listen(server);
  try {
    const account = createAccount(server, "alice");
    const authHeaders = { authorization: `Bearer ${account.token}` };
    await upsertCloudClaudeCodeBot(baseUrl, authHeaders, "mia", "Mia");
    const group = await jsonFetch(baseUrl, "/api/conversations", {
      method: "POST",
      headers: authHeaders,
      body: { name: "Cloud Group", memberBots: [{ botId: "mia", runtimeKind: "cloud-claude-code" }] }
    });

    await jsonFetch(baseUrl, `/api/conversations/${group.conversation.id}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: {
        bodyMd: "ok",
        clientOpId: "op_cloud_ack_group_1"
      }
    });
    await server.mia.cloudAgentDispatcher.idle();

    assert.equal(hermesCalls.length, 1);
    assert.equal(hermesCalls[0].bot.id, "mia");
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
