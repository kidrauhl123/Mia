// Phase 4 — bot private chats live in conversations+messages now.
// Verify the unified conversation model end-to-end.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { freePort } = require("./helpers/free-port");
const { seedCloudAccountInDataDir } = require("./helpers/cloud-auth.js");

const dataDirsByPort = new Map();

async function startServer() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-bot-conversation-"));
  const port = await freePort();
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["scripts/serve-cloud.js"], {
      env: { ...process.env, MIA_CLOUD_HOST: "127.0.0.1", MIA_CLOUD_PORT: String(port), MIA_CLOUD_DATA: tmpDir, MIA_CLOUD_ALLOW_QUERY_TOKEN: "1" },
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

async function saveBot(port, token, botId, name = botId) {
  const r = await api(port, "PUT", `/api/me/bots/${encodeURIComponent(botId)}`, {
    token,
    body: { name }
  });
  assert.equal(r.status, 200);
  return r.body.bot;
}

test("PUT /api/me/bot-conversations/:sessionId rejects never-created bots", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "missing-bot-chat");
    const r = await api(ctx.port, "PUT", "/api/me/bot-conversations/missing", {
      token: A.token,
      body: { botId: "missing", title: "Missing Bot", runtimeKind: "desktop-local" }
    });
    assert.equal(r.status, 404);
    assert.match(String(r.body?.error || ""), /bot not found/);
  } finally { await stopServer(ctx); }
});

test("deleted bots cannot keep posting through stale bot conversation membership", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "deleted-bot-chat");
    await saveBot(ctx.port, A.token, "codex", "Codex");
    const ensureBody = { botId: "codex", title: "Codex", runtimeKind: "desktop-local", clientOpId: "op_codex_session" };
    const ensured = await api(ctx.port, "PUT", "/api/me/bot-conversations/codex-session", {
      token: A.token,
      body: ensureBody
    });
    assert.equal(ensured.status, 200);

    const deleted = await api(ctx.port, "DELETE", "/api/me/bots/codex", { token: A.token });
    assert.equal(deleted.status, 200);

    const stalePost = await api(ctx.port, "POST", `/api/conversations/${ensured.body.conversation.id}/messages/as-bot`, {
      token: A.token,
      body: { botId: "codex", bodyMd: "stale bot reply" }
    });
    assert.equal(stalePost.status, 404);
    assert.match(String(stalePost.body?.error || ""), /bot not found/);

    const staleEnsure = await api(ctx.port, "PUT", "/api/me/bot-conversations/codex-session", {
      token: A.token,
      body: ensureBody
    });
    assert.equal(staleEnsure.status, 404);
  } finally { await stopServer(ctx); }
});

test("PUT /api/me/bot-conversations/:sessionId creates a stable bot conversation", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "jung");
    await saveBot(ctx.port, A.token, "alice", "爱丽丝");
    const first = await api(ctx.port, "PUT", "/api/me/bot-conversations/alice", {
      token: A.token,
      body: { botId: "alice", title: "爱丽丝", runtimeKind: "desktop-local" }
    });

    assert.equal(first.status, 200);
    assert.equal(first.body.conversation.id, "botc_alice");
    assert.equal(first.body.conversation.type, "bot");
    assert.equal(first.body.conversation.decorations.botId, "alice");

    const conversations = await api(ctx.port, "GET", "/api/conversations", { token: A.token });
    assert.equal((conversations.body.conversations || []).some((conversation) => conversation.id === first.body.conversation.id), true);

    await new Promise((r) => setTimeout(r, 25));
    const second = await api(ctx.port, "PUT", "/api/me/bot-conversations/alice", {
      token: A.token,
      body: { botId: "alice", title: "爱丽丝", runtimeKind: "desktop-local" }
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.conversation.id, first.body.conversation.id);
    assert.equal(second.body.conversation.updatedAt, first.body.conversation.updatedAt);
  } finally { await stopServer(ctx); }
});

