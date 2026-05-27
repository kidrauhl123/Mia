const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const WebSocket = require("ws");
const { freePort } = require("./helpers/free-port");

async function startServer() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-api-test-"));
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
    const done = () => { if (!resolved) { resolved = true; resolve({ proc, port, tmpDir }); } };
    proc.stdout.on("data", (chunk) => { if (/listening|Listening/.test(chunk.toString())) done(); });
    proc.stderr.on("data", (chunk) => { if (/listening|Listening|mia-cloud/i.test(chunk.toString())) done(); });
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

async function friendUp(port, a, b) {
  const created = await api(port, "POST", "/api/social/friend-requests", {
    token: a.token,
    body: { toUsername: b.user.username }
  });
  if (created.status !== 201) throw new Error("friend request failed: " + JSON.stringify(created));
  const accepted = await api(port, "POST", "/api/social/friend-requests/" + created.body.request.id + "/respond", {
    token: b.token,
    body: { action: "accept" }
  });
  if (accepted.status !== 200) throw new Error("friend accept failed: " + JSON.stringify(accepted));
  return accepted.body.conversation;
}

test("POST /api/social/friend-requests creates pending request", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const r = await api(ctx.port, "POST", "/api/social/friend-requests", {
      token: alice.token,
      body: { toUsername: "bob" }
    });
    assert.equal(r.status, 201);
    assert.ok(r.body.request.id);
    assert.equal(r.body.request.status, "pending");
    assert.equal(r.body.request.from_user, alice.user.id);
    assert.equal(r.body.request.to_user, bob.user.id);
  } finally { await stopServer(ctx); }
});

test("POST /api/social/friend-requests → 404 unknown user", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const r = await api(ctx.port, "POST", "/api/social/friend-requests", {
      token: alice.token,
      body: { toUsername: "nobody_here" }
    });
    assert.equal(r.status, 404);
  } finally { await stopServer(ctx); }
});

test("POST /api/social/friend-requests → 400 self-add", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const r = await api(ctx.port, "POST", "/api/social/friend-requests", {
      token: alice.token,
      body: { toUsername: "alice" }
    });
    assert.equal(r.status, 400);
  } finally { await stopServer(ctx); }
});

test("POST /api/social/friend-requests → 409 already friends", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    await friendUp(ctx.port, alice, bob);
    const r = await api(ctx.port, "POST", "/api/social/friend-requests", {
      token: alice.token,
      body: { toUsername: "bob" }
    });
    assert.equal(r.status, 409);
  } finally { await stopServer(ctx); }
});

test("POST /api/social/friend-requests → 409 duplicate pending", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    await register(ctx.port, "bob");
    await api(ctx.port, "POST", "/api/social/friend-requests", { token: alice.token, body: { toUsername: "bob" } });
    const r = await api(ctx.port, "POST", "/api/social/friend-requests", { token: alice.token, body: { toUsername: "bob" } });
    assert.equal(r.status, 409);
  } finally { await stopServer(ctx); }
});

test("POST /api/social/friend-requests → 400 missing toUsername", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const r = await api(ctx.port, "POST", "/api/social/friend-requests", {
      token: alice.token,
      body: {}
    });
    assert.equal(r.status, 400);
  } finally { await stopServer(ctx); }
});

test("POST /:id/respond accept creates friendship + DM conversation + returns both", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const created = await api(ctx.port, "POST", "/api/social/friend-requests", {
      token: alice.token, body: { toUsername: "bob" }
    });
    const accept = await api(ctx.port, "POST", "/api/social/friend-requests/" + created.body.request.id + "/respond", {
      token: bob.token, body: { action: "accept" }
    });
    assert.equal(accept.status, 200);
    assert.equal(accept.body.friend.id, alice.user.id);
    assert.ok(accept.body.conversation.id.startsWith("dm:"));
    assert.equal(accept.body.request.status, "accepted");
  } finally { await stopServer(ctx); }
});

