const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCloudStore } = require("../src/cloud/sqlite-store");
const { createBotsStore } = require("../src/cloud/bots-store");
const { normalizeBotCapabilities } = require("../src/shared/bot-identity.js");

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-bots-"));
  const store = createCloudStore({ dataDir: dir });
  return { store, dir, cleanup() { fs.rmSync(dir, { recursive: true, force: true }); } };
}

function makeUser(store, id = "u1") {
  store.getDb().prepare(
    "INSERT INTO users (id, account, username, email, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, `wechat:${id}`, `user-${id}`, "", `user-${id}`, new Date().toISOString());
  return id;
}

test("upsertBot creates, then updates, preserving createdAt", () => {
  const ctx = freshStore();
  try {
    const bots = createBotsStore(ctx.store.getDb());
    const u = makeUser(ctx.store);
    const inserted = bots.upsertBot(u, {
      id: "codex",
      displayName: "Codex",
      color: "#0f766e",
      avatarImage: "/avatar/codex.png",
      avatarCrop: { x: 10, y: 20, w: 100, h: 100 },
      statusBadge: { kind: "lottie", assetId: "ready", label: "Ready" },
      bio: "Coding helper",
      capabilities: ["chat", "tools"],
      personaText: "You are Codex."
    });
    assert.equal(inserted.kind, "bot");
    assert.equal(inserted.id, "codex");
    assert.equal(inserted.ownerUserId, u);
    assert.equal(inserted.displayName, "Codex");
    assert.equal(inserted.name, "Codex");
    assert.deepEqual(inserted.avatar, {
      image: "/avatar/codex.png",
      crop: { x: 10, y: 20, w: 100, h: 100 },
      color: "#0f766e",
      text: "Codex"
    });
    assert.deepEqual(inserted.statusBadge, { kind: "lottie", assetId: "ready", label: "Ready" });
    assert.deepEqual(inserted.capabilities, normalizeBotCapabilities(["chat", "tools"]));

    const updated = bots.upsertBot(u, {
      id: "codex",
      displayName: "Codex v2",
      color: "#0f766e",
      statusBadge: { kind: "gift", assetId: "wrench", label: "Busy" },
      bio: "Better helper",
      capabilities: ["chat", "tools", "files"],
      personaText: "You are Codex v2."
    });
    assert.equal(updated.displayName, "Codex v2");
    assert.equal(updated.bio, "Better helper");
    assert.deepEqual(updated.statusBadge, { kind: "gift", assetId: "wrench", label: "Busy" });
    assert.deepEqual(updated.capabilities, normalizeBotCapabilities(["chat", "tools", "files"]));
    assert.equal(updated.createdAt, inserted.createdAt, "createdAt preserved across upserts");
    assert.ok(updated.updatedAt >= inserted.updatedAt, "updatedAt does not regress");
  } finally { ctx.cleanup(); }
});

test("bot ids are globally unique and cannot be reused by another owner", () => {
  const ctx = freshStore();
  try {
    const bots = createBotsStore(ctx.store.getDb());
    const a = makeUser(ctx.store, "ua");
    const b = makeUser(ctx.store, "ub");
    bots.upsertBot(a, { id: "shared", displayName: "Alpha" });

    assert.equal(bots.getBot("shared").ownerUserId, a);
    assert.throws(
      () => bots.upsertBot(b, { id: "shared", displayName: "Beta" }),
      /bot id already belongs to another owner/
    );
  } finally { ctx.cleanup(); }
});

test("listBots scopes to owner while getBot resolves global identity", () => {
  const ctx = freshStore();
  try {
    const bots = createBotsStore(ctx.store.getDb());
    const a = makeUser(ctx.store, "ua");
    const b = makeUser(ctx.store, "ub");
    bots.upsertBot(a, { id: "f1", displayName: "Alpha" });
    bots.upsertBot(a, { id: "f2", displayName: "Beta" });
    bots.upsertBot(b, { id: "f3", displayName: "Gamma" });
    const aList = bots.listBots(a);
    const bList = bots.listBots(b);
    assert.equal(aList.length, 2);
    assert.equal(bList.length, 1);
    assert.equal(bList[0].displayName, "Gamma");
    assert.equal(bots.getBot("f1").ownerUserId, a);
    assert.equal(bots.getBot("f3").ownerUserId, b);
  } finally { ctx.cleanup(); }
});

test("upsertBot preserves object-shaped capabilities", () => {
  const ctx = freshStore();
  try {
    const bots = createBotsStore(ctx.store.getDb());
    const u = makeUser(ctx.store);
    const capabilities = {
      inheritEngineDefaults: false,
      enabledPlugins: ["github"],
      disabledPlugins: [],
      enabledSkills: ["code-review"],
      disabledSkills: [],
      enabledConnectors: ["outlook"]
    };
    const saved = bots.upsertBot(u, {
      id: "mia",
      displayName: "Mia",
      capabilities
    });

    assert.deepEqual(saved.capabilities, normalizeBotCapabilities(capabilities));
    assert.deepEqual(bots.getBot("mia").capabilities, normalizeBotCapabilities(capabilities));
  } finally { ctx.cleanup(); }
});

test("getBot parses status_badge_json into statusBadge", () => {
  const ctx = freshStore();
  try {
    const db = ctx.store.getDb();
    const bots = createBotsStore(db);
    const u = makeUser(ctx.store);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO bots (
        id, owner_user_id, display_name, status_badge_json, capabilities_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "bot_rose",
      u,
      "Rose",
      JSON.stringify({ kind: "gift", asset_id: "rose", collectible_id: "nft_rose_1" }),
      "{}",
      now,
      now
    );

    assert.deepEqual(bots.getBot("bot_rose").statusBadge, {
      kind: "gift",
      assetId: "rose",
      collectibleId: "nft_rose_1"
    });
  } finally { ctx.cleanup(); }
});

test("upsertBot requires ownerUserId, bot id, and explicit display name", () => {
  const ctx = freshStore();
  try {
    const bots = createBotsStore(ctx.store.getDb());
    const u = makeUser(ctx.store);
    assert.throws(() => bots.upsertBot("", { id: "missing-owner", displayName: "Bot" }), /ownerUserId required/);
    assert.throws(() => bots.upsertBot(u, { displayName: "Missing id" }), /bot.id and bot.displayName required/);
    assert.throws(() => bots.upsertBot(u, { id: "implicit-only" }), /bot.id and bot.displayName required/);
  } finally { ctx.cleanup(); }
});

test("deleteBot removes only the owner's bot row", () => {
  const ctx = freshStore();
  try {
    const bots = createBotsStore(ctx.store.getDb());
    const a = makeUser(ctx.store, "ua");
    const b = makeUser(ctx.store, "ub");
    bots.upsertBot(a, { id: "a-bot", displayName: "Alpha" });
    bots.upsertBot(b, { id: "b-bot", displayName: "Beta" });
    assert.equal(bots.deleteBot(b, "a-bot"), 0);
    const removed = bots.deleteBot(a, "a-bot");
    assert.equal(removed, 1);
    assert.equal(bots.getBot("a-bot"), null);
    assert.notEqual(bots.getBot("b-bot"), null, "other owner's bot untouched");
  } finally { ctx.cleanup(); }
});

test("schema: bots table + idx_bots_owner index + migration v5 recorded", () => {
  const ctx = freshStore();
  try {
    const db = ctx.store.getDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    assert.ok(tables.includes("bots"));
    assert.ok(!tables.includes("fellows"));
    assert.ok(!tables.includes("fellow_runtime_bindings"));
    const indices = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
    assert.ok(indices.includes("idx_bots_owner"));
    const migrations = db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version);
    assert.ok(migrations.includes(5));
  } finally { ctx.cleanup(); }
});
