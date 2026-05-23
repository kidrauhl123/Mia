// Phase 1.D — verify clientOpId makes write endpoints idempotent.
// Same id → same response, no duplicate side-effects.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

function startServer() {
  return new Promise((resolve, reject) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimashi-opid-"));
    const port = 4000 + Math.floor(Math.random() * 1000);
    const proc = spawn(process.execPath, ["scripts/serve-cloud.js"], {
      env: {
        ...process.env,
        AIMASHI_CLOUD_HOST: "127.0.0.1",
        AIMASHI_CLOUD_PORT: String(port),
        AIMASHI_CLOUD_DATA: tmpDir
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

test("POST /api/rooms is idempotent on clientOpId", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "iota");
    const body = { name: "test-group", memberFellows: [{ fellowId: "f1" }], memberFriendUserIds: [], clientOpId: "op_test_123" };
    const r1 = await api(ctx.port, "POST", "/api/rooms", { token: A.token, body });
    const r2 = await api(ctx.port, "POST", "/api/rooms", { token: A.token, body });
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201, "replay status code mirrors first call");
    assert.equal(r1.body.room.id, r2.body.room.id, "both calls return the same room id");

    // Belt and suspenders: server-side count of rooms for this user is 1
    const list = await api(ctx.port, "GET", "/api/rooms", { token: A.token });
    assert.equal(list.body.rooms.length, 1, "only ONE room created across two POSTs with same clientOpId");
  } finally { await stopServer(ctx); }
});

test("POST /api/rooms/:id/messages is idempotent on clientOpId", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "kappa");
    const B = await register(ctx.port, "lambda");
    const fr = await api(ctx.port, "POST", "/api/social/friend-requests", { token: A.token, body: { toUsername: B.user.username, clientOpId: "op_fr_1" } });
    await api(ctx.port, "POST", `/api/social/friend-requests/${fr.body.request.id}/respond`, { token: B.token, body: { action: "accept", clientOpId: "op_resp_1" } });
    const dm = `dm:${[A.user.id, B.user.id].sort().join(":")}`;
    const msg = { bodyMd: "hello-once", clientOpId: "op_msg_42" };
    const r1 = await api(ctx.port, "POST", `/api/rooms/${dm}/messages`, { token: A.token, body: msg });
    const r2 = await api(ctx.port, "POST", `/api/rooms/${dm}/messages`, { token: A.token, body: msg });
    assert.equal(r1.body.message.id, r2.body.message.id, "both POSTs return the same message id");

    const listed = await api(ctx.port, "GET", `/api/rooms/${dm}/messages`, { token: A.token });
    const helloMessages = (listed.body.messages || []).filter((m) => m.body_md === "hello-once");
    assert.equal(helloMessages.length, 1, "only ONE row persisted across two identical POSTs");
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
    const r1 = await api(ctx.port, "POST", "/api/rooms", { token: A.token, body: { name: "a", memberFellows: [{ fellowId: "f1" }], memberFriendUserIds: [], clientOpId: "op_A" } });
    const r2 = await api(ctx.port, "POST", "/api/rooms", { token: A.token, body: { name: "b", memberFellows: [{ fellowId: "f1" }], memberFriendUserIds: [], clientOpId: "op_B" } });
    assert.notEqual(r1.body.room.id, r2.body.room.id);
    const list = await api(ctx.port, "GET", "/api/rooms", { token: A.token });
    assert.equal(list.body.rooms.length, 2);
  } finally { await stopServer(ctx); }
});
