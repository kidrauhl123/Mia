// Phase 4 — fellow private chats live in rooms+messages now.
// Verify the unified room model end-to-end.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { freePort } = require("./helpers/free-port");

async function startServer() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimashi-fellow-room-"));
  const port = await freePort();
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["scripts/serve-cloud.js"], {
      env: { ...process.env, AIMASHI_CLOUD_HOST: "127.0.0.1", AIMASHI_CLOUD_PORT: String(port), AIMASHI_CLOUD_DATA: tmpDir, AIMASHI_CLOUD_ALLOW_QUERY_TOKEN: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve({ proc, port, tmpDir }); } };
    proc.stdout.on("data", (c) => { if (/listening|Listening/.test(c.toString())) done(); });
    proc.stderr.on("data", (c) => { if (/listening|Listening|aimashi-cloud/i.test(c.toString())) done(); });
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

test("PUT /api/me/fellows/:fellowId/room creates a stable fellow room", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "jung");
    const first = await api(ctx.port, "PUT", "/api/me/fellows/alice/room", {
      token: A.token,
      body: { title: "爱丽丝", runtimeKind: "desktop-local" }
    });

    assert.equal(first.status, 200);
    assert.equal(first.body.ok, true);
    assert.equal(first.body.room.id, `fellow:${A.user.id}:alice`);
    assert.equal(first.body.room.type, "fellow");
    assert.equal(first.body.room.decorations.fellowKey, "alice");
    assert.equal(first.body.created, true);

    const rooms = await api(ctx.port, "GET", "/api/rooms", { token: A.token });
    assert.equal((rooms.body.rooms || []).some((room) => room.id === first.body.room.id), true);

    await new Promise((r) => setTimeout(r, 25));
    const second = await api(ctx.port, "PUT", "/api/me/fellows/alice/room", {
      token: A.token,
      body: { title: "爱丽丝", runtimeKind: "desktop-local" }
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.room.id, first.body.room.id);
    assert.equal(second.body.created, false);

    assert.equal(second.body.room.updatedAt, first.body.room.updatedAt);

    const { createCloudStore } = require("../src/cloud/sqlite-store");
    const { createEventLogStore } = require("../src/cloud/event-log-store");
    const store = createCloudStore({ dataDir: ctx.tmpDir });
    try {
      const log = createEventLogStore(store.getDb());
      const roomUpdatedEvents = log.listEventsSince(A.user.id, 0).filter((event) =>
        event.kind === "room.updated" &&
        event.payload?.room?.id === first.body.room.id
      );
      assert.equal(roomUpdatedEvents.length, 1);
    } finally { store.close?.(); }
  } finally { await stopServer(ctx); }
});

test("PUT /api/me/fellows/:fellowId/room preserves runtimeKind when omitted", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "runtime");
    const first = await api(ctx.port, "PUT", "/api/me/fellows/alice/room", {
      token: A.token,
      body: { title: "爱丽丝", runtimeKind: "desktop-local" }
    });
    assert.equal(first.status, 200);
    await new Promise((r) => setTimeout(r, 25));

    const second = await api(ctx.port, "PUT", "/api/me/fellows/alice/room", {
      token: A.token,
      body: { title: "爱丽丝" }
    });

    assert.equal(second.status, 200);
    assert.equal(second.body.room.id, first.body.room.id);
    assert.equal(second.body.room.decorations.runtimeKind, "desktop-local");
    assert.equal(second.body.room.updatedAt, first.body.room.updatedAt);

    const { createCloudStore } = require("../src/cloud/sqlite-store");
    const { createEventLogStore } = require("../src/cloud/event-log-store");
    const store = createCloudStore({ dataDir: ctx.tmpDir });
    try {
      const log = createEventLogStore(store.getDb());
      const roomUpdatedEvents = log.listEventsSince(A.user.id, 0).filter((event) =>
        event.kind === "room.updated" &&
        event.payload?.room?.id === first.body.room.id
      );
      assert.equal(roomUpdatedEvents.length, 1);
    } finally { store.close?.(); }
  } finally { await stopServer(ctx); }
});

