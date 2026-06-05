// Desktop-local cache of cloud conversation messages, backed by node:sqlite.
//
// The cloud remains the source of truth; this is a render cache so that opening
// a conversation paints instantly from disk (TG-style local-first render) and a
// reconnect only fetches messages newer than what we already have
// (delta sync keyed on the monotonic per-conversation `seq`).
//
// Each row stores the full message JSON in `payload` so new message fields ride
// along without a schema migration; the extracted columns exist only for
// querying/ordering. Client-only transient fields (e.g. in-place `translation`)
// are intentionally NOT persisted.
//
// The same SQLite file also stores a small social bootstrap cache keyed by cloud
// user id. It replaces the old renderer localStorage snapshot so cold starts can
// render a conversation list from disk without making localStorage a data source.

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const DEFAULT_RECENT_LIMIT = 50;
const DEFAULT_PRUNE_KEEP = 300;

function hasColumn(db, tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().some((row) => row.name === columnName);
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      conversation_id TEXT NOT NULL,
      id              TEXT NOT NULL,
      seq             INTEGER NOT NULL,
      sender_kind     TEXT,
      sender_ref      TEXT,
      body_md         TEXT,
      created_at      TEXT,
      payload         TEXT NOT NULL,
      PRIMARY KEY (conversation_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_seq
      ON messages (conversation_id, seq);
  `);

  if (!hasColumn(db, "social_bootstrap", "bots_json")) {
    db.exec("DROP TABLE IF EXISTS social_bootstrap");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS social_bootstrap (
      user_id            TEXT PRIMARY KEY,
      conversations_json TEXT NOT NULL,
      friends_json       TEXT NOT NULL,
      bots_json          TEXT NOT NULL,
      members_json       TEXT NOT NULL,
      updated_at         TEXT NOT NULL
    );
  `);
}

