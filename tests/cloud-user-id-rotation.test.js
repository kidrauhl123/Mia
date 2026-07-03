const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createCloudStore } = require("../src/cloud/sqlite-store.js");
const { dmConversationId } = require("../src/cloud/dm-conversation.js");
const { rotateCloudUserIds } = require("../scripts/rotate-cloud-user-ids.js");

function tempStore() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-user-id-rotation-"));
  return {
    dataDir,
    dbPath: path.join(dataDir, "cloud.sqlite"),
    uploadDir: path.join(dataDir, "uploads")
  };
}

function insertUser(db, id, account) {
  db.prepare(`
    INSERT INTO users (id, account, username, email, display_name, created_at)
    VALUES (?, ?, ?, '', ?, '2026-06-10T00:00:00.000Z')
  `).run(id, account.toLowerCase(), account.toLowerCase(), account);
}

function insertConversation(db, id, type = "dm") {
  db.prepare(`
    INSERT INTO conversations (id, type, created_at, updated_at)
    VALUES (?, ?, '2026-06-10T00:00:00.000Z', '2026-06-10T00:00:00.000Z')
  `).run(id, type);
}

function oldReferenceCount(db, oldIds) {
  let count = 0;
  const checks = [
    ["users", "id"],
    ["sessions", "user_id"],
    ["wechat_accounts", "user_id"],
    ["workspaces", "user_id"],
    ["files", "user_id"],
    ["bridge_devices", "user_id"],
    ["bridge_runs", "user_id"],
    ["friend_requests", "from_user"],
    ["friend_requests", "to_user"],
    ["conversation_members", "member_ref"],
    ["conversation_members", "owner_id"],
    ["messages", "sender_ref"],
    ["messages", "sender_owner_id"],
    ["message_hidden", "user_id"],
    ["user_events", "user_id"],
    ["op_idempotency", "user_id"],
    ["bots", "owner_user_id"],
    ["user_settings", "user_id"],
    ["bot_runtime_bindings", "user_id"],
    ["cloud_agent_runs", "user_id"],
    ["skills", "owner_user_id"],
    ["skill_installs", "user_id"],
    ["skill_reports", "reporter_id"],
    ["model_accounts", "user_id"],
    ["model_balance_ledger", "user_id"],
    ["model_usage_ledger", "user_id"],
    ["push_tokens", "user_id"]
  ];
  for (const [table, column] of checks) {
    for (const oldId of oldIds) {
      count += db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(oldId).n;
    }
  }
  return count;
}