test("POST /:id/respond reject returns 200 without friend/conversation", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const created = await api(ctx.port, "POST", "/api/social/friend-requests", {
      token: alice.token, body: { toUsername: "bob" }
    });
    const reject = await api(ctx.port, "POST", "/api/social/friend-requests/" + created.body.request.id + "/respond", {
      token: bob.token, body: { action: "reject" }
    });
    assert.equal(reject.status, 200);
    assert.equal(reject.body.request.status, "rejected");
    assert.equal(reject.body.friend, undefined);
    assert.equal(reject.body.conversation, undefined);
  } finally { await stopServer(ctx); }
});

test("POST /:id/respond → 400 invalid action", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const created = await api(ctx.port, "POST", "/api/social/friend-requests", {
      token: alice.token, body: { toUsername: "bob" }
    });
    const r = await api(ctx.port, "POST", "/api/social/friend-requests/" + created.body.request.id + "/respond", {
      token: bob.token, body: { action: "maybe" }
    });
    assert.equal(r.status, 400);
  } finally { await stopServer(ctx); }
});

test("POST /:id/respond → 400 non-recipient cannot respond", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const created = await api(ctx.port, "POST", "/api/social/friend-requests", {
      token: alice.token, body: { toUsername: "bob" }
    });
    // Alice tries to accept her own request
    const r = await api(ctx.port, "POST", "/api/social/friend-requests/" + created.body.request.id + "/respond", {
      token: alice.token, body: { action: "accept" }
    });
    assert.equal(r.status, 400);
  } finally { await stopServer(ctx); }
});

test("DELETE /api/social/friend-requests/:id cancels by sender", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const created = await api(ctx.port, "POST", "/api/social/friend-requests", {
      token: alice.token, body: { toUsername: "bob" }
    });
    const del = await api(ctx.port, "DELETE", "/api/social/friend-requests/" + created.body.request.id, {
      token: alice.token
    });
    assert.equal(del.status, 200);
    assert.equal(del.body.request.status, "cancelled");

    // bob can no longer accept
    const r = await api(ctx.port, "POST", "/api/social/friend-requests/" + created.body.request.id + "/respond", {
      token: bob.token, body: { action: "accept" }
    });
    assert.equal(r.status, 400);
  } finally { await stopServer(ctx); }
});

test("DELETE /api/social/friend-requests/:id → 400 non-sender cannot cancel", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const created = await api(ctx.port, "POST", "/api/social/friend-requests", {
      token: alice.token, body: { toUsername: "bob" }
    });
    const r = await api(ctx.port, "DELETE", "/api/social/friend-requests/" + created.body.request.id, {
      token: bob.token
    });
    assert.equal(r.status, 400);
  } finally { await stopServer(ctx); }
});

test("GET /api/social/friend-requests?direction=incoming lists incoming", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    await api(ctx.port, "POST", "/api/social/friend-requests", { token: alice.token, body: { toUsername: "bob" } });
    const list = await api(ctx.port, "GET", "/api/social/friend-requests?direction=incoming", { token: bob.token });
    assert.equal(list.status, 200);
    assert.equal(list.body.requests.length, 1);
    assert.equal(list.body.requests[0].from_user, alice.user.id);
    assert.ok(list.body.requests[0].other);
    assert.equal(list.body.requests[0].other.id, alice.user.id);
  } finally { await stopServer(ctx); }
});

test("GET /api/social/friend-requests?direction=outgoing lists outgoing", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    await register(ctx.port, "bob");
    await api(ctx.port, "POST", "/api/social/friend-requests", { token: alice.token, body: { toUsername: "bob" } });
    const list = await api(ctx.port, "GET", "/api/social/friend-requests?direction=outgoing", { token: alice.token });
    assert.equal(list.status, 200);
    assert.equal(list.body.requests.length, 1);
    assert.ok(list.body.requests[0].other);
  } finally { await stopServer(ctx); }
});

