const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const { createCloudStore } = require("../src/cloud/sqlite-store.js");

function tempStore() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-cloud-store-"));
  return {
    dataDir,
    dbPath: path.join(dataDir, "cloud.sqlite"),
    uploadDir: path.join(dataDir, "uploads")
  };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test("sqlite store registers, logs in, authenticates, and logs out a user", () => {
  const paths = tempStore();
  const store = createCloudStore(paths);
  try {
    const registered = store.registerUser({ username: "Alice", password: "secret1" });
    assert.equal(registered.user.username, "alice");
    assert.ok(registered.token);
        // Phase 4: workspace removed from auth response.

    const loggedIn = store.loginUser({ username: "ALICE", password: "secret1" });
    assert.ok(loggedIn.token);
    const auth = store.authenticateToken(loggedIn.token);
    assert.equal(auth.user.username, "alice");

    store.logoutSession(loggedIn.token);
    assert.equal(store.authenticateToken(loggedIn.token), null);
  } finally {
    store.close();
    cleanup(paths.dataDir);
  }
});




test("sqlite store enforces file ownership", () => {
  const paths = tempStore();
  const store = createCloudStore(paths);
  try {
    const alice = store.registerUser({ username: "alice", password: "secret1" }).user;
    const bob = store.registerUser({ username: "bob", password: "secret1" }).user;
    const saved = store.saveImageDataUrl(alice.id, {
      name: "dog.png",
      dataUrl: `data:image/png;base64,${Buffer.from("png-data").toString("base64")}`
    });
    assert.equal(saved.type, "image");
    assert.equal(saved.url, `/api/files/${saved.id}`);
    assert.ok(fs.existsSync(saved.path));

    assert.equal(store.getFileForUser(alice.id, saved.id).id, saved.id);
    assert.equal(store.getFileForUser(bob.id, saved.id), null);

    const localPath = path.join(paths.dataDir, "report.txt");
    fs.writeFileSync(localPath, "generated report", { mode: 0o600 });
    const generated = store.saveLocalFileForUser(alice.id, {
      path: localPath,
      name: "../report.txt",
      mimeType: "text/plain",
      type: "text"
    });
    assert.equal(generated.type, "text");
    assert.equal(generated.name, "report.txt");
    assert.equal(fs.readFileSync(generated.path, "utf8"), "generated report");
    assert.equal(store.getFileForUser(bob.id, generated.id), null);

    assert.throws(
      () => store.saveImageDataUrl(alice.id, {
        name: "script.svg",
        dataUrl: `data:image/svg+xml;base64,${Buffer.from("<svg><script>alert(1)</script></svg>").toString("base64")}`
      }),
      /Unsupported image type/
    );
  } finally {
    store.close();
    cleanup(paths.dataDir);
  }
});

test("sqlite store records bridge devices and run lifecycle", () => {
  const paths = tempStore();
  const store = createCloudStore(paths);
  try {
    const user = store.registerUser({ username: "bridge", password: "secret1" }).user;
    const device = store.upsertBridgeDevice(user.id, {
      id: "bridge_local",
      deviceName: "Mac Studio",
      engine: "codex",
      capabilities: { streaming: false, attachments: true }
    });
    assert.equal(device.deviceName, "Mac Studio");
    assert.deepEqual(store.listBridgeDevices(user.id).map((item) => item.id), ["bridge_local"]);

    const run = store.createBridgeRun(user.id, {
      deviceId: device.id,
      conversationId: "conv_mia",
      text: "你好",
      attachments: [{ id: "req_1", type: "image", url: "/api/files/file_request" }]
    });
    assert.equal(run.status, "pending");
    assert.deepEqual(run.requestAttachments.map((item) => item.id), ["req_1"]);

    const running = store.startBridgeRun(user.id, run.id);
    assert.equal(running.status, "running");
    assert.deepEqual(running.requestAttachments.map((item) => item.id), ["req_1"]);

    const completed = store.completeBridgeRun(user.id, run.id, {
      text: "完成",
      attachments: [{ id: "att_1", type: "image", url: "/api/files/file_1" }]
    });
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.resultText, "完成");
    assert.deepEqual(completed.requestAttachments.map((item) => item.id), ["req_1"]);
    assert.deepEqual(completed.attachments.map((item) => item.id), ["att_1"]);
    assert.equal(store.listBridgeRuns(user.id)[0].id, run.id);
    assert.equal(store.cancelBridgeRun(user.id, run.id).status, "succeeded");
    assert.equal(store.failBridgeRun(user.id, run.id, "late failure").status, "succeeded");
    assert.equal(store.timeoutBridgeRun(user.id, run.id, "late timeout").status, "succeeded");

    const timeoutRun = store.createBridgeRun(user.id, {
      deviceId: device.id,
      conversationId: "conv_mia",
      text: "超时"
    });
    const timedOut = store.timeoutBridgeRun(user.id, timeoutRun.id, "本机 Agent 响应超时。");
    assert.equal(timedOut.status, "timed_out");
    assert.match(timedOut.error, /超时/);

    const cancelRun = store.createBridgeRun(user.id, {
      deviceId: device.id,
      conversationId: "conv_mia",
      text: "取消"
    });
    const cancelled = store.cancelBridgeRun(user.id, cancelRun.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(store.completeBridgeRun(user.id, cancelRun.id, { text: "late success" }).status, "cancelled");
  } finally {
    store.close();
    cleanup(paths.dataDir);
  }
});

