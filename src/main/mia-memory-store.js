"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const VALID_SCOPES = new Set(["user", "bot", "session"]);
const MEMORY_NEAR_DUPLICATE_MIN_SCORE = 0.88;

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value = "") {
  return String(value || "")
    .replace(/## Mia Bot Memory/g, "Mia Bot Memory")
    .replace(/\r/g, "")
    .trim();
}

function normalizeText(value = "") {
  return cleanText(value).replace(/\s+/g, " ").toLowerCase();
}

function normalizeMemoryMatchKey(value = "") {
  return normalizeText(value)
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMemorySemanticKey(value = "") {
  const key = normalizeMemoryMatchKey(value);
  if (!key) return "";
  return key
    .replace(/^(?:the user|user|i am|i m|i|my|me)\s+/i, "")
    .replace(/^(?:\u8be5\u7528\u6237|\u8fd9\u4e2a\u7528\u6237|\u7528\u6237|\u672c\u4eba|\u6211\u7684|\u6211\u4eec|\u54b1\u4eec|\u54b1|\u6211|\u4f60\u7684|\u4f60)\s*/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenFrequency(value = "") {
  const map = new Map();
  for (const token of String(value || "").split(/\s+/g).map((item) => item.trim()).filter(Boolean)) {
    map.set(token, (map.get(token) || 0) + 1);
  }
  return map;
}

function tokenOverlapScore(left = "", right = "") {
  const leftMap = tokenFrequency(left);
  const rightMap = tokenFrequency(right);
  if (!leftMap.size || !rightMap.size) return 0;
  let leftCount = 0;
  let rightCount = 0;
  let intersection = 0;
  for (const count of leftMap.values()) leftCount += count;
  for (const count of rightMap.values()) rightCount += count;
  for (const [token, count] of leftMap.entries()) {
    intersection += Math.min(count, rightMap.get(token) || 0);
  }
  const denominator = Math.min(leftCount, rightCount);
  return denominator > 0 ? intersection / denominator : 0;
}

function characterBigramMap(value = "") {
  const compact = String(value || "").replace(/\s+/g, "").trim();
  if (!compact) return new Map();
  if (compact.length <= 1) return new Map([[compact, 1]]);
  const map = new Map();
  for (let index = 0; index < compact.length - 1; index += 1) {
    const gram = compact.slice(index, index + 2);
    map.set(gram, (map.get(gram) || 0) + 1);
  }
  return map;
}

function characterBigramDiceScore(left = "", right = "") {
  const leftMap = characterBigramMap(left);
  const rightMap = characterBigramMap(right);
  if (!leftMap.size || !rightMap.size) return 0;
  let leftCount = 0;
  let rightCount = 0;
  let intersection = 0;
  for (const count of leftMap.values()) leftCount += count;
  for (const count of rightMap.values()) rightCount += count;
  for (const [gram, count] of leftMap.entries()) {
    intersection += Math.min(count, rightMap.get(gram) || 0);
  }
  const denominator = leftCount + rightCount;
  return denominator > 0 ? (2 * intersection) / denominator : 0;
}

function memorySimilarityScore(left = "", right = "") {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const compactLeft = String(left).replace(/\s+/g, "");
  const compactRight = String(right).replace(/\s+/g, "");
  if (compactLeft && compactLeft === compactRight) return 1;

  let phraseScore = 0;
  if (compactLeft && compactRight && (compactLeft.includes(compactRight) || compactRight.includes(compactLeft))) {
    phraseScore = Math.min(compactLeft.length, compactRight.length) / Math.max(compactLeft.length, compactRight.length);
  }
  return Math.max(
    phraseScore,
    tokenOverlapScore(left, right),
    characterBigramDiceScore(left, right)
  );
}

function memoryTextQuality(value = "") {
  const normalized = cleanText(value);
  if (!normalized) return 0;
  let score = normalized.length;
  if (/^(?:the user|user)\b/i.test(normalized)) score -= 12;
  if (/^(?:i|i am|i'm|my)\b/i.test(normalized)) score += 4;
  if (/^(?:\u8be5\u7528\u6237|\u8fd9\u4e2a\u7528\u6237|\u7528\u6237)\s*/u.test(normalized)) score -= 12;
  if (/^(?:\u6211|\u6211\u662f|\u6211\u6709|\u6211\u4f1a|\u6211\u559c\u6b22|\u6211\u504f\u597d)/u.test(normalized)) score += 4;
  return score;
}

function choosePreferredMemoryText(currentText = "", incomingText = "") {
  const current = cleanText(currentText);
  const incoming = cleanText(incomingText);
  if (!current) return incoming;
  if (!incoming) return current;
  const currentScore = memoryTextQuality(current);
  const incomingScore = memoryTextQuality(incoming);
  if (incomingScore > currentScore + 1) return incoming;
  if (currentScore > incomingScore + 1) return current;
  return incoming.length >= current.length ? incoming : current;
}

function sha256(value = "") {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function safeJson(value, fallback) {
  try {
    if (typeof value === "string") return value ? JSON.parse(value) : fallback;
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

function json(value) {
  return JSON.stringify(value == null ? null : value);
}

function normalizeScope(value = "", fallback = "bot") {
  const scope = String(value || "").trim().toLowerCase();
  return VALID_SCOPES.has(scope) ? scope : fallback;
}

function normalizePriority(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(-100, Math.min(100, Math.trunc(n)));
}

function cleanId(value = "", fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function arrayFrom(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
}

function hasColumn(db, tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().some((row) => row.name === columnName);
}

function rowToEntry(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    botId: row.bot_id,
    sessionId: row.session_id,
    scope: row.scope,
    text: row.text,
    confidence: Number(row.confidence || 0),
    source: row.source,
    originEngine: row.origin_engine || "",
    originNativeSessionId: row.origin_native_session_id || "",
    sourceMessageIds: safeJson(row.source_message_ids_json, []),
    linkedMemoryIds: safeJson(row.linked_memory_ids_json, []),
    policyResult: safeJson(row.policy_result_json, {}),
    priority: Number(row.priority || 0),
    pinned: Boolean(row.pinned),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at || "",
    expiresAt: row.expires_at || "",
    metadata: safeJson(row.metadata_json, {}),
    deletedAt: row.deleted_at || "",
    revision: Number(row.revision || 1)
  };
}

function ftsQuery(value = "") {
  const terms = normalizeText(value)
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, 8);
  if (!terms.length) return "";
  return terms.map((term) => `"${term.replace(/"/g, "\"\"")}"`).join(" OR ");
}

function sensitivity(text = "") {
  const value = String(text || "");
  const credentialWords = [
    "api[_ -]?key",
    "secret",
    "token",
    "bearer\\s+[a-z0-9._-]+",
    "password",
    "passwd",
    "\\u5bc6\\u7801",
    "\\u53e3\\u4ee4",
    "\\u79c1\\u94a5",
    "private key"
  ].join("|");
  const sensitiveIdWords = [
    "\\u8eab\\u4efd\\u8bc1",
    "\\u94f6\\u884c\\u5361",
    "\\u4fe1\\u7528\\u5361",
    "credit card",
    "ssn",
    "social security"
  ].join("|");
  if (new RegExp(`(${credentialWords})`, "i").test(value)) {
    return { sensitive: true, severity: "credential", reason: "looks like credential material" };
  }
  if (new RegExp(`(\\b\\d{15,18}[xX]?\\b|${sensitiveIdWords})`, "i").test(value)) {
    return { sensitive: true, severity: "sensitive_id", reason: "looks like sensitive identity or payment data" };
  }
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value) || /\b(?:\+?\d[\d\s().-]{7,}\d)\b/.test(value)) {
    return { sensitive: true, severity: "contact", reason: "looks like contact information" };
  }
  return { sensitive: false, severity: "", reason: "" };
}

function createMiaMemoryStore(deps = {}) {
  const runtimePaths = deps.runtimePaths;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");

  const fsImpl = deps.fs || fs;
  const now = deps.now || nowIso;
  const randomUUID = deps.randomUUID || (() => crypto.randomUUID());
  const getCurrentUserId = typeof deps.currentUserId === "function" ? deps.currentUserId : () => "local";
  const Database = deps.DatabaseSync || DatabaseSync;

  function paths() {
    const p = runtimePaths();
    const fallbackHome = p.home || path.dirname(p.memoryDb || path.join(os.tmpdir(), "mia-memory", String(process.pid), "mia-memory.sqlite"));
    const legacyMemory = p.memory || path.join(fallbackHome, "mia-memory.json");
    const dbPath = p.memoryDb || path.join(path.dirname(legacyMemory), "mia-memory.sqlite");
    return { legacyMemory, dbPath };
  }

  const resolved = paths();
  fsImpl.mkdirSync(path.dirname(resolved.dbPath), { recursive: true });
  const db = new Database(resolved.dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate();

  function currentUserId(explicit = "") {
    return cleanId(explicit, cleanId(getCurrentUserId(), "local"));
  }

  function migrate() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        bot_id TEXT NOT NULL DEFAULT '',
        session_id TEXT NOT NULL DEFAULT '',
        scope TEXT NOT NULL,
        text TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1,
        source TEXT NOT NULL DEFAULT '',
        origin_engine TEXT NOT NULL DEFAULT '',
        origin_native_session_id TEXT NOT NULL DEFAULT '',
        source_message_ids_json TEXT NOT NULL DEFAULT '[]',
        linked_memory_ids_json TEXT NOT NULL DEFAULT '[]',
        policy_result_json TEXT NOT NULL DEFAULT '{}',
        hash TEXT NOT NULL,
        text_normalized TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL DEFAULT '',
        expires_at TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        deleted_at TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS memory_events (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        event TEXT NOT NULL,
        actor TEXT NOT NULL,
        before_json TEXT NOT NULL DEFAULT '{}',
        after_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
    `);
    if (!hasColumn(db, "memory_entries", "origin_engine")) {
      db.exec("ALTER TABLE memory_entries ADD COLUMN origin_engine TEXT NOT NULL DEFAULT ''");
    }
    if (!hasColumn(db, "memory_entries", "origin_native_session_id")) {
      db.exec("ALTER TABLE memory_entries ADD COLUMN origin_native_session_id TEXT NOT NULL DEFAULT ''");
    }
    if (!hasColumn(db, "memory_entries", "deleted_at")) {
      db.exec("ALTER TABLE memory_entries ADD COLUMN deleted_at TEXT NOT NULL DEFAULT ''");
    }
    if (!hasColumn(db, "memory_entries", "revision")) {
      db.exec("ALTER TABLE memory_entries ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
    }
    if (hasColumn(db, "memory_entries", "kind") || hasColumn(db, "memory_entries", "status")) {
      db.exec(`
        DROP TRIGGER IF EXISTS memory_entries_ai;
        DROP TRIGGER IF EXISTS memory_entries_ad;
        DROP TRIGGER IF EXISTS memory_entries_au;
        DROP TABLE IF EXISTS memory_entries_fts;
        CREATE TABLE memory_entries_clean (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          bot_id TEXT NOT NULL DEFAULT '',
          session_id TEXT NOT NULL DEFAULT '',
          scope TEXT NOT NULL,
          text TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 1,
          source TEXT NOT NULL DEFAULT '',
          origin_engine TEXT NOT NULL DEFAULT '',
          origin_native_session_id TEXT NOT NULL DEFAULT '',
          source_message_ids_json TEXT NOT NULL DEFAULT '[]',
          linked_memory_ids_json TEXT NOT NULL DEFAULT '[]',
          policy_result_json TEXT NOT NULL DEFAULT '{}',
          hash TEXT NOT NULL,
          text_normalized TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 0,
          pinned INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_used_at TEXT NOT NULL DEFAULT '',
          expires_at TEXT NOT NULL DEFAULT '',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          deleted_at TEXT NOT NULL DEFAULT '',
          revision INTEGER NOT NULL DEFAULT 1
        );
        INSERT INTO memory_entries_clean (
          id, user_id, bot_id, session_id, scope, text, confidence,
          source, origin_engine, origin_native_session_id, source_message_ids_json,
          linked_memory_ids_json, policy_result_json, hash, text_normalized, priority,
          pinned, created_at, updated_at, last_used_at, expires_at, metadata_json,
          deleted_at, revision
        )
        SELECT
          id, user_id, bot_id, session_id, scope, text, confidence,
          source, origin_engine, origin_native_session_id, source_message_ids_json,
          linked_memory_ids_json, policy_result_json, hash, text_normalized, priority,
          pinned, created_at, updated_at, last_used_at, expires_at, metadata_json,
          deleted_at, revision
        FROM memory_entries;
        DROP TABLE memory_entries;
        ALTER TABLE memory_entries_clean RENAME TO memory_entries;
      `);
    }
    if (hasColumn(db, "memory_entries_fts", "kind")) {
      db.exec(`
        DROP TRIGGER IF EXISTS memory_entries_ai;
        DROP TRIGGER IF EXISTS memory_entries_ad;
        DROP TRIGGER IF EXISTS memory_entries_au;
        DROP TABLE IF EXISTS memory_entries_fts;
      `);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_entries(user_id, bot_id, session_id, scope);
      CREATE INDEX IF NOT EXISTS idx_memory_updated ON memory_entries(updated_at);
      CREATE INDEX IF NOT EXISTS idx_memory_hash ON memory_entries(hash);
    `);
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_entries_fts
      USING fts5(text, content='memory_entries', content_rowid='rowid');
      CREATE TRIGGER IF NOT EXISTS memory_entries_ai AFTER INSERT ON memory_entries BEGIN
        INSERT INTO memory_entries_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_entries_ad AFTER DELETE ON memory_entries BEGIN
        INSERT INTO memory_entries_fts(memory_entries_fts, rowid, text)
        VALUES('delete', old.rowid, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_entries_au AFTER UPDATE ON memory_entries BEGIN
        INSERT INTO memory_entries_fts(memory_entries_fts, rowid, text)
        VALUES('delete', old.rowid, old.text);
        INSERT INTO memory_entries_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
    `);
    db.exec("INSERT INTO memory_entries_fts(memory_entries_fts) VALUES('rebuild')");
    const migrated = db.prepare("SELECT 1 FROM schema_migrations WHERE version = 1").get();
    if (!migrated) migrateLegacyJson();
    db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, ?)").run(now());
  }

  function migrateLegacyJson() {
    const legacyPath = paths().legacyMemory;
    let legacy = null;
    try {
      legacy = JSON.parse(fsImpl.readFileSync(legacyPath, "utf8"));
    } catch {
      legacy = null;
    }
    if (!legacy || typeof legacy !== "object") return;
    const userId = currentUserId();
    for (const line of arrayFrom(legacy.shared)) {
      insertEntry({ userId, scope: "user", text: line, source: "migration" });
    }
    const bots = legacy.bots && typeof legacy.bots === "object" ? legacy.bots : {};
    for (const [botId, lines] of Object.entries(bots)) {
      for (const line of arrayFrom(lines)) {
        insertEntry({ userId, botId, scope: "bot", text: line, source: "migration" });
      }
    }
  }

  function event(memoryId, eventName, actor, before = {}, after = {}) {
    db.prepare(`
      INSERT INTO memory_events (id, memory_id, event, actor, before_json, after_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), memoryId || "", eventName, actor || "system", json(before || {}), json(after || {}), now());
  }

  function insertEntry(input = {}) {
    const text = cleanText(input.text);
    if (!text) return null;
    const scope = normalizeScope(input.scope);
    const timestamp = now();
    const entry = {
      id: input.id || randomUUID(),
      userId: currentUserId(input.userId),
      botId: cleanId(input.botId),
      sessionId: cleanId(input.sessionId),
      scope,
      text,
      confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : 1,
      source: cleanId(input.source, "manual"),
      originEngine: cleanId(input.originEngine || input.origin_engine),
      originNativeSessionId: cleanId(input.originNativeSessionId || input.origin_native_session_id),
      sourceMessageIds: arrayFrom(input.sourceMessageIds || input.source_message_ids),
      linkedMemoryIds: arrayFrom(input.linkedMemoryIds || input.linked_memory_ids),
      policyResult: input.policyResult || input.policy_result || {},
      hash: sha256(`${scope}\n${normalizeText(text)}`),
      textNormalized: normalizeText(text),
      priority: normalizePriority(input.priority),
      pinned: input.pinned ? 1 : 0,
      createdAt: input.createdAt || timestamp,
      updatedAt: input.updatedAt || timestamp,
      lastUsedAt: input.lastUsedAt || "",
      expiresAt: input.expiresAt || "",
      metadata: input.metadata || {},
      deletedAt: input.deletedAt || input.deleted_at || "",
      revision: Math.max(1, Math.trunc(Number(input.revision) || 1))
    };
    db.prepare(`
      INSERT INTO memory_entries (
        id, user_id, bot_id, session_id, scope, text, confidence,
        source, origin_engine, origin_native_session_id, source_message_ids_json,
        linked_memory_ids_json, policy_result_json, hash, text_normalized, priority,
        pinned, created_at, updated_at, last_used_at, expires_at, metadata_json,
        deleted_at, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id, entry.userId, entry.botId, entry.sessionId, entry.scope, entry.text,
      entry.confidence, entry.source, entry.originEngine, entry.originNativeSessionId,
      json(entry.sourceMessageIds), json(entry.linkedMemoryIds), json(entry.policyResult),
      entry.hash, entry.textNormalized, entry.priority, entry.pinned, entry.createdAt,
      entry.updatedAt, entry.lastUsedAt, entry.expiresAt, json(entry.metadata),
      entry.deletedAt, entry.revision
    );
    event(entry.id, "remember", entry.source === "agent_tool" ? "agent" : "system", {}, entry);
    return getEntry(entry.id);
  }

  function getEntry(id) {
    return rowToEntry(db.prepare("SELECT * FROM memory_entries WHERE id = ?").get(String(id || "")));
  }

  function visibleRows({ userId, botId, sessionId, scopes = [], limit = 50, query = "" } = {}) {
    const uid = currentUserId(userId);
    const bid = cleanId(botId);
    const sid = cleanId(sessionId);
    const wantedScopes = new Set((Array.isArray(scopes) ? scopes : []).map((scope) => normalizeScope(scope, "")).filter(Boolean));
    const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
    const params = [uid, uid, bid, uid, bid, sid];
    let where = `
      (
        (scope = 'user' AND user_id = ?)
        OR (scope = 'bot' AND user_id = ? AND bot_id = ?)
        OR (scope = 'session' AND user_id = ? AND bot_id = ? AND session_id = ?)
      )
      AND deleted_at = ''
    `;
    if (wantedScopes.size) {
      where += ` AND scope IN (${[...wantedScopes].map(() => "?").join(",")})`;
      params.push(...wantedScopes);
    }

    const match = ftsQuery(query);
    if (match) {
      try {
        const ftsRows = db.prepare(`
          SELECT e.*, bm25(memory_entries_fts) AS rank
          FROM memory_entries e
          JOIN memory_entries_fts ON memory_entries_fts.rowid = e.rowid
          WHERE memory_entries_fts MATCH ? AND ${where}
          ORDER BY rank ASC, e.pinned DESC, e.priority DESC, e.updated_at DESC
          LIMIT ?
        `).all(match, ...params, safeLimit);
        if (ftsRows.length) return ftsRows;
      } catch {
        // Fall through to non-FTS filtering.
      }
    }

    const rows = db.prepare(`
      SELECT * FROM memory_entries
      WHERE ${where}
      ORDER BY pinned DESC, priority DESC, updated_at DESC
      LIMIT ?
    `).all(...params, Math.max(safeLimit, match ? 100 : safeLimit));
    if (!query) return rows.slice(0, safeLimit);
    const needle = normalizeText(query);
    return rows
      .map((row) => ({ row, score: row.text_normalized.includes(needle) ? 2 : overlapScore(needle, row.text_normalized) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, safeLimit)
      .map((item) => item.row);
  }

  function overlapScore(query, text) {
    const terms = new Set(String(query || "").split(/\s+/).filter(Boolean));
    if (!terms.size) return 0;
    let score = 0;
    for (const term of terms) {
      if (String(text || "").includes(term)) score += 1;
    }
    return score;
  }

  function searchMemories(input = {}) {
    const rows = visibleRows(input);
    const at = now();
    const query = String(input.query || "");
    const resultChars = rows.reduce((sum, row) => sum + String(row.text || "").length, 0);
    const retrievalMeta = {
      queryChars: query.length,
      resultCount: rows.length,
      resultChars,
      botId: cleanId(input.botId),
      sessionId: cleanId(input.sessionId)
    };
    for (const row of rows) {
      db.prepare("UPDATE memory_entries SET last_used_at = ? WHERE id = ?").run(at, row.id);
      event(row.id, "retrieve", "agent", {}, retrievalMeta);
    }
    return rows.map(rowToEntry);
  }

  function listMemories(input = {}) {
    return visibleRows(input).map(rowToEntry);
  }

  function managementRows(input = {}) {
    const uid = currentUserId(input.userId);
    const wantedScopes = new Set((Array.isArray(input.scopes) ? input.scopes : (input.scope ? [input.scope] : []))
      .map((scope) => normalizeScope(scope, ""))
      .filter(Boolean));
    const safeLimit = Math.max(1, Math.min(5000, Math.floor(Number(input.limit) || 250)));
    const params = [uid];
    let where = "e.user_id = ?";
    if (input.includeDeleted !== true) {
      where += " AND e.deleted_at = ''";
    }

    if (wantedScopes.size) {
      where += ` AND e.scope IN (${[...wantedScopes].map(() => "?").join(",")})`;
      params.push(...wantedScopes);
    }
    const botId = cleanId(input.botId);
    if (botId) {
      where += " AND e.bot_id = ?";
      params.push(botId);
    }
    const sessionId = cleanId(input.sessionId);
    if (sessionId) {
      where += " AND e.session_id = ?";
      params.push(sessionId);
    }

    const match = ftsQuery(input.query);
    if (match) {
      try {
        const ftsRows = db.prepare(`
          SELECT e.*, bm25(memory_entries_fts) AS rank
          FROM memory_entries e
          JOIN memory_entries_fts ON memory_entries_fts.rowid = e.rowid
          WHERE memory_entries_fts MATCH ? AND ${where}
          ORDER BY rank ASC, e.pinned DESC, e.priority DESC, e.updated_at DESC
          LIMIT ?
        `).all(match, ...params, safeLimit);
        if (ftsRows.length) return ftsRows;
      } catch {
        // Fall through to non-FTS filtering.
      }
    }

    const rows = db.prepare(`
      SELECT e.* FROM memory_entries e
      WHERE ${where}
      ORDER BY e.pinned DESC, e.priority DESC, e.updated_at DESC
      LIMIT ?
    `).all(...params, Math.max(safeLimit, match ? 5000 : safeLimit));
    if (!input.query) return rows.slice(0, safeLimit);
    const needle = normalizeText(input.query);
    return rows
      .map((row) => ({ row, score: row.text_normalized.includes(needle) ? 2 : overlapScore(needle, row.text_normalized) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, safeLimit)
      .map((item) => item.row);
  }

  function listAllMemories(input = {}) {
    return managementRows(input).map(rowToEntry);
  }

  function findOwnedMemory(input = {}) {
    const userId = currentUserId(input.userId);
    const memoryId = cleanId(input.memoryId || input.id);
    if (!memoryId) return { error: "missing_target", message: "memoryId is required." };
    const row = db.prepare("SELECT * FROM memory_entries WHERE id = ? AND user_id = ? AND deleted_at = ''").get(memoryId, userId);
    if (!row) return { error: "not_found", message: "No memory matched the requested id." };
    return { row };
  }

  function deleteMemory(input = {}) {
    const target = findOwnedMemory(input);
    if (target.error) return { status: target.error, error: target.message };
    const row = target.row;
    const before = rowToEntry(row);
    const timestamp = now();
    db.prepare(`
      UPDATE memory_entries
      SET text = '', text_normalized = '', hash = '',
          deleted_at = ?, updated_at = ?, revision = revision + 1
      WHERE id = ? AND user_id = ?
    `).run(timestamp, timestamp, row.id, row.user_id);
    event(row.id, "delete", cleanId(input.actor, "user"), before, { hardDelete: true });
    return { status: "deleted", memoryId: row.id };
  }

  function findDuplicate({ userId, botId, sessionId, scope, textNormalized }) {
    const rows = visibleRows({ userId, botId, sessionId, scopes: [scope], limit: 100 });
    const exact = rows.find((row) => row.text_normalized === textNormalized);
    if (exact) return exact;

    const incomingKey = normalizeMemorySemanticKey(textNormalized);
    if (!incomingKey) return null;
    let best = null;
    let bestScore = 0;
    for (const row of rows) {
      const candidateKey = normalizeMemorySemanticKey(row.text_normalized || row.text);
      if (!candidateKey) continue;
      const score = memorySimilarityScore(candidateKey, incomingKey);
      if (score <= bestScore) continue;
      bestScore = score;
      best = row;
    }
    return best && bestScore >= MEMORY_NEAR_DUPLICATE_MIN_SCORE ? best : null;
  }

  function uniqueArray(...values) {
    return [...new Set(values.flatMap((value) => arrayFrom(value)))];
  }

  function mergeDuplicateMemory({ duplicate, input = {}, text = "", policy = {} }) {
    if (!duplicate) return null;
    const before = rowToEntry(duplicate);
    const nextText = choosePreferredMemoryText(duplicate.text, text);
    const nextNormalized = normalizeText(nextText);
    const nextConfidence = Math.max(
      Number(duplicate.confidence || 0),
      Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : 0
    );
    const nextPriority = Math.max(
      normalizePriority(duplicate.priority, 0),
      normalizePriority(input.priority, normalizePriority(duplicate.priority, 0))
    );
    const nextPinned = duplicate.pinned || input.pinned ? 1 : 0;
    const sourceMessageIds = uniqueArray(safeJson(duplicate.source_message_ids_json, []), input.sourceMessageIds || input.source_message_ids);
    const linkedMemoryIds = uniqueArray(safeJson(duplicate.linked_memory_ids_json, []), input.linkedMemoryIds || input.linked_memory_ids);
    const nextMetadata = {
      ...safeJson(duplicate.metadata_json, {}),
      ...(input.metadata && typeof input.metadata === "object" ? input.metadata : {})
    };
    const nextPolicy = {
      ...safeJson(duplicate.policy_result_json, {}),
      duplicatePolicy: policy,
      duplicateMergedAt: now()
    };
    const changed = nextText !== duplicate.text
      || nextConfidence !== Number(duplicate.confidence || 0)
      || nextPriority !== Number(duplicate.priority || 0)
      || nextPinned !== Number(duplicate.pinned || 0)
      || JSON.stringify(sourceMessageIds) !== duplicate.source_message_ids_json
      || JSON.stringify(linkedMemoryIds) !== duplicate.linked_memory_ids_json;
    if (!changed) return getEntry(duplicate.id);

    const timestamp = now();
    db.prepare(`
      UPDATE memory_entries
      SET text = ?, text_normalized = ?, hash = ?,
          confidence = ?, source = ?, origin_engine = ?, origin_native_session_id = ?,
          source_message_ids_json = ?, linked_memory_ids_json = ?,
          policy_result_json = ?, priority = ?, pinned = ?, metadata_json = ?,
          updated_at = ?, revision = revision + 1
      WHERE id = ?
    `).run(
      nextText,
      nextNormalized,
      sha256(`${duplicate.scope}\n${nextNormalized}`),
      nextConfidence,
      cleanId(input.source, duplicate.source || "agent_tool"),
      cleanId(input.originEngine || input.origin_engine || duplicate.origin_engine),
      cleanId(input.originNativeSessionId || input.origin_native_session_id || duplicate.origin_native_session_id),
      json(sourceMessageIds),
      json(linkedMemoryIds),
      json(nextPolicy),
      nextPriority,
      nextPinned,
      json(nextMetadata),
      timestamp,
      duplicate.id
    );
    const entry = getEntry(duplicate.id);
    event(
      duplicate.id,
      "merge_duplicate",
      cleanId(input.source, "agent_tool"),
      before,
      { memory: entry, policy }
    );
    return entry;
  }

  function isVisibleToContext(row, { userId, botId, sessionId } = {}) {
    if (!row) return false;
    const uid = currentUserId(userId);
    const bid = cleanId(botId);
    const sid = cleanId(sessionId);
    if (row.user_id !== uid) return false;
    if (row.scope === "user") return true;
    if (row.scope === "bot") return row.bot_id === bid;
    if (row.scope === "session") return row.bot_id === bid && row.session_id === sid;
    return false;
  }

  function mutableRows(input = {}) {
    const rows = [
      ...visibleRows({ ...input, limit: 100, query: "" })
    ];
    const seen = new Set();
    return rows.filter((row) => {
      if (!row || seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    });
  }

  function findMutableMemory(input = {}) {
    const userId = currentUserId(input.userId);
    const botId = cleanId(input.botId);
    const sessionId = cleanId(input.sessionId);
    const memoryId = cleanId(input.memoryId || input.id);
    if (memoryId) {
      const row = db.prepare("SELECT * FROM memory_entries WHERE id = ? AND deleted_at = ''").get(memoryId);
      if (!isVisibleToContext(row, { userId, botId, sessionId })) {
        return { error: "not_found", message: "No visible active memory matched the requested id." };
      }
      return { row };
    }

    const oldText = normalizeText(input.oldText || input.old_text || input.query || "");
    if (!oldText) return { error: "missing_target", message: "memoryId or oldText is required." };
    const rows = mutableRows({ userId, botId, sessionId, scopes: input.scope ? [input.scope] : [] });
    const matches = rows.filter((row) => normalizeText(row.text).includes(oldText));
    if (matches.length === 0) return { error: "not_found", message: "No visible active memory matched oldText." };
    if (matches.length > 1) {
      return {
        error: "ambiguous",
        message: "Multiple visible memories matched oldText. Use memoryId or a more specific oldText.",
        matches: matches.slice(0, 10).map(rowToEntry)
      };
    }
    return { row: matches[0] };
  }

  function policyFor(input = {}) {
    const requestedScope = normalizeScope(input.scope, "bot");
    const text = cleanText(input.text);
    if (!text) return { decision: "ignore", effectiveScope: requestedScope, reason: "empty memory text" };
    const sensitive = sensitivity(text);
    if (sensitive.severity === "credential") {
      return { decision: "ignore", effectiveScope: requestedScope, reason: sensitive.reason, sensitivity: sensitive };
    }
    return { decision: "store", effectiveScope: requestedScope, reason: "safe scoped memory", sensitivity: sensitive };
  }

  function rememberMemory(input = {}) {
    const userId = currentUserId(input.userId);
    const botId = cleanId(input.botId);
    const sessionId = cleanId(input.sessionId);
    const text = cleanText(input.text);
    const policy = policyFor(input);
    if (policy.decision !== "store") {
      event("", "ignore", "system", {}, policy);
      return { status: "ignored", effectiveScope: policy.effectiveScope, policyReason: policy.reason, memoryId: "" };
    }
    const textNormalized = normalizeText(text);
    const duplicate = findDuplicate({ userId, botId, sessionId, scope: policy.effectiveScope, textNormalized });
    if (duplicate) {
      const entry = mergeDuplicateMemory({ duplicate, input, text, policy });
      return {
        status: "ok",
        effectiveScope: entry.scope,
        policyReason: "duplicate memory",
        memoryId: entry.id,
        memory: entry
      };
    }
    const entry = insertEntry({
      userId,
      botId,
      sessionId,
      text,
      scope: policy.effectiveScope,
      confidence: input.confidence,
      source: input.source || "agent_tool",
      originEngine: input.originEngine,
      originNativeSessionId: input.originNativeSessionId,
      sourceMessageIds: input.sourceMessageIds,
      linkedMemoryIds: input.linkedMemoryIds,
      policyResult: policy,
      priority: input.priority,
      pinned: input.pinned,
      metadata: input.metadata
    });
    event(entry.id, "remember", "agent", {}, { policy });
    return {
      status: "ok",
      effectiveScope: entry.scope,
      policyReason: policy.reason,
      memoryId: entry.id,
      memory: entry
    };
  }

  function updateMemory(input = {}) {
    const target = findMutableMemory(input);
    if (target.error) return { status: target.error, error: target.message, matches: target.matches || [] };
    const row = target.row;
    const text = cleanText(input.text || input.content || input.newText || input.new_content);
    if (!text) return { status: "ignored", error: "text is required" };
    const policy = policyFor({ ...input, text, scope: row.scope });
    if (policy.decision !== "store") {
      event(row.id, "ignore", "system", rowToEntry(row), { policy });
      return { status: "ignored", effectiveScope: row.scope, policyReason: policy.reason, memoryId: "" };
    }
    const duplicate = findDuplicate({
      userId: row.user_id,
      botId: row.bot_id,
      sessionId: row.session_id,
      scope: row.scope,
      textNormalized: normalizeText(text)
    });
    if (duplicate && duplicate.id !== row.id) {
      const entry = mergeDuplicateMemory({ duplicate, input, text, policy });
      return {
        status: "ok",
        effectiveScope: entry.scope,
        policyReason: "duplicate memory",
        memoryId: entry.id,
        memory: entry
      };
    }
    const before = rowToEntry(row);
    const timestamp = now();
    db.prepare(`
      UPDATE memory_entries
      SET text = ?, text_normalized = ?, hash = ?,
          confidence = ?, source = ?, origin_engine = ?, origin_native_session_id = ?,
          source_message_ids_json = ?, linked_memory_ids_json = ?,
          policy_result_json = ?, priority = ?, pinned = ?, metadata_json = ?,
          updated_at = ?, revision = revision + 1
      WHERE id = ?
    `).run(
      text,
      normalizeText(text),
      sha256(`${row.scope}\n${normalizeText(text)}`),
      Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : Number(row.confidence || 1),
      cleanId(input.source, "agent_tool"),
      cleanId(input.originEngine || input.origin_engine || row.origin_engine),
      cleanId(input.originNativeSessionId || input.origin_native_session_id || row.origin_native_session_id),
      json(arrayFrom(input.sourceMessageIds || input.source_message_ids)),
      json(arrayFrom(input.linkedMemoryIds || input.linked_memory_ids)),
      json(policy),
      normalizePriority(input.priority, Number(row.priority || 0)),
      input.pinned == null ? Number(row.pinned || 0) : (input.pinned ? 1 : 0),
      json(input.metadata && typeof input.metadata === "object" ? input.metadata : safeJson(row.metadata_json, {})),
      timestamp,
      row.id
    );
    const entry = getEntry(row.id);
    event(row.id, "replace", "agent", before, { memory: entry, policy });
    return {
      status: "ok",
      effectiveScope: entry.scope,
      policyReason: policy.reason,
      memoryId: entry.id,
      memory: entry
    };
  }

  function forgetMemory(input = {}) {
    const target = findMutableMemory(input);
    if (target.error) return { status: target.error, error: target.message, matches: target.matches || [] };
    const row = target.row;
    const before = rowToEntry(row);
    const timestamp = now();
    db.prepare("UPDATE memory_entries SET text = '', text_normalized = '', hash = '', deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?")
      .run(timestamp, timestamp, row.id);
    const entry = getEntry(row.id);
    event(row.id, "delete", "agent", before, { reason: cleanId(input.reason), memory: entry });
    return {
      status: "deleted",
      effectiveScope: before.scope,
      memoryId: row.id,
      memory: entry
    };
  }

  function replaceScopeLines({ userId, botId = "", scope, lines = [] }) {
    const uid = currentUserId(userId);
    const bid = cleanId(botId);
    const timestamp = now();
    if (scope === "user") {
      db.prepare("UPDATE memory_entries SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE user_id = ? AND scope = 'user' AND deleted_at = ''")
        .run(timestamp, timestamp, uid);
    } else {
      db.prepare("UPDATE memory_entries SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE user_id = ? AND bot_id = ? AND scope = 'bot' AND deleted_at = ''")
        .run(timestamp, timestamp, uid, bid);
    }
    for (const line of arrayFrom(lines)) {
      insertEntry({ userId: uid, botId: bid, scope, text: line, source: "manual" });
    }
  }

  function normalizeSyncEntry(input = {}, userId = "") {
    const uid = currentUserId(userId || input.userId || input.user_id);
    const deletedAt = cleanId(input.deletedAt || input.deleted_at);
    const text = deletedAt ? "" : cleanText(input.text);
    if (!deletedAt && !text) return null;
    const scope = normalizeScope(input.scope, "bot");
    const updatedAt = cleanId(input.updatedAt || input.updated_at, now());
    const createdAt = cleanId(input.createdAt || input.created_at, updatedAt);
    const normalized = normalizeText(text);
    return {
      id: cleanId(input.id || input.memoryId || input.memory_id, randomUUID()),
      userId: uid,
      botId: cleanId(input.botId || input.bot_id),
      sessionId: cleanId(input.sessionId || input.session_id),
      scope,
      text,
      confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : 1,
      source: cleanId(input.source, "cloud_sync"),
      originEngine: cleanId(input.originEngine || input.origin_engine),
      originNativeSessionId: cleanId(input.originNativeSessionId || input.origin_native_session_id),
      sourceMessageIds: arrayFrom(input.sourceMessageIds || input.source_message_ids),
      linkedMemoryIds: arrayFrom(input.linkedMemoryIds || input.linked_memory_ids),
      policyResult: input.policyResult || input.policy_result || {},
      hash: deletedAt ? "" : sha256(`${scope}\n${normalized}`),
      textNormalized: normalized,
      priority: normalizePriority(input.priority),
      pinned: input.pinned ? 1 : 0,
      createdAt,
      updatedAt,
      lastUsedAt: cleanId(input.lastUsedAt || input.last_used_at),
      expiresAt: cleanId(input.expiresAt || input.expires_at),
      metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
      deletedAt,
      revision: Math.max(1, Math.trunc(Number(input.revision) || 1))
    };
  }

  function insertSyncedEntry(entry) {
    db.prepare(`
      INSERT INTO memory_entries (
        id, user_id, bot_id, session_id, scope, text, confidence,
        source, origin_engine, origin_native_session_id, source_message_ids_json,
        linked_memory_ids_json, policy_result_json, hash, text_normalized, priority,
        pinned, created_at, updated_at, last_used_at, expires_at, metadata_json,
        deleted_at, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      entry.userId,
      entry.botId,
      entry.sessionId,
      entry.scope,
      entry.text,
      entry.confidence,
      entry.source,
      entry.originEngine,
      entry.originNativeSessionId,
      json(entry.sourceMessageIds),
      json(entry.linkedMemoryIds),
      json(entry.policyResult),
      entry.hash,
      entry.textNormalized,
      entry.priority,
      entry.pinned,
      entry.createdAt,
      entry.updatedAt,
      entry.lastUsedAt,
      entry.expiresAt,
      json(entry.metadata),
      entry.deletedAt,
      entry.revision
    );
    event(entry.id, entry.deletedAt ? "sync_delete" : "sync_insert", "cloud", {}, entry);
    return getEntry(entry.id);
  }

  function applySyncedMemory(input = {}, options = {}) {
    const entry = normalizeSyncEntry(input, options.userId);
    if (!entry) return { ok: false, skipped: true, error: "empty memory text" };
    const existing = db.prepare("SELECT * FROM memory_entries WHERE id = ? AND user_id = ?")
      .get(entry.id, entry.userId);
    if (existing && !options.force) {
      const localNewer = existing.updated_at && entry.updatedAt && existing.updated_at > entry.updatedAt;
      const localRevision = Number(existing.revision || 1);
      if (localNewer || (existing.updated_at === entry.updatedAt && localRevision > entry.revision)) {
        return { ok: false, conflict: true, memory: rowToEntry(existing) };
      }
    }
    if (!existing) {
      return { ok: true, memory: insertSyncedEntry(entry) };
    }
    const before = rowToEntry(existing);
    const revision = Math.max(Number(existing.revision || 1), entry.revision);
    db.prepare(`
      UPDATE memory_entries SET
        bot_id = ?, session_id = ?, scope = ?, text = ?,
        confidence = ?, source = ?, origin_engine = ?, origin_native_session_id = ?,
        source_message_ids_json = ?, linked_memory_ids_json = ?, policy_result_json = ?,
        hash = ?, text_normalized = ?, priority = ?, pinned = ?, created_at = ?,
        updated_at = ?, last_used_at = ?, expires_at = ?, metadata_json = ?,
        deleted_at = ?, revision = ?
      WHERE id = ? AND user_id = ?
    `).run(
      entry.botId,
      entry.sessionId,
      entry.scope,
      entry.text,
      entry.confidence,
      entry.source,
      entry.originEngine,
      entry.originNativeSessionId,
      json(entry.sourceMessageIds),
      json(entry.linkedMemoryIds),
      json(entry.policyResult),
      entry.hash,
      entry.textNormalized,
      entry.priority,
      entry.pinned,
      entry.createdAt,
      entry.updatedAt,
      entry.lastUsedAt,
      entry.expiresAt,
      json(entry.metadata),
      entry.deletedAt,
      revision,
      entry.id,
      entry.userId
    );
    const memory = getEntry(entry.id);
    event(entry.id, entry.deletedAt ? "sync_delete" : "sync_update", "cloud", before, { memory });
    return { ok: true, memory };
  }

  function applySyncedMemories(entries = [], options = {}) {
    const applied = [];
    const conflicts = [];
    const errors = [];
    for (const input of Array.isArray(entries) ? entries : []) {
      try {
        const result = applySyncedMemory(input, options);
        if (result.conflict) conflicts.push(result.memory);
        else if (result.memory) applied.push(result.memory);
        else if (result.error) errors.push({ id: input?.id || "", error: result.error });
      } catch (error) {
        errors.push({ id: input?.id || "", error: error.message || String(error) });
      }
    }
    return { applied, conflicts, errors };
  }

  function listSyncMemories(input = {}) {
    const uid = currentUserId(input.userId);
    const params = [uid];
    let where = "user_id = ?";
    const since = cleanId(input.since || input.updatedAfter);
    if (since) {
      where += " AND updated_at > ?";
      params.push(since);
    }
    const includeDeleted = input.includeDeleted === undefined || input.includeDeleted === null
      ? Boolean(since)
      : input.includeDeleted === true;
    if (!includeDeleted) where += " AND deleted_at = ''";
    const limit = Math.max(1, Math.min(5000, Math.trunc(Number(input.limit) || 1000)));
    return db.prepare(`
      SELECT * FROM memory_entries
      WHERE ${where}
      ORDER BY updated_at ASC, id ASC
      LIMIT ?
    `).all(...params, limit).map(rowToEntry);
  }

  function v1Store(userId = "") {
    const uid = currentUserId(userId);
    const shared = db.prepare(`
      SELECT text FROM memory_entries
      WHERE user_id = ? AND scope = 'user' AND deleted_at = ''
      ORDER BY pinned DESC, priority DESC, updated_at ASC
    `).all(uid).map((row) => row.text);
    const bots = {};
    const rows = db.prepare(`
      SELECT bot_id, text FROM memory_entries
      WHERE user_id = ? AND scope = 'bot' AND deleted_at = ''
      ORDER BY bot_id ASC, pinned DESC, priority DESC, updated_at ASC
    `).all(uid);
    for (const row of rows) {
      const key = row.bot_id || "mia";
      bots[key] = bots[key] || [];
      bots[key].push(row.text);
    }
    return { shared, bots, updatedAt: now() };
  }

  return {
    close: () => {
      if (db && typeof db.close === "function") db.close();
    },
    db,
    currentUserId,
    applySyncedMemories,
    applySyncedMemory,
    deleteMemory,
    getEntry,
    forgetMemory,
    insertEntry,
    listAllMemories,
    listMemories,
    listSyncMemories,
    paths,
    readStore: v1Store,
    rememberMemory,
    replaceScopeLines,
    searchMemories,
    updateMemory
  };
}

module.exports = {
  cleanText,
  createMiaMemoryStore,
  normalizeScope,
  rowToEntry,
  sensitivity
};