test("GET /api/social/friends lists accepted friends", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    await friendUp(ctx.port, alice, bob);
    const aliceList = await api(ctx.port, "GET", "/api/social/friends", { token: alice.token });
    assert.equal(aliceList.status, 200);
    assert.equal(aliceList.body.friends.length, 1);
    assert.equal(aliceList.body.friends[0].id, bob.user.id);
    const bobList = await api(ctx.port, "GET", "/api/social/friends", { token: bob.token });
    assert.equal(bobList.body.friends[0].id, alice.user.id);
  } finally { await stopServer(ctx); }
});

test("DELETE /api/social/friends/:userId removes friendship but keeps DM conversation", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    await friendUp(ctx.port, alice, bob);
    const del = await api(ctx.port, "DELETE", "/api/social/friends/" + bob.user.id, { token: alice.token });
    assert.equal(del.status, 200);
    const aliceList = await api(ctx.port, "GET", "/api/social/friends", { token: alice.token });
    assert.equal(aliceList.body.friends.length, 0);
  } finally { await stopServer(ctx); }
});

test("POST /api/conversations/:id/messages sends to DM conversation, server assigns seq", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const conversation = await friendUp(ctx.port, alice, bob);
    const m1 = await api(ctx.port, "POST", "/api/conversations/" + conversation.id + "/messages", {
      token: alice.token, body: { bodyMd: "hi bob" }
    });
    assert.equal(m1.status, 201);
    assert.equal(m1.body.message.seq, 1);
    assert.equal(m1.body.message.sender_ref, alice.user.id);
    const m2 = await api(ctx.port, "POST", "/api/conversations/" + conversation.id + "/messages", {
      token: bob.token, body: { bodyMd: "sup" }
    });
    assert.equal(m2.body.message.seq, 2);
  } finally { await stopServer(ctx); }
});

test("GET /api/conversations/:id/messages?since_seq=N returns incremental", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const conversation = await friendUp(ctx.port, alice, bob);
    for (let i = 1; i <= 5; i++) {
      await api(ctx.port, "POST", "/api/conversations/" + conversation.id + "/messages", { token: alice.token, body: { bodyMd: "m" + i } });
    }
    const r = await api(ctx.port, "GET", "/api/conversations/" + conversation.id + "/messages?since_seq=2", { token: bob.token });
    assert.equal(r.status, 200);
    assert.equal(r.body.messages.length, 3);
    assert.deepEqual(r.body.messages.map((m) => m.seq), [3, 4, 5]);
  } finally { await stopServer(ctx); }
});

test("POST to conversation user is not member of returns 403", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const charlie = await register(ctx.port, "charlie");
    const conversation = await friendUp(ctx.port, alice, bob);
    const r = await api(ctx.port, "POST", "/api/conversations/" + conversation.id + "/messages", { token: charlie.token, body: { bodyMd: "intruder" } });
    assert.equal(r.status, 403);
  } finally { await stopServer(ctx); }
});

test("DELETE message hides it for the deleter only — other members keep their copy", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const conversation = await friendUp(ctx.port, alice, bob);
    const posted = await api(ctx.port, "POST", "/api/conversations/" + conversation.id + "/messages", {
      token: alice.token, body: { bodyMd: "alice's message" }
    });
    assert.equal(posted.status, 201);
    const msgId = posted.body.message.id;
    // Bob deletes Alice's message — WeChat-style local delete, not a recall.
    const del = await api(ctx.port, "DELETE", "/api/conversations/" + conversation.id + "/messages/" + msgId, { token: bob.token });
    assert.equal(del.status, 200);
    // Bob's history drops it.
    const bobList = await api(ctx.port, "GET", "/api/conversations/" + conversation.id + "/messages?since_seq=0", { token: bob.token });
    assert.deepEqual(bobList.body.messages.map((m) => m.id), []);
    // Alice's history is UNTOUCHED — a member must never delete from another's view.
    const aliceList = await api(ctx.port, "GET", "/api/conversations/" + conversation.id + "/messages?since_seq=0", { token: alice.token });
    assert.deepEqual(aliceList.body.messages.map((m) => m.id), [msgId]);
  } finally { await stopServer(ctx); }
});