test("rotateCloudUserIds rewrites legacy user ids, conversation ids, JSON settings, and upload paths", () => {
  const paths = tempStore();
  const store = createCloudStore(paths);
  const db = store.getDb();
  const old755 = "user_QrruqrvKlz4p9PAE";
  const oldMarcos = "user_marcos_legacy";
  const oldKing = "user_king_legacy";
  const friend = "2222222222";
  const newIds = ["8123456789", "7234567890", "6345678901"];
  const dmOld = dmConversationId(old755, oldMarcos);
  const botOld = `botc_${old755}_mia`;
  const groupId = "g_3333333333";
  const uploadOldDir = path.join(paths.uploadDir, old755);
  fs.mkdirSync(uploadOldDir, { recursive: true });
  const fileOldPath = path.join(uploadOldDir, "file_a.png");
  fs.writeFileSync(fileOldPath, "avatar");

  try {
    insertUser(db, old755, "755439");
    insertUser(db, oldMarcos, "marcos");
    insertUser(db, oldKing, "king");
    insertUser(db, friend, "friend");
    db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ('tok', ?, 't', 't')").run(old755);
    db.prepare("INSERT INTO wechat_accounts (openid, user_id, unionid, nickname, avatar_url, raw_json, created_at, updated_at) VALUES ('openid_a', ?, 'union_a', 'Alice', '', '{}', 't', 't')")
      .run(old755);
    db.prepare("INSERT INTO workspaces (user_id, revision, snapshot_json, updated_at) VALUES (?, 1, ?, 't')")
      .run(old755, JSON.stringify({ activeConversationId: dmOld, owner: old755 }));
    db.prepare("INSERT INTO files (id, user_id, type, name, mime_type, path, size, created_at) VALUES ('file_a', ?, 'image', 'a.png', 'image/png', ?, 6, 't')")
      .run(old755, fileOldPath);
    db.prepare("INSERT INTO bridge_devices (id, user_id, device_name, engine, connected_at, last_seen_at) VALUES ('bridge_a', ?, 'Mac', 'codex', 't', 't')")
      .run(old755);
    db.prepare("INSERT INTO bridge_runs (id, user_id, device_id, conversation_id, status, created_at, updated_at) VALUES ('run_a', ?, 'bridge_a', ?, 'pending', 't', 't')")
      .run(old755, dmOld);
    db.prepare("INSERT INTO friendships (user_a, user_b, created_at) VALUES (?, ?, 't')")
      .run(old755 < oldMarcos ? old755 : oldMarcos, old755 < oldMarcos ? oldMarcos : old755);
    db.prepare("INSERT INTO friend_requests (id, from_user, to_user, status, created_at) VALUES ('fr_a', ?, ?, 'pending', 't')")
      .run(oldKing, old755);

    insertConversation(db, dmOld, "dm");
    insertConversation(db, botOld, "bot");
    insertConversation(db, groupId, "group");
    db.prepare("INSERT INTO conversation_members (conversation_id, member_kind, member_ref, joined_at) VALUES (?, 'user', ?, 't')")
      .run(dmOld, old755);
    db.prepare("INSERT INTO conversation_members (conversation_id, member_kind, member_ref, joined_at) VALUES (?, 'user', ?, 't')")
      .run(dmOld, oldMarcos);
    db.prepare("INSERT INTO conversation_members (conversation_id, member_kind, member_ref, joined_at) VALUES (?, 'user', ?, 't')")
      .run(botOld, old755);
    db.prepare("INSERT INTO conversation_members (conversation_id, member_kind, member_ref, owner_id, joined_at) VALUES (?, 'bot', 'mia', ?, 't')")
      .run(botOld, old755);
    db.prepare("INSERT INTO conversation_members (conversation_id, member_kind, member_ref, joined_at) VALUES (?, 'user', ?, 't')")
      .run(groupId, oldKing);
    db.prepare("INSERT INTO conversation_members (conversation_id, member_kind, member_ref, owner_id, joined_at) VALUES (?, 'bot', 'king-bot', ?, 't')")
      .run(groupId, oldKing);
    db.prepare("INSERT INTO messages (id, conversation_id, seq, sender_kind, sender_ref, sender_owner_id, status, created_at, mentions_json) VALUES ('msg_a', ?, 1, 'user', ?, NULL, 'sent', 't', ?)")
      .run(dmOld, old755, JSON.stringify([{ member_kind: "user", member_ref: oldMarcos }]));
    db.prepare("INSERT INTO messages (id, conversation_id, seq, sender_kind, sender_ref, sender_owner_id, status, created_at) VALUES ('msg_b', ?, 1, 'bot', 'mia', ?, 'sent', 't')")
      .run(botOld, old755);
    db.prepare("INSERT INTO message_hidden (user_id, conversation_id, message_id, created_at) VALUES (?, ?, 'msg_a', 't')")
      .run(oldMarcos, dmOld);
    db.prepare("INSERT INTO bots (id, owner_user_id, display_name, created_at, updated_at) VALUES ('mia', ?, 'Mia', 't', 't')")
      .run(old755);
    db.prepare(`
      INSERT INTO user_settings (
        user_id,
        pins_json,
        read_marks_json,
        muted_conversations_json,
        unread_overrides_json,
        appearance_json,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, '{}', 't')
    `).run(
      old755,
      JSON.stringify([dmOld, botOld]),
      JSON.stringify({ [dmOld]: 1, [botOld]: 2 }),
      JSON.stringify([dmOld]),
      JSON.stringify({ [botOld]: true })
    );
    db.prepare("INSERT INTO bot_runtime_bindings (user_id, bot_id, runtime_kind, config_json, created_at, updated_at) VALUES (?, 'mia', 'cloud-claude-code', ?, 't', 't')")
      .run(old755, JSON.stringify({ session: botOld, owner: old755 }));
    db.prepare("INSERT INTO cloud_agent_runs (id, user_id, bot_id, conversation_id, trigger_message_id, status, error_json, created_at, updated_at) VALUES ('car_a', ?, 'mia', ?, 'msg_b', 'queued', ?, 't', 't')")
      .run(old755, botOld, JSON.stringify({ conversationId: botOld, userId: old755 }));
    db.prepare("INSERT INTO user_events (user_id, seq, kind, scope_kind, scope_ref, payload, created_at) VALUES (?, 1, 'conversation.message_appended', 'conversation', ?, ?, 't')")
      .run(old755, dmOld, JSON.stringify({ conversationId: dmOld, sender: old755 }));
    db.prepare("INSERT INTO op_idempotency (user_id, client_op, result_json, created_at) VALUES (?, 'op_a', ?, 't')")
      .run(old755, JSON.stringify({ conversation: { id: dmOld }, user: { id: old755 } }));
    db.prepare("INSERT INTO skills (id, owner_user_id, name, body, created_at, updated_at) VALUES ('skill_a', ?, 'Skill A', 'body', 't', 't')")
      .run(old755);
    db.prepare("INSERT INTO skill_installs (skill_id, user_id, created_at) VALUES ('skill_a', ?, 't')")
      .run(oldMarcos);
    db.prepare("INSERT INTO skill_reports (id, skill_id, reporter_id, created_at) VALUES ('report_a', 'skill_a', ?, 't')")
      .run(oldKing);
    db.prepare("INSERT INTO model_accounts (user_id, balance_microusd, updated_at) VALUES (?, 100, 't')")
      .run(old755);
    db.prepare("INSERT INTO model_balance_ledger (id, user_id, delta_microusd, balance_after_microusd, reason, usage_id, created_at) VALUES ('ledger_a', ?, 100, 100, 'test', '', 't')")
      .run(old755);
    db.prepare("INSERT INTO model_usage_ledger (id, user_id, model_id, upstream_model, provider, request_path, prompt_tokens, completion_tokens, total_tokens, cost_microusd, charge_microusd, status, error, created_at) VALUES ('usage_a', ?, 'mia-default', 'deepseek-chat', 'deepseek', '/v1/chat/completions', 1, 2, 3, 4, 5, 'ok', '', 't')")
      .run(old755);
    db.prepare("INSERT INTO push_tokens (token, user_id, platform, device_name, created_at, updated_at) VALUES ('push_a', ?, 'ios', 'iPhone', 't', 't')")
      .run(old755);

    const result = rotateCloudUserIds({
      dbPath: paths.dbPath,
      accounts: ["755439", "Marcos", "king"],
      apply: true,
      backup: false,
      idGenerator: () => newIds.shift()
    });

    assert.deepEqual(result.rotated.map((item) => [item.account, item.oldId, item.newId]), [
      ["755439", old755, "8123456789"],
      ["marcos", oldMarcos, "7234567890"],
      ["king", oldKing, "6345678901"]
    ]);
    assert.equal(result.conversationIds.some((item) => item.oldId === dmOld), true);
    assert.equal(result.conversationIds.some((item) => item.oldId === botOld), true);

    const newDm = dmConversationId("8123456789", "7234567890");
    const newBot = "botc_8123456789_mia";
    assert.equal(db.prepare("SELECT id FROM users WHERE account = '755439'").get().id, "8123456789");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE id = ?").get(newDm).n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE id = ?").get(newBot).n, 1);
    assert.equal(db.prepare("SELECT sender_ref FROM messages WHERE id = 'msg_a'").get().sender_ref, "8123456789");
    assert.equal(db.prepare("SELECT sender_owner_id FROM messages WHERE id = 'msg_b'").get().sender_owner_id, "8123456789");
    assert.equal(db.prepare("SELECT owner_id FROM conversation_members WHERE member_kind = 'bot' AND member_ref = 'king-bot'").get().owner_id, "6345678901");
    assert.deepEqual(
      db.prepare("SELECT user_a, user_b FROM friendships").all().map((row) => [row.user_a, row.user_b]),
      [["7234567890", "8123456789"]]
    );
    const settings = db.prepare("SELECT pins_json, read_marks_json, muted_conversations_json, unread_overrides_json FROM user_settings WHERE user_id = '8123456789'").get();
    assert.deepEqual(JSON.parse(settings.pins_json), [newDm, newBot]);
    assert.deepEqual(Object.keys(JSON.parse(settings.read_marks_json)).sort(), [newBot, newDm].sort());
    assert.deepEqual(JSON.parse(settings.muted_conversations_json), [newDm]);
    assert.deepEqual(JSON.parse(settings.unread_overrides_json), { [newBot]: true });
    assert.ok(db.prepare("SELECT payload FROM user_events WHERE user_id = '8123456789'").get().payload.includes(newDm));
    assert.ok(db.prepare("SELECT result_json FROM op_idempotency WHERE user_id = '8123456789'").get().result_json.includes("8123456789"));
    assert.equal(oldReferenceCount(db, [old755, oldMarcos, oldKing]), 0);
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);

    const filePath = db.prepare("SELECT path FROM files WHERE id = 'file_a'").get().path;
    assert.match(filePath, /8123456789/);
    assert.equal(fs.existsSync(fileOldPath), false);
    assert.equal(fs.existsSync(filePath), true);
  } finally {
    store.close();
    fs.rmSync(paths.dataDir, { recursive: true, force: true });
  }
});