test("PUT /api/me/bot-conversations/:sessionId preserves runtimeKind when omitted", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "runtime");
    await saveBot(ctx.port, A.token, "alice", "爱丽丝");
    const first = await api(ctx.port, "PUT", "/api/me/bot-conversations/alice", {
      token: A.token,
      body: { botId: "alice", title: "爱丽丝", runtimeKind: "desktop-local" }
    });
    assert.equal(first.status, 200);
    await new Promise((r) => setTimeout(r, 25));

    const second = await api(ctx.port, "PUT", "/api/me/bot-conversations/alice", {
      token: A.token,
      body: { botId: "alice", title: "爱丽丝" }
    });

    assert.equal(second.status, 200);
    assert.equal(second.body.conversation.id, first.body.conversation.id);
    assert.equal(second.body.conversation.decorations.runtimeKind, "desktop-local");
    assert.equal(second.body.conversation.updatedAt, first.body.conversation.updatedAt);
  } finally { await stopServer(ctx); }
});

test("PUT /api/me/bot-conversations/:sessionId updates the title on subsequent ensures", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "generated-title");
    await saveBot(ctx.port, A.token, "alice", "爱丽丝");
    const first = await api(ctx.port, "PUT", "/api/me/bot-conversations/alice", {
      token: A.token,
      body: { botId: "alice", title: "爱丽丝", runtimeKind: "desktop-local" }
    });
    assert.equal(first.status, 200);

    const renamed = await api(ctx.port, "PATCH", `/api/conversations/${first.body.conversation.id}`, {
      token: A.token,
      body: { name: "周报整理" }
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.conversation.name, "周报整理");

    const ensured = await api(ctx.port, "PUT", "/api/me/bot-conversations/alice", {
      token: A.token,
      body: { botId: "alice", title: "爱丽丝", runtimeKind: "desktop-local" }
    });

    assert.equal(ensured.status, 200);
    assert.equal(ensured.body.conversation.id, first.body.conversation.id);
    assert.equal(ensured.body.conversation.name, "爱丽丝");
  } finally { await stopServer(ctx); }
});

test("stable bot conversations with dotted bot keys can be fetched and messaged", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "dotted");
    await saveBot(ctx.port, A.token, "my.bot", "My Bot");
    const ensured = await api(ctx.port, "PUT", "/api/me/bot-conversations/my.bot", {
      token: A.token,
      body: { botId: "my.bot", title: "My Bot", runtimeKind: "desktop-local" }
    });
    assert.equal(ensured.status, 200);
    assert.equal(ensured.body.conversation.id, "botc_my.bot");

    const detail = await api(ctx.port, "GET", `/api/conversations/${ensured.body.conversation.id}`, { token: A.token });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.conversation.id, ensured.body.conversation.id);

    const posted = await api(ctx.port, "POST", `/api/conversations/${ensured.body.conversation.id}/messages`, {
      token: A.token,
      body: { bodyMd: "hello dotted" }
    });
    assert.ok(posted.status === 200 || posted.status === 201);
  } finally { await stopServer(ctx); }
});

test("PUT /api/me/bot-conversations/:sessionId creates a bot-type conversation owned by the user", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "rho");
    await saveBot(ctx.port, A.token, "codex", "Codex");
    const sessionId = "sess_abc";
    const r = await api(ctx.port, "PUT", `/api/me/bot-conversations/${sessionId}`, {
      token: A.token,
      body: { botId: "codex", title: "和 Codex 的会话" }
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.conversation.id, "botc_sess_abc");
    assert.equal(r.body.conversation.type, "bot");
    assert.equal(r.body.conversation.name, "和 Codex 的会话");
    assert.deepEqual(r.body.conversation.decorations, { botId: "codex", sessionId, runtimeKind: "desktop-local" });
    const member_kinds = r.body.members.map((m) => m.member_kind).sort();
    assert.deepEqual(member_kinds, ["bot", "user"]);
  } finally { await stopServer(ctx); }
});

