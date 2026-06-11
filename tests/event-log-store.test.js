const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCloudStore } = require("../src/cloud/sqlite-store");
const { createEventLogStore } = require("../src/cloud/event-log-store");

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-evt-"));
  const store = createCloudStore({ dataDir: dir });
  return { store, dir, cleanup() { fs.rmSync(dir, { recursive: true, force: true }); } };
}

function makeUser(store, id = "u1") {
  const db = store.getDb();
  db.prepare(
    "INSERT INTO users (id, account, username, email, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, `wechat:${id}`, `user-${id}`, "", `user-${id}`, new Date().toISOString());
  return id;
}

test("appendEvent increments seq monotonically per user", () => {
  const ctx = freshStore();
  try {
    const log = createEventLogStore(ctx.store.getDb());
    const userA = makeUser(ctx.store, "ua");
    const userB = makeUser(ctx.store, "ub");
    const a1 = log.appendEvent(userA, { kind: "conversation.updated", payload: { x: 1 } });
    const a2 = log.appendEvent(userA, { kind: "conversation.message_appended", payload: { x: 2 } });
    const a3 = log.appendEvent(userA, { kind: "conversation.updated", payload: { x: 3 } });
    const b1 = log.appendEvent(userB, { kind: "conversation.updated", payload: { y: 1 } });
    assert.equal(a1.seq, 1);
    assert.equal(a2.seq, 2);
    assert.equal(a3.seq, 3);
    assert.equal(b1.seq, 1, "user B's seq is independent of user A's");
    assert.equal(log.maxSeqForUser(userA), 3);
    assert.equal(log.maxSeqForUser(userB), 1);
  } finally { ctx.cleanup(); }
});

test("appendEvent persists scopeKind / scopeRef / payload roundtrip", () => {
  const ctx = freshStore();
  try {
    const log = createEventLogStore(ctx.store.getDb());
    const u = makeUser(ctx.store);
    log.appendEvent(u, {
      kind: "conversation.message_appended",
      scopeKind: "conversation",
      scopeRef: "g_abc",
      payload: { messageId: "m_1", text: "hi" }
    });
    const events = log.listEventsSince(u, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "conversation.message_appended");
    assert.equal(events[0].scopeKind, "conversation");
    assert.equal(events[0].scopeRef, "g_abc");
    assert.deepEqual(events[0].payload, { messageId: "m_1", text: "hi" });
  } finally { ctx.cleanup(); }
});

test("listEventsSince returns only events with seq > sinceSeq, in order, respecting limit", () => {
  const ctx = freshStore();
  try {
    const log = createEventLogStore(ctx.store.getDb());
    const u = makeUser(ctx.store);
    for (let i = 1; i <= 10; i++) log.appendEvent(u, { kind: "conversation.updated", payload: { i } });
    const tail = log.listEventsSince(u, 7);
    assert.equal(tail.length, 3, "events 8,9,10 should be returned");
    assert.deepEqual(tail.map((e) => e.seq), [8, 9, 10]);
    const empty = log.listEventsSince(u, 10);
    assert.equal(empty.length, 0);
    const limited = log.listEventsSince(u, 0, 3);
    assert.deepEqual(limited.map((e) => e.seq), [1, 2, 3]);
  } finally { ctx.cleanup(); }
});

test("users.event_seq cache stays in lock-step with last appended seq", () => {
  const ctx = freshStore();
  try {
    const log = createEventLogStore(ctx.store.getDb());
    const u = makeUser(ctx.store);
    log.appendEvent(u, { kind: "x", payload: {} });
    log.appendEvent(u, { kind: "x", payload: {} });
    const row = ctx.store.getDb().prepare("SELECT event_seq FROM users WHERE id = ?").get(u);
    assert.equal(row.event_seq, 2);
  } finally { ctx.cleanup(); }
});

test("op idempotency cache: getCachedOp returns null when missing, result when present", () => {
  const ctx = freshStore();
  try {
    const log = createEventLogStore(ctx.store.getDb());
    const u = makeUser(ctx.store);
    assert.equal(log.getCachedOp(u, "op_xyz"), null);
    log.cacheOp(u, "op_xyz", { result: { ok: true, conversation: { id: "g_1" } }, statusCode: 201 });
    const cached = log.getCachedOp(u, "op_xyz");
    assert.deepEqual(cached.result, { ok: true, conversation: { id: "g_1" } });
    assert.equal(cached.statusCode, 201);
  } finally { ctx.cleanup(); }
});

test("op idempotency cacheOp is replace-on-conflict (last write wins by clientOpId)", () => {
  const ctx = freshStore();
  try {
    const log = createEventLogStore(ctx.store.getDb());
    const u = makeUser(ctx.store);
    log.cacheOp(u, "op_x", { result: { v: 1 } });
    log.cacheOp(u, "op_x", { result: { v: 2 } });
    assert.deepEqual(log.getCachedOp(u, "op_x").result, { v: 2 });
  } finally { ctx.cleanup(); }
});

test("op idempotency purgeStaleOps removes rows older than the cutoff", () => {
  const ctx = freshStore();
  try {
    const db = ctx.store.getDb();
    const log = createEventLogStore(db);
    const u = makeUser(ctx.store);
    log.cacheOp(u, "old", { result: { v: 1 } });
    // Manually rewrite created_at to 48h ago
    const oldIso = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    db.prepare("UPDATE op_idempotency SET created_at = ? WHERE client_op = ?").run(oldIso, "old");
    log.cacheOp(u, "fresh", { result: { v: 2 } });
    const purged = log.purgeStaleOps();
    assert.equal(purged, 1);
    assert.equal(log.getCachedOp(u, "old"), null);
    assert.notEqual(log.getCachedOp(u, "fresh"), null);
  } finally { ctx.cleanup(); }
});

test("schema: user_events + op_idempotency tables + users.event_seq column exist after migrate", () => {
  const ctx = freshStore();
  try {
    const db = ctx.store.getDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    assert.ok(tables.includes("user_events"), "user_events table missing");
    assert.ok(tables.includes("op_idempotency"), "op_idempotency table missing");
    const cols = db.prepare("PRAGMA table_info(users)").all().map((r) => r.name);
    assert.ok(cols.includes("event_seq"), "users.event_seq column missing");
    const migrations = db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version);
    assert.ok(migrations.includes(4), "schema_migrations should record v4");
  } finally { ctx.cleanup(); }
});
