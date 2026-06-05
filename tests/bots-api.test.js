// Bot definitions on cloud, end-to-end through the HTTP API.

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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-bot-api-"));
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

test("PUT then GET /api/me/bots roundtrips identity fields", async () => {
  const ctx = await startServer();
  const { normalizeBotCapabilities } = require("../src/shared/bot-identity.js");
  try {
    const A = await register(ctx.port, "phi");
    const put = await api(ctx.port, "PUT", "/api/me/bots/bot_codex", {
      token: A.token,
      body: {
        displayName: "Codex",
        color: "#0f766e",
        avatarImage: "data:image/png;base64,fake",
        avatarCrop: { x: 10, y: 20, w: 100, h: 100 },
        bio: "Coding helper",
        capabilities: ["chat", "tools"],
        personaText: "You are Codex.",
        clientOpId: "op_bot_1"
      }
    });
    assert.equal(put.status, 200);
    assert.equal(put.body.bot.id, "bot_codex");
    assert.equal(put.body.bot.ownerUserId, A.user.id);
    assert.equal(put.body.bot.displayName, "Codex");
    assert.equal(put.body.bot.color, "#0f766e");
    assert.deepEqual(put.body.bot.capabilities, normalizeBotCapabilities(["chat", "tools"]));

    const list = await api(ctx.port, "GET", "/api/me/bots", { token: A.token });
    assert.equal(list.status, 200);
    const codex = list.body.bots.find((bot) => bot.id === "bot_codex");
    assert.ok(codex);
    assert.equal(codex.ownerUserId, A.user.id);
    assert.equal(codex.displayName, "Codex");
    assert.equal(codex.color, "#0f766e");
    assert.deepEqual(codex.capabilities, normalizeBotCapabilities(["chat", "tools"]));
    assert.deepEqual(codex.avatarCrop, { x: 10, y: 20, w: 100, h: 100 });
  } finally { await stopServer(ctx); }
});

