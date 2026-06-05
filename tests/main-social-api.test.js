const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createSocialApi } = require("../src/main/social/social-api.js");

function spawnFakeCloud(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function teardown(ctx) {
  await new Promise((r) => ctx.server.close(r));
}

test("sendFriendRequest posts toUsername and parses response", async () => {
  const seen = [];
  const ctx = await spawnFakeCloud(async (req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body });
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ request: { id: "fr_1", from_user: "u_a", to_user: "u_b", status: "pending" } }));
    });
  });
  try {
    const api = createSocialApi({
      getSettings: () => ({ enabled: true, token: "t", url: ctx.baseUrl }),
      normalizeUrl: (u) => u
    });
    const result = await api.sendFriendRequest("bob");
    assert.equal(result.request.id, "fr_1");
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].url, "/api/social/friend-requests");
    const sent = JSON.parse(seen[0].body);
    assert.equal(sent.toUsername, "bob");
    // Phase 1.D: writes carry an auto-generated clientOpId for idempotency.
    assert.match(String(sent.clientOpId || ""), /^op_/, "clientOpId should be auto-attached");
  } finally { await teardown(ctx); }
});

test("listConversationMessages encodes sinceSeq and limit as query params", async () => {
  const seen = [];
  const ctx = await spawnFakeCloud((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ messages: [{ seq: 3, body_md: "hi" }] }));
  });
  try {
    const api = createSocialApi({
      getSettings: () => ({ enabled: true, token: "t", url: ctx.baseUrl }),
      normalizeUrl: (u) => u
    });
    const result = await api.listConversationMessages("dm:x:y", 2, 50);
    assert.equal(result.messages[0].seq, 3);
    // Conversation ids travel verbatim — encodeURIComponent would turn `:` into
    // `%3A` and the cloud route regex /api/conversations/([A-Za-z0-9_:-]+) wouldn't
    // match, silently 404ing DM sends.
    assert.equal(seen[0], "/api/conversations/dm:x:y/messages?since_seq=2&limit=50");
  } finally { await teardown(ctx); }
});

test("updateConversation sends PATCH with patch body verbatim", async () => {
  const seen = [];
  const ctx = await spawnFakeCloud(async (req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ conversation: { id: "g_abc", name: "renamed" } }));
    });
  });
  try {
    const api = createSocialApi({
      getSettings: () => ({ enabled: true, token: "t", url: ctx.baseUrl }),
      normalizeUrl: (u) => u
    });
    const result = await api.updateConversation("g_abc", { name: "renamed" });
    assert.equal(result.conversation.name, "renamed");
    assert.equal(seen[0].method, "PATCH");
    // Conversation ids travel verbatim — encodeURIComponent on `:` would 404.
    assert.equal(seen[0].url, "/api/conversations/g_abc");
    assert.deepEqual(JSON.parse(seen[0].body), { name: "renamed" });
  } finally { await teardown(ctx); }
});

test("deleteConversation sends DELETE to the conversation route", async () => {
  const seen = [];
  const ctx = await spawnFakeCloud((req, res) => {
    seen.push({ method: req.method, url: req.url });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    const api = createSocialApi({
      getSettings: () => ({ enabled: true, token: "t", url: ctx.baseUrl }),
      normalizeUrl: (u) => u
    });
    const result = await api.deleteConversation("dm:a:b");
    assert.equal(result.ok, true);
    assert.equal(seen[0].method, "DELETE");
    assert.equal(seen[0].url, "/api/conversations/dm:a:b");
  } finally { await teardown(ctx); }
});

test("createConversation sends memberBots to the cloud route", async () => {
  const seen = [];
  const ctx = await spawnFakeCloud(async (req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body });
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ conversation: { id: "g_1", type: "group" } }));
    });
  });
  try {
    const api = createSocialApi({
      getSettings: () => ({ enabled: true, token: "t", url: ctx.baseUrl }),
      normalizeUrl: (u) => u
    });
    const result = await api.createConversation({
      name: "Group",
      memberBots: [{ botId: "mia", runtimeKind: "cloud-hermes" }],
      memberFriendUserIds: ["u_friend"]
    });
    assert.equal(result.conversation.id, "g_1");
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].url, "/api/conversations");
    const sent = JSON.parse(seen[0].body);
    assert.deepEqual(sent.memberBots, [{ botId: "mia", runtimeKind: "cloud-hermes" }]);
    assert.equal(sent["member" + "Fellows"], undefined);
    assert.match(sent.clientOpId, /^op_/);
  } finally { await teardown(ctx); }
});