test("stable fellow rooms with dotted fellow keys can be fetched and messaged", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "dotted");
    const ensured = await api(ctx.port, "PUT", "/api/me/fellows/my.bot/room", {
      token: A.token,
      body: { title: "My Bot", runtimeKind: "desktop-local" }
    });
    assert.equal(ensured.status, 200);
    assert.equal(ensured.body.room.id, `fellow:${A.user.id}:my.bot`);

    const detail = await api(ctx.port, "GET", `/api/rooms/${ensured.body.room.id}`, { token: A.token });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.room.id, ensured.body.room.id);

    const posted = await api(ctx.port, "POST", `/api/rooms/${ensured.body.room.id}/messages`, {
      token: A.token,
      body: { bodyMd: "hello dotted" }
    });
    assert.ok(posted.status === 200 || posted.status === 201);
  } finally { await stopServer(ctx); }
});

test("PUT /api/me/fellow-rooms/:sessionId creates a fellow-type room owned by the user", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "rho");
    const sessionId = "sess_abc";
    const r = await api(ctx.port, "PUT", `/api/me/fellow-rooms/${sessionId}`, {
      token: A.token,
      body: { fellowKey: "codex", title: "和 Codex 的会话" }
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.room.id, `fellow:${A.user.id}:${sessionId}`);
    assert.equal(r.body.room.type, "fellow");
    assert.equal(r.body.room.name, "和 Codex 的会话");
    assert.deepEqual(r.body.room.decorations, { fellowKey: "codex", sessionId, runtimeKind: "desktop-local" });
    const member_kinds = r.body.members.map((m) => m.member_kind).sort();
    assert.deepEqual(member_kinds, ["fellow", "user"]);
  } finally { await stopServer(ctx); }
});

test("PUT /api/me/fellow-rooms is idempotent (same sessionId returns same room)", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "sigma");
    const r1 = await api(ctx.port, "PUT", "/api/me/fellow-rooms/sess1", { token: A.token, body: { fellowKey: "codex", title: "v1" } });
    const r2 = await api(ctx.port, "PUT", "/api/me/fellow-rooms/sess1", { token: A.token, body: { fellowKey: "codex", title: "v2" } });
    assert.equal(r1.body.room.id, r2.body.room.id);
    assert.equal(r2.body.room.name, "v2", "title update on subsequent PUT");
    assert.equal(r2.body.room.decorations.runtimeKind, "desktop-local", "desktop-created fellow rooms must stay local-runtime by default");
  } finally { await stopServer(ctx); }
});

test("fellow rooms show up in GET /api/rooms alongside DMs and groups", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "tau");
    await api(ctx.port, "PUT", "/api/me/fellow-rooms/sess1", { token: A.token, body: { fellowKey: "codex", title: "Codex chat" } });
    await api(ctx.port, "PUT", "/api/me/fellow-rooms/sess2", { token: A.token, body: { fellowKey: "aimashi", title: "Aimashi chat" } });
    const list = await api(ctx.port, "GET", "/api/rooms", { token: A.token });
    const fellowRooms = (list.body.rooms || []).filter((r) => r.type === "fellow");
    assert.equal(fellowRooms.length, 3);
    const names = fellowRooms.map((r) => r.name).sort();
    assert.deepEqual(names, ["Aimashi", "Aimashi chat", "Codex chat"]);
  } finally { await stopServer(ctx); }
});

test("Fellow-room messages POST works through the unified /api/rooms/:id/messages endpoint", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "upsilon");
    const room = await api(ctx.port, "PUT", "/api/me/fellow-rooms/sess1", { token: A.token, body: { fellowKey: "codex", title: "x" } });
    const roomId = room.body.room.id;
    const sent = await api(ctx.port, "POST", `/api/rooms/${roomId}/messages`, { token: A.token, body: { bodyMd: "hello fellow chat", clientOpId: "op_msg_1" } });
    assert.equal(sent.status, 201);
    const list = await api(ctx.port, "GET", `/api/rooms/${roomId}/messages`, { token: A.token });
    assert.equal((list.body.messages || []).length, 1);
    assert.equal(list.body.messages[0].body_md, "hello fellow chat");
  } finally { await stopServer(ctx); }
});

test("Schema v7: rooms.type column + index", async () => {
  const ctx = await startServer();
  try {
    // No need to spin up server again; just open the DB the server writes to.
    await new Promise((r) => setTimeout(r, 100));
    const { createCloudStore } = require("../src/cloud/sqlite-store");
    const store = createCloudStore({ dataDir: ctx.tmpDir });
    try {
      const cols = store.getDb().prepare("PRAGMA table_info(rooms)").all().map((r) => r.name);
      assert.ok(cols.includes("type"), "rooms.type column missing");
      const indices = store.getDb().prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
      assert.ok(indices.includes("idx_rooms_type"));
    } finally { store.close?.(); }
  } finally { await stopServer(ctx); }
});