test("DELETE message → 403 non-member, 404 missing id", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const charlie = await register(ctx.port, "charlie");
    const conversation = await friendUp(ctx.port, alice, bob);
    const posted = await api(ctx.port, "POST", "/api/conversations/" + conversation.id + "/messages", {
      token: alice.token, body: { bodyMd: "hi" }
    });
    const msgId = posted.body.message.id;
    const intruder = await api(ctx.port, "DELETE", "/api/conversations/" + conversation.id + "/messages/" + msgId, { token: charlie.token });
    assert.equal(intruder.status, 403);
    const missing = await api(ctx.port, "DELETE", "/api/conversations/" + conversation.id + "/messages/m_nope", { token: alice.token });
    assert.equal(missing.status, 404);
  } finally { await stopServer(ctx); }
});

test("POST to DM conversation id derives membership from friendship even before explicit conversation", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const dmId = "dm:" + [alice.user.id, bob.user.id].sort().join(":");
    const r1 = await api(ctx.port, "POST", "/api/conversations/" + dmId + "/messages", { token: alice.token, body: { bodyMd: "hi" } });
    assert.equal(r1.status, 403, "non-friends cannot start DM");

    await friendUp(ctx.port, alice, bob);
    const r2 = await api(ctx.port, "POST", "/api/conversations/" + dmId + "/messages", { token: alice.token, body: { bodyMd: "hi friend" } });
    assert.equal(r2.status, 201);
  } finally { await stopServer(ctx); }
});

test("GET /api/conversations lists current user's conversations", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    await friendUp(ctx.port, alice, bob);
    const list = await api(ctx.port, "GET", "/api/conversations", { token: alice.token });
    assert.equal(list.status, 200);
    const dmConversations = list.body.conversations.filter((conversation) => conversation.id.startsWith("dm:"));
    assert.equal(dmConversations.length, 1);
  } finally { await stopServer(ctx); }
});

test("GET /api/conversations/:id returns conversation + members", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const conversation = await friendUp(ctx.port, alice, bob);
    const r = await api(ctx.port, "GET", "/api/conversations/" + conversation.id, { token: alice.token });
    assert.equal(r.status, 200);
    assert.equal(r.body.conversation.id, conversation.id);
    assert.equal(r.body.members.length, 2);
  } finally { await stopServer(ctx); }
});

test("GET /api/conversations/:id returns fellow owner without profile avatar payloads", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const avatarImage = "data:image/gif;base64," + "A".repeat(200_000);
    const profile = await api(ctx.port, "PATCH", "/api/me/profile", {
      token: alice.token,
      body: {
        avatarImage,
        avatarCrop: { x: 1, y: 2, zoom: 3 },
        avatarColor: "#111827"
      }
    });
    assert.equal(profile.status, 200);

    const ensured = await api(ctx.port, "PUT", "/api/me/fellows/bot/conversation", {
      token: alice.token,
      body: { title: "Bot", runtimeKind: "desktop-local" }
    });
    assert.equal(ensured.status, 200);

    const detail = await api(ctx.port, "GET", "/api/conversations/" + ensured.body.conversation.id, { token: alice.token });
    assert.equal(detail.status, 200);
    const fellowMember = detail.body.members.find((member) => member.member_kind === "fellow");
    assert.equal(fellowMember.owner.id, alice.user.id);
    assert.equal(fellowMember.owner.username, alice.user.username);
    assert.equal(Object.prototype.hasOwnProperty.call(fellowMember.owner, "avatarImage"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(fellowMember.owner, "avatarCrop"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(fellowMember.owner, "avatarColor"), false);
  } finally { await stopServer(ctx); }
});

