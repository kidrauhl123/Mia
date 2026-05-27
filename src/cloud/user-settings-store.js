// Per-user cross-device settings (Phase 3). Holds:
//   pins:        ["conversation_id_a", "fellow_key_b", ...]   — pinned conversation refs
//   readMarks:   { "conversation_id_a": last_seen_seq, ... } — last seq the user has read
//   appearance:  { theme, listStyle, ... }            — UI preferences
//
// One row per user, JSON-bagged so we don't migrate the schema for every
// new setting category. Server is canonical. Clients hold a cached copy
// and write back via PUT /api/me/settings; a user_settings.updated event
// broadcasts the new shape to every connected device.

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
  return { pins: [], readMarks: {}, appearance: {} };
}

function createUserSettingsStore(db) {
  const selectStmt = db.prepare(
    "SELECT pins_json, read_marks_json, appearance_json, version, updated_at FROM user_settings WHERE user_id = ?"
  );
  // CAS-aware upsert. Caller supplies expectedVersion; we only write
  // when the stored version matches. INSERT path is unconditional
  // (no row yet, no race possible). The RETURNING clause hands back
  // the new version so the caller's cache stays current.
  const insertStmt = db.prepare(
    "INSERT INTO user_settings (user_id, pins_json, read_marks_json, appearance_json, version, updated_at) " +
    "VALUES (?, ?, ?, ?, 1, ?) " +
    "RETURNING pins_json, read_marks_json, appearance_json, version, updated_at"
  );
  const updateStmt = db.prepare(
    "UPDATE user_settings SET pins_json = ?, read_marks_json = ?, appearance_json = ?, " +
    "  version = version + 1, updated_at = ? " +
    "WHERE user_id = ? AND version = ? " +
    "RETURNING pins_json, read_marks_json, appearance_json, version, updated_at"
  );

  function _selectRow(userId) {
    return selectStmt.get(String(userId));
  }

  function getSettings(userId) {
    const row = _selectRow(userId);
    if (!row) return { ...defaultSettings(), version: 0, updatedAt: "" };
    return {
      pins: parseJsonOr(row.pins_json, []),
      readMarks: parseJsonOr(row.read_marks_json, {}),
      appearance: parseJsonOr(row.appearance_json, {}),
      version: Number(row.version) || 0,
      updatedAt: row.updated_at
    };
  }

  // Whole-bag replace with compare-and-swap. expectedVersion:
  //   - 0  → caller expects no existing row (initial write).
  //   - N>0 → caller read with version N and now writes N+1.
  // Returns { ok, settings, conflict } — on conflict the caller should
  // re-read, merge their delta with the server's latest, and retry.
  function putSettings(userId, { pins, readMarks, appearance, expectedVersion = null }) {
    const safe = {
      pins: Array.isArray(pins) ? pins.map(String).slice(0, 1000) : [],
      readMarks: readMarks && typeof readMarks === "object" ? readMarks : {},
      appearance: appearance && typeof appearance === "object" ? appearance : {}
    };
    const existing = _selectRow(userId);
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
        JSON.stringify(safe.appearance),
        nowIso()
      );
    } else {
      row = updateStmt.get(
        JSON.stringify(safe.pins),
        JSON.stringify(safe.readMarks),
        JSON.stringify(safe.appearance),
        nowIso(),
        String(userId),
        expected
      );
      if (!row) {
        // Version mismatch — return current row so caller can retry.
        return {
          ok: false,
          conflict: true,
          settings: {
            pins: parseJsonOr(existing.pins_json, []),
            readMarks: parseJsonOr(existing.read_marks_json, {}),
            appearance: parseJsonOr(existing.appearance_json, {}),
            version: Number(existing.version) || 0,
            updatedAt: existing.updated_at
          }
        };
      }
    }
    return {
      ok: true,
      settings: {
        pins: parseJsonOr(row.pins_json, []),
        readMarks: parseJsonOr(row.read_marks_json, {}),
        appearance: parseJsonOr(row.appearance_json, {}),
        version: Number(row.version) || 0,
        updatedAt: row.updated_at
      }
    };
  }

  return { getSettings, putSettings, defaultSettings };
}

module.exports = { createUserSettingsStore };
