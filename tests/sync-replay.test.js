// Phase 1.C — verify a WS reconnect with since_seq replays every event
// the client missed while disconnected.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const WebSocket = require("ws");
const { freePort } = require("./helpers/free-port");
const { seedCloudAccountInDataDir } = require("./helpers/cloud-auth.js");

const dataDirsByPort = new Map();

async function startServer() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-sync-replay-"));
  const port = await freePort();
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["scripts/serve-cloud.js"], {
      env: {
        ...process.env,
        MIA_CLOUD_HOST: "127.0.0.1",
        MIA_CLOUD_PORT: String(port),
        MIA_CLOUD_DATA: tmpDir,
        // Necessary so token can travel via ?token= rather than the
        // sec-websocket-protocol subprotocol header.
        MIA_CLOUD_ALLOW_QUERY_TOKEN: "1",
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

function openEvents(port, token, sinceSeq = 0) {
  const url = `ws://127.0.0.1:${port}/api/events?token=${encodeURIComponent(token)}&since_seq=${sinceSeq}`;
  return new WebSocket(url);
}

function collectEvents(ws, predicate) {
  return new Promise((resolve, reject) => {
    const events = [];
    const timer = setTimeout(() => resolve(events), 1500);
    ws.on("message", (raw) => {
      try {
        const e = JSON.parse(raw.toString());
        events.push(e);
        if (predicate && predicate(events)) {
          clearTimeout(timer);
          resolve(events);
        }
      } catch { /* ignore non-json frames */ }
    });
    ws.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

test("WS reconnect with since_seq replays every persisted event missed while offline", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "alpha");
    const B = await register(ctx.port, "bravo");
    // Cause some events: A friends B, both accept
    const req = await api(ctx.port, "POST", "/api/social/friend-requests",
      { token: A.token, body: { toUsername: B.user.username } });
    await api(ctx.port, "POST", `/api/social/friend-requests/${req.body.request.id}/respond`,
      { token: B.token, body: { action: "accept" } });

    // A is offline during the next batch of activity — send 5 messages
    // from B to the freshly-created DM conversation.
    const dmConversation = `dm:${[A.user.id, B.user.id].sort().join(":")}`;
    for (let i = 1; i <= 5; i++) {
      const r = await api(ctx.port, "POST", `/api/conversations/${dmConversation}/messages`,
        { token: B.token, body: { bodyMd: `hello ${i}` } });
      assert.ok(r.status === 200 || r.status === 201, `msg ${i}: ${r.status}`);
    }

    // A now "connects" with since_seq=0 → server should replay everything.
    const ws = openEvents(ctx.port, A.token, 0);
    const events = await collectEvents(ws, (collected) => {
      // wait until we've seen events_ready + all 5 replayed message events
      const messages = collected.filter((e) => e.type === "conversation.message_appended" && e.replay);
      return messages.length >= 5;
    });
    ws.close();

    const ready = events.find((e) => e.type === "events_ready");
    assert.ok(ready, "events_ready should be the first frame");
    assert.equal(ready.sinceSeq, 0);
    assert.ok(ready.serverSeq >= 5, `serverSeq should reflect appended events (got ${ready.serverSeq})`);

    const replayed = events.filter((e) => e.replay && e.type === "conversation.message_appended");
    assert.equal(replayed.length, 5, `expected 5 replayed messages, got ${replayed.length}`);
    // Seq monotonic and ordered
    const seqs = replayed.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  } finally {
    await stopServer(ctx);
  }
});

test("WS connecting with up-to-date since_seq receives no replay", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "gamma");
    const B = await register(ctx.port, "delta");
    const req = await api(ctx.port, "POST", "/api/social/friend-requests",
      { token: A.token, body: { toUsername: B.user.username } });
    await api(ctx.port, "POST", `/api/social/friend-requests/${req.body.request.id}/respond`,
      { token: B.token, body: { action: "accept" } });

    // First connect to discover the current serverSeq.
    const ws1 = openEvents(ctx.port, A.token, 0);
    const first = await collectEvents(ws1, (collected) => collected.some((e) => e.type === "events_ready") && collected.length > 0);
    const ready = first.find((e) => e.type === "events_ready");
    const currentSeq = ready.serverSeq;
    ws1.close();
    await new Promise((r) => setTimeout(r, 100));

    // Reconnect at the current seq — server should send events_ready and nothing else.
    const ws2 = openEvents(ctx.port, A.token, currentSeq);
    const second = await collectEvents(ws2, () => false);  // wait full timeout
    ws2.close();

    const replayed = second.filter((e) => e.replay);
    assert.equal(replayed.length, 0, "no replay when up to date");
    const ready2 = second.find((e) => e.type === "events_ready");
    assert.ok(ready2);
    assert.equal(ready2.sinceSeq, currentSeq);
    assert.equal(ready2.serverSeq, currentSeq);
  } finally {
    await stopServer(ctx);
  }
});
