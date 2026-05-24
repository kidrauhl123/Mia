// Phase 2 — fellow definitions on cloud, end-to-end through the HTTP API.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const WebSocket = require("ws");
const { spawn } = require("node:child_process");

function startServer() {
  return new Promise((resolve, reject) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimashi-fellow-api-"));
    const port = 4000 + Math.floor(Math.random() * 1000);
    const proc = spawn(process.execPath, ["scripts/serve-cloud.js"], {
      env: {
        ...process.env,
        AIMASHI_CLOUD_HOST: "127.0.0.1",
        AIMASHI_CLOUD_PORT: String(port),
        AIMASHI_CLOUD_DATA: tmpDir,
        AIMASHI_CLOUD_ALLOW_QUERY_TOKEN: "1"
      },
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
  ctx.proc.kill("SIGTERM");
  await new Promise((r) => ctx.proc.on("exit", r));
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

test("PUT then GET /api/me/fellows roundtrips identity fields", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "phi");
    const put = await api(ctx.port, "PUT", "/api/me/fellows/codex", {
      token: A.token,
      body: {
        name: "Codex",
        color: "#0f766e",
        avatarImage: "data:image/png;base64,fake",
        avatarCrop: { x: 10, y: 20, w: 100, h: 100 },
        bio: "Coding helper",
        capabilities: ["chat", "tools"],
        personaText: "You are Codex.",
        clientOpId: "op_fellow_1"
      }
    });
    assert.equal(put.status, 200);
    assert.equal(put.body.fellow.id, "codex");
    assert.equal(put.body.fellow.name, "Codex");
    assert.deepEqual(put.body.fellow.capabilities, ["chat", "tools"]);

    const list = await api(ctx.port, "GET", "/api/me/fellows", { token: A.token });
    assert.equal(list.status, 200);
    const codex = list.body.fellows.find((fellow) => fellow.id === "codex");
    assert.ok(codex);
    assert.equal(codex.name, "Codex");
    assert.deepEqual(codex.avatarCrop, { x: 10, y: 20, w: 100, h: 100 });
  } finally { await stopServer(ctx); }
});

test("PUT same clientOpId twice creates only one fellow upsert event in user_events", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "chi");
    const body = { name: "Aimashi", color: "#5e5ce6", clientOpId: "op_fellow_idem" };
    await api(ctx.port, "PUT", "/api/me/fellows/aimashi", { token: A.token, body });
    await api(ctx.port, "PUT", "/api/me/fellows/aimashi", { token: A.token, body });

    await new Promise((r) => setTimeout(r, 100));
    const { createCloudStore } = require("../src/cloud/sqlite-store");
    const { createEventLogStore } = require("../src/cloud/event-log-store");
    const store = createCloudStore({ dataDir: ctx.tmpDir });
    try {
      const log = createEventLogStore(store.getDb());
      const upsertEvents = log.listEventsSince(A.user.id, 0).filter((e) => e.kind === "fellow.upserted");
      assert.equal(upsertEvents.length, 1, "idempotent PUT writes one event only");
    } finally { store.close?.(); }
  } finally { await stopServer(ctx); }
});

test("DELETE /api/me/fellows/:id removes the row and fires fellow.deleted", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "psi");
    await api(ctx.port, "PUT", "/api/me/fellows/x", { token: A.token, body: { name: "X" } });
    const del = await api(ctx.port, "DELETE", "/api/me/fellows/x", { token: A.token });
    assert.equal(del.status, 200);
    const list = await api(ctx.port, "GET", "/api/me/fellows", { token: A.token });
    assert.equal(list.body.fellows.some((fellow) => fellow.id === "x"), false);

    await new Promise((r) => setTimeout(r, 100));
    const { createCloudStore } = require("../src/cloud/sqlite-store");
    const { createEventLogStore } = require("../src/cloud/event-log-store");
    const store = createCloudStore({ dataDir: ctx.tmpDir });
    try {
      const log = createEventLogStore(store.getDb());
      const kinds = log.listEventsSince(A.user.id, 0).map((e) => e.kind);
      assert.ok(kinds.includes("fellow.upserted"));
      assert.ok(kinds.includes("fellow.deleted"));
    } finally { store.close?.(); }
  } finally { await stopServer(ctx); }
});

test("fellow.upserted is broadcast live to a connected event socket", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "omega");
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/api/events?token=${encodeURIComponent(A.token)}`);
    await new Promise((r) => ws.once("open", r));
    // Wait for events_ready
    await new Promise((r) => {
      const onMsg = (raw) => {
        const e = JSON.parse(raw.toString());
        if (e.type === "events_ready") { ws.off("message", onMsg); r(); }
      };
      ws.on("message", onMsg);
    });
    const received = new Promise((r) => {
      ws.on("message", (raw) => {
        const e = JSON.parse(raw.toString());
        if (e.type === "fellow.upserted") r(e);
      });
    });
    await api(ctx.port, "PUT", "/api/me/fellows/codex", { token: A.token, body: { name: "Codex" } });
    const evt = await Promise.race([
      received,
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout waiting for fellow.upserted")), 2000))
    ]);
    ws.close();
    assert.equal(evt.fellow.id, "codex");
    assert.equal(evt.fellow.name, "Codex");
    assert.ok(Number.isFinite(Number(evt.seq)));
  } finally { await stopServer(ctx); }
});
