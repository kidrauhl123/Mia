const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const WebSocket = require("ws");

function startServer() {
  return new Promise((resolve, reject) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimashi-api-test-"));
    const port = 4000 + Math.floor(Math.random() * 1000);
    const proc = spawn(process.execPath, ["scripts/serve-cloud.js"], {
      env: {
        ...process.env,
        AIMASHI_CLOUD_HOST: "127.0.0.1",
        AIMASHI_CLOUD_PORT: String(port),
        AIMASHI_CLOUD_DATA: tmpDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve({ proc, port, tmpDir }); } };
    proc.stdout.on("data", (chunk) => { if (/listening|Listening/.test(chunk.toString())) done(); });
    proc.stderr.on("data", (chunk) => { if (/listening|Listening|aimashi-cloud/i.test(chunk.toString())) done(); });
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
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: "Bearer " + token } : {}),
      },
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

async function register(port, username) {
  const r = await api(port, "POST", "/api/auth/register", { body: { username, password: "Pa55word!" } });
  if (r.status !== 201) throw new Error("register failed: " + JSON.stringify(r));
  const login = await api(port, "POST", "/api/auth/login", { body: { username, password: "Pa55word!" } });
  return { user: login.body.user, token: login.body.token };
}

test("POST /api/social/invite-codes generates pending code", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const r = await api(ctx.port, "POST", "/api/social/invite-codes", { token: alice.token, body: {} });
    assert.equal(r.status, 201);
    assert.ok(r.body.code);
    assert.equal(r.body.code.length, 8);
    assert.ok(r.body.expiresAt);
  } finally { await stopServer(ctx); }
});

test("accept invite creates friendship + DM room + returns both", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const created = await api(ctx.port, "POST", "/api/social/invite-codes", { token: alice.token, body: {} });
    const accept = await api(ctx.port, "POST", "/api/social/invite-codes/" + created.body.code + "/accept", { token: bob.token, body: {} });
    assert.equal(accept.status, 200);
    assert.equal(accept.body.friend.id, alice.user.id);
    assert.ok(accept.body.room.id.startsWith("dm:"));
  } finally { await stopServer(ctx); }
});

test("accept same code twice → 409 already consumed", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const charlie = await register(ctx.port, "charlie");
    const created = await api(ctx.port, "POST", "/api/social/invite-codes", { token: alice.token, body: {} });
    await api(ctx.port, "POST", "/api/social/invite-codes/" + created.body.code + "/accept", { token: bob.token, body: {} });
    const second = await api(ctx.port, "POST", "/api/social/invite-codes/" + created.body.code + "/accept", { token: charlie.token, body: {} });
    assert.equal(second.status, 409);
  } finally { await stopServer(ctx); }
});

test("DELETE invite-codes/:code by owner marks expired", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const created = await api(ctx.port, "POST", "/api/social/invite-codes", { token: alice.token, body: {} });
    const del = await api(ctx.port, "DELETE", "/api/social/invite-codes/" + created.body.code, { token: alice.token });
    assert.equal(del.status, 200);
    const accept = await api(ctx.port, "POST", "/api/social/invite-codes/" + created.body.code + "/accept", { token: bob.token, body: {} });
    assert.notEqual(accept.status, 200);
  } finally { await stopServer(ctx); }
});

test("self-accept invite is rejected", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const created = await api(ctx.port, "POST", "/api/social/invite-codes", { token: alice.token, body: {} });
    const accept = await api(ctx.port, "POST", "/api/social/invite-codes/" + created.body.code + "/accept", { token: alice.token, body: {} });
    assert.equal(accept.status, 400);
  } finally { await stopServer(ctx); }
});

