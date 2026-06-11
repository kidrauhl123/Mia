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
const { seedCloudAccountInDataDir } = require("./helpers/cloud-auth.js");

const dataDirsByPort = new Map();

async function startServer(extraEnv = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-bot-api-"));
  const port = await freePort();
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["scripts/serve-cloud.js"], {
      env: {
        ...process.env,
        MIA_CLOUD_HOST: "127.0.0.1",
        MIA_CLOUD_PORT: String(port),
        MIA_CLOUD_DATA: tmpDir,
        MIA_CLOUD_ALLOW_QUERY_TOKEN: "1",
        ...extraEnv
      },
      stdio: ["ignore", "pipe", "pipe"]
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
      headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }
    }, (res) => {
      let chunks = "";
      res.on("data", (c) => { chunks += c; });
      res.on("end", () => {
        let parsed = null; try { parsed = JSON.parse(chunks); } catch { parsed = chunks; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
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
        statusBadge: { kind: "gift", assetId: "rose", collectibleId: "nft_rose_1" },
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
    assert.deepEqual(put.body.bot.statusBadge, { kind: "gift", assetId: "rose", collectibleId: "nft_rose_1" });
    assert.deepEqual(put.body.bot.capabilities, normalizeBotCapabilities(["chat", "tools"]));

    const list = await api(ctx.port, "GET", "/api/me/bots", { token: A.token });
    assert.equal(list.status, 200);
    const codex = list.body.bots.find((bot) => bot.id === "bot_codex");
    assert.ok(codex);
    assert.equal(codex.ownerUserId, A.user.id);
    assert.equal(codex.displayName, "Codex");
    assert.equal(codex.color, "#0f766e");
    assert.match(codex.avatarImage, /^\/api\/avatar-assets\/[A-Za-z0-9_.-]+\.png$/);
    assert.deepEqual(codex.statusBadge, { kind: "gift", assetId: "rose", collectibleId: "nft_rose_1" });
    assert.deepEqual(codex.capabilities, normalizeBotCapabilities(["chat", "tools"]));
    assert.deepEqual(codex.avatarCrop, { x: 10, y: 20, w: 100, h: 100 });

    const asset = await api(ctx.port, "GET", codex.avatarImage);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers["cross-origin-resource-policy"], "cross-origin");
    assert.match(asset.headers["cache-control"], /public, max-age=31536000, immutable/);

    const detail = await api(ctx.port, "GET", "/api/me/bots/bot_codex", { token: A.token });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.bot.id, "bot_codex");
    assert.equal(detail.body.bot.personaText, "You are Codex.");
    assert.equal(detail.body.bot.avatarImage, codex.avatarImage);

    const patch = await api(ctx.port, "PUT", "/api/me/bots/bot_codex", {
      token: A.token,
      body: {
        displayName: "Codex Prime",
        color: "#155e75",
        bio: "Updated helper",
        capabilities: ["chat"],
        personaText: "Updated persona.",
        clientOpId: "op_bot_2"
      }
    });
    assert.equal(patch.status, 200);
    assert.equal(patch.body.bot.displayName, "Codex Prime");
    assert.equal(patch.body.bot.avatarImage, codex.avatarImage);
    assert.deepEqual(patch.body.bot.avatarCrop, { x: 10, y: 20, w: 100, h: 100 });
  } finally { await stopServer(ctx); }
});

test("PATCH /api/me/profile accepts snake_case status badge and GET /api/me returns it", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "profilebadge");
    const badge = { kind: "emoji", emoji: "✅" };
    const profile = await api(ctx.port, "PATCH", "/api/me/profile", {
      token: A.token,
      body: {
        status_badge: badge,
        clientOpId: "op_profile_badge"
      }
    });
    assert.equal(profile.status, 200);
    assert.deepEqual(profile.body.user.statusBadge, badge);

    const me = await api(ctx.port, "GET", "/api/me", { token: A.token });
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.user.statusBadge, badge);

    const cleared = await api(ctx.port, "PATCH", "/api/me/profile", {
      token: A.token,
      body: {
        statusBadge: null,
        clientOpId: "op_profile_badge_clear"
      }
    });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.user.statusBadge, undefined);

    const afterClear = await api(ctx.port, "GET", "/api/me", { token: A.token });
    assert.equal(afterClear.status, 200);
    assert.equal(afterClear.body.user.statusBadge, undefined);
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
    assert.match(profile.body.user.avatarImage, /^\/api\/avatar-assets\/[A-Za-z0-9_.-]+\.png$/);
    assert.equal(profile.body.user.avatarImage.startsWith("data:"), false);
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
    assert.match(codex.avatarImage, /^\/api\/avatar-assets\/[A-Za-z0-9_.-]+\.png$/);
    assert.equal(codex.avatarImage.startsWith("data:"), false);
    assert.deepEqual(codex.avatarCrop, { x: 10, y: 20, w: 100, h: 100 });
    assert.equal(Object.prototype.hasOwnProperty.call(codex, "personaText"), false);

    assert.ok(JSON.stringify(me.body).length < 1_000, "compact /api/me should stay small");
    assert.ok(JSON.stringify(list.body).length < 5_000, "compact bot list should stay small");
  } finally { await stopServer(ctx); }
});

