const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createCloudStore } = require("../src/cloud/sqlite-store.js");
const { createRuntimeBindingsStore } = require("../src/cloud-agent/runtime-bindings-store.js");
const { createCloudAgentRunsStore } = require("../src/cloud-agent/cloud-agent-runs-store.js");

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimashi-cloud-agent-stores-"));
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

function insertRoom(db, id) {
  db.prepare(
    "INSERT INTO rooms (id, type, name, created_at, updated_at) VALUES (?, 'fellow', ?, ?, ?)"
  ).run(id, "Aimashi", new Date().toISOString(), new Date().toISOString());
}

test("schema has fellow runtime bindings and cloud agent runs", () => {
  const ctx = freshStore();
  try {
    const tables = ctx.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    assert.ok(tables.includes("fellow_runtime_bindings"));
    assert.ok(tables.includes("cloud_agent_runs"));
    const migrations = ctx.db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version);
    assert.ok(migrations.includes(8));
  } finally {
    ctx.cleanup();
  }
});

test("runtime binding upsert/get scopes by user and fellow", () => {
  const ctx = freshStore();
  try {
    insertUser(ctx.db, "u1");
    const bindings = createRuntimeBindingsStore(ctx.db);
    const inserted = bindings.upsertBinding({
      userId: "u1",
      fellowId: "aimashi",
      runtimeKind: "cloud-hermes",
      enabled: true,
      config: { model: "hermes-agent" }
    });
    assert.equal(inserted.userId, "u1");
    assert.equal(inserted.fellowId, "aimashi");
    assert.equal(inserted.runtimeKind, "cloud-hermes");
    assert.equal(inserted.enabled, true);
    assert.deepEqual(inserted.config, { model: "hermes-agent" });

    assert.equal(bindings.getBinding("u2", "aimashi", "cloud-hermes"), null);
    assert.equal(bindings.getEnabledBinding("u1", "aimashi", "cloud-hermes").enabled, true);

    const disabled = bindings.upsertBinding({
      userId: "u1",
      fellowId: "aimashi",
      runtimeKind: "cloud-hermes",
      enabled: false,
      config: { model: "off" }
    });
    assert.equal(disabled.enabled, false);
    assert.equal(bindings.getEnabledBinding("u1", "aimashi", "cloud-hermes"), null);
  } finally {
    ctx.cleanup();
  }
});

test("cloud agent run lifecycle records hermes run id and completion", () => {
  const ctx = freshStore();
  try {
    insertUser(ctx.db, "u1");
    insertRoom(ctx.db, "fellow:u1:aimashi");
    const runs = createCloudAgentRunsStore(ctx.db);
    const run = runs.createRun({
      userId: "u1",
      fellowId: "aimashi",
      roomId: "fellow:u1:aimashi",
      triggerMessageId: "m1"
    });
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
      fellowId: "aimashi",
      roomId: "fellow:u1:aimashi",
      triggerMessageId: "m2"
    });
    const failed = runs.markError(errored.id, new Error("boom"));
    assert.equal(failed.status, "error");
    assert.deepEqual(failed.error, { message: "boom" });
  } finally {
    ctx.cleanup();
  }
});