test("postConversationMessageAsBot sends POST to the canonical bot message route", async () => {
  const seen = [];
  const ctx = await spawnFakeCloud((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body });
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: { id: "m_bot_1", sender_kind: "bot" } }));
    });
  });
  try {
    const api = createSocialApi({
      getSettings: () => ({ enabled: true, token: "t", url: ctx.baseUrl }),
      normalizeUrl: (u) => u
    });
    const result = await api.postConversationMessageAsBot("bot:u_1:sess_1", {
      botId: "mia",
      bodyMd: "你好"
    });
    assert.equal(result.message.id, "m_bot_1");
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].url, "/api/conversations/bot:u_1:sess_1/messages/as-bot");
    const sent = JSON.parse(seen[0].body);
    assert.equal(sent.botId, "mia");
    assert.equal(sent.bodyMd, "你好");
    assert.match(sent.clientOpId, /^op_/);
  } finally { await teardown(ctx); }
});

test("ensureBotConversation sends PUT to the stable bot conversation route", async () => {
  const seen = [];
  const ctx = await spawnFakeCloud(async (req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, conversation: { id: "bot:u_1:alice" }, created: true }));
    });
  });
  try {
    const api = createSocialApi({
      getSettings: () => ({ enabled: true, token: "t", url: ctx.baseUrl }),
      normalizeUrl: (u) => u
    });
    const result = await api.ensureBotConversation("alice", { title: "爱丽丝" });
    assert.equal(result.conversation.id, "bot:u_1:alice");
    assert.equal(seen[0].method, "PUT");
    assert.equal(seen[0].url, "/api/me/bots/alice/conversation");
    const sentBody = JSON.parse(seen[0].body);
    assert.equal(sentBody.title, "爱丽丝");
    assert.match(sentBody.clientOpId, /^op_/);
  } finally { await teardown(ctx); }
});

test("ensureBotSessionConversation sends PUT to the per-session bot conversation route", async () => {
  const seen = [];
  const ctx = await spawnFakeCloud(async (req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, conversation: { id: "bot:u_1:sess_1" }, created: true }));
    });
  });
  try {
    const api = createSocialApi({
      getSettings: () => ({ enabled: true, token: "t", url: ctx.baseUrl }),
      normalizeUrl: (u) => u
    });
    const result = await api.ensureBotSessionConversation("sess_1", {
      botId: "mia",
      title: "新对话",
      runtimeKind: "cloud-hermes"
    });
    assert.equal(result.conversation.id, "bot:u_1:sess_1");
    assert.equal(seen[0].method, "PUT");
    assert.equal(seen[0].url, "/api/me/bot-conversations/sess_1");
    const sentBody = JSON.parse(seen[0].body);
    assert.equal(sentBody.botId, "mia");
    assert.equal(sentBody.runtimeKind, "cloud-hermes");
    assert.match(sentBody.clientOpId, /^op_/);
  } finally { await teardown(ctx); }
});

test("listBots fetches cloud bot identities", async () => {
  const seen = [];
  const ctx = await spawnFakeCloud((req, res) => {
    seen.push({ method: req.method, url: req.url });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ bots: [{ id: "mia", name: "Mia", avatarImage: "data:mia-cloud" }] }));
  });
  try {
    const api = createSocialApi({
      getSettings: () => ({ enabled: true, token: "t", url: ctx.baseUrl }),
      normalizeUrl: (u) => u
    });
    const result = await api.listBots();
    assert.equal(result.bots[0].avatarImage, "data:mia-cloud");
    assert.deepEqual(seen[0], { method: "GET", url: "/api/me/bots" });
  } finally { await teardown(ctx); }
});

