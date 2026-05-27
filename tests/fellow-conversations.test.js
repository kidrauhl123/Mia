// Phase 4 — fellow private chats live in conversations+messages now.
// Verify the unified conversation model end-to-end.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { freePort } = require("./helpers/free-port");

async function startServer() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-fellow-conversation-"));
  const port = await freePort();
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["scripts/serve-cloud.js"], {
      env: { ...process.env, MIA_CLOUD_HOST: "127.0.0.1", MIA_CLOUD_PORT: String(port), MIA_CLOUD_DATA: tmpDir, MIA_CLOUD_ALLOW_QUERY_TOKEN: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve({ proc, port, tmpDir }); } };
    proc.stdout.on("data", (c) => { if (/listening|Listening/.test(c.toString())) done(); });
    proc.stderr.on("data", (c) => { if (/listening|Listening|mia-cloud/i.test(c.toString())) done(); });
    proc.on("error", reject);
    setTimeout(done, 1500);
  });
}

async function stopServer(ctx) {
  if (ctx.proc.exitCode === null && ctx.proc.signalCode === null) {
    ctx.proc.kill("SIGTERM");
    await new Promise((r) => ctx.proc.once("exit", r));
  }
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
  const r = await api(port, "POST", "/api/auth/register", { body: { account, password: "passworD1!", username: `u-${account}` } });
  assert.ok(r.status === 200 || r.status === 201);
  return r.body;
}

test("PUT /api/me/fellows/:fellowId/conversation creates a stable fellow conversation", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "jung");
    const first = await api(ctx.port, "PUT", "/api/me/fellows/alice/conversation", {
      token: A.token,
      body: { title: "爱丽丝", runtimeKind: "desktop-local" }
    });

    assert.equal(first.status, 200);
    assert.equal(first.body.ok, true);
    assert.equal(first.body.conversation.id, `fellow:${A.user.id}:alice`);
    assert.equal(first.body.conversation.type, "fellow");
    assert.equal(first.body.conversation.decorations.fellowKey, "alice");
    assert.equal(first.body.created, true);

    const conversations = await api(ctx.port, "GET", "/api/conversations", { token: A.token });
    assert.equal((conversations.body.conversations || []).some((conversation) => conversation.id === first.body.conversation.id), true);

    await new Promise((r) => setTimeout(r, 25));
    const second = await api(ctx.port, "PUT", "/api/me/fellows/alice/conversation", {
      token: A.token,
      body: { title: "爱丽丝", runtimeKind: "desktop-local" }
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.conversation.id, first.body.conversation.id);
    assert.equal(second.body.created, false);

    assert.equal(second.body.conversation.updatedAt, first.body.conversation.updatedAt);

    const { createCloudStore } = require("../src/cloud/sqlite-store");
    const { createEventLogStore } = require("../src/cloud/event-log-store");
    const store = createCloudStore({ dataDir: ctx.tmpDir });
    try {
      const log = createEventLogStore(store.getDb());
      const conversationUpdatedEvents = log.listEventsSince(A.user.id, 0).filter((event) =>
        event.kind === "conversation.updated" &&
        event.payload?.conversation?.id === first.body.conversation.id
      );
      assert.equal(conversationUpdatedEvents.length, 1);
    } finally { store.close?.(); }
  } finally { await stopServer(ctx); }
});

test("PUT /api/me/fellows/:fellowId/conversation preserves runtimeKind when omitted", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "runtime");
    const first = await api(ctx.port, "PUT", "/api/me/fellows/alice/conversation", {
      token: A.token,
      body: { title: "爱丽丝", runtimeKind: "desktop-local" }
    });
    assert.equal(first.status, 200);
    await new Promise((r) => setTimeout(r, 25));

    const second = await api(ctx.port, "PUT", "/api/me/fellows/alice/conversation", {
      token: A.token,
      body: { title: "爱丽丝" }
    });

    assert.equal(second.status, 200);
    assert.equal(second.body.conversation.id, first.body.conversation.id);
    assert.equal(second.body.conversation.decorations.runtimeKind, "desktop-local");
    assert.equal(second.body.conversation.updatedAt, first.body.conversation.updatedAt);

    const { createCloudStore } = require("../src/cloud/sqlite-store");
    const { createEventLogStore } = require("../src/cloud/event-log-store");
    const store = createCloudStore({ dataDir: ctx.tmpDir });
    try {
      const log = createEventLogStore(store.getDb());
      const conversationUpdatedEvents = log.listEventsSince(A.user.id, 0).filter((event) =>
        event.kind === "conversation.updated" &&
        event.payload?.conversation?.id === first.body.conversation.id
      );
      assert.equal(conversationUpdatedEvents.length, 1);
    } finally { store.close?.(); }
  } finally { await stopServer(ctx); }
});

