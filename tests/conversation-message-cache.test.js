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

test("legacy scheduled wake cleanup removes referenced user messages from every cached alias", () => {
  const { dir, dbPath } = tempCache();
  const cache = openConversationMessageCache(dbPath);
  try {
    assert.equal(typeof cache.cleanupLegacyScheduledUserMessages, "function");
    cache.upsertMessages("botc_1", [
      msg(1, { id: "setup", body_md: "一分钟后提醒我喝水" }),
      msg(2, { id: "legacy_wake", body_md: "提醒用户喝水" })
    ]);
    cache.upsertMessages("cloud_bridge_botc_1", [
      msg(2, { id: "legacy_wake", body_md: "提醒用户喝水" }),
      msg(3, { id: "reply", sender_kind: "bot", body_md: "该喝水啦" })
    ]);

    const result = cache.cleanupLegacyScheduledUserMessages([
      {
        target: {
          conversationId: "cloud_bridge_botc_1",
          runs: [{ messageId: "legacy_wake", assistantMessageId: "reply" }]
        }
      },
      { target: { conversationId: "botc_1", runs: [{ messageId: null }] } }
    ]);

    assert.equal(result.deleted, 2);
    assert.deepEqual(result.refs, [
      {
        messageId: "legacy_wake",
        conversationIds: ["cloud_bridge_botc_1", "botc_1"]
      }
    ]);
    assert.deepEqual(cache.getRecentMessages("botc_1", 50).map((m) => m.id), ["setup"]);
    assert.deepEqual(cache.getRecentMessages("cloud_bridge_botc_1", 50).map((m) => m.id), ["reply"]);
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

test("large message payloads are canonical on disk, compact in lists, and full by id", () => {
  const { dir, dbPath } = tempCache();
  const large = "x".repeat(200_000);
  const trace = { reasoning: large, tools: [{ id: "tool_1", name: "shell", output: large }] };
  const blocks = [{ type: "tool", id: "tool_1", name: "shell", output: large }];
  const cache = openConversationMessageCache(dbPath);
  try {
    cache.upsertMessages("c1", [msg(1, {
      content: { runtime: { trace, contentBlocks: blocks }, label: "kept" },
      content_json: JSON.stringify({ runtime: { trace, contentBlocks: blocks }, label: "kept" }),
      trace,
      trace_json: JSON.stringify(trace),
      contentBlocks: blocks,
      content_blocks_json: JSON.stringify(blocks)
    })]);

    const [compact] = cache.getRecentMessages("c1", 50, { compact: true });
    assert.equal(compact._messagePayload, "compact");
    assert.ok(JSON.stringify(compact).length < 20_000, "list payload stays bounded");

    const full = cache.getMessage("c1", "m1");
    assert.equal(full.trace.reasoning, large);
    assert.equal(full.contentBlocks[0].output, large);
  } finally {
    cache.close();
  }

  const db = new DatabaseSync(dbPath);
  try {
    const payload = JSON.parse(db.prepare("SELECT payload FROM messages WHERE id = 'm1'").get().payload);
    const content = JSON.parse(payload.content_json);
    assert.equal(payload.content, undefined);
    assert.equal(payload.trace, undefined);
    assert.equal(payload.contentBlocks, undefined);
    assert.equal(content.label, "kept");
    assert.equal(content.runtime, undefined, "runtime aliases were removed from content_json");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("logical identity keeps cloud and Core mirrors as one durable cache row", () => {
  const { dir, dbPath } = tempCache();
  const cache = openConversationMessageCache(dbPath);
  try {
    cache.upsertMessages("botc_1", [{
      id: "msg_core_reply",
      seq: 2,
      sender_kind: "bot",
      sender_ref: "bot_1",
      body_md: "done",
      turn_id: "turn_1",
      trace: { reasoning: "checked" },
      _localCoreConversationId: "cloud_bridge_botc_1",
      created_at: "2026-07-29T12:00:01.000Z"
    }]);
    cache.upsertMessages("botc_1", [{
      id: "m_cloud_reply",
      seq: 2,
      sender_kind: "bot",
      sender_ref: "bot_1",
      body_md: "done",
      turn_id: "turn_1",
      created_at: "2026-07-29T12:00:01.000Z"
    }]);

    const rows = cache.getRecentMessages("botc_1", 50);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "m_cloud_reply");
    assert.deepEqual(rows[0].trace, { reasoning: "checked" });
  } finally {
    cache.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("opening a legacy cache migrates existing cloud/Core duplicates exactly once", () => {
  const { dir, dbPath } = tempCache();
  const oldDb = new DatabaseSync(dbPath);
  try {
    oldDb.exec(`
      CREATE TABLE messages (
        conversation_id TEXT NOT NULL,
        id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        sender_kind TEXT,
        sender_ref TEXT,
        body_md TEXT,
        created_at TEXT,
        payload TEXT NOT NULL,
        PRIMARY KEY (conversation_id, id)
      );
    `);
    const insert = oldDb.prepare(`
      INSERT INTO messages (
        conversation_id, id, seq, sender_kind, sender_ref, body_md, created_at, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const rows = [
      msg(1, {
        id: "m_cloud_user",
        body_md: "hi",
        created_at: "2026-07-29T12:00:00.000Z"
      }),
      msg(1, {
        id: "msg_core_user",
        body_md: "hi",
        _localCoreConversationId: "cloud_bridge_botc_1",
        created_at: "2026-07-29T12:00:00.221Z"
      }),
      msg(2, {
        id: "m_cloud_reply",
        sender_kind: "bot",
        body_md: "hello",
        turn_id: "turn_1",
        created_at: "2026-07-29T12:00:01.000Z"
      }),
      msg(2, {
        id: "msg_core_reply",
        sender_kind: "bot",
        body_md: "hello",
        turn_id: "turn_1",
        trace: { reasoning: "kept" },
        _localCoreConversationId: "cloud_bridge_botc_1",
        created_at: "2026-07-29T12:00:01.000Z"
      })
    ];
    for (const row of rows) {
      insert.run(
        "botc_1",
        row.id,
        row.seq,
        row.sender_kind,
        row.sender_ref,
        row.body_md,
        row.created_at,
        JSON.stringify(row)
      );
    }
  } finally {
    oldDb.close();
  }

  let cache = openConversationMessageCache(dbPath);
  try {
    const rows = cache.getRecentMessages("botc_1", 50);
    assert.deepEqual(rows.map((row) => row.id), ["m_cloud_user", "m_cloud_reply"]);
    assert.deepEqual(rows[1].trace, { reasoning: "kept" });
  } finally {
    cache.close();
  }

  cache = openConversationMessageCache(dbPath);
  cache.close();
  const migratedDb = new DatabaseSync(dbPath);
  try {
    const columns = migratedDb.prepare("PRAGMA table_info(messages)").all().map((row) => row.name);
    const indexes = migratedDb.prepare("PRAGMA index_list(messages)").all().map((row) => row.name);
    assert.ok(columns.includes("logical_id"));
    assert.ok(indexes.includes("idx_messages_conversation_logical_id"));
    assert.equal(migratedDb.prepare("SELECT COUNT(*) AS count FROM messages").get().count, 2);
  } finally {
    migratedDb.close();
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
  const dbPath = path.join(dir, "conversation-cache.db");
  const owner = openConversationMessageCache(dbPath);
  const mirror = openConversationMessageCache(dbPath);
  t.after(() => {
    owner.close?.();
    mirror.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  for (let i = 0; i < 25; i += 1) {
    owner.upsertMessages("c_1", [{ id: `m_${i}`, seq: i + 1, sender_kind: "bot", body_md: `回复 ${i}` }]);
    mirror.updateSocialBootstrap("u_1", { conversations: [{ id: "c_1", title: `第 ${i} 轮` }] });
  }

  assert.equal(owner.getRecentMessages("c_1", 50).length, 25);
  assert.equal(mirror.getSocialBootstrap("u_1").conversations[0].title, "第 24 轮");
});
