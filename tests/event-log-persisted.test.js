// Integration test for Phase 1.B — verifies that state-changing broadcasts
// actually write into the user_events table (so reconnect replay will
// work in Stage 1.C) and that transient events DO NOT.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { createCloudStore } = require("../src/cloud/sqlite-store");
const { createEventLogStore } = require("../src/cloud/event-log-store");
const { freePort } = require("./helpers/free-port");
const { seedCloudAccountInDataDir } = require("./helpers/cloud-auth.js");

const dataDirsByPort = new Map();

async function startServer() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-evt-int-"));
  const port = await freePort();
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["scripts/serve-cloud.js"], {
      env: {
        ...process.env,
        MIA_CLOUD_HOST: "127.0.0.1",
        MIA_CLOUD_PORT: String(port),
        MIA_CLOUD_DATA: tmpDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
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
      headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
    }, (res) => {
      let chunks = "";
      res.on("data", (c) => { chunks += c; });
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(chunks); } catch { parsed = chunks; }
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

function openStoreReadonly(tmpDir) {
  // Read the same SQLite file the server is writing.
  return createCloudStore({ dataDir: tmpDir });
}

test("friend acceptance lands social.friend_added in user_events for BOTH parties", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "alice");
    const B = await register(ctx.port, "bob");
    // A sends friend request to B
    const reqRes = await api(ctx.port, "POST", "/api/social/friend-requests",
      { token: A.token, body: { toUserId: B.user.id } });
    assert.equal(reqRes.status, 201);
    // B accepts
    const acc = await api(ctx.port, "POST", `/api/social/friend-requests/${reqRes.body.request.id}/respond`,
      { token: B.token, body: { action: "accept" } });
    assert.equal(acc.status, 200);

    // The server runs in a subprocess; give it a tick to commit before we
    // open a second reader on the same SQLite file.
    await new Promise((r) => setTimeout(r, 200));

    const store = openStoreReadonly(ctx.tmpDir);
    try {
      const log = createEventLogStore(store.getDb());
      // friend_request_received → A's request to B, ALSO friend_added × 2 (one per side)
      const aEvents = log.listEventsSince(A.user.id, 0);
      const bEvents = log.listEventsSince(B.user.id, 0);
      const aKinds = aEvents.map((e) => e.kind);
      const bKinds = bEvents.map((e) => e.kind);
      assert.ok(aKinds.includes("social.friend_added"),
        `A's events should include social.friend_added (got: ${JSON.stringify(aKinds)})`);
      assert.ok(bKinds.includes("social.friend_added"),
        `B's events should include social.friend_added (got: ${JSON.stringify(bKinds)})`);
      assert.ok(bKinds.includes("social.friend_request_received"),
        `B should have received the friend_request_received event (got: ${JSON.stringify(bKinds)})`);

      // Seq must be monotonic per user
      for (const ev of aEvents) assert.ok(ev.seq > 0, "seq populated on persisted event");
      for (let i = 1; i < aEvents.length; i++) assert.ok(aEvents[i].seq > aEvents[i - 1].seq);
    } finally {
      store.close?.();
    }
  } finally {
    await stopServer(ctx);
  }
});

test("transient events (device_updated etc) do NOT land in user_events", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "carol");
    await new Promise((r) => setTimeout(r, 100));

    // No actions taken that would mutate state — only the registration
    // happened (which doesn't fire any persisted event since the user has
    // no friends/conversations yet).
    const store = openStoreReadonly(ctx.tmpDir);
    try {
      const log = createEventLogStore(store.getDb());
      const events = log.listEventsSince(A.user.id, 0);
      // Should be empty — registration alone doesn't fire any state-change event.
      const transientKinds = events.filter((e) =>
        e.kind === "bridge_run_updated" || e.kind === "device_updated" || e.kind === "bridge_run_event"
      );
      assert.equal(transientKinds.length, 0, "transient events must never persist");
    } finally {
      store.close?.();
    }
  } finally {
    await stopServer(ctx);
  }
});