test("sqlite store clears volatile bridge state after reopening", () => {
  const paths = tempStore();
  let userId = "";
  let runningRunId = "";
  let pendingRunId = "";
  let store = createCloudStore({
    ...paths,
    now: () => "2026-05-21T00:00:00.000Z"
  });
  try {
    const user = store.registerUser({ username: "restart", password: "secret1" }).user;
    userId = user.id;
    const device = store.upsertBridgeDevice(user.id, {
      id: "bridge_restart",
      deviceName: "Mac",
      engine: "codex"
    });
    assert.equal(store.listBridgeDevices(user.id).length, 1);

    const runningRun = store.createBridgeRun(user.id, {
      deviceId: device.id,
      conversationId: "conv_mia",
      text: "running"
    });
    runningRunId = runningRun.id;
    store.startBridgeRun(user.id, runningRun.id);
    pendingRunId = store.createBridgeRun(user.id, {
      deviceId: device.id,
      conversationId: "conv_mia",
      text: "pending"
    }).id;
  } finally {
    store.close();
  }

  store = createCloudStore({
    ...paths,
    now: () => "2026-05-21T00:01:00.000Z"
  });
  try {
    assert.deepEqual(store.listBridgeDevices(userId), []);
    const running = store.getBridgeRun(userId, runningRunId);
    const pending = store.getBridgeRun(userId, pendingRunId);
    assert.equal(running.status, "failed");
    assert.equal(pending.status, "failed");
    assert.match(running.error, /已重启/);
    assert.equal(running.completedAt, "2026-05-21T00:01:00.000Z");
  } finally {
    store.close();
    cleanup(paths.dataDir);
  }
});

test("sqlite store rate limits repeated failed logins per account and ip", () => {
  const paths = tempStore();
  const store = createCloudStore({
    ...paths,
    loginRateLimit: { maxFailures: 2, windowMs: 60_000 }
  });
  try {
    store.registerUser({ username: "limited", password: "secret1" });
    assert.throws(
      () => store.loginUser({ username: "limited", password: "wrong", ip: "10.0.0.1" }),
      /用户名或密码不正确/
    );
    assert.throws(
      () => store.loginUser({ username: "limited", password: "wrong", ip: "10.0.0.1" }),
      /用户名或密码不正确/
    );
    assert.throws(
      () => store.loginUser({ username: "limited", password: "secret1", ip: "10.0.0.1" }),
      /登录尝试过多/
    );

    const loggedIn = store.loginUser({ username: "limited", password: "secret1", ip: "10.0.0.2" });
    assert.ok(loggedIn.token);
  } finally {
    store.close();
    cleanup(paths.dataDir);
  }
});