test("stable fellow conversations with dotted fellow keys can be fetched and messaged", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "dotted");
    const ensured = await api(ctx.port, "PUT", "/api/me/fellows/my.bot/conversation", {
      token: A.token,
      body: { title: "My Bot", runtimeKind: "desktop-local" }
    });
    assert.equal(ensured.status, 200);
    assert.equal(ensured.body.conversation.id, `fellow:${A.user.id}:my.bot`);

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

test("PUT /api/me/fellow-conversations/:sessionId creates a fellow-type conversation owned by the user", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "rho");
    const sessionId = "sess_abc";
    const r = await api(ctx.port, "PUT", `/api/me/fellow-conversations/${sessionId}`, {
      token: A.token,
      body: { fellowKey: "codex", title: "和 Codex 的会话" }
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.conversation.id, `fellow:${A.user.id}:${sessionId}`);
    assert.equal(r.body.conversation.type, "fellow");
    assert.equal(r.body.conversation.name, "和 Codex 的会话");
    assert.deepEqual(r.body.conversation.decorations, { fellowKey: "codex", sessionId, runtimeKind: "desktop-local" });
    const member_kinds = r.body.members.map((m) => m.member_kind).sort();
    assert.deepEqual(member_kinds, ["fellow", "user"]);
  } finally { await stopServer(ctx); }
});

test("PUT /api/me/fellow-conversations/:sessionId preserves requested runtimeKind for new history conversations", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "rho-cloud");
    const r = await api(ctx.port, "PUT", "/api/me/fellow-conversations/sess_cloud", {
      token: A.token,
      body: { fellowKey: "mia", title: "新对话", runtimeKind: "cloud-hermes" }
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.conversation.decorations.fellowKey, "mia");
    assert.equal(r.body.conversation.decorations.sessionId, "sess_cloud");
    assert.equal(r.body.conversation.decorations.runtimeKind, "cloud-hermes");
  } finally { await stopServer(ctx); }
});

test("PUT /api/me/fellow-conversations is idempotent (same sessionId returns same conversation)", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "sigma");
    const r1 = await api(ctx.port, "PUT", "/api/me/fellow-conversations/sess1", { token: A.token, body: { fellowKey: "codex", title: "v1" } });
    const r2 = await api(ctx.port, "PUT", "/api/me/fellow-conversations/sess1", { token: A.token, body: { fellowKey: "codex", title: "v2" } });
    assert.equal(r1.body.conversation.id, r2.body.conversation.id);
    assert.equal(r2.body.conversation.name, "v2", "title update on subsequent PUT");
    assert.equal(r2.body.conversation.decorations.runtimeKind, "desktop-local", "desktop-created fellow conversations must stay local-runtime by default");
  } finally { await stopServer(ctx); }
});

test("fellow conversations show up in GET /api/conversations alongside DMs and groups", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "tau");
    await api(ctx.port, "PUT", "/api/me/fellow-conversations/sess1", { token: A.token, body: { fellowKey: "codex", title: "Codex chat" } });
    await api(ctx.port, "PUT", "/api/me/fellow-conversations/sess2", { token: A.token, body: { fellowKey: "mia", title: "Mia chat" } });
    const list = await api(ctx.port, "GET", "/api/conversations", { token: A.token });
    const fellowConversations = (list.body.conversations || []).filter((r) => r.type === "fellow");
    assert.equal(fellowConversations.length, 3);
    const names = fellowConversations.map((r) => r.name).sort();
    assert.deepEqual(names, ["Codex chat", "Mia", "Mia chat"]);
  } finally { await stopServer(ctx); }
});

test("Fellow-conversation messages POST works through the unified /api/conversations/:id/messages endpoint", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "upsilon");
    const conversation = await api(ctx.port, "PUT", "/api/me/fellow-conversations/sess1", { token: A.token, body: { fellowKey: "codex", title: "x" } });
    const conversationId = conversation.body.conversation.id;
    const sent = await api(ctx.port, "POST", `/api/conversations/${conversationId}/messages`, { token: A.token, body: { bodyMd: "hello fellow chat", clientOpId: "op_msg_1" } });
    assert.equal(sent.status, 201);
    const list = await api(ctx.port, "GET", `/api/conversations/${conversationId}/messages`, { token: A.token });
    assert.equal((list.body.messages || []).length, 1);
    assert.equal(list.body.messages[0].body_md, "hello fellow chat");
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
