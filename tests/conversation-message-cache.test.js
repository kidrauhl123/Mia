const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const { openConversationMessageCache } = require("../src/main/social/conversation-message-cache.js");

function tempCache() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-msg-cache-"));
  return { dir, dbPath: path.join(dir, "conversation-cache.db") };
}

function msg(seq, overrides = {}) {
  return {
    id: overrides.id || `m${seq}`,
    seq,
    sender_kind: "user",
    sender_ref: "u1",
    body_md: `body ${seq}`,
    created_at: `2026-05-27T00:00:${String(seq).padStart(2, "0")}Z`,
    ...overrides
  };
}

test("upsert then getRecentMessages returns oldest→newest and tracks maxSeq", () => {
  const { dir, dbPath } = tempCache();
  const cache = openConversationMessageCache(dbPath);
  try {
    cache.upsertMessages("c1", [msg(3), msg(1), msg(2)]); // out of order on purpose
    const rows = cache.getRecentMessages("c1", 50);
    assert.deepEqual(rows.map((m) => m.seq), [1, 2, 3], "render order is ascending by seq");
    assert.equal(cache.getMaxSeq("c1"), 3);
    assert.equal(cache.getMaxSeq("unknown"), 0);
  } finally {
    cache.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("getRecentMessages caps to the newest N", () => {
  const { dir, dbPath } = tempCache();
  const cache = openConversationMessageCache(dbPath);
  try {
    cache.upsertMessages("c1", [msg(1), msg(2), msg(3), msg(4), msg(5)]);
    const rows = cache.getRecentMessages("c1", 2);
    assert.deepEqual(rows.map((m) => m.seq), [4, 5], "keeps the two newest, in ascending order");
  } finally {
    cache.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("re-upsert of same id updates in place (no duplicate row), enabling delta merge", () => {
  const { dir, dbPath } = tempCache();
  const cache = openConversationMessageCache(dbPath);
  try {
    cache.upsertMessages("c1", [msg(1, { body_md: "old" })]);
    cache.upsertMessages("c1", [msg(1, { body_md: "edited" }), msg(2)]); // delta arrives
    const rows = cache.getRecentMessages("c1", 50);
    assert.equal(rows.length, 2);
    assert.equal(rows.find((m) => m.seq === 1).body_md, "edited");
    assert.equal(cache.getMaxSeq("c1"), 2);
  } finally {
    cache.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("transient translation field is not persisted, but other payload fields survive", () => {
  const { dir, dbPath } = tempCache();
  const cache = openConversationMessageCache(dbPath);
  try {
    cache.upsertMessages("c1", [msg(1, {
      translation: { status: "done", text: "hi" },
      trace_json: "{\"reasoning\":\"x\"}",
      attachments: [{ name: "a.png" }]
    })]);
    const [row] = cache.getRecentMessages("c1", 50);
    assert.equal(row.translation, undefined, "client-only translation dropped");
    assert.equal(row.trace_json, "{\"reasoning\":\"x\"}", "trace survives via payload JSON");
    assert.deepEqual(row.attachments, [{ name: "a.png" }], "unknown fields ride along in payload");
  } finally {
    cache.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("messages without id or finite seq are skipped", () => {
  const { dir, dbPath } = tempCache();
  const cache = openConversationMessageCache(dbPath);
  try {
    const written = cache.upsertMessages("c1", [
      msg(1),
      { id: "", seq: 2 },
      { id: "x", seq: NaN },
      { id: "y" }
    ]);
    assert.equal(written, 1);
    assert.deepEqual(cache.getRecentMessages("c1", 50).map((m) => m.id), ["m1"]);
  } finally {
    cache.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneConversation keeps only the newest N", () => {
  const { dir, dbPath } = tempCache();
  const cache = openConversationMessageCache(dbPath);
  try {
    cache.upsertMessages("c1", [msg(1), msg(2), msg(3), msg(4), msg(5)]);
    cache.pruneConversation("c1", 2);
    assert.deepEqual(cache.getRecentMessages("c1", 50).map((m) => m.seq), [4, 5]);
    assert.equal(cache.getMaxSeq("c1"), 5);
  } finally {
    cache.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deleteConversation removes only that conversation", () => {
  const { dir, dbPath } = tempCache();
  const cache = openConversationMessageCache(dbPath);
  try {
    cache.upsertMessages("c1", [msg(1)]);
    cache.upsertMessages("c2", [msg(1)]);
    cache.deleteConversation("c1");
    assert.deepEqual(cache.getRecentMessages("c1", 50), []);
    assert.equal(cache.getRecentMessages("c2", 50).length, 1);
  } finally {
    cache.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deleteMessage removes one cached row and survives reopen", () => {
  const { dir, dbPath } = tempCache();
  let cache = openConversationMessageCache(dbPath);
  try {
    cache.upsertMessages("c1", [msg(1), msg(2), msg(3)]);
    assert.equal(cache.deleteMessage("c1", "m2"), 1);
    assert.equal(cache.deleteMessage("c1", "m_missing"), 0);
    assert.deepEqual(cache.getRecentMessages("c1", 50).map((m) => m.id), ["m1", "m3"]);
  } finally {
    cache.close();
  }

  cache = openConversationMessageCache(dbPath);
  try {
    assert.deepEqual(cache.getRecentMessages("c1", 50).map((m) => m.id), ["m1", "m3"]);
    assert.equal(cache.getMaxSeq("c1"), 3);
  } finally {
    cache.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reconcileFetchedMessages keeps cached rows missing from a fetched server window", () => {
  const { dir, dbPath } = tempCache();
  const cache = openConversationMessageCache(dbPath);
  try {
    cache.upsertMessages("c1", [msg(1), msg(2), msg(3)]);
    const removed = cache.reconcileFetchedMessages("c1", 0, [msg(1), msg(3)], 100);
    assert.equal(removed, 0);
    assert.deepEqual(cache.getRecentMessages("c1", 50).map((m) => m.id), ["m1", "m2", "m3"]);
  } finally {
    cache.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reconcileFetchedMessages keeps rows beyond a full page boundary", () => {
  const { dir, dbPath } = tempCache();
  const cache = openConversationMessageCache(dbPath);
  try {
    cache.upsertMessages("c1", [msg(1), msg(2), msg(200)]);
    const removed = cache.reconcileFetchedMessages("c1", 0, [msg(1), msg(2)], 2);
    assert.equal(removed, 0);
    assert.deepEqual(cache.getRecentMessages("c1", 50).map((m) => m.id), ["m1", "m2", "m200"]);
  } finally {
    cache.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cache persists across reopen (cold-start render survives restart)", () => {
  const { dir, dbPath } = tempCache();
  let cache = openConversationMessageCache(dbPath);
  cache.upsertMessages("c1", [msg(1), msg(2)]);
  cache.close();
  cache = openConversationMessageCache(dbPath);
  try {
    assert.deepEqual(cache.getRecentMessages("c1", 50).map((m) => m.seq), [1, 2]);
    assert.equal(cache.getMaxSeq("c1"), 2);
  } finally {
    cache.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("social bootstrap cache persists conversations, friends, bots, and members per user", () => {
  const { dir, dbPath } = tempCache();
  let cache = openConversationMessageCache(dbPath);
  cache.updateSocialBootstrap("u1", {
    conversations: [
      { id: "botc_u1_mia", type: "bot", name: "Mia", decorations: { botId: "mia", sessionId: "mia" } },
      { id: "botc_u1_9b7c6d5e-1111-4222-8333-123456789abc", type: "bot", name: "history", decorations: { botId: "mia", sessionId: "9b7c6d5e-1111-4222-8333-123456789abc" } },
      { id: "g_abc", type: "group", name: "Group" }
    ],
    friends: [{ id: "u2", username: "friend" }],
    bots: [{ id: "mia", key: "mia", name: "Mia" }],
    members: { "botc_u1_mia": [{ member_kind: "bot", member_ref: "mia" }] }
  });
  cache.close();
  cache = openConversationMessageCache(dbPath);
  try {
    const snapshot = cache.getSocialBootstrap("u1");
    assert.deepEqual(snapshot.conversations.map((item) => item.id), [
      "botc_u1_mia",
      "botc_u1_9b7c6d5e-1111-4222-8333-123456789abc",
      "g_abc"
    ]);
    assert.deepEqual(snapshot.friends.map((item) => item.username), ["friend"]);
    assert.deepEqual(snapshot.bots.map((item) => item.key), ["mia"]);
    assert.equal(snapshot.members["botc_u1_mia"][0].member_ref, "mia");
    assert.equal(cache.getSocialBootstrap("u2"), null);
  } finally {
    cache.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("social bootstrap falls back to cached bot and dm conversation ids", () => {
  const { dir, dbPath } = tempCache();
  const cache = openConversationMessageCache(dbPath);
  try {
    cache.upsertMessages("botc_u1_mia", [msg(1)]);
    cache.upsertMessages("botc_u1_9b7c6d5e-1111-4222-8333-123456789abc", [msg(1)]);
    cache.upsertMessages("dm:u1:u2", [msg(1)]);
    cache.upsertMessages("botc_u_other_mia", [msg(1)]);

    const snapshot = cache.getSocialBootstrap("u1");

    assert.deepEqual(snapshot.conversations.map((item) => item.id).sort(), [
      "botc_u1_9b7c6d5e-1111-4222-8333-123456789abc",
      "botc_u1_mia",
      "botc_u_other_mia",
      "dm:u1:u2"
    ]);
    assert.deepEqual(snapshot.friends, []);
    assert.deepEqual(snapshot.bots, []);
  } finally {
    cache.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("old social bootstrap cache without bots_json is rebuilt destructively", () => {
  const { dir, dbPath } = tempCache();
  const oldDb = new DatabaseSync(dbPath);
  try {
    oldDb.exec(`
      CREATE TABLE social_bootstrap (
        user_id TEXT PRIMARY KEY,
        conversations_json TEXT NOT NULL,
        friends_json TEXT NOT NULL,
        members_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO social_bootstrap (user_id, conversations_json, friends_json, members_json, updated_at)
        VALUES ('u1', '[]', '[]', '{}', '2026-01-01T00:00:00.000Z');
    `);
  } finally {
    oldDb.close();
  }

  const cache = openConversationMessageCache(dbPath);
  try {
    assert.equal(cache.getSocialBootstrap("u1"), null);
    cache.updateSocialBootstrap("u1", {
      conversations: [],
      friends: [],
      bots: [{ id: "mia", key: "mia" }],
      members: {}
    });
    assert.deepEqual(cache.getSocialBootstrap("u1").bots.map((item) => item.key), ["mia"]);
  } finally {
    cache.close();
  }
  const migratedDb = new DatabaseSync(dbPath);
  try {
    const columns = migratedDb.prepare("PRAGMA table_info(social_bootstrap)").all().map((row) => row.name);
    assert.ok(columns.includes("bots_json"));
  } finally {
    migratedDb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("two handles on the same cache file interleave writes without SQLITE_BUSY", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-cache-dual-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, "conversation-cache.db");
  const owner = openConversationMessageCache(dbPath);
  const mirror = openConversationMessageCache(dbPath);
  t.after(() => { owner.close?.(); mirror.close?.(); });

  for (let i = 0; i < 25; i += 1) {
    owner.upsertMessages("c_1", [{ id: `m_${i}`, seq: i + 1, sender_kind: "bot", body_md: `回复 ${i}` }]);
    mirror.updateSocialBootstrap("u_1", { conversations: [{ id: "c_1", title: `第 ${i} 轮` }] });
  }

  assert.equal(owner.getRecentMessages("c_1", 50).length, 25);
  assert.equal(mirror.getSocialBootstrap("u_1").conversations[0].title, "第 24 轮");
});
