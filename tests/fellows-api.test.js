// Phase 2 — fellow definitions on cloud, end-to-end through the HTTP API.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const WebSocket = require("ws");
const { spawn } = require("node:child_process");
const { freePort } = require("./helpers/free-port");

async function startServer() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-fellow-api-"));
  const port = await freePort();
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["scripts/serve-cloud.js"], {
      env: {
        ...process.env,
        MIA_CLOUD_HOST: "127.0.0.1",
        MIA_CLOUD_PORT: String(port),
        MIA_CLOUD_DATA: tmpDir,
        MIA_CLOUD_ALLOW_QUERY_TOKEN: "1"
      },
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

test("web bootstrap can request compact user and fellow identities without avatar blobs", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "compact");
    const avatarImage = "data:image/png;base64," + "A".repeat(200_000);
    const personaText = "You are Codex.\n" + "x".repeat(100_000);
    const profile = await api(ctx.port, "PATCH", "/api/me/profile", {
      token: A.token,
      body: {
        avatarImage,
        avatarCrop: { x: 10, y: 20, w: 100, h: 100 },
        avatarColor: "#112233",
        clientOpId: "op_profile_compact"
      }
    });
    assert.equal(profile.status, 200);
    const put = await api(ctx.port, "PUT", "/api/me/fellows/codex", {
      token: A.token,
      body: {
        name: "Codex",
        avatarImage,
        avatarCrop: { x: 10, y: 20, w: 100, h: 100 },
        personaText,
        clientOpId: "op_fellow_compact"
      }
    });
    assert.equal(put.status, 200);

    const me = await api(ctx.port, "GET", "/api/me?compact=1", { token: A.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.id, A.user.id);
    assert.equal(Object.prototype.hasOwnProperty.call(me.body.user, "avatarImage"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(me.body.user, "avatarCrop"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(me.body.user, "avatarColor"), false);

    const list = await api(ctx.port, "GET", "/api/me/fellows?compact=1", { token: A.token });
    assert.equal(list.status, 200);
    const codex = list.body.fellows.find((fellow) => fellow.id === "codex");
    assert.ok(codex);
    assert.equal(codex.name, "Codex");
    assert.equal(Object.prototype.hasOwnProperty.call(codex, "avatarImage"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(codex, "avatarCrop"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(codex, "personaText"), false);

    assert.ok(JSON.stringify(me.body).length < 1_000, "compact /api/me should stay small");
    assert.ok(JSON.stringify(list.body).length < 5_000, "compact fellow list should stay small");
  } finally { await stopServer(ctx); }
});

test("GET and PUT /api/me/fellows/:id/runtime roundtrip cloud AI controls", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "rho");
    await api(ctx.port, "PUT", "/api/me/fellows/codex", {
      token: A.token,
      body: { name: "Codex", clientOpId: "op_runtime_fellow" }
    });

    const empty = await api(ctx.port, "GET", "/api/me/fellows/codex/runtime?kind=cloud-hermes", { token: A.token });
    assert.equal(empty.status, 200);
    assert.equal(empty.body.binding.enabled, false);
    assert.deepEqual(empty.body.binding.config, {});

    const saved = await api(ctx.port, "PUT", "/api/me/fellows/codex/runtime", {
      token: A.token,
      body: {
        runtimeKind: "cloud-hermes",
        enabled: true,
        config: {
          model: "hermes-agent",
          effortLevel: "high",
          permissionMode: "auto",
          agentEngine: "codex",
          modelEntries: [
            { value: "gpt-5.3-codex", label: "GPT-5.3 Codex", model: "gpt-5.3-codex", provider: "codex", providerLabel: "Codex CLI" }
          ]
        },
        clientOpId: "op_runtime_save"
      }
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.binding.enabled, true);
    assert.equal(saved.body.binding.config.effortLevel, "high");

    const got = await api(ctx.port, "GET", "/api/me/fellows/codex/runtime?kind=cloud-hermes", { token: A.token });
    assert.equal(got.status, 200);
    assert.equal(got.body.binding.config.model, "hermes-agent");
    assert.equal(got.body.binding.config.permissionMode, "auto");
    assert.equal(got.body.binding.config.agentEngine, "codex");
    assert.deepEqual(got.body.binding.config.modelEntries, [
      { value: "gpt-5.3-codex", label: "GPT-5.3 Codex", model: "gpt-5.3-codex", provider: "codex", providerLabel: "Codex CLI" }
    ]);
  } finally { await stopServer(ctx); }
});

test("PUT same clientOpId twice creates only one fellow upsert event in user_events", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "chi");
    const body = { name: "Mia", color: "#5e5ce6", clientOpId: "op_fellow_idem" };
    await api(ctx.port, "PUT", "/api/me/fellows/mia", { token: A.token, body });
    await api(ctx.port, "PUT", "/api/me/fellows/mia", { token: A.token, body });

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