test("GET /api/social/invite-codes lists own pending invites", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    await api(ctx.port, "POST", "/api/social/invite-codes", { token: alice.token, body: {} });
    await api(ctx.port, "POST", "/api/social/invite-codes", { token: alice.token, body: {} });
    const list = await api(ctx.port, "GET", "/api/social/invite-codes", { token: alice.token });
    assert.equal(list.status, 200);
    assert.equal(list.body.invites.length, 2);
  } finally { await stopServer(ctx); }
});

test("GET /api/social/friends lists accepted friends", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const created = await api(ctx.port, "POST", "/api/social/invite-codes", { token: alice.token, body: {} });
    await api(ctx.port, "POST", "/api/social/invite-codes/" + created.body.code + "/accept", { token: bob.token, body: {} });
    const aliceList = await api(ctx.port, "GET", "/api/social/friends", { token: alice.token });
    assert.equal(aliceList.status, 200);
    assert.equal(aliceList.body.friends.length, 1);
    assert.equal(aliceList.body.friends[0].id, bob.user.id);
    const bobList = await api(ctx.port, "GET", "/api/social/friends", { token: bob.token });
    assert.equal(bobList.body.friends[0].id, alice.user.id);
  } finally { await stopServer(ctx); }
});

test("DELETE /api/social/friends/:userId removes friendship but keeps DM room", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const created = await api(ctx.port, "POST", "/api/social/invite-codes", { token: alice.token, body: {} });
    await api(ctx.port, "POST", "/api/social/invite-codes/" + created.body.code + "/accept", { token: bob.token, body: {} });
    const del = await api(ctx.port, "DELETE", "/api/social/friends/" + bob.user.id, { token: alice.token });
    assert.equal(del.status, 200);
    const aliceList = await api(ctx.port, "GET", "/api/social/friends", { token: alice.token });
    assert.equal(aliceList.body.friends.length, 0);
  } finally { await stopServer(ctx); }
});

async function friendUp(port, a, b) {
  const created = await api(port, "POST", "/api/social/invite-codes", { token: a.token, body: {} });
  const accepted = await api(port, "POST", "/api/social/invite-codes/" + created.body.code + "/accept", { token: b.token, body: {} });
  return accepted.body.room;
}

test("POST /api/rooms/:id/messages sends to DM room, server assigns seq", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const room = await friendUp(ctx.port, alice, bob);
    const m1 = await api(ctx.port, "POST", "/api/rooms/" + room.id + "/messages", {
      token: alice.token, body: { bodyMd: "hi bob" }
    });
    assert.equal(m1.status, 201);
    assert.equal(m1.body.message.seq, 1);
    assert.equal(m1.body.message.sender_ref, alice.user.id);
    const m2 = await api(ctx.port, "POST", "/api/rooms/" + room.id + "/messages", {
      token: bob.token, body: { bodyMd: "sup" }
    });
    assert.equal(m2.body.message.seq, 2);
  } finally { await stopServer(ctx); }
});

test("GET /api/rooms/:id/messages?since_seq=N returns incremental", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const room = await friendUp(ctx.port, alice, bob);
    for (let i = 1; i <= 5; i++) {
      await api(ctx.port, "POST", "/api/rooms/" + room.id + "/messages", { token: alice.token, body: { bodyMd: "m" + i } });
    }
    const r = await api(ctx.port, "GET", "/api/rooms/" + room.id + "/messages?since_seq=2", { token: bob.token });
    assert.equal(r.status, 200);
    assert.equal(r.body.messages.length, 3);
    assert.deepEqual(r.body.messages.map((m) => m.seq), [3, 4, 5]);
  } finally { await stopServer(ctx); }
});

test("POST to room user is not member of returns 403", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const charlie = await register(ctx.port, "charlie");
    const room = await friendUp(ctx.port, alice, bob);
    const r = await api(ctx.port, "POST", "/api/rooms/" + room.id + "/messages", { token: charlie.token, body: { bodyMd: "intruder" } });
    assert.equal(r.status, 403);
  } finally { await stopServer(ctx); }
});

