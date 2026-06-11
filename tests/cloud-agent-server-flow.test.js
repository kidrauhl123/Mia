const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");

const { createMiaCloudServer } = require("../scripts/serve-cloud.js");
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

async function upsertCloudHermesBot(baseUrl, authHeaders, botId, displayName = botId, personaText = "") {
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
      runtimeKind: "cloud-hermes",
      enabled: true,
      config: { model: "mia-default" }
    }
  });
}

async function upsertDesktopLocalBot(baseUrl, authHeaders, botId, displayName = botId) {
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
      config: { agentEngine: "codex" }
    }
  });
}

test("bot DM falls back to desktop invocation when cloud dispatcher is not configured", async () => {
  const dataDir = tempDir("mia-cloud-agent-desktop-fallback-");
  const server = createMiaCloudServer({ dataDir });
  const baseUrl = await listen(server);
  let eventsWs = null;
  try {
    const account = createAccount(server, "alice");
    const authHeaders = { authorization: `Bearer ${account.token}` };
    await upsertDesktopLocalBot(baseUrl, authHeaders, "codex", "Codex");
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
    assert.equal(invocation.triggeringMessage.body_md, "hi desktop");
    assert.equal(invocation.invokedBy.id, account.user.id);
    assert.ok(Array.isArray(invocation.members));
  } finally {
    closeWs(eventsWs);
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
          paths: { attachments: path.join(dataDir, "agent-users", userId, "attachments") }
        };
      }
    },
    cloudAgentHermesClient: {
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
    await upsertCloudHermesBot(baseUrl, authHeaders, "mia", "Mia");
    const ensured = await jsonFetch(baseUrl, "/api/me/bot-conversations/mia", {
      method: "PUT",
      headers: authHeaders,
      body: { botId: "mia", title: "Mia", runtimeKind: "cloud-hermes" }
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

test("POST group mention invokes cloud-hermes bot without desktop-local event fallback", async () => {
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
          paths: { attachments: path.join(dataDir, "agent-users", userId, "attachments") }
        };
      }
    },
    cloudAgentHermesClient: {
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
    await upsertCloudHermesBot(baseUrl, authHeaders, "mia", "Mia");
    const group = await jsonFetch(baseUrl, "/api/conversations", {
      method: "POST",
      headers: authHeaders,
      body: { name: "Cloud Group", memberBots: [{ botId: "mia", runtimeKind: "cloud-hermes" }] }
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
          paths: { attachments: path.join(dataDir, "agent-users", userId, "attachments") }
        };
      }
    },
    cloudAgentHermesClient: {
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
    await upsertCloudHermesBot(baseUrl, authHeaders, "mia", "Mia");
    await upsertCloudHermesBot(baseUrl, authHeaders, "kongling", "空铃", "你是空铃，群聊里的 Bot。");
    const group = await jsonFetch(baseUrl, "/api/conversations", {
      method: "POST",
      headers: authHeaders,
      body: {
        name: "Cloud Group",
        memberBots: [
          { botId: "mia", runtimeKind: "cloud-hermes" },
          { botId: "kongling", runtimeKind: "cloud-hermes" }
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
          paths: { attachments: path.join(dataDir, "agent-users", userId, "attachments") }
        };
      }
    },
    cloudAgentHermesClient: {
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
    await upsertCloudHermesBot(baseUrl, authHeaders, "mia", "Mia");
    const group = await jsonFetch(baseUrl, "/api/conversations", {
      method: "POST",
      headers: authHeaders,
      body: { name: "Cloud Group", memberBots: [{ botId: "mia", runtimeKind: "cloud-hermes" }] }
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
