// Phase 1.D — verify clientOpId makes write endpoints idempotent.
// Same id → same response, no duplicate side-effects.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { seedCloudAccountInDataDir } = require("./helpers/cloud-auth.js");

const dataDirsByPort = new Map();

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
    server.on("error", reject);
  });
}

async function startServer() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-opid-"));
  const port = await freePort();
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["scripts/serve-cloud.js"], {
      env: {
        ...process.env,
        MIA_CLOUD_HOST: "127.0.0.1",
        MIA_CLOUD_PORT: String(port),
        MIA_CLOUD_DATA: tmpDir
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let resolved = false;
    const done = () => {
      if (!resolved) {
        resolved = true;
        dataDirsByPort.set(port, tmpDir);
        resolve({ proc, port, tmpDir });
      }
    };
    proc.stdout.on("data", (c) => { if (/listening|Listening/.test(c.toString())) done(); });
    proc.stderr.on("data", (c) => { if (/listening|Listening|mia-cloud/i.test(c.toString())) done(); });
    proc.on("error", reject);
    setTimeout(done, 5000);
  });
}

async function stopServer(ctx) {
  if (ctx.proc.exitCode === null && ctx.proc.signalCode === null) {
    ctx.proc.kill("SIGTERM");
    await new Promise((r) => ctx.proc.once("exit", r));
  }
  dataDirsByPort.delete(ctx.port);
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
}

function api(port, method, pathStr, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: "127.0.0.1", port, path: pathStr, method,
      headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }
    }, (res) => {
      let chunks = "";
      res.on("data", (c) => { chunks += c; });
      res.on("end", () => {
        let parsed = null; try { parsed = JSON.parse(chunks); } catch { parsed = chunks; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function register(port, account) {
  const dataDir = dataDirsByPort.get(port);
  if (!dataDir) throw new Error("missing test cloud data dir for port " + port);
  return seedCloudAccountInDataDir(dataDir, account);
}

test("POST /api/conversations is idempotent on clientOpId", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "iota");
    await api(ctx.port, "PUT", "/api/me/bots/f1", { token: A.token, body: { name: "F1" } });
    const body = { name: "test-group", memberBots: [{ botId: "f1" }], memberFriendUserIds: [], clientOpId: "op_test_123" };
    const r1 = await api(ctx.port, "POST", "/api/conversations", { token: A.token, body });
    const r2 = await api(ctx.port, "POST", "/api/conversations", { token: A.token, body });
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201, "replay status code mirrors first call");
    assert.equal(r1.body.conversation.id, r2.body.conversation.id, "both calls return the same conversation id");

    // Belt and suspenders: server-side count of conversations for this user is 1
    const list = await api(ctx.port, "GET", "/api/conversations", { token: A.token });
    const groupConversations = list.body.conversations.filter((conversation) => conversation.type === "group");
    assert.equal(groupConversations.length, 1, "only ONE group conversation created across two POSTs with same clientOpId");
  } finally { await stopServer(ctx); }
});

test("POST /api/conversations/:id/messages is idempotent on clientOpId", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "kappa");
    const B = await register(ctx.port, "lambda");
    const fr = await api(ctx.port, "POST", "/api/social/friend-requests", { token: A.token, body: { toUsername: B.user.username, clientOpId: "op_fr_1" } });
    await api(ctx.port, "POST", `/api/social/friend-requests/${fr.body.request.id}/respond`, { token: B.token, body: { action: "accept", clientOpId: "op_resp_1" } });
    const dm = `dm:${[A.user.id, B.user.id].sort().join(":")}`;
    const msg = { bodyMd: "hello-once", clientOpId: "op_msg_42" };
    const r1 = await api(ctx.port, "POST", `/api/conversations/${dm}/messages`, { token: A.token, body: msg });
    const r2 = await api(ctx.port, "POST", `/api/conversations/${dm}/messages`, { token: A.token, body: msg });
    assert.equal(r1.body.message.id, r2.body.message.id, "both POSTs return the same message id");

    const listed = await api(ctx.port, "GET", `/api/conversations/${dm}/messages`, { token: A.token });
    const helloMessages = (listed.body.messages || []).filter((m) => m.body_md === "hello-once");
    assert.equal(helloMessages.length, 1, "only ONE row persisted across two identical POSTs");
  } finally { await stopServer(ctx); }
});

test("POST /api/conversations/:id/messages/as-bot is idempotent on clientOpId", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "kappa-bot");
    await api(ctx.port, "PUT", "/api/me/bots/f1", {
      token: A.token,
      body: { name: "F1" }
    });
    const conversation = await api(ctx.port, "POST", "/api/conversations", {
      token: A.token,
      body: {
        name: "bot-idempotency",
        memberBots: [{ botId: "f1" }],
        memberFriendUserIds: [],
        clientOpId: "op_conversation_for_bot_msg"
      }
    });
    const conversationId = conversation.body.conversation.id;
    const msg = { botId: "f1", bodyMd: "assistant-once", clientOpId: "op_bot_msg_42" };
    const r1 = await api(ctx.port, "POST", `/api/conversations/${conversationId}/messages/as-bot`, { token: A.token, body: msg });
    const r2 = await api(ctx.port, "POST", `/api/conversations/${conversationId}/messages/as-bot`, { token: A.token, body: msg });
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201);
    assert.equal(r1.body.message.id, r2.body.message.id, "both POSTs return the same bot message id");

    const listed = await api(ctx.port, "GET", `/api/conversations/${conversationId}/messages`, { token: A.token });
    const assistantMessages = (listed.body.messages || []).filter((m) => m.body_md === "assistant-once");
    assert.equal(assistantMessages.length, 1, "only ONE bot row persisted across two identical POSTs");
  } finally { await stopServer(ctx); }
});

test("POST /api/social/friend-requests is idempotent on clientOpId", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "mu");
    const B = await register(ctx.port, "nu");
    const body = { toUsername: B.user.username, clientOpId: "op_fr_aaa" };
    const r1 = await api(ctx.port, "POST", "/api/social/friend-requests", { token: A.token, body });
    const r2 = await api(ctx.port, "POST", "/api/social/friend-requests", { token: A.token, body });
    assert.equal(r1.body.request.id, r2.body.request.id, "same request id across retries");

    const incoming = await api(ctx.port, "GET", "/api/social/friend-requests?direction=incoming", { token: B.token });
    assert.equal((incoming.body.requests || []).length, 1, "only ONE pending request created");
  } finally { await stopServer(ctx); }
});

test("Different clientOpIds → different writes (sanity check on cache scoping)", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "xi");
    await api(ctx.port, "PUT", "/api/me/bots/f1", { token: A.token, body: { name: "F1" } });
    const r1 = await api(ctx.port, "POST", "/api/conversations", { token: A.token, body: { name: "a", memberBots: [{ botId: "f1" }], memberFriendUserIds: [], clientOpId: "op_A" } });
    const r2 = await api(ctx.port, "POST", "/api/conversations", { token: A.token, body: { name: "b", memberBots: [{ botId: "f1" }], memberFriendUserIds: [], clientOpId: "op_B" } });
    assert.notEqual(r1.body.conversation.id, r2.body.conversation.id);
    const list = await api(ctx.port, "GET", "/api/conversations", { token: A.token });
    const groupConversations = list.body.conversations.filter((conversation) => conversation.type === "group");
    assert.equal(groupConversations.length, 2);
  } finally { await stopServer(ctx); }
});