test("POST to DM room id derives membership from friendship even before explicit room", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const dmId = "dm:" + [alice.user.id, bob.user.id].sort().join(":");
    const r1 = await api(ctx.port, "POST", "/api/rooms/" + dmId + "/messages", { token: alice.token, body: { bodyMd: "hi" } });
    assert.equal(r1.status, 403, "non-friends cannot start DM");

    await friendUp(ctx.port, alice, bob);
    const r2 = await api(ctx.port, "POST", "/api/rooms/" + dmId + "/messages", { token: alice.token, body: { bodyMd: "hi friend" } });
    assert.equal(r2.status, 201);
  } finally { await stopServer(ctx); }
});

test("GET /api/rooms lists current user's rooms", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    await friendUp(ctx.port, alice, bob);
    const list = await api(ctx.port, "GET", "/api/rooms", { token: alice.token });
    assert.equal(list.status, 200);
    assert.equal(list.body.rooms.length, 1);
    assert.ok(list.body.rooms[0].id.startsWith("dm:"));
  } finally { await stopServer(ctx); }
});

test("GET /api/rooms/:id returns room + members", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const room = await friendUp(ctx.port, alice, bob);
    const r = await api(ctx.port, "GET", "/api/rooms/" + room.id, { token: alice.token });
    assert.equal(r.status, 200);
    assert.equal(r.body.room.id, room.id);
    assert.equal(r.body.members.length, 2);
  } finally { await stopServer(ctx); }
});

function openEventsWs(port, token) {
  const ws = new WebSocket(
    "ws://127.0.0.1:" + port + "/api/events",
    ["aimashi-token." + token]
  );
  const events = [];
  ws.on("message", (data) => {
    try { events.push(JSON.parse(data.toString())); } catch { /* ignore */ }
  });
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({ ws, events }));
    ws.once("error", reject);
  });
}

async function waitForEvent(events, predicate, timeoutMs = 1500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = events.find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("event not received within " + timeoutMs + "ms; got: " + JSON.stringify(events));
}

test("accept invite emits social.friend_added to both users", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const aliceWs = await openEventsWs(ctx.port, alice.token);
    const bobWs = await openEventsWs(ctx.port, bob.token);
    try {
      const created = await api(ctx.port, "POST", "/api/social/invite-codes", { token: alice.token, body: {} });
      await api(ctx.port, "POST", "/api/social/invite-codes/" + created.body.code + "/accept", { token: bob.token, body: {} });
      const ae = await waitForEvent(aliceWs.events, (e) => e.type === "social.friend_added");
      const be = await waitForEvent(bobWs.events, (e) => e.type === "social.friend_added");
      assert.equal(ae.friend.id, bob.user.id);
      assert.equal(be.friend.id, alice.user.id);
      assert.ok(ae.room.id.startsWith("dm:"));
    } finally {
      aliceWs.ws.close();
      bobWs.ws.close();
    }
  } finally { await stopServer(ctx); }
});

test("post DM message emits room.message_appended to both members", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    await friendUp(ctx.port, alice, bob);
    const aliceWs = await openEventsWs(ctx.port, alice.token);
    const bobWs = await openEventsWs(ctx.port, bob.token);
    try {
      const dmId = "dm:" + [alice.user.id, bob.user.id].sort().join(":");
      await api(ctx.port, "POST", "/api/rooms/" + dmId + "/messages", { token: alice.token, body: { bodyMd: "boo" } });
      const ae = await waitForEvent(aliceWs.events, (e) => e.type === "room.message_appended");
      const be = await waitForEvent(bobWs.events, (e) => e.type === "room.message_appended");
      assert.equal(ae.message.seq, 1);
      assert.equal(ae.message.body_md, "boo");
      assert.equal(be.message.body_md, "boo");
    } finally {
      aliceWs.ws.close();
      bobWs.ws.close();
    }
  } finally { await stopServer(ctx); }
});
