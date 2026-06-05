const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createCloudStore } = require("../src/cloud/sqlite-store.js");
const { createRuntimeBindingsStore } = require("../src/cloud-agent/runtime-bindings-store.js");
const { createCloudAgentRunsStore } = require("../src/cloud-agent/cloud-agent-runs-store.js");
const { DatabaseSync } = require("node:sqlite");

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-cloud-agent-stores-"));
  const store = createCloudStore({ dataDir: dir });
  return {
    dir,
    store,
    db: store.getDb(),
    cleanup() {
      store.close?.();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function insertUser(db, id) {
  db.prepare(
    "INSERT INTO users (id, account, username, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, `${id}@local`, id, "salt", "hash", new Date().toISOString());
}

function insertBot(db, id, ownerUserId) {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO bots (id, owner_user_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  ).run(id, ownerUserId, id, now, now);
}

function insertConversation(db, id) {
  db.prepare(
    "INSERT INTO conversations (id, type, name, created_at, updated_at) VALUES (?, 'bot', ?, ?, ?)"
  ).run(id, "Mia", new Date().toISOString(), new Date().toISOString());
}

test("schema has bot runtime bindings and cloud agent runs", () => {
  const ctx = freshStore();
  try {
    const tables = ctx.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    assert.ok(tables.includes("bot_runtime_bindings"));
    assert.ok(tables.includes("cloud_agent_runs"));
    const bindingCols = ctx.db.prepare("PRAGMA table_info(bot_runtime_bindings)").all().map((r) => r.name);
    assert.ok(bindingCols.includes("bot_id"));
    const migrations = ctx.db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version);
    assert.ok(migrations.includes(8));
  } finally {
    ctx.cleanup();
  }
});

test("runtime binding upsert/get scopes by user and bot", () => {
  const ctx = freshStore();
  try {
    insertUser(ctx.db, "u1");
    insertBot(ctx.db, "bot_mia", "u1");
    const bindings = createRuntimeBindingsStore(ctx.db);
    const inserted = bindings.upsertBinding({
      userId: "u1",
      botId: "bot_mia",
      runtimeKind: "cloud-hermes",
      enabled: true,
      config: { model: "hermes-agent" }
    });
    assert.equal(inserted.userId, "u1");
    assert.equal(inserted.botId, "bot_mia");
    assert.equal(inserted.runtimeKind, "cloud-hermes");
    assert.equal(inserted.enabled, true);
    assert.deepEqual(inserted.config, { model: "hermes-agent" });

    assert.equal(bindings.getBinding("u2", "bot_mia", "cloud-hermes"), null);
    assert.equal(bindings.getEnabledBinding("u1", "bot_mia", "cloud-hermes").enabled, true);

    const disabled = bindings.upsertBinding({
      userId: "u1",
      botId: "bot_mia",
      runtimeKind: "cloud-hermes",
      enabled: false,
      config: { model: "off" }
    });
    assert.equal(disabled.enabled, false);
    assert.equal(bindings.getEnabledBinding("u1", "bot_mia", "cloud-hermes"), null);
  } finally {
    ctx.cleanup();
  }
});

test("cloud agent run lifecycle records hermes run id and completion", () => {
  const ctx = freshStore();
  try {
    insertUser(ctx.db, "u1");
    insertConversation(ctx.db, "botc_session_1");
    const runs = createCloudAgentRunsStore(ctx.db);
    const run = runs.createRun({
      userId: "u1",
      botId: "bot_mia",
      conversationId: "botc_session_1",
      triggerMessageId: "m1"
    });
    assert.equal(run.botId, "bot_mia");
    assert.equal(run.status, "queued");
    assert.equal(run.hermesRunId, "");

    const running = runs.markRunning(run.id, "hr_1");
    assert.equal(running.status, "running");
    assert.equal(running.hermesRunId, "hr_1");

    const complete = runs.markComplete(run.id);
    assert.equal(complete.status, "complete");
    assert.equal(runs.getRun(run.id).status, "complete");

    const errored = runs.createRun({
      userId: "u1",
      botId: "bot_mia",
      conversationId: "botc_session_1",
      triggerMessageId: "m2"
    });
    const failed = runs.markError(errored.id, new Error("boom"));
    assert.equal(failed.status, "error");
    assert.deepEqual(failed.error, { message: "boom" });
  } finally {
    ctx.cleanup();
  }
});

test("cloud store destructively rebuilds old cloud_agent_runs table without bot_id", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-cloud-agent-runs-migrate-"));
  const dbPath = path.join(dir, "cloud.sqlite");
  const legacy = new DatabaseSync(dbPath);
  try {
    legacy.exec(`
      CREATE TABLE cloud_agent_runs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        trigger_message_id TEXT NOT NULL,
        hermes_run_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        error_json TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO cloud_agent_runs (
        id, user_id, actor_id, conversation_id, trigger_message_id, status, created_at, updated_at
      ) VALUES (
        'old_run', 'u1', 'old_actor', 'botc_old', 'm_old', 'queued', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
    `);
  } finally {
    legacy.close();
  }

  const store = createCloudStore({ dataDir: dir, dbPath });
  try {
    const db = store.getDb();
    const columns = db.prepare("PRAGMA table_info(cloud_agent_runs)").all().map((row) => row.name);
    assert.ok(columns.includes("bot_id"));
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM cloud_agent_runs").get().count, 0);

    insertUser(db, "u1");
    insertConversation(db, "botc_new");
    const runs = createCloudAgentRunsStore(db);
    const run = runs.createRun({
      userId: "u1",
      botId: "bot_mia",
      conversationId: "botc_new",
      triggerMessageId: "m1"
    });
    assert.equal(run.botId, "bot_mia");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
