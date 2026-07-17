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
const ids = require("../src/shared/ids.js");

const dataDirsByPort = new Map();

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
    const done = () => {
      if (!resolved) {
        resolved = true;
        dataDirsByPort.set(port, tmpDir);
        resolve({ proc, port, tmpDir });
      }
    };
    proc.stdout.on("data", (chunk) => { if (/listening|Listening/.test(chunk.toString())) done(); });
    proc.stderr.on("data", (chunk) => { if (/listening|Listening|mia-cloud/i.test(chunk.toString())) done(); });
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

function rawApi(port, method, pathStr, { token } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, path: pathStr, method,
      headers: {
        ...(token ? { authorization: "Bearer " + token } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => { chunks.push(c); });
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks)
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function register(port, username) {
  const dataDir = dataDirsByPort.get(port);
  if (!dataDir) throw new Error("missing test cloud data dir for port " + port);
  return seedCloudAccountInDataDir(dataDir, username);
}

async function createBot(port, account, botId, displayName = botId) {
  const response = await api(port, "PUT", "/api/me/bots/" + encodeURIComponent(botId), {
    token: account.token,
    body: { displayName }
  });
  if (response.status !== 200) throw new Error("create bot failed: " + JSON.stringify(response));
  return response.body.bot;
}

async function friendUp(port, a, b) {
  const created = await api(port, "POST", "/api/social/friend-requests", {
    token: a.token,
    body: { toUserId: b.user.id }
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
      body: { toUserId: bob.user.id }
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
      body: { toUserId: "9999999999" }
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
      body: { toUserId: alice.user.id }
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
      body: { toUserId: bob.user.id }
    });
    assert.equal(r.status, 409);
  } finally { await stopServer(ctx); }
});

test("POST /api/social/friend-requests → 409 duplicate pending", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    await api(ctx.port, "POST", "/api/social/friend-requests", { token: alice.token, body: { toUserId: bob.user.id } });
    const r = await api(ctx.port, "POST", "/api/social/friend-requests", { token: alice.token, body: { toUserId: bob.user.id } });
    assert.equal(r.status, 409);
  } finally { await stopServer(ctx); }
});

