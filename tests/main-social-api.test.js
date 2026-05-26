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

test("listRoomMessages encodes sinceSeq and limit as query params", async () => {
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
    const result = await api.listRoomMessages("dm:x:y", 2, 50);
    assert.equal(result.messages[0].seq, 3);
    // Room ids travel verbatim — encodeURIComponent would turn `:` into
    // `%3A` and the cloud route regex /api/rooms/([A-Za-z0-9_:-]+) wouldn't
    // match, silently 404ing DM sends.
    assert.equal(seen[0], "/api/rooms/dm:x:y/messages?since_seq=2&limit=50");
  } finally { await teardown(ctx); }
});

test("updateRoom sends PATCH with patch body verbatim", async () => {
  const seen = [];
  const ctx = await spawnFakeCloud(async (req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ room: { id: "g_abc", name: "renamed" } }));
    });
  });
  try {
    const api = createSocialApi({
      getSettings: () => ({ enabled: true, token: "t", url: ctx.baseUrl }),
      normalizeUrl: (u) => u
    });
    const result = await api.updateRoom("g_abc", { name: "renamed" });
    assert.equal(result.room.name, "renamed");
    assert.equal(seen[0].method, "PATCH");
    // Room ids travel verbatim — encodeURIComponent on `:` would 404.
    assert.equal(seen[0].url, "/api/rooms/g_abc");
    assert.deepEqual(JSON.parse(seen[0].body), { name: "renamed" });
  } finally { await teardown(ctx); }
});

test("deleteRoom sends DELETE to the room route", async () => {
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
    const result = await api.deleteRoom("dm:a:b");
    assert.equal(result.ok, true);
    assert.equal(seen[0].method, "DELETE");
    assert.equal(seen[0].url, "/api/rooms/dm:a:b");
  } finally { await teardown(ctx); }
});

test("ensureFellowRoom sends PUT to the stable fellow room route", async () => {
  const seen = [];
  const ctx = await spawnFakeCloud(async (req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, room: { id: "fellow:u_1:alice" }, created: true }));
    });
  });
  try {
    const api = createSocialApi({
      getSettings: () => ({ enabled: true, token: "t", url: ctx.baseUrl }),
      normalizeUrl: (u) => u
    });
    const result = await api.ensureFellowRoom("alice", { title: "爱丽丝" });
    assert.equal(result.room.id, "fellow:u_1:alice");
    assert.equal(seen[0].method, "PUT");
    assert.equal(seen[0].url, "/api/me/fellows/alice/room");
    const sentBody = JSON.parse(seen[0].body);
    assert.equal(sentBody.title, "爱丽丝");
    assert.match(sentBody.clientOpId, /^op_/);
  } finally { await teardown(ctx); }
});

test("listFellows fetches cloud fellow identities", async () => {
  const seen = [];
  const ctx = await spawnFakeCloud((req, res) => {
    seen.push({ method: req.method, url: req.url });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ fellows: [{ id: "mia", name: "Mia", avatarImage: "data:mia-cloud" }] }));
  });
  try {
    const api = createSocialApi({
      getSettings: () => ({ enabled: true, token: "t", url: ctx.baseUrl }),
      normalizeUrl: (u) => u
    });
    const result = await api.listFellows();
    assert.equal(result.fellows[0].avatarImage, "data:mia-cloud");
    assert.deepEqual(seen[0], { method: "GET", url: "/api/me/fellows" });
  } finally { await teardown(ctx); }
});

test("deleteFellow removes a cloud fellow identity", async () => {
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
    const result = await api.deleteFellow("mia");
    assert.equal(result.ok, true);
    assert.deepEqual(seen[0], { method: "DELETE", url: "/api/me/fellows/mia" });
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

test("saveFellowRuntime sends PUT with an idempotency key", async () => {
  const seen = [];
  const ctx = await spawnFakeCloud(async (req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ binding: { fellowId: "alice", runtimeKind: "cloud-hermes" } }));
    });
  });
  try {
    const api = createSocialApi({
      getSettings: () => ({ enabled: true, token: "t", url: ctx.baseUrl }),
      normalizeUrl: (u) => u
    });
    const result = await api.saveFellowRuntime("alice", {
      runtimeKind: "cloud-hermes",
      config: { model: "hermes-agent" }
    });
    assert.equal(result.binding.fellowId, "alice");
    assert.equal(seen[0].method, "PUT");
    assert.equal(seen[0].url, "/api/me/fellows/alice/runtime");
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