test("rotateCloudUserIds dry run reports current-format ids without mutating", () => {
  const paths = tempStore();
  const store = createCloudStore(paths);
  const db = store.getDb();
  try {
    insertUser(db, "5123456789", "755439");
    const result = rotateCloudUserIds({
      dbPath: paths.dbPath,
      accounts: ["755439"],
      apply: false,
      backup: false,
      idGenerator: () => "6123456789"
    });
    assert.equal(result.rotated.length, 0);
    assert.equal(result.skipped[0].reason, "already-current-format");
    assert.equal(db.prepare("SELECT id FROM users WHERE account = '755439'").get().id, "5123456789");
  } finally {
    store.close();
    fs.rmSync(paths.dataDir, { recursive: true, force: true });
  }
});

test("rotateCloudUserIds can target a user by display name", () => {
  const paths = tempStore();
  const store = createCloudStore(paths);
  const db = store.getDb();
  try {
    insertUser(db, "5123456", "wechat:openid");
    db.prepare("UPDATE users SET username = 'wx_8067aabb7153', display_name = '我耳塞呢' WHERE id = '5123456'").run();
    const result = rotateCloudUserIds({
      dbPath: paths.dbPath,
      accounts: ["我耳塞呢"],
      apply: false,
      backup: false,
      idGenerator: () => "100001"
    });
    assert.equal(result.rotated.length, 0);
    assert.equal(result.skipped[0].id, "5123456");
    assert.equal(result.skipped[0].reason, "already-current-format");
  } finally {
    store.close();
    fs.rmSync(paths.dataDir, { recursive: true, force: true });
  }
});

test("rotateCloudUserIds force-rotates current ids to a custom short uid", () => {
  const paths = tempStore();
  const store = createCloudStore(paths);
  const db = store.getDb();
  try {
    insertUser(db, "5123456", "wechat:openid");
    db.prepare("UPDATE users SET display_name = '我耳塞呢' WHERE id = '5123456'").run();
    const result = rotateCloudUserIds({
      dbPath: paths.dbPath,
      accounts: ["我耳塞呢"],
      apply: true,
      backup: false,
      forceCurrent: true,
      idGenerator: () => "100001"
    });
    assert.deepEqual(result.rotated.map((item) => [item.oldId, item.newId]), [["5123456", "100001"]]);
    assert.equal(db.prepare("SELECT id FROM users WHERE display_name = '我耳塞呢'").get().id, "100001");
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    store.close();
    fs.rmSync(paths.dataDir, { recursive: true, force: true });
  }
});