test("POST /api/social/friend-requests → 400 missing toUserId", async () => {
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
      token: alice.token, body: { toUserId: bob.user.id }
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
      token: alice.token, body: { toUserId: bob.user.id }
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
      token: alice.token, body: { toUserId: bob.user.id }
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
      token: alice.token, body: { toUserId: bob.user.id }
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
      token: alice.token, body: { toUserId: bob.user.id }
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
      token: alice.token, body: { toUserId: bob.user.id }
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
    await api(ctx.port, "POST", "/api/social/friend-requests", { token: alice.token, body: { toUserId: bob.user.id } });
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
    const bob = await register(ctx.port, "bob");
    await api(ctx.port, "POST", "/api/social/friend-requests", { token: alice.token, body: { toUserId: bob.user.id } });
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

test("conversation attachments are visible and downloadable by conversation members", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const charlie = await register(ctx.port, "charlie");
    const conversation = await friendUp(ctx.port, alice, bob);
    const bytes = Buffer.from("workbook bytes");
    const posted = await api(ctx.port, "POST", "/api/conversations/" + conversation.id + "/messages", {
      token: alice.token,
      body: {
        bodyMd: "发你一个表格",
        attachments: [{
          name: "世界杯赛果汇总.xlsx",
          mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          dataUrl: `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${bytes.toString("base64")}`
        }]
      }
    });
    assert.equal(posted.status, 201);
    const messageAttachments = JSON.parse(posted.body.message.attachments_json || "[]");
    assert.equal(messageAttachments.length, 1);
    assert.equal(messageAttachments[0].name, "世界杯赛果汇总.xlsx");
    assert.match(messageAttachments[0].url, /^\/api\/files\/file_/);

    const listed = await api(ctx.port, "GET", "/api/conversations/" + conversation.id + "/messages?since_seq=0", { token: bob.token });
    assert.equal(listed.status, 200);
    const listedAttachments = JSON.parse(listed.body.messages[0].attachments_json || "[]");
    assert.equal(listedAttachments[0].url, messageAttachments[0].url);

    const downloaded = await rawApi(ctx.port, "GET", messageAttachments[0].url, { token: bob.token });
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.body.toString("utf8"), "workbook bytes");
    assert.equal(downloaded.headers["content-type"], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

    const blocked = await rawApi(ctx.port, "GET", messageAttachments[0].url, { token: charlie.token });
    assert.equal(blocked.status, 404);
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

test("GET /messages latest + before_seq pages cover newest history in ascending display order", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const conversation = await friendUp(ctx.port, alice, bob);
    for (let i = 1; i <= 5; i++) {
      await api(ctx.port, "POST", "/api/conversations/" + conversation.id + "/messages", {
        token: alice.token,
        body: { bodyMd: "m" + i, clientOpId: "op_page_" + i },
      });
    }

    const latest = await api(ctx.port, "GET", "/api/conversations/" + conversation.id + "/messages?latest=1&limit=2", { token: bob.token });
    assert.equal(latest.status, 200);
    assert.deepEqual(latest.body.messages.map((message) => message.seq), [4, 5]);
    assert.deepEqual(latest.body.pageInfo, { oldestSeq: 4, newestSeq: 5, hasMoreBefore: true });

    const middle = await api(ctx.port, "GET", "/api/conversations/" + conversation.id + "/messages?before_seq=4&limit=2", { token: bob.token });
    assert.equal(middle.status, 200);
    assert.deepEqual(middle.body.messages.map((message) => message.seq), [2, 3]);
    assert.deepEqual(middle.body.pageInfo, { oldestSeq: 2, newestSeq: 3, hasMoreBefore: true });

    const oldest = await api(ctx.port, "GET", "/api/conversations/" + conversation.id + "/messages?before_seq=2&limit=2", { token: bob.token });
    assert.equal(oldest.status, 200);
    assert.deepEqual(oldest.body.messages.map((message) => message.seq), [1]);
    assert.equal(oldest.body.pageInfo.hasMoreBefore, false);

    const invalid = await api(ctx.port, "GET", "/api/conversations/" + conversation.id + "/messages?before_seq=0", { token: bob.token });
    assert.equal(invalid.status, 400);
  } finally { await stopServer(ctx); }
});

test("GET /api/conversations/search returns individual message hits across bot sessions", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    await createBot(ctx.port, alice, "bot_codex", "Codex");

    const first = await api(ctx.port, "PUT", "/api/me/bot-conversations/session_one", {
      token: alice.token,
      body: { botId: "bot_codex", title: "Codex one", runtimeKind: "desktop-local" }
    });
    const second = await api(ctx.port, "PUT", "/api/me/bot-conversations/session_two", {
      token: alice.token,
      body: { botId: "bot_codex", title: "Codex two", runtimeKind: "desktop-local" }
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.notEqual(first.body.conversation.id, second.body.conversation.id);

    await api(ctx.port, "POST", "/api/conversations/" + first.body.conversation.id + "/messages", {
      token: alice.token,
      body: { bodyMd: "searchable needle from first bot session" }
    });
    await api(ctx.port, "POST", "/api/conversations/" + second.body.conversation.id + "/messages", {
      token: alice.token,
      body: { bodyMd: "searchable needle from second bot session" }
    });

    const search = await api(ctx.port, "GET", "/api/conversations/search?q=searchable%20needle&limit=10", { token: alice.token });
    assert.equal(search.status, 200);
    const hits = search.body.results || [];
    assert.equal(hits.length, 2);
    assert.deepEqual(new Set(hits.map((hit) => hit.conversation.id)), new Set([
      first.body.conversation.id,
      second.body.conversation.id
    ]));
    assert.deepEqual(new Set(hits.map((hit) => hit.conversation.decorations.botId)), new Set(["bot_codex"]));
    assert.deepEqual(new Set(hits.map((hit) => hit.message.body_md)), new Set([
      "searchable needle from first bot session",
      "searchable needle from second bot session"
    ]));
    assert.equal(hits.every((hit) => String(hit.matchText || "").includes("searchable needle")), true);
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
    const conversation = await friendUp(ctx.port, alice, bob);
    const posted = await api(ctx.port, "POST", "/api/conversations/" + conversation.id + "/messages", {
      token: bob.token,
      body: { bodyMd: "hello from bob" }
    });
    assert.equal(posted.status, 201);
    const list = await api(ctx.port, "GET", "/api/conversations", { token: alice.token });
    assert.equal(list.status, 200);
    const dmConversations = list.body.conversations.filter((conversation) => conversation.id.startsWith("dm:"));
    assert.equal(dmConversations.length, 1);
    assert.equal(dmConversations[0].last_message_text, "hello from bob");
    assert.equal(dmConversations[0].lastMessageText, "hello from bob");
    assert.equal(dmConversations[0].last_message_seq, 1);
    assert.equal(dmConversations[0].lastMessageSeq, 1);
    assert.equal(dmConversations[0].last_activity_at, posted.body.message.created_at);

    const withMembers = await api(ctx.port, "GET", "/api/conversations?include=members", { token: alice.token });
    assert.equal(withMembers.status, 200);
    const dmWithMembers = withMembers.body.conversations.find((item) => item.id === conversation.id);
    assert.equal(dmWithMembers.members.length, 2);
    assert.equal(dmWithMembers.members.some((member) => member.identity?.kind === "user" && member.member_ref === bob.user.id), true);
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

test("PATCH /api/me/profile persists display name and avatar for the next device", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "profile-sync");
    const profile = await api(ctx.port, "PATCH", "/api/me/profile", {
      token: alice.token,
      body: {
        displayName: "Jung",
        avatarImage: "data:image/png;base64," + Buffer.from("avatar").toString("base64"),
        avatarCrop: { x: 45, y: 55, zoom: 1.2 },
        avatarColor: "#112233"
      }
    });
    assert.equal(profile.status, 200);
    assert.equal(profile.body.user.displayName, "Jung");
    assert.match(profile.body.user.avatarImage, /^\/api\/avatar-assets\/[A-Za-z0-9_.-]+\.png$/);
    assert.deepEqual(profile.body.user.avatarCrop, { x: 45, y: 55, zoom: 1.2 });
    assert.equal(profile.body.user.avatarColor, "#112233");

    const me = await api(ctx.port, "GET", "/api/me", { token: alice.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.displayName, "Jung");
    assert.equal(me.body.user.avatarImage, profile.body.user.avatarImage);
  } finally { await stopServer(ctx); }
});

test("GET /api/conversations/:id returns user member public identity without profile avatar payloads", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const avatarImage = "data:image/gif;base64," + "B".repeat(200_000);
    const profile = await api(ctx.port, "PATCH", "/api/me/profile", {
      token: bob.token,
      body: {
        avatarImage,
        avatarCrop: { x: 1, y: 2, zoom: 3 },
        avatarColor: "#111827",
        statusBadge: { kind: "emoji", emoji: "⭐", label: "星标" }
      }
    });
    assert.equal(profile.status, 200);

    const conversation = await friendUp(ctx.port, alice, bob);
    const r = await api(ctx.port, "GET", "/api/conversations/" + conversation.id, { token: alice.token });
    assert.equal(r.status, 200);
    const bobMember = r.body.members.find((member) => member.member_kind === "user" && member.member_ref === bob.user.id);
    assert.equal(bobMember.user.id, bob.user.id);
    assert.equal(bobMember.user.username, "bob");
    assert.equal(Object.prototype.hasOwnProperty.call(bobMember.user, "avatarImage"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(bobMember.user, "avatarCrop"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(bobMember.user, "avatarColor"), false);
    assert.equal(bobMember.identity.kind, "user");
    assert.equal(bobMember.identity.id, bob.user.id);
    assert.equal(bobMember.identity.displayName, "bob");
    assert.match(bobMember.identity.avatar.image, /^\/api\/avatar-assets\/[A-Za-z0-9_.-]+\.gif$/);
    assert.equal(bobMember.identity.avatar.image.startsWith("data:"), false);
    assert.deepEqual(bobMember.identity.avatar.crop, { x: 1, y: 2, zoom: 3 });
    assert.equal(bobMember.identity.avatar.text, "bo");
    assert.deepEqual(bobMember.identity.statusBadge, { kind: "emoji", emoji: "⭐", label: "星标" });
  } finally { await stopServer(ctx); }
});

test("GET /api/conversations/:id returns bot owner without profile avatar payloads", async () => {
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

    await api(ctx.port, "PUT", "/api/me/bots/bot_mia", {
      token: alice.token,
      body: { displayName: "Bot" }
    });
    const ensured = await api(ctx.port, "PUT", "/api/me/bot-conversations/session_owner", {
      token: alice.token,
      body: { botId: "bot_mia", title: "Bot", runtimeKind: "desktop-local" }
    });
    assert.equal(ensured.status, 200);

    const detail = await api(ctx.port, "GET", "/api/conversations/" + ensured.body.conversation.id, { token: alice.token });
    assert.equal(detail.status, 200);
    const botMember = detail.body.members.find((member) => member.member_kind === "bot");
    assert.equal(botMember.owner.id, alice.user.id);
    assert.equal(botMember.owner.username, alice.user.username);
    assert.equal(Object.prototype.hasOwnProperty.call(botMember.owner, "avatarImage"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(botMember.owner, "avatarCrop"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(botMember.owner, "avatarColor"), false);
    assert.equal(botMember.identity.kind, "bot");
    assert.equal(botMember.identity.id, "bot_mia");
    assert.equal(botMember.identity.ownerUserId, alice.user.id);
    assert.equal(botMember.identity.displayName, "Bot");
    assert.equal(botMember.identity.avatar.image, "");
    assert.equal(botMember.identity.avatar.text, "Bo");
  } finally { await stopServer(ctx); }
});

test("GET /api/conversations/:id normalizes bot preset avatars in member identity", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const put = await api(ctx.port, "PUT", "/api/me/bots/bot_kongling", {
      token: alice.token,
      body: {
        displayName: "空铃",
        avatarImage: "./assets/avatars/12.png",
        avatarCrop: { x: 47, y: 17, zoom: 1.8 }
      }
    });
    assert.equal(put.status, 200);
    const ensured = await api(ctx.port, "PUT", "/api/me/bot-conversations/session_kongling", {
      token: alice.token,
      body: { botId: "bot_kongling", title: "空铃", runtimeKind: "desktop-local" }
    });
    assert.equal(ensured.status, 200);

    const detail = await api(ctx.port, "GET", "/api/conversations/" + ensured.body.conversation.id, { token: alice.token });
    assert.equal(detail.status, 200);
    const botMember = detail.body.members.find((member) => member.member_kind === "bot");
    assert.equal(botMember.identity.displayName, "空铃");
    assert.equal(botMember.identity.avatar.image, "");
    assert.equal(botMember.identity.avatar.crop, null);
    assert.equal(botMember.identity.avatar.text, "空铃");
    assert.notEqual(botMember.identity.avatar.color, "");
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
        token: alice.token, body: { toUserId: bob.user.id }
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
        token: alice.token, body: { toUserId: bob.user.id }
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
      token: alice.token, body: { toUserId: bob.user.id }
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

// ── Group conversations + bot members + cross-user invocation ──

async function setupGroupScenario(port) {
  const alice = await register(port, "alice");
  const bob = await register(port, "bob");
  const created = await api(port, "POST", "/api/social/friend-requests", { token: alice.token, body: { toUserId: bob.user.id } });
  await api(port, "POST", "/api/social/friend-requests/" + created.body.request.id + "/respond", { token: bob.token, body: { action: "accept" } });
  await createBot(port, alice, "bot_codex", "Codex");
  return { alice, bob };
}

test("POST /api/conversations creates group with creator + bot + friend members", async () => {
  const ctx = await startServer();
  try {
    const { alice, bob } = await setupGroupScenario(ctx.port);
    const r = await api(ctx.port, "POST", "/api/conversations", {
      token: alice.token,
      body: {
        name: "Test Squad",
        memberBots: [{ botId: "bot_codex", runtimeKind: "cloud-claude-code" }],
        memberFriendUserIds: [bob.user.id]
      }
    });
    assert.equal(r.status, 201);
    assert.ok(r.body.conversation.id.startsWith("g_"));
    assert.equal(ids.isPublicId(r.body.conversation.publicId), true);
    assert.equal(r.body.conversation.public_id, r.body.conversation.publicId);
    assert.equal(r.body.conversation.id, `g_${r.body.conversation.publicId}`);
    assert.equal(r.body.conversation.name, "Test Squad");
    const members = r.body.members;
    assert.equal(members.length, 3); // alice + bot_codex + bob
    const userMembers = members.filter((m) => m.member_kind === "user").map((m) => m.member_ref).sort();
    assert.deepEqual(userMembers, [alice.user.id, bob.user.id].sort());
    const botMembers = members.filter((m) => m.member_kind === "bot");
    assert.equal(botMembers.length, 1);
    assert.equal(botMembers[0].member_ref, "bot_codex");
    assert.equal(botMembers[0].owner_id, alice.user.id);
    assert.deepEqual(JSON.parse(botMembers[0].ai_perms_json), { runtimeKind: "cloud-claude-code" });
  } finally { await stopServer(ctx); }
});

test("POST /api/conversations refuses non-friend in memberFriendUserIds", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const stranger = await register(ctx.port, "stranger");
    const r = await api(ctx.port, "POST", "/api/conversations", {
      token: alice.token,
        body: { name: "x", memberBots: [], memberFriendUserIds: [stranger.user.id] }
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
    const fr = await api(ctx.port, "POST", "/api/social/friend-requests", { token: alice.token, body: { toUserId: charlie.user.id } });
    await api(ctx.port, "POST", "/api/social/friend-requests/" + fr.body.request.id + "/respond", { token: charlie.token, body: { action: "accept" } });
    // create group with bob
    const grp = await api(ctx.port, "POST", "/api/conversations", {
      token: alice.token,
      body: { name: "G", memberBots: [], memberFriendUserIds: [bob.user.id] }
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

test("POST /api/conversations/:id/members rejects pulling someone else's bot", async () => {
  const ctx = await startServer();
  try {
    const { alice, bob } = await setupGroupScenario(ctx.port);
    const grp = await api(ctx.port, "POST", "/api/conversations", {
      token: alice.token,
      body: { name: "G", memberBots: [], memberFriendUserIds: [bob.user.id] }
    });
    // bob tries to pull alice's bot (owner_id=alice.user.id) — should fail
    const add = await api(ctx.port, "POST", "/api/conversations/" + grp.body.conversation.id + "/members", {
      token: bob.token,
      body: { memberKind: "bot", memberRef: "bot_codex", ownerId: alice.user.id }
    });
    assert.equal(add.status, 403);
  } finally { await stopServer(ctx); }
});

test("bot member routes reject spoofing another user's bot id", async () => {
  const ctx = await startServer();
  try {
    const { alice, bob } = await setupGroupScenario(ctx.port);
    await createBot(ctx.port, alice, "bot_alice", "Alice Bot");

    const create = await api(ctx.port, "POST", "/api/conversations", {
      token: bob.token,
      body: { name: "Spoof Create", memberBots: [{ botId: "bot_alice" }], memberFriendUserIds: [alice.user.id] }
    });
    assert.equal(create.status, 403);

    const group = await api(ctx.port, "POST", "/api/conversations", {
      token: bob.token,
      body: { name: "Bob Group", memberBots: [], memberFriendUserIds: [alice.user.id] }
    });
    assert.equal(group.status, 201);

    const add = await api(ctx.port, "POST", "/api/conversations/" + group.body.conversation.id + "/members", {
      token: bob.token,
      body: { memberKind: "bot", memberRef: "bot_alice", ownerId: bob.user.id }
    });
    assert.equal(add.status, 403);

    const post = await api(ctx.port, "POST", "/api/conversations/" + group.body.conversation.id + "/messages/as-bot", {
      token: bob.token,
      body: { botId: "bot_alice", bodyMd: "spoof" }
    });
    assert.equal(post.status, 403);
  } finally { await stopServer(ctx); }
});

test("POST /messages/as-bot allows owner to post on behalf of own bot", async () => {
  const ctx = await startServer();
  try {
    const { alice, bob } = await setupGroupScenario(ctx.port);
    const grp = await api(ctx.port, "POST", "/api/conversations", {
      token: alice.token,
      body: { name: "G", memberBots: [{ botId: "bot_codex" }], memberFriendUserIds: [bob.user.id] }
    });
    const r = await api(ctx.port, "POST", "/api/conversations/" + grp.body.conversation.id + "/messages/as-bot", {
      token: alice.token,
      body: {
        botId: "bot_codex",
        bodyMd: "Hello from Codex",
        trace: {
          reasoning: "检查上下文",
          tools: [{ id: "tool_1", name: "shell", preview: "pwd", status: "completed" }]
        },
        contentBlocks: [
          { type: "thinking", id: "think_1", text: "检查上下文", status: "completed" },
          { type: "text", id: "text_1", text: "Hello from Codex" },
          { type: "tool", id: "tool_1", name: "shell", preview: "pwd", status: "completed" }
        ]
      }
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.message.sender_kind, "bot");
    assert.equal(r.body.message.sender_ref, "bot_codex");
    assert.equal(r.body.message.sender_owner_id, alice.user.id);
    assert.equal(r.body.message.body_md, "Hello from Codex");
    assert.deepEqual(JSON.parse(r.body.message.trace_json), {
      reasoning: "检查上下文",
      tools: [{ id: "tool_1", name: "shell", preview: "pwd", status: "completed", duration: null, error: false }]
    });
    assert.deepEqual(JSON.parse(r.body.message.content_blocks_json), [
      { type: "thinking", id: "think_1", status: "completed", duration: null, text: "检查上下文" },
      { type: "text", id: "text_1", text: "Hello from Codex" },
      { type: "tool", id: "tool_1", name: "shell", preview: "pwd", status: "completed", duration: null, error: false }
    ]);
  } finally { await stopServer(ctx); }
});

test("POST /messages/as-bot deduplicates bot replies by triggerMessageId across clientOpIds", async () => {
  const ctx = await startServer();
  try {
    const { alice, bob } = await setupGroupScenario(ctx.port);
    const grp = await api(ctx.port, "POST", "/api/conversations", {
      token: alice.token,
      body: { name: "G", memberBots: [{ botId: "bot_codex" }], memberFriendUserIds: [bob.user.id] }
    });
    const conversationId = grp.body.conversation.id;
    const first = await api(ctx.port, "POST", "/api/conversations/" + conversationId + "/messages/as-bot", {
      token: alice.token,
      body: {
        botId: "bot_codex",
        bodyMd: "first reply",
        triggerMessageId: "m_user_1",
        clientOpId: "op_bot_reply_m_user_1_bot_codex"
      }
    });
    const second = await api(ctx.port, "POST", "/api/conversations/" + conversationId + "/messages/as-bot", {
      token: alice.token,
      body: {
        botId: "bot_codex",
        bodyMd: "late failure",
        triggerMessageId: "m_user_1",
        errorJson: { stage: "engine", message: "failed after success" },
        clientOpId: "op_bot_reply_error_m_user_1_bot_codex"
      }
    });

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(second.body.message.id, first.body.message.id);
    assert.equal(second.body.deduplicated, true);
    assert.equal(second.body.message.body_md, "first reply");
    assert.equal(second.body.message.trigger_message_id, "m_user_1");

    const listed = await api(ctx.port, "GET", "/api/conversations/" + conversationId + "/messages", { token: alice.token });
    const botReplies = (listed.body.messages || []).filter((m) => m.sender_kind === "bot" && m.sender_ref === "bot_codex");
    assert.equal(botReplies.length, 1);
  } finally { await stopServer(ctx); }
});

test("POST /messages/as-bot rejects non-owner", async () => {
  const ctx = await startServer();
  try {
    const { alice, bob } = await setupGroupScenario(ctx.port);
    const grp = await api(ctx.port, "POST", "/api/conversations", {
      token: alice.token,
      body: { name: "G", memberBots: [{ botId: "bot_codex" }], memberFriendUserIds: [bob.user.id] }
    });
    // bob tries to post as alice's bot_codex
    const r = await api(ctx.port, "POST", "/api/conversations/" + grp.body.conversation.id + "/messages/as-bot", {
      token: bob.token,
      body: { botId: "bot_codex", bodyMd: "fake" }
    });
    assert.equal(r.status, 403);
  } finally { await stopServer(ctx); }
});

test("bot mention in group message triggers conversation.bot_invocation_requested to owner", async () => {
  const ctx = await startServer();
  try {
    const { alice, bob } = await setupGroupScenario(ctx.port);
    await api(ctx.port, "PUT", "/api/me/bots/bot_codex/runtime", {
      token: alice.token,
      body: {
        runtimeKind: "desktop-local",
        enabled: true,
        config: { agentEngine: "codex", deviceId: "desktop-codex" }
      }
    });
    const grp = await api(ctx.port, "POST", "/api/conversations", {
      token: alice.token,
      body: {
        name: "G",
        memberBots: [{ botId: "bot_codex", runtimeKind: "desktop-local" }],
        memberFriendUserIds: [bob.user.id]
      }
    });
    const aliceWs = await openEventsWs(ctx.port, alice.token);
    try {
      await api(ctx.port, "POST", "/api/conversations/" + grp.body.conversation.id + "/messages", {
        token: bob.token,
        body: { bodyMd: "@bot_codex help me", mentions: [{ kind: "bot", botId: "bot_codex" }] }
      });
      const inv = await waitForEvent(aliceWs.events, (e) => e.type === "conversation.bot_invocation_requested");
      assert.equal(inv.botId, "bot_codex");
      assert.equal(inv.targetDeviceId, "desktop-codex");
      assert.equal(inv.invokedBy.id, bob.user.id);
      assert.ok(Array.isArray(inv.recentMessages));
      assert.ok(inv.triggeringMessage.body_md.includes("help me"));
    } finally {
      aliceWs.ws.close();
    }
  } finally { await stopServer(ctx); }
});