function openEventsWs(port, token) {
  const ws = new WebSocket(
    "ws://127.0.0.1:" + port + "/api/events",
    ["mia-token." + token]
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

test("respond accept emits social.friend_added to both users", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const aliceWs = await openEventsWs(ctx.port, alice.token);
    const bobWs = await openEventsWs(ctx.port, bob.token);
    try {
      const created = await api(ctx.port, "POST", "/api/social/friend-requests", {
        token: alice.token, body: { toUsername: "bob" }
      });
      await api(ctx.port, "POST", "/api/social/friend-requests/" + created.body.request.id + "/respond", {
        token: bob.token, body: { action: "accept" }
      });
      const ae = await waitForEvent(aliceWs.events, (e) => e.type === "social.friend_added");
      const be = await waitForEvent(bobWs.events, (e) => e.type === "social.friend_added");
      assert.equal(ae.friend.id, bob.user.id);
      assert.equal(be.friend.id, alice.user.id);
      assert.ok(ae.conversation.id.startsWith("dm:"));
    } finally {
      aliceWs.ws.close();
      bobWs.ws.close();
    }
  } finally { await stopServer(ctx); }
});

test("POST friend-request emits social.friend_request_received to recipient", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const bobWs = await openEventsWs(ctx.port, bob.token);
    try {
      await api(ctx.port, "POST", "/api/social/friend-requests", {
        token: alice.token, body: { toUsername: "bob" }
      });
      const evt = await waitForEvent(bobWs.events, (e) => e.type === "social.friend_request_received");
      assert.equal(evt.request.from.id, alice.user.id);
      assert.equal(evt.request.to_user, bob.user.id);
    } finally {
      bobWs.ws.close();
    }
  } finally { await stopServer(ctx); }
});

test("post DM message emits conversation.message_appended to both members", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    await friendUp(ctx.port, alice, bob);
    const aliceWs = await openEventsWs(ctx.port, alice.token);
    const bobWs = await openEventsWs(ctx.port, bob.token);
    try {
      const dmId = "dm:" + [alice.user.id, bob.user.id].sort().join(":");
      await api(ctx.port, "POST", "/api/conversations/" + dmId + "/messages", { token: alice.token, body: { bodyMd: "boo" } });
      const ae = await waitForEvent(aliceWs.events, (e) => e.type === "conversation.message_appended");
      const be = await waitForEvent(bobWs.events, (e) => e.type === "conversation.message_appended");
      assert.equal(ae.message.seq, 1);
      assert.equal(ae.message.body_md, "boo");
      assert.equal(be.message.body_md, "boo");
    } finally {
      aliceWs.ws.close();
      bobWs.ws.close();
    }
  } finally { await stopServer(ctx); }
});

test("end-to-end: two users meet, friend up, exchange DM messages with seq", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");

    const created = await api(ctx.port, "POST", "/api/social/friend-requests", {
      token: alice.token, body: { toUsername: "bob" }
    });
    assert.equal(created.status, 201);

    const accepted = await api(ctx.port, "POST", "/api/social/friend-requests/" + created.body.request.id + "/respond", {
      token: bob.token, body: { action: "accept" }
    });
    assert.equal(accepted.status, 200);
    const conversationId = accepted.body.conversation.id;

    const aFriends = await api(ctx.port, "GET", "/api/social/friends", { token: alice.token });
    assert.equal(aFriends.body.friends.length, 1);

    const aConversations = await api(ctx.port, "GET", "/api/conversations", { token: alice.token });
    const dmConversations = aConversations.body.conversations.filter((conversation) => conversation.id.startsWith("dm:"));
    assert.equal(dmConversations.length, 1);
    assert.equal(dmConversations[0].id, conversationId);

    const m1 = await api(ctx.port, "POST", "/api/conversations/" + conversationId + "/messages", { token: alice.token, body: { bodyMd: "hi bob" } });
    const m2 = await api(ctx.port, "POST", "/api/conversations/" + conversationId + "/messages", { token: bob.token, body: { bodyMd: "hey alice" } });
    const m3 = await api(ctx.port, "POST", "/api/conversations/" + conversationId + "/messages", { token: alice.token, body: { bodyMd: "tomorrow at 9?" } });
    assert.deepEqual([m1.body.message.seq, m2.body.message.seq, m3.body.message.seq], [1, 2, 3]);

    const all = await api(ctx.port, "GET", "/api/conversations/" + conversationId + "/messages?since_seq=0", { token: bob.token });
    assert.equal(all.body.messages.length, 3);
    assert.deepEqual(all.body.messages.map((m) => m.body_md), ["hi bob", "hey alice", "tomorrow at 9?"]);

    const partial = await api(ctx.port, "GET", "/api/conversations/" + conversationId + "/messages?since_seq=1", { token: bob.token });
    assert.equal(partial.body.messages.length, 2);
    assert.deepEqual(partial.body.messages.map((m) => m.seq), [2, 3]);
  } finally { await stopServer(ctx); }
});

