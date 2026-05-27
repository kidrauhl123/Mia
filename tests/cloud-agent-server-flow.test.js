const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");

const { createMiaCloudServer } = require("../scripts/serve-cloud.js");

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

function closeWs(ws) {
  if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) return;
  try { ws.close(); } catch { /* test cleanup */ }
}

test("POST /api/conversations/:id/messages appends cloud fellow reply through existing conversation messages", async () => {
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
    const account = await jsonFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { username: "alice", password: "123456" }
    });
    const conversationId = `fellow:${account.user.id}:mia`;
    const authHeaders = { authorization: `Bearer ${account.token}` };
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
    assert.deepEqual(listed.messages.map((m) => m.sender_kind), ["user", "fellow"]);
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

test("POST group mention invokes cloud-hermes fellow without desktop-local event fallback", async () => {
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
    const account = await jsonFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { username: "alice", password: "123456" }
    });
    const authHeaders = { authorization: `Bearer ${account.token}` };
    const group = await jsonFetch(baseUrl, "/api/conversations", {
      method: "POST",
      headers: authHeaders,
      body: { name: "Cloud Group", memberFellows: [{ fellowId: "mia" }] }
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
        mentions: [{ kind: "fellow", fellowId: "mia" }],
        clientOpId: "op_cloud_group_1"
      }
    });

    await server.mia.cloudAgentDispatcher.idle();
    const started = await runStarted;
    assert.equal(started.fellowId, "mia");
    const listed = await jsonFetch(baseUrl, `/api/conversations/${conversationId}/messages`, {
      headers: authHeaders
    });
    assert.deepEqual(listed.messages.map((m) => m.sender_kind), ["user", "fellow"]);
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
