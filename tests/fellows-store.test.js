const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCloudStore } = require("../src/cloud/sqlite-store");
const { createFellowsStore } = require("../src/cloud/fellows-store");
const { normalizeFellowCapabilities } = require("../src/shared/fellow-identity.js");

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-fellows-"));
  const store = createCloudStore({ dataDir: dir });
  return { store, dir, cleanup() { fs.rmSync(dir, { recursive: true, force: true }); } };
}

function makeUser(store, id = "u1") {
  store.getDb().prepare(
    "INSERT INTO users (id, account, username, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, `${id}@local`, `user-${id}`, "salt", "hash", new Date().toISOString());
  return id;
}

test("upsertFellow creates, then updates, preserving createdAt", () => {
  const ctx = freshStore();
  try {
    const fellows = createFellowsStore(ctx.store.getDb());
    const u = makeUser(ctx.store);
    const inserted = fellows.upsertFellow(u, {
      id: "codex",
      name: "Codex",
      color: "#0f766e",
      avatarImage: "/avatar/codex.png",
      avatarCrop: { x: 10, y: 20, w: 100, h: 100 },
      bio: "Coding helper",
      capabilities: ["chat", "tools"],
      personaText: "You are Codex."
    });
    assert.equal(inserted.id, "codex");
    assert.equal(inserted.name, "Codex");
    assert.deepEqual(inserted.avatarCrop, { x: 10, y: 20, w: 100, h: 100 });
    assert.deepEqual(inserted.capabilities, normalizeFellowCapabilities(["chat", "tools"]));

    const updated = fellows.upsertFellow(u, {
      id: "codex",
      name: "Codex v2",
      color: "#0f766e",
      bio: "Better helper",
      capabilities: ["chat", "tools", "files"],
      personaText: "You are Codex v2."
    });
    assert.equal(updated.name, "Codex v2");
    assert.equal(updated.bio, "Better helper");
    assert.deepEqual(updated.capabilities, normalizeFellowCapabilities(["chat", "tools", "files"]));
    assert.equal(updated.createdAt, inserted.createdAt, "createdAt preserved across upserts");
    assert.ok(updated.updatedAt >= inserted.updatedAt, "updatedAt does not regress");
  } finally { ctx.cleanup(); }
});

test("listFellows scopes to owner", () => {
  const ctx = freshStore();
  try {
    const fellows = createFellowsStore(ctx.store.getDb());
    const a = makeUser(ctx.store, "ua");
    const b = makeUser(ctx.store, "ub");
    fellows.upsertFellow(a, { id: "f1", name: "Alpha" });
    fellows.upsertFellow(a, { id: "f2", name: "Beta" });
    fellows.upsertFellow(b, { id: "f1", name: "Alpha-of-B" });
    const aList = fellows.listFellows(a);
    const bList = fellows.listFellows(b);
    assert.equal(aList.length, 2);
    assert.equal(bList.length, 1);
    assert.equal(bList[0].name, "Alpha-of-B");
    assert.equal(fellows.getFellow(a, "f1").globalId, "fellow:ua:f1");
    assert.equal(fellows.getFellow(b, "f1").globalId, "fellow:ub:f1");
    assert.notEqual(
      fellows.getFellow(a, "f1").globalId,
      fellows.getFellow(b, "f1").globalId,
      "same local fellow id must still have a unique shareable identity per owner"
    );
  } finally { ctx.cleanup(); }
});

test("upsertFellow preserves object-shaped capabilities", () => {
  const ctx = freshStore();
  try {
    const fellows = createFellowsStore(ctx.store.getDb());
    const u = makeUser(ctx.store);
    const capabilities = {
      inheritEngineDefaults: false,
      enabledPlugins: ["github"],
      disabledPlugins: [],
      enabledSkills: ["code-review"],
      disabledSkills: [],
      enabledConnectors: ["outlook"]
    };
    const saved = fellows.upsertFellow(u, {
      id: "mia",
      name: "Mia",
      capabilities
    });

    assert.deepEqual(saved.capabilities, normalizeFellowCapabilities(capabilities));
    assert.deepEqual(fellows.getFellow(u, "mia").capabilities, normalizeFellowCapabilities(capabilities));
  } finally { ctx.cleanup(); }
});

test("deleteFellow removes only that owner's row", () => {
  const ctx = freshStore();
  try {
    const fellows = createFellowsStore(ctx.store.getDb());
    const a = makeUser(ctx.store, "ua");
    const b = makeUser(ctx.store, "ub");
    fellows.upsertFellow(a, { id: "f1", name: "Alpha" });
    fellows.upsertFellow(b, { id: "f1", name: "Alpha-of-B" });
    const removed = fellows.deleteFellow(a, "f1");
    assert.equal(removed, 1);
    assert.equal(fellows.getFellow(a, "f1"), null);
    assert.notEqual(fellows.getFellow(b, "f1"), null, "B's fellow with same id untouched");
  } finally { ctx.cleanup(); }
});

test("schema: fellows table + idx_fellows_owner index + migration v5 recorded", () => {
  const ctx = freshStore();
  try {
    const db = ctx.store.getDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    assert.ok(tables.includes("fellows"));
    const indices = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
    assert.ok(indices.includes("idx_fellows_owner"));
    const migrations = db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version);
    assert.ok(migrations.includes(5));
  } finally { ctx.cleanup(); }
});