// dbPath: absolute path to the sqlite file. The directory is created if missing.
function openConversationMessageCache(dbPath) {
  if (!dbPath || typeof dbPath !== "string") {
    throw new Error("[conversation-message-cache] dbPath is required");
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  migrate(db);

  const insertStmt = db.prepare(`
    INSERT INTO messages (conversation_id, id, seq, sender_kind, sender_ref, body_md, created_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (conversation_id, id) DO UPDATE SET
      seq = excluded.seq,
      sender_kind = excluded.sender_kind,
      sender_ref = excluded.sender_ref,
      body_md = excluded.body_md,
      created_at = excluded.created_at,
      payload = excluded.payload
  `);
  const recentStmt = db.prepare(`
    SELECT payload FROM messages
    WHERE conversation_id = ?
    ORDER BY seq DESC
    LIMIT ?
  `);
  const maxSeqStmt = db.prepare(`
    SELECT MAX(seq) AS maxSeq FROM messages WHERE conversation_id = ?
  `);
  const deleteConvStmt = db.prepare("DELETE FROM messages WHERE conversation_id = ?");
  const socialBootstrapStmt = db.prepare(`
    SELECT conversations_json, friends_json, bots_json, members_json, updated_at
    FROM social_bootstrap
    WHERE user_id = ?
  `);
  const socialBootstrapUpsertStmt = db.prepare(`
    INSERT INTO social_bootstrap (user_id, conversations_json, friends_json, bots_json, members_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET
      conversations_json = excluded.conversations_json,
      friends_json = excluded.friends_json,
      bots_json = excluded.bots_json,
      members_json = excluded.members_json,
      updated_at = excluded.updated_at
  `);
  const socialBootstrapAllStmt = db.prepare("SELECT user_id, conversations_json, friends_json, bots_json, members_json FROM social_bootstrap");
  const cachedConversationIdsStmt = db.prepare(`
    SELECT conversation_id, MAX(seq) AS max_seq
    FROM messages
    GROUP BY conversation_id
    ORDER BY max_seq DESC
    LIMIT ?
  `);
  const pruneStmt = db.prepare(`
    DELETE FROM messages
    WHERE conversation_id = ?
      AND seq <= (
        SELECT seq FROM messages
        WHERE conversation_id = ?
        ORDER BY seq DESC
        LIMIT 1 OFFSET ?
      )
  `);

  // Persist a batch of messages for a conversation. Missing/invalid seq is
  // skipped — a message without a server seq has no stable cache identity.
  function upsertMessages(conversationId, messages) {
    const convId = String(conversationId || "");
    if (!convId || !Array.isArray(messages) || messages.length === 0) return 0;
    let written = 0;
    db.exec("BEGIN");
    try {
      for (const msg of messages) {
        if (!msg || typeof msg !== "object") continue;
        const seq = Number(msg.seq);
        const id = String(msg.id || "");
        if (!id || !Number.isFinite(seq)) continue;
        const { translation, ...persisted } = msg; // drop client-only transient state
        insertStmt.run(
          convId,
          id,
          seq,
          msg.sender_kind != null ? String(msg.sender_kind) : null,
          msg.sender_ref != null ? String(msg.sender_ref) : null,
          msg.body_md != null ? String(msg.body_md) : null,
          msg.created_at != null ? String(msg.created_at) : null,
          JSON.stringify(persisted)
        );
        written += 1;
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return written;
  }

  // Newest `limit` messages, returned oldest→newest (render order).
  function getRecentMessages(conversationId, limit = DEFAULT_RECENT_LIMIT) {
    const convId = String(conversationId || "");
    if (!convId) return [];
    const cap = Math.max(1, Math.min(Number(limit) || DEFAULT_RECENT_LIMIT, 1000));
    const rows = recentStmt.all(convId, cap);
    const out = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.payload));
      } catch { /* skip a corrupt row rather than fail the whole load */ }
    }
    return out.reverse();
  }

  function getMaxSeq(conversationId) {
    const convId = String(conversationId || "");
    if (!convId) return 0;
    const row = maxSeqStmt.get(convId);
    return Number(row?.maxSeq) || 0;
  }

  function deleteConversation(conversationId) {
    const convId = String(conversationId || "");
    if (!convId) return;
    deleteConvStmt.run(convId);
    for (const row of socialBootstrapAllStmt.all()) {
      const snapshot = parseSocialBootstrapRow(row.user_id, row);
      if (!snapshot) continue;
      const conversations = snapshot.conversations.filter((item) => item?.id !== convId);
      const members = { ...(snapshot.members || {}) };
      delete members[convId];
      updateSocialBootstrap(row.user_id, { conversations, members });
    }
  }

  // Keep only the newest `keep` messages for a conversation, dropping older rows.
  function pruneConversation(conversationId, keep = DEFAULT_PRUNE_KEEP) {
    const convId = String(conversationId || "");
    if (!convId) return;
    const keepN = Math.max(1, Number(keep) || DEFAULT_PRUNE_KEEP);
    pruneStmt.run(convId, convId, keepN);
  }

  function close() {
    db.close();
  }

  function parseJson(value, fallback) {
    try {
      const parsed = JSON.parse(value || "");
      return parsed == null ? fallback : parsed;
    } catch {
      return fallback;
    }
  }

  function parseSocialBootstrapRow(userId, row) {
    if (!row) return null;
    const conversations = parseJson(row.conversations_json, []);
    const friends = parseJson(row.friends_json, []);
    const bots = parseJson(row.bots_json, []);
    const members = parseJson(row.members_json, {});
    return {
      userId,
      conversations: Array.isArray(conversations) ? conversations : [],
      friends: Array.isArray(friends) ? friends : [],
      bots: Array.isArray(bots) ? bots : [],
      members: members && typeof members === "object" && !Array.isArray(members) ? members : {},
      updatedAt: row.updated_at || ""
    };
  }

  function getSocialBootstrap(userId) {
    const uid = String(userId || "").trim();
    if (!uid) return null;
    const stored = parseSocialBootstrapRow(uid, socialBootstrapStmt.get(uid));
    if (stored) return stored;
    const conversations = inferredConversationsForUser(uid);
    if (!conversations.length) return null;
    return {
      userId: uid,
      conversations,
      friends: [],
      bots: [],
      members: {},
      updatedAt: ""
    };
  }

  function inferredConversationForUser(conversationId, userId) {
    const id = String(conversationId || "");
    if (id.startsWith("botc_")) {
      return { id, type: "bot" };
    }
    if (id.startsWith("dm:")) {
      const parts = id.split(":").slice(1);
      if (parts.includes(userId)) return { id, type: "dm" };
    }
    return null;
  }

  function inferredConversationsForUser(userId) {
    const uid = String(userId || "").trim();
    if (!uid) return [];
    const rows = cachedConversationIdsStmt.all(100);
    return rows
      .map((row) => inferredConversationForUser(row.conversation_id, uid))
      .filter(Boolean);
  }

  function updateSocialBootstrap(userId, patch = {}) {
    const uid = String(userId || "").trim();
    if (!uid || !patch || typeof patch !== "object") return null;
    const current = getSocialBootstrap(uid) || {
      userId: uid,
      conversations: [],
      friends: [],
      bots: [],
      members: {}
    };
    const next = {
      userId: uid,
      conversations: Array.isArray(patch.conversations) ? patch.conversations : current.conversations,
      friends: Array.isArray(patch.friends) ? patch.friends : current.friends,
      bots: Array.isArray(patch.bots) ? patch.bots : current.bots,
      members: patch.members && typeof patch.members === "object" && !Array.isArray(patch.members)
        ? { ...(current.members || {}), ...patch.members }
        : (current.members || {}),
      updatedAt: new Date().toISOString()
    };
    socialBootstrapUpsertStmt.run(
      uid,
      JSON.stringify(next.conversations),
      JSON.stringify(next.friends),
      JSON.stringify(next.bots),
      JSON.stringify(next.members),
      next.updatedAt
    );
    return next;
  }

  return {
    upsertMessages,
    getRecentMessages,
    getMaxSeq,
    deleteConversation,
    pruneConversation,
    getSocialBootstrap,
    updateSocialBootstrap,
    close
  };
}

module.exports = { openConversationMessageCache, DEFAULT_RECENT_LIMIT };
