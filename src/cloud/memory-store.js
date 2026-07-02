"use strict";

const crypto = require("node:crypto");

const VALID_SCOPES = new Set(["user", "bot", "session"]);

function nowIso() {
  return new Date().toISOString();
}

function randomId() {
  return `mem_${crypto.randomBytes(12).toString("base64url")}`;
}

function cleanText(value = "") {
  return String(value || "")
    .replace(/## Mia Bot Memory/g, "Mia Bot Memory")
    .replace(/\r/g, "")
    .trim()
    .slice(0, 12000);
}

function cleanId(value = "", fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function normalizeText(value = "") {
  return cleanText(value).replace(/\s+/g, " ").toLowerCase();
}

function normalizeScope(value = "", fallback = "bot") {
  const scope = String(value || "").trim().toLowerCase();
  return VALID_SCOPES.has(scope) ? scope : fallback;
}

function normalizeIso(value = "", fallback = nowIso()) {
  const text = String(value || "").trim();
  if (!text) return fallback;
  const time = new Date(text).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

function sha256(value = "") {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function json(value) {
  return JSON.stringify(value == null ? null : value);
}

function arrayFrom(value, cap = 200) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, cap)
    : [];
}

function objectFrom(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function truthyFlag(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function rowToMemory(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    botId: row.bot_id || "",
    sessionId: row.session_id || "",
    scope: row.scope,
    text: row.text || "",
    confidence: Number(row.confidence || 0),
    source: row.source || "",
    originEngine: row.origin_engine || "",
    originNativeSessionId: row.origin_native_session_id || "",
    sourceMessageIds: parseJson(row.source_message_ids_json, []),
    linkedMemoryIds: parseJson(row.linked_memory_ids_json, []),
    policyResult: parseJson(row.policy_result_json, {}),
    priority: Number(row.priority || 0),
    pinned: Boolean(row.pinned),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at || "",
    expiresAt: row.expires_at || "",
    metadata: parseJson(row.metadata_json, {}),
    deletedAt: row.deleted_at || "",
    revision: Number(row.revision || 1)
  };
}

function createCloudMemoryStore(db, deps = {}) {
  const now = deps.now || nowIso;
  const makeId = deps.idFactory || randomId;
  const makeEventId = deps.eventIdFactory || (() => crypto.randomUUID());

  const columns = `
    id, user_id, bot_id, session_id, scope, text, confidence,
    source, origin_engine, origin_native_session_id, source_message_ids_json,
    linked_memory_ids_json, policy_result_json, hash, text_normalized, priority,
    pinned, created_at, updated_at, last_used_at, expires_at, metadata_json,
    deleted_at, revision
  `;
  const selectById = db.prepare(`SELECT ${columns} FROM memory_entries WHERE user_id = ? AND id = ?`);
  const insertStmt = db.prepare(`
    INSERT INTO memory_entries (${columns})
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateStmt = db.prepare(`
    UPDATE memory_entries SET
      bot_id = ?, session_id = ?, scope = ?, text = ?,
      confidence = ?, source = ?, origin_engine = ?, origin_native_session_id = ?,
      source_message_ids_json = ?, linked_memory_ids_json = ?, policy_result_json = ?,
      hash = ?, text_normalized = ?, priority = ?, pinned = ?, updated_at = ?,
      last_used_at = ?, expires_at = ?, metadata_json = ?, deleted_at = ?, revision = ?
    WHERE user_id = ? AND id = ?
  `);
  const eventStmt = db.prepare(`
    INSERT INTO memory_events (id, user_id, memory_id, event, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  function getMemory(userId, memoryId) {
    return rowToMemory(selectById.get(String(userId || ""), String(memoryId || "")));
  }

  function logEvent(userId, memoryId, event, payload = {}) {
    eventStmt.run(
      makeEventId(),
      String(userId || ""),
      String(memoryId || ""),
      String(event || "memory.updated"),
      json(payload || {}),
      now()
    );
  }

  function normalizeIncoming(userId, input = {}, existing = null) {
    const timestamp = now();
    const id = cleanId(input.id || input.memoryId, makeId());
    const deletedAt = normalizeIso(input.deletedAt || input.deleted_at || "", "");
    const deleted = Boolean(deletedAt);
    const text = deleted ? "" : cleanText(input.text);
    if (!deleted && !text) {
      const error = new Error("memory text is required");
      error.status = 400;
      throw error;
    }
    const scope = normalizeScope(input.scope, existing?.scope || "bot");
    const botId = cleanId(input.botId || input.bot_id, existing?.bot_id || "");
    const sessionId = cleanId(input.sessionId || input.session_id, existing?.session_id || "");
    if (scope === "session" && !sessionId) {
      const error = new Error("sessionId is required for session memory");
      error.status = 400;
      throw error;
    }
    if ((scope === "bot" || scope === "session") && !botId) {
      const error = new Error("botId is required for bot/session memory");
      error.status = 400;
      throw error;
    }
    const updatedAt = normalizeIso(input.updatedAt || input.updated_at || "", timestamp);
    const createdAt = normalizeIso(input.createdAt || input.created_at || "", existing?.created_at || updatedAt);
    const normalizedText = normalizeText(text);
    return {
      id,
      userId: String(userId || ""),
      botId,
      sessionId,
      scope,
      text,
      confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : Number(existing?.confidence ?? 1),
      source: cleanId(input.source, existing?.source || "sync"),
      originEngine: cleanId(input.originEngine || input.origin_engine, existing?.origin_engine || ""),
      originNativeSessionId: cleanId(input.originNativeSessionId || input.origin_native_session_id, existing?.origin_native_session_id || ""),
      sourceMessageIds: arrayFrom(input.sourceMessageIds || input.source_message_ids),
      linkedMemoryIds: arrayFrom(input.linkedMemoryIds || input.linked_memory_ids),
      policyResult: objectFrom(input.policyResult || input.policy_result),
      hash: sha256(`${scope}\n${normalizedText}`),
      textNormalized: normalizedText,
      priority: Number.isFinite(Number(input.priority)) ? Math.trunc(Number(input.priority)) : Number(existing?.priority || 0),
      pinned: truthyFlag(input.pinned) ? 1 : 0,
      createdAt,
      updatedAt,
      lastUsedAt: normalizeIso(input.lastUsedAt || input.last_used_at || "", existing?.last_used_at || ""),
      expiresAt: normalizeIso(input.expiresAt || input.expires_at || "", existing?.expires_at || ""),
      metadata: objectFrom(input.metadata),
      deletedAt,
      revision: Math.max(1, Math.trunc(Number(input.revision) || 0))
    };
  }

  function upsertMemory(userId, input = {}, options = {}) {
    const ownerId = String(userId || "");
    if (!ownerId) {
      const error = new Error("userId is required");
      error.status = 400;
      throw error;
    }
    const requestedId = cleanId(input.id || input.memoryId);
    const existing = requestedId ? selectById.get(ownerId, requestedId) : null;
    const entry = normalizeIncoming(ownerId, input, existing);
    if (existing && !options.force) {
      const incomingRevision = Number(input.revision || 0);
      const existingRevision = Number(existing.revision || 1);
      const staleByTime = existing.updated_at && entry.updatedAt && existing.updated_at > entry.updatedAt;
      const staleByRevision = incomingRevision > 0 && incomingRevision < existingRevision;
      if (staleByTime || staleByRevision) {
        return { ok: false, conflict: true, memory: rowToMemory(existing) };
      }
    }
    const revision = existing
      ? Math.max(Number(existing.revision || 1) + 1, entry.revision)
      : entry.revision;
    if (!existing) {
      insertStmt.run(
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
        revision
      );
      const memory = getMemory(ownerId, entry.id);
      logEvent(ownerId, entry.id, entry.deletedAt ? "memory.deleted" : "memory.created", { memory });
      return { ok: true, conflict: false, memory };
    }
    updateStmt.run(
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
      entry.updatedAt,
      entry.lastUsedAt,
      entry.expiresAt,
      json(entry.metadata),
      entry.deletedAt,
      revision,
      ownerId,
      entry.id
    );
    const memory = getMemory(ownerId, entry.id);
    logEvent(ownerId, entry.id, entry.deletedAt ? "memory.deleted" : "memory.updated", { memory });
    return { ok: true, conflict: false, memory };
  }

  function pushMemories(userId, entries = [], options = {}) {
    const rows = Array.isArray(entries) ? entries.slice(0, 1000) : [];
    const memories = [];
    const conflicts = [];
    const errors = [];
    for (const entry of rows) {
      try {
        const result = upsertMemory(userId, entry, options);
        if (result.conflict) conflicts.push(result.memory);
        else if (result.memory) memories.push(result.memory);
      } catch (error) {
        errors.push({ id: entry?.id || entry?.memoryId || "", error: error.message || String(error) });
      }
    }
    return { memories, conflicts, errors, serverTime: now() };
  }

  function listMemories(userId, input = {}) {
    const ownerId = String(userId || "");
    const params = [ownerId];
    let where = "user_id = ?";
    const since = normalizeIso(input.since || input.updatedAfter || "", "");
    if (since) {
      where += " AND updated_at > ?";
      params.push(since);
    }
    const includeDeleted = input.includeDeleted == null || input.includeDeleted === ""
      ? Boolean(since)
      : truthyFlag(input.includeDeleted);
    if (!includeDeleted) where += " AND deleted_at = ''";
    const scope = normalizeScope(input.scope, "");
    if (scope) {
      where += " AND scope = ?";
      params.push(scope);
    }
    const botId = cleanId(input.botId || input.bot_id);
    if (botId) {
      where += " AND bot_id = ?";
      params.push(botId);
    }
    const sessionId = cleanId(input.sessionId || input.session_id);
    if (sessionId) {
      where += " AND session_id = ?";
      params.push(sessionId);
    }
    const query = normalizeText(input.query || input.q || "");
    if (query) {
      where += " AND text_normalized LIKE ?";
      params.push(`%${query.replace(/[%_]/g, "\\$&")}%`);
    }
    const limit = Math.max(1, Math.min(5000, Math.trunc(Number(input.limit) || 500)));
    return db.prepare(`
      SELECT ${columns} FROM memory_entries
      WHERE ${where}
      ORDER BY updated_at ASC, id ASC
      LIMIT ?
    `).all(...params, limit).map(rowToMemory);
  }

  function deleteMemory(userId, memoryId) {
    const ownerId = String(userId || "");
    const existing = selectById.get(ownerId, String(memoryId || ""));
    if (!existing) return { ok: false, missing: true };
    const deletedAt = now();
    const result = upsertMemory(ownerId, {
      ...rowToMemory(existing),
      deletedAt,
      updatedAt: deletedAt,
      text: "",
      revision: Number(existing.revision || 1) + 1
    }, { force: true });
    return { ok: true, memory: result.memory };
  }

  return {
    deleteMemory,
    getMemory,
    listMemories,
    pushMemories,
    upsertMemory
  };
}

module.exports = {
  createCloudMemoryStore
};