// ── Phase 4.1: Group conversations + fellow members + cross-user invocation ──

async function setupGroupScenario(port) {
  const alice = await register(port, "alice");
  const bob = await register(port, "bob");
  const created = await api(port, "POST", "/api/social/friend-requests", { token: alice.token, body: { toUsername: "bob" } });
  await api(port, "POST", "/api/social/friend-requests/" + created.body.request.id + "/respond", { token: bob.token, body: { action: "accept" } });
  return { alice, bob };
}

test("POST /api/conversations creates group with creator + fellow + friend members", async () => {
  const ctx = await startServer();
  try {
    const { alice, bob } = await setupGroupScenario(ctx.port);
    const r = await api(ctx.port, "POST", "/api/conversations", {
      token: alice.token,
      body: {
        name: "Test Squad",
        memberFellows: [{ fellowId: "codex" }],
        memberFriendUserIds: [bob.user.id]
      }
    });
    assert.equal(r.status, 201);
    assert.ok(r.body.conversation.id.startsWith("g_"));
    assert.equal(r.body.conversation.name, "Test Squad");
    const members = r.body.members;
    assert.equal(members.length, 3); // alice + codex + bob
    const userMembers = members.filter((m) => m.member_kind === "user").map((m) => m.member_ref).sort();
    assert.deepEqual(userMembers, [alice.user.id, bob.user.id].sort());
    const fellowMembers = members.filter((m) => m.member_kind === "fellow");
    assert.equal(fellowMembers.length, 1);
    assert.equal(fellowMembers[0].member_ref, "codex");
    assert.equal(fellowMembers[0].owner_id, alice.user.id);
  } finally { await stopServer(ctx); }
});

test("POST /api/conversations refuses non-friend in memberFriendUserIds", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const stranger = await register(ctx.port, "stranger");
    const r = await api(ctx.port, "POST", "/api/conversations", {
      token: alice.token,
      body: { name: "x", memberFellows: [], memberFriendUserIds: [stranger.user.id] }
    });
    assert.equal(r.status, 403);
  } finally { await stopServer(ctx); }
});

test("POST /api/conversations/:id/members adds friend after group exists", async () => {
  const ctx = await startServer();
  try {
    const { alice, bob } = await setupGroupScenario(ctx.port);
    const charlie = await register(ctx.port, "charlie");
    // alice friends charlie
    const fr = await api(ctx.port, "POST", "/api/social/friend-requests", { token: alice.token, body: { toUsername: "charlie" } });
    await api(ctx.port, "POST", "/api/social/friend-requests/" + fr.body.request.id + "/respond", { token: charlie.token, body: { action: "accept" } });
    // create group with bob
    const grp = await api(ctx.port, "POST", "/api/conversations", {
      token: alice.token,
      body: { name: "G", memberFellows: [], memberFriendUserIds: [bob.user.id] }
    });
    // add charlie later
    const add = await api(ctx.port, "POST", "/api/conversations/" + grp.body.conversation.id + "/members", {
      token: alice.token,
      body: { memberKind: "user", memberRef: charlie.user.id }
    });
    assert.equal(add.status, 201);
    const detail = await api(ctx.port, "GET", "/api/conversations/" + grp.body.conversation.id, { token: alice.token });
    assert.equal(detail.body.members.length, 3);
  } finally { await stopServer(ctx); }
});

