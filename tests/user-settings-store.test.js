const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCloudStore } = require("../src/cloud/sqlite-store");
const { createUserSettingsStore } = require("../src/cloud/user-settings-store");

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-us-"));
  const store = createCloudStore({ dataDir: dir });
  return { store, dir, cleanup() { fs.rmSync(dir, { recursive: true, force: true }); } };
}

function makeUser(store, id = "u1") {
  store.getDb().prepare(
    "INSERT INTO users (id, account, username, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, `${id}@local`, `user-${id}`, "salt", "hash", new Date().toISOString());
  return id;
}

test("getSettings returns defaults for users with no row", () => {
  const ctx = freshStore();
  try {
    const s = createUserSettingsStore(ctx.store.getDb());
    const u = makeUser(ctx.store);
    const out = s.getSettings(u);
    assert.deepEqual(out.pins, []);
    assert.deepEqual(out.readMarks, {});
    assert.deepEqual(out.appearance, {});
  } finally { ctx.cleanup(); }
});

test("putSettings whole-bag replace then read roundtrips, bumps version", () => {
  const ctx = freshStore();
  try {
    const s = createUserSettingsStore(ctx.store.getDb());
    const u = makeUser(ctx.store);
    const put = s.putSettings(u, {
      pins: ["g_abc", "fellow:codex"],
      readMarks: { "g_abc": 17, "dm:a:b": 4 },
      appearance: { theme: "dark", accentColor: "#5e5ce6" }
    });
    assert.equal(put.ok, true);
    assert.equal(put.settings.version, 1);
    assert.deepEqual(put.settings.pins, ["g_abc", "fellow:codex"]);

    const put2 = s.putSettings(u, {
      pins: ["only-one"],
      readMarks: {},
      appearance: {},
      expectedVersion: 1
    });
    assert.equal(put2.ok, true);
    assert.equal(put2.settings.version, 2);

    const read = s.getSettings(u);
    assert.deepEqual(read.pins, ["only-one"]);
    assert.equal(read.version, 2);
  } finally { ctx.cleanup(); }
});

test("putSettings rejects array length > 1000 pins (defensive cap)", () => {
  const ctx = freshStore();
  try {
    const s = createUserSettingsStore(ctx.store.getDb());
    const u = makeUser(ctx.store);
    const giant = Array.from({ length: 1500 }, (_, i) => `room_${i}`);
    const put = s.putSettings(u, { pins: giant, readMarks: {}, appearance: {} });
    assert.equal(put.ok, true);
    assert.equal(put.settings.pins.length, 1000);
  } finally { ctx.cleanup(); }
});

test("putSettings is per-user", () => {
  const ctx = freshStore();
  try {
    const s = createUserSettingsStore(ctx.store.getDb());
    const a = makeUser(ctx.store, "ua");
    const b = makeUser(ctx.store, "ub");
    s.putSettings(a, { pins: ["x"], readMarks: {}, appearance: {} });
    s.putSettings(b, { pins: ["y"], readMarks: {}, appearance: {} });
    assert.deepEqual(s.getSettings(a).pins, ["x"]);
    assert.deepEqual(s.getSettings(b).pins, ["y"]);
  } finally { ctx.cleanup(); }
});

test("putSettings CAS: stale expectedVersion returns conflict + current settings", () => {
  const ctx = freshStore();
  try {
    const s = createUserSettingsStore(ctx.store.getDb());
    const u = makeUser(ctx.store);
    s.putSettings(u, { pins: ["a"], readMarks: {}, appearance: {} });
    // simulate device B writing v2
    s.putSettings(u, { pins: ["a", "b"], readMarks: {}, appearance: {}, expectedVersion: 1 });
    // simulate device A still thinks v1 — should fail CAS
    const stale = s.putSettings(u, { pins: ["a", "z"], readMarks: {}, appearance: {}, expectedVersion: 1 });
    assert.equal(stale.ok, false);
    assert.equal(stale.conflict, true);
    assert.deepEqual(stale.settings.pins, ["a", "b"], "conflict response returns current server state for retry");
    assert.equal(stale.settings.version, 2);
  } finally { ctx.cleanup(); }
});

test("schema: user_settings table + migration v6", () => {
  const ctx = freshStore();
  try {
    const db = ctx.store.getDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    assert.ok(tables.includes("user_settings"));
    const m = db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version);
    assert.ok(m.includes(6));
  } finally { ctx.cleanup(); }
});