test("PUT /api/me/bot-conversations/:sessionId preserves requested runtimeKind for new history conversations", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "rho-cloud");
    await saveBot(ctx.port, A.token, "mia", "Mia");
    const r = await api(ctx.port, "PUT", "/api/me/bot-conversations/sess_cloud", {
      token: A.token,
      body: { botId: "mia", title: "新对话", runtimeKind: "cloud-hermes" }
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.conversation.decorations.botId, "mia");
    assert.equal(r.body.conversation.decorations.sessionId, "sess_cloud");
    assert.equal(r.body.conversation.decorations.runtimeKind, "cloud-hermes");
  } finally { await stopServer(ctx); }
});

test("PUT /api/me/bot-conversations is idempotent (same sessionId returns same conversation)", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "sigma");
    await saveBot(ctx.port, A.token, "codex", "Codex");
    const r1 = await api(ctx.port, "PUT", "/api/me/bot-conversations/sess1", { token: A.token, body: { botId: "codex", title: "v1" } });
    const r2 = await api(ctx.port, "PUT", "/api/me/bot-conversations/sess1", { token: A.token, body: { botId: "codex", title: "v2" } });
    assert.equal(r1.body.conversation.id, r2.body.conversation.id);
    assert.equal(r2.body.conversation.name, "v2", "title update on subsequent PUT");
    assert.equal(r2.body.conversation.decorations.runtimeKind, "desktop-local", "desktop-created bot conversations must stay local-runtime by default");
  } finally { await stopServer(ctx); }
});

test("bot conversations show up in GET /api/conversations alongside DMs and groups", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "tau");
    await saveBot(ctx.port, A.token, "codex", "Codex");
    await saveBot(ctx.port, A.token, "mia", "Mia");
    await api(ctx.port, "PUT", "/api/me/bot-conversations/sess1", { token: A.token, body: { botId: "codex", title: "Codex chat" } });
    await api(ctx.port, "PUT", "/api/me/bot-conversations/sess2", { token: A.token, body: { botId: "mia", title: "Mia chat" } });
    const list = await api(ctx.port, "GET", "/api/conversations", { token: A.token });
    const botConversations = (list.body.conversations || []).filter((r) => r.type === "bot");
    assert.equal(botConversations.length, 2);
    const names = botConversations.map((r) => r.name).sort();
    assert.deepEqual(names, ["Codex chat", "Mia chat"]);
  } finally { await stopServer(ctx); }
});

test("Bot-conversation messages POST works through the unified /api/conversations/:id/messages endpoint", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "upsilon");
    await saveBot(ctx.port, A.token, "codex", "Codex");
    const conversation = await api(ctx.port, "PUT", "/api/me/bot-conversations/sess1", { token: A.token, body: { botId: "codex", title: "x" } });
    const conversationId = conversation.body.conversation.id;
    const sent = await api(ctx.port, "POST", `/api/conversations/${conversationId}/messages`, { token: A.token, body: { bodyMd: "hello bot chat", clientOpId: "op_msg_1" } });
    assert.equal(sent.status, 201);
    const list = await api(ctx.port, "GET", `/api/conversations/${conversationId}/messages`, { token: A.token });
    assert.equal((list.body.messages || []).length, 1);
    assert.equal(list.body.messages[0].body_md, "hello bot chat");
  } finally { await stopServer(ctx); }
});

test("Schema v7: conversations.type column + index", async () => {
  const ctx = await startServer();
  try {
    // No need to spin up server again; just open the DB the server writes to.
    await new Promise((r) => setTimeout(r, 100));
    const { createCloudStore } = require("../src/cloud/sqlite-store");
    const store = createCloudStore({ dataDir: ctx.tmpDir });
    try {
      const cols = store.getDb().prepare("PRAGMA table_info(conversations)").all().map((r) => r.name);
      assert.ok(cols.includes("type"), "conversations.type column missing");
      const indices = store.getDb().prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
      assert.ok(indices.includes("idx_conversations_type"));
    } finally { store.close?.(); }
  } finally { await stopServer(ctx); }
});