test("POST /api/conversations/:id/members rejects pulling someone else's fellow", async () => {
  const ctx = await startServer();
  try {
    const { alice, bob } = await setupGroupScenario(ctx.port);
    const grp = await api(ctx.port, "POST", "/api/conversations", {
      token: alice.token,
      body: { name: "G", memberFellows: [], memberFriendUserIds: [bob.user.id] }
    });
    // bob tries to pull alice's fellow (owner_id=alice.user.id) — should fail
    const add = await api(ctx.port, "POST", "/api/conversations/" + grp.body.conversation.id + "/members", {
      token: bob.token,
      body: { memberKind: "fellow", memberRef: "codex", ownerId: alice.user.id }
    });
    assert.equal(add.status, 403);
  } finally { await stopServer(ctx); }
});

test("POST /messages/as-fellow allows owner to post on behalf of own fellow", async () => {
  const ctx = await startServer();
  try {
    const { alice, bob } = await setupGroupScenario(ctx.port);
    const grp = await api(ctx.port, "POST", "/api/conversations", {
      token: alice.token,
      body: { name: "G", memberFellows: [{ fellowId: "codex" }], memberFriendUserIds: [bob.user.id] }
    });
    const r = await api(ctx.port, "POST", "/api/conversations/" + grp.body.conversation.id + "/messages/as-fellow", {
      token: alice.token,
      body: { fellowId: "codex", bodyMd: "Hello from Codex" }
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.message.sender_kind, "fellow");
    assert.equal(r.body.message.sender_ref, "codex");
    assert.equal(r.body.message.sender_owner_id, alice.user.id);
    assert.equal(r.body.message.body_md, "Hello from Codex");
  } finally { await stopServer(ctx); }
});

test("POST /messages/as-fellow rejects non-owner", async () => {
  const ctx = await startServer();
  try {
    const { alice, bob } = await setupGroupScenario(ctx.port);
    const grp = await api(ctx.port, "POST", "/api/conversations", {
      token: alice.token,
      body: { name: "G", memberFellows: [{ fellowId: "codex" }], memberFriendUserIds: [bob.user.id] }
    });
    // bob tries to post as alice's codex
    const r = await api(ctx.port, "POST", "/api/conversations/" + grp.body.conversation.id + "/messages/as-fellow", {
      token: bob.token,
      body: { fellowId: "codex", bodyMd: "fake" }
    });
    assert.equal(r.status, 403);
  } finally { await stopServer(ctx); }
});

test("fellow mention in group message triggers conversation.fellow_invocation_requested to owner", async () => {
  const ctx = await startServer();
  try {
    const { alice, bob } = await setupGroupScenario(ctx.port);
    const grp = await api(ctx.port, "POST", "/api/conversations", {
      token: alice.token,
      body: { name: "G", memberFellows: [{ fellowId: "codex" }], memberFriendUserIds: [bob.user.id] }
    });
    const aliceWs = await openEventsWs(ctx.port, alice.token);
    try {
      await api(ctx.port, "POST", "/api/conversations/" + grp.body.conversation.id + "/messages", {
        token: bob.token,
        body: { bodyMd: "@codex help me", mentions: [{ kind: "fellow", fellowId: "codex" }] }
      });
      const inv = await waitForEvent(aliceWs.events, (e) => e.type === "conversation.fellow_invocation_requested");
      assert.equal(inv.fellowId, "codex");
      assert.equal(inv.invokedBy.id, bob.user.id);
      assert.ok(Array.isArray(inv.recentMessages));
      assert.ok(inv.triggeringMessage.body_md.includes("help me"));
    } finally {
      aliceWs.ws.close();
    }
  } finally { await stopServer(ctx); }
});