test("saveBotIdentity upserts a cloud bot identity", async () => {
  const seen = [];
  const ctx = await spawnFakeCloud((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ bot: { id: "alice", name: "Alice" } }));
    });
  });
  try {
    const api = createSocialApi({
      getSettings: () => ({ enabled: true, token: "t", url: ctx.baseUrl }),
      normalizeUrl: (u) => u
    });
    const result = await api.saveBotIdentity("alice", {
      name: "Alice",
      color: "#2563eb",
      avatarImage: "data:image/png;base64,x",
      avatarCrop: { x: 50, y: 50, zoom: 1 },
      bio: "A cloud Bot",
      personaText: "You are Alice."
    });
    assert.equal(result.bot.id, "alice");
    assert.equal(seen[0].method, "PUT");
    assert.equal(seen[0].url, "/api/me/bots/alice");
    const sent = JSON.parse(seen[0].body);
    assert.equal(sent.name, "Alice");
    assert.equal(sent.personaText, "You are Alice.");
    assert.match(sent.clientOpId, /^op_/);
  } finally { await teardown(ctx); }
});

test("deleteBot removes a cloud bot identity", async () => {
  const seen = [];
  const ctx = await spawnFakeCloud((req, res) => {
    seen.push({ method: req.method, url: req.url });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    const api = createSocialApi({
      getSettings: () => ({ enabled: true, token: "t", url: ctx.baseUrl }),
      normalizeUrl: (u) => u
    });
    const result = await api.deleteBot("mia");
    assert.equal(result.ok, true);
    assert.deepEqual(seen[0], { method: "DELETE", url: "/api/me/bots/mia" });
  } finally { await teardown(ctx); }
});

test("listPlatformModels fetches platform model catalog", async () => {
  const seen = [];
  const ctx = await spawnFakeCloud((req, res) => {
    seen.push({ method: req.method, url: req.url });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ models: [{ id: "mia-pro", label: "Mia Pro" }] }));
  });
  try {
    const api = createSocialApi({
      getSettings: () => ({ enabled: true, token: "t", url: ctx.baseUrl }),
      normalizeUrl: (u) => u
    });
    const result = await api.listPlatformModels();
    assert.equal(result.models[0].id, "mia-pro");
    assert.deepEqual(seen[0], { method: "GET", url: "/api/me/model-catalog" });
  } finally { await teardown(ctx); }
});

test("saveBotRuntime sends PUT with an idempotency key", async () => {
  const seen = [];
  const ctx = await spawnFakeCloud(async (req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ binding: { botId: "alice", runtimeKind: "cloud-hermes" } }));
    });
  });
  try {
    const api = createSocialApi({
      getSettings: () => ({ enabled: true, token: "t", url: ctx.baseUrl }),
      normalizeUrl: (u) => u
    });
    const result = await api.saveBotRuntime("alice", {
      runtimeKind: "cloud-hermes",
      config: { model: "hermes-agent" }
    });
    assert.equal(result.binding.botId, "alice");
    assert.equal(seen[0].method, "PUT");
    assert.equal(seen[0].url, "/api/me/bots/alice/runtime");
    const sentBody = JSON.parse(seen[0].body);
    assert.equal(sentBody.runtimeKind, "cloud-hermes");
    assert.match(sentBody.clientOpId, /^op_/);
  } finally { await teardown(ctx); }
});

test("non-2xx responses throw with parsed error message", async () => {
  const ctx = await spawnFakeCloud((req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "user not found" }));
  });
  try {
    const api = createSocialApi({
      getSettings: () => ({ enabled: true, token: "t", url: ctx.baseUrl }),
      normalizeUrl: (u) => u
    });
    await assert.rejects(() => api.sendFriendRequest("ghost"), /user not found/);
  } finally { await teardown(ctx); }
});

test("throws if cloud not logged in", async () => {
  const api = createSocialApi({
    getSettings: () => ({ enabled: false, token: "", url: "" }),
    normalizeUrl: (u) => u
  });
  await assert.rejects(() => api.sendFriendRequest("bob"), /Cloud not logged in/);
});