test("video bot avatars are materialized with the selected trim window", async () => {
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-fake-ffmpeg-"));
  const argsPath = path.join(fakeDir, "args.json");
  const fakeFfmpeg = path.join(fakeDir, "ffmpeg.js");
  fs.writeFileSync(fakeFfmpeg, `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.MIA_FAKE_FFMPEG_ARGS, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(process.argv[process.argv.length - 1], Buffer.alloc(1));
`, { mode: 0o755 });
  const ctx = await startServer({
    MIA_FFMPEG: fakeFfmpeg,
    MIA_FAKE_FFMPEG_ARGS: argsPath
  });
  try {
    const A = await register(ctx.port, "trimavatar");
    const put = await api(ctx.port, "PUT", "/api/me/bots/bot_video", {
      token: A.token,
      body: {
        displayName: "Video Bot",
        avatarImage: "data:video/mp4;base64," + Buffer.alloc(120_000, 7).toString("base64"),
        avatarCrop: { x: 36, y: 100, zoom: 1.09, start: 7.26, duration: 4.94 },
        personaText: "You are Video Bot.",
        clientOpId: "op_video_trim"
      }
    });
    assert.equal(put.status, 200);
    assert.match(put.body.bot.avatarImage, /^\/api\/avatar-assets\/[A-Za-z0-9_.-]+\.avatar\.mp4$/);
    assert.deepEqual(put.body.bot.avatarCrop, { x: 36, y: 100, zoom: 1.09, start: 7.26, duration: 4.94 });

    const args = JSON.parse(fs.readFileSync(argsPath, "utf8"));
    assert.ok(args.includes("-ss"), `ffmpeg args should include -ss: ${args.join(" ")}`);
    assert.equal(args[args.indexOf("-ss") + 1], "7.26");
    assert.ok(args.includes("-t"), `ffmpeg args should include -t: ${args.join(" ")}`);
    assert.equal(args[args.indexOf("-t") + 1], "4.94");

    const putAlt = await api(ctx.port, "PUT", "/api/me/bots/bot_video_alt", {
      token: A.token,
      body: {
        displayName: "Video Bot Alt",
        avatarImage: "data:video/mp4;base64," + Buffer.alloc(120_000, 7).toString("base64"),
        avatarCrop: { x: 36, y: 100, zoom: 1.09, start: 1.5, duration: 2.25 },
        personaText: "You are Video Bot Alt.",
        clientOpId: "op_video_trim_alt"
      }
    });
    assert.equal(putAlt.status, 200);
    assert.notEqual(
      putAlt.body.bot.avatarImage,
      put.body.bot.avatarImage,
      "same source video with a different trim must get a distinct immutable asset URL"
    );
  } finally {
    await stopServer(ctx);
    fs.rmSync(fakeDir, { recursive: true, force: true });
  }
});

test("compact /api/me returns compact user identity even when the profile avatar is large", async () => {
  const ctx = await startServer();
  try {
    const A = await register(ctx.port, "logincompact");
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

    const me = await api(ctx.port, "GET", "/api/me?compact=1", { token: A.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.id, A.user.id);
    assert.equal(Object.prototype.hasOwnProperty.call(me.body.user, "avatarImage"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(me.body.user, "avatarCrop"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(me.body.user, "avatarColor"), false);
    assert.ok(JSON.stringify(me.body).length < 1_000, "compact response should stay small");
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
