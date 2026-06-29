// Per-user cross-device settings (Phase 3). Holds:
//   pins:        ["conversation_id_a", "bot_ref_b", ...]   — pinned conversation refs
//   readMarks:   { "conversation_id_a": last_seen_seq, ... } — last seq the user has read
//   mutedConversations: ["conversation_id_a", ...]     — conversations excluded from global unread
//   unreadOverrides: { "conversation_id_a": true }      — manual unread flags
//   appearance:  {}                                   — legacy compatibility only;
//                                                       UI preferences are device-local
//   tags:        { items, assignments }                — user-private conversation tags
//   starterEngineBots: { seededAt, engineIds }         — one-time starter bot seed marker
//
// One row per user, JSON-bagged so we don't migrate the schema for every
// new setting category. Server is canonical. Clients hold a cached copy
// and write back via PUT /api/me/settings; a user_settings.updated event
// broadcasts the new shape to every connected device.
const { defaultConversationTags, normalizeConversationTags } = require("../shared/conversation-tags.js");

function nowIso() {
  return new Date().toISOString();
}

function parseJsonOr(value, fallback) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed == null ? fallback : parsed;
  } catch { return fallback; }
}

function defaultSettings() {
  return {
    pins: [],
    readMarks: {},
    mutedConversations: [],
    unreadOverrides: {},
    appearance: {},
    tags: defaultConversationTags(),
    starterEngineBots: {}
  };
}

function normalizeStringList(value, cap = 1000) {
  return Array.isArray(value) ? [...new Set(value.map(String).filter(Boolean))].slice(0, cap) : [];
}

function normalizeUnreadOverrides(value, cap = 1000) {
  if (!value || typeof value !== "object") return {};
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!key || raw !== true) continue;
    out[String(key)] = true;
    if (Object.keys(out).length >= cap) break;
  }
  return out;
}

function normalizeStarterEngineBots(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const seededAt = String(value.seededAt || "").trim();
  const engineIds = normalizeStringList(value.engineIds, 16);
  if (!seededAt && !engineIds.length) return {};
  return {
    ...(seededAt ? { seededAt } : {}),
    engineIds
  };
}

function createUserSettingsStore(db) {
  const selectStmt = db.prepare(
    "SELECT pins_json, read_marks_json, muted_conversations_json, unread_overrides_json, appearance_json, tags_json, starter_engine_bots_json, version, updated_at FROM user_settings WHERE user_id = ?"
  );
  // CAS-aware upsert. Caller supplies expectedVersion; we only write
  // when the stored version matches. INSERT path is unconditional
  // (no row yet, no race possible). The RETURNING clause hands back
  // the new version so the caller's cache stays current.
  const insertStmt = db.prepare(
    "INSERT INTO user_settings (user_id, pins_json, read_marks_json, muted_conversations_json, unread_overrides_json, appearance_json, tags_json, starter_engine_bots_json, version, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?) " +
    "RETURNING pins_json, read_marks_json, muted_conversations_json, unread_overrides_json, appearance_json, tags_json, starter_engine_bots_json, version, updated_at"
  );
  const updateStmt = db.prepare(
    "UPDATE user_settings SET pins_json = ?, read_marks_json = ?, muted_conversations_json = ?, unread_overrides_json = ?, appearance_json = ?, tags_json = ?, starter_engine_bots_json = ?, " +
    "  version = version + 1, updated_at = ? " +
    "WHERE user_id = ? AND version = ? " +
    "RETURNING pins_json, read_marks_json, muted_conversations_json, unread_overrides_json, appearance_json, tags_json, starter_engine_bots_json, version, updated_at"
  );

  function rowToSettings(row) {
    if (!row) return { ...defaultSettings(), version: 0, updatedAt: "" };
    return {
      pins: normalizeStringList(parseJsonOr(row.pins_json, [])),
      readMarks: parseJsonOr(row.read_marks_json, {}),
      mutedConversations: normalizeStringList(parseJsonOr(row.muted_conversations_json, [])),
      unreadOverrides: normalizeUnreadOverrides(parseJsonOr(row.unread_overrides_json, {})),
      appearance: {},
      tags: normalizeConversationTags(parseJsonOr(row.tags_json, defaultConversationTags())),
      starterEngineBots: normalizeStarterEngineBots(parseJsonOr(row.starter_engine_bots_json, {})),
      version: Number(row.version) || 0,
      updatedAt: row.updated_at
    };
  }

  function _selectRow(userId) {
    return selectStmt.get(String(userId));
  }

  function getSettings(userId) {
    const row = _selectRow(userId);
    return rowToSettings(row);
  }

  // Whole-bag replace with compare-and-swap. expectedVersion:
  //   - 0  → caller expects no existing row (initial write).
  //   - N>0 → caller read with version N and now writes N+1.
  // Returns { ok, settings, conflict } — on conflict the caller should
  // re-read, merge their delta with the server's latest, and retry.
  function putSettings(userId, { pins, readMarks, mutedConversations, unreadOverrides, appearance, tags, starterEngineBots, expectedVersion = null }) {
    const existing = _selectRow(userId);
    const existingSettings = rowToSettings(existing);
    const safe = {
      pins: normalizeStringList(pins),
      readMarks: readMarks && typeof readMarks === "object" ? readMarks : {},
      mutedConversations: mutedConversations === undefined
        ? existingSettings.mutedConversations
        : normalizeStringList(mutedConversations),
      unreadOverrides: unreadOverrides === undefined
        ? existingSettings.unreadOverrides
        : normalizeUnreadOverrides(unreadOverrides),
      appearance: {},
      tags: tags === undefined ? existingSettings.tags : normalizeConversationTags(tags),
      starterEngineBots: starterEngineBots === undefined
        ? existingSettings.starterEngineBots
        : normalizeStarterEngineBots(starterEngineBots)
    };
    const expected = expectedVersion == null
      ? (existing ? existing.version : 0)
      : Number(expectedVersion) || 0;

    let row;
    if (!existing) {
      // No row yet — only allowed if caller passed expectedVersion 0 (or omitted it).
      if (expected !== 0) {
        return { ok: false, conflict: true, settings: { ...defaultSettings(), version: 0, updatedAt: "" } };
      }
      row = insertStmt.get(
        String(userId),
        JSON.stringify(safe.pins),
        JSON.stringify(safe.readMarks),
        JSON.stringify(safe.mutedConversations),
        JSON.stringify(safe.unreadOverrides),
        JSON.stringify(safe.appearance),
        JSON.stringify(safe.tags),
        JSON.stringify(safe.starterEngineBots),
        nowIso()
      );
    } else {
      row = updateStmt.get(
        JSON.stringify(safe.pins),
        JSON.stringify(safe.readMarks),
        JSON.stringify(safe.mutedConversations),
        JSON.stringify(safe.unreadOverrides),
        JSON.stringify(safe.appearance),
        JSON.stringify(safe.tags),
        JSON.stringify(safe.starterEngineBots),
        nowIso(),
        String(userId),
        expected
      );
      if (!row) {
        // Version mismatch — return current row so caller can retry.
        return {
          ok: false,
          conflict: true,
          settings: rowToSettings(existing)
        };
      }
    }
    return {
      ok: true,
      settings: rowToSettings(row)
    };
  }

  return { getSettings, putSettings, defaultSettings };
}

module.exports = { createUserSettingsStore };