test("schema v2 creates social tables and indexes", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-schema-test-"));
  const store = createCloudStore({ dataDir: tmpDir });
  try {
    const db = store.getDb();
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map((r) => r.name);
    for (const t of ["friendships", "friend_requests", "conversations", "conversation_members", "messages"]) {
      assert.ok(tables.includes(t), `missing table: ${t}`);
    }
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' ORDER BY name`).all().map((r) => r.name);
    for (const i of ["idx_friend_requests_to", "idx_friend_requests_code", "idx_conversation_members_user", "idx_messages_conversation_seq"]) {
      assert.ok(idx.includes(i), `missing index: ${i}`);
    }
    const version = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v;
    assert.ok(version >= 2, `schema_migrations max version should be >= 2, got ${version}`);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("schema creates bot-only identity and runtime tables", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-bot-schema-test-"));
  const dbPath = path.join(tmpDir, "cloud.sqlite");
  const store = createCloudStore({ dataDir: tmpDir, dbPath });
  try {
    const db = store.getDb();
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map((r) => r.name);
    assert.ok(tables.includes("bots"), "missing table: bots");
    assert.ok(tables.includes("bot_runtime_bindings"), "missing table: bot_runtime_bindings");

    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' ORDER BY name`).all().map((r) => r.name);
    assert.ok(idx.includes("idx_bots_owner"), "missing index: idx_bots_owner");

    const botColumns = db.prepare("PRAGMA table_info(bots)").all().map((r) => r.name);
    for (const column of ["id", "owner_user_id", "display_name", "status_badge_json", "capabilities_json", "persona_text"]) {
      assert.ok(botColumns.includes(column), `missing bots column: ${column}`);
    }
    assert.equal(db.prepare("SELECT pk FROM pragma_table_info('bots') WHERE name = 'id'").get().pk, 1);
    const runtimeColumns = db.prepare("PRAGMA table_info(bot_runtime_bindings)").all().map((r) => r.name);
    for (const column of ["user_id", "bot_id", "runtime_kind", "enabled", "config_json"]) {
      assert.ok(runtimeColumns.includes(column), `missing bot_runtime_bindings column: ${column}`);
    }
    assert.ok(db.prepare("PRAGMA table_info(users)").all().some((r) => r.name === "status_badge_json"));
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("migrate destructively removes old private bot conversation rows", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-bot-cleanup-test-"));
  const dbPath = path.join(tmpDir, "cloud.sqlite");
  const oldDb = new DatabaseSync(dbPath);
  try {
    oldDb.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'group',
        name TEXT,
        avatar TEXT,
        host_member_json TEXT,
        decorations_json TEXT,
        context_card_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE conversation_members (
        conversation_id TEXT NOT NULL,
        member_kind TEXT NOT NULL,
        member_ref TEXT NOT NULL,
        owner_id TEXT,
        ai_perms_json TEXT,
        joined_at TEXT NOT NULL,
        PRIMARY KEY (conversation_id, member_kind, member_ref)
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        turn_id TEXT,
        sender_kind TEXT NOT NULL,
        sender_ref TEXT NOT NULL,
        sender_owner_id TEXT,
        body_md TEXT NOT NULL DEFAULT '',
        attachments_json TEXT,
        mentions_json TEXT,
        skills_json TEXT,
        trace_json TEXT,
        status TEXT NOT NULL,
        error_json TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (conversation_id, seq)
      );
      INSERT INTO conversations (id, type, created_at, updated_at)
        VALUES ('fellow:u1:codex', 'fellow', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO conversations (id, type, created_at, updated_at)
        VALUES ('group-with-old-bot', 'group', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO conversations (id, type, created_at, updated_at)
        VALUES ('group-marked-old', 'fellow', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO conversations (id, type, created_at, updated_at)
        VALUES ('botc_u1_mia', 'bot', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO conversation_members (conversation_id, member_kind, member_ref, joined_at)
        VALUES ('fellow:u1:codex', 'user', 'u1', '2026-01-01T00:00:00.000Z');
      INSERT INTO conversation_members (conversation_id, member_kind, member_ref, joined_at)
        VALUES ('group-with-old-bot', 'fellow', 'codex', '2026-01-01T00:00:00.000Z');
      INSERT INTO conversation_members (conversation_id, member_kind, member_ref, joined_at)
        VALUES ('botc_u1_mia', 'bot', 'mia', '2026-01-01T00:00:00.000Z');
      INSERT INTO messages (id, conversation_id, seq, sender_kind, sender_ref, status, created_at)
        VALUES ('old_user_msg', 'fellow:u1:codex', 1, 'user', 'u1', 'sent', '2026-01-01T00:00:00.000Z');
      INSERT INTO messages (id, conversation_id, seq, sender_kind, sender_ref, status, created_at)
        VALUES ('old_msg', 'group-with-old-bot', 1, 'fellow', 'codex', 'sent', '2026-01-01T00:00:00.000Z');
      INSERT INTO messages (id, conversation_id, seq, sender_kind, sender_ref, status, created_at)
        VALUES ('bot_msg', 'botc_u1_mia', 1, 'bot', 'mia', 'sent', '2026-01-01T00:00:00.000Z');
    `);
  } finally {
    oldDb.close();
  }

  const store = createCloudStore({ dataDir: tmpDir, dbPath });
  try {
    const db = store.getDb();
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM conversations WHERE type = 'fellow' OR id LIKE 'fellow:%'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM conversation_members WHERE member_kind = 'fellow'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM conversation_members WHERE conversation_id LIKE 'fellow:%'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE sender_kind = 'fellow'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id LIKE 'fellow:%'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM conversations WHERE id = 'botc_u1_mia'").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM conversation_members WHERE member_kind = 'bot'").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE sender_kind = 'bot'").get().count, 1);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