test("web bootstrap can request compact user and bot identities without avatar blobs", async () => {
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
    const put = await api(ctx.port, "PUT", "/api/me/bots/bot_codex", {
      token: A.token,
      body: {
        displayName: "Codex",
        avatarImage,
        avatarCrop: { x: 10, y: 20, w: 100, h: 100 },
        personaText,
        clientOpId: "op_bot_compact"
      }
    });
    assert.equal(put.status, 200);

    const me = await api(ctx.port, "GET", "/api/me?compact=1", { token: A.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.id, A.user.id);
    assert.equal(Object.prototype.hasOwnProperty.call(me.body.user, "avatarImage"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(me.body.user, "avatarCrop"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(me.body.user, "avatarColor"), false);

    const list = await api(ctx.port, "GET", "/api/me/bots?compact=1", { token: A.token });
    assert.equal(list.status, 200);
    const codex = list.body.bots.find((bot) => bot.id === "bot_codex");
    assert.ok(codex);
    assert.equal(codex.ownerUserId, A.user.id);
    assert.equal(codex.displayName, "Codex");
    assert.equal(Object.prototype.hasOwnProperty.call(codex, "avatarImage"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(codex, "avatarCrop"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(codex, "personaText"), false);

    assert.ok(JSON.stringify(me.body).length < 1_000, "compact /api/me should stay small");
    assert.ok(JSON.stringify(list.body).length < 5_000, "compact bot list should stay small");
  } finally { await stopServer(ctx); }
});

test("auth login returns compact user identity even when the profile avatar is large", async () => {
  const ctx = await startServer();
  try {
    const username = "logincompact";
    const password = "passworD1!";
    const A = await register(ctx.port, username);
    const avatarImage = "data:image/png;base64," + "A".repeat(200_000);
    const profile = await api(ctx.port, "PATCH", "/api/me/profile", {
      token: A.token,
      body: {
        avatarImage,
        avatarCrop: { x: 10, y: 20, w: 100, h: 100 },
        avatarColor: "#112233",
        clientOpId: "op_profile_login_compact"
      }
    });
    assert.equal(profile.status, 200);

    const login = await api(ctx.port, "POST", "/api/auth/login", {
      body: { username: A.user.username, password }
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.id, A.user.id);
    assert.equal(Object.prototype.hasOwnProperty.call(login.body.user, "avatarImage"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(login.body.user, "avatarCrop"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(login.body.user, "avatarColor"), false);
    assert.ok(JSON.stringify(login.body).length < 1_000, "login response should stay small");
  } finally { await stopServer(ctx); }
});

test("GET and PUT /api/me/bots/:id/runtime roundtrip cloud AI controls", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "rho");
    await api(ctx.port, "PUT", "/api/me/bots/bot_codex", {
      token: A.token,
      body: { displayName: "Codex", clientOpId: "op_runtime_bot" }
    });

    const empty = await api(ctx.port, "GET", "/api/me/bots/bot_codex/runtime?kind=cloud-hermes", { token: A.token });
    assert.equal(empty.status, 200);
    assert.equal(empty.body.binding.botId, "bot_codex");
    assert.equal(empty.body.binding.enabled, false);
    assert.deepEqual(empty.body.binding.config, {});

    const saved = await api(ctx.port, "PUT", "/api/me/bots/bot_codex/runtime", {
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
    assert.equal(saved.body.binding.botId, "bot_codex");
    assert.equal(saved.body.binding.enabled, true);
    assert.equal(saved.body.binding.config.effortLevel, "high");

    const got = await api(ctx.port, "GET", "/api/me/bots/bot_codex/runtime?kind=cloud-hermes", { token: A.token });
    assert.equal(got.status, 200);
    assert.equal(got.body.binding.config.model, "hermes-agent");
    assert.equal(got.body.binding.config.permissionMode, "auto");
    assert.equal(got.body.binding.config.agentEngine, "codex");
    assert.deepEqual(got.body.binding.config.modelEntries, [
      { value: "gpt-5.3-codex", label: "GPT-5.3 Codex", model: "gpt-5.3-codex", provider: "codex", providerLabel: "Codex CLI" }
    ]);
  } finally { await stopServer(ctx); }
});

test("PUT /api/me/bot-conversations/:sessionId creates a bot conversation", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "memberbot");
    await api(ctx.port, "PUT", "/api/me/bots/bot_mia", {
      token: A.token,
      body: { displayName: "Mia" }
    });
    const ensured = await api(ctx.port, "PUT", "/api/me/bot-conversations/session_1", {
      token: A.token,
      body: { botId: "bot_mia", title: "Mia chat", runtimeKind: "cloud-hermes" }
    });
    assert.equal(ensured.status, 200);
    assert.equal(ensured.body.conversation.id, "botc_session_1");
    assert.equal(ensured.body.conversation.type, "bot");
    assert.equal(ensured.body.conversation.decorations.botId, "bot_mia");

    const detail = await api(ctx.port, "GET", `/api/conversations/${ensured.body.conversation.id}`, { token: A.token });
    assert.equal(detail.status, 200);
    const botMember = detail.body.members.find((member) => member.member_kind === "bot");
    assert.ok(botMember);
    assert.equal(botMember.identity.id, "bot_mia");
    assert.equal(botMember.identity.ownerUserId, A.user.id);
    assert.equal(botMember.identity.displayName, "Mia");
  } finally { await stopServer(ctx); }
});

test("PUT same clientOpId twice creates only one bot upsert event in user_events", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "chi");
    const body = { displayName: "Mia", color: "#5e5ce6", clientOpId: "op_bot_idem" };
    await api(ctx.port, "PUT", "/api/me/bots/bot_mia", { token: A.token, body });
    await api(ctx.port, "PUT", "/api/me/bots/bot_mia", { token: A.token, body });

    await new Promise((r) => setTimeout(r, 100));
    const { createCloudStore } = require("../src/cloud/sqlite-store");
    const { createEventLogStore } = require("../src/cloud/event-log-store");
    const store = createCloudStore({ dataDir: ctx.tmpDir });
    try {
      const log = createEventLogStore(store.getDb());
      const upsertEvents = log.listEventsSince(A.user.id, 0).filter((e) => e.kind === "bot.upserted");
      assert.equal(upsertEvents.length, 1, "idempotent PUT writes one event only");
    } finally { store.close?.(); }
  } finally { await stopServer(ctx); }
});

test("DELETE /api/me/bots/:id removes the row and fires bot.deleted", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "psi");
    await api(ctx.port, "PUT", "/api/me/bots/bot_x", { token: A.token, body: { displayName: "X" } });
    const del = await api(ctx.port, "DELETE", "/api/me/bots/bot_x", { token: A.token });
    assert.equal(del.status, 200);
    const list = await api(ctx.port, "GET", "/api/me/bots", { token: A.token });
    assert.equal(list.body.bots.some((bot) => bot.id === "bot_x"), false);

    await new Promise((r) => setTimeout(r, 100));
    const { createCloudStore } = require("../src/cloud/sqlite-store");
    const { createEventLogStore } = require("../src/cloud/event-log-store");
    const store = createCloudStore({ dataDir: ctx.tmpDir });
    try {
      const log = createEventLogStore(store.getDb());
      const kinds = log.listEventsSince(A.user.id, 0).map((e) => e.kind);
      assert.ok(kinds.includes("bot.upserted"));
      assert.ok(kinds.includes("bot.deleted"));
    } finally { store.close?.(); }
  } finally { await stopServer(ctx); }
});

test("bot.upserted is broadcast live to a connected event socket", async () => {
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
        if (e.type === "bot.upserted") r(e);
      });
    });
    await api(ctx.port, "PUT", "/api/me/bots/bot_codex", { token: A.token, body: { displayName: "Codex" } });
    const evt = await Promise.race([
      received,
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout waiting for bot.upserted")), 2000))
    ]);
    ws.close();
    assert.equal(evt.bot.id, "bot_codex");
    assert.equal(evt.bot.ownerUserId, A.user.id);
    assert.equal(evt.bot.displayName, "Codex");
    assert.ok(Number.isFinite(Number(evt.seq)));
  } finally { await stopServer(ctx); }
});
