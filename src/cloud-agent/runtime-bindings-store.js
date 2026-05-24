function nowIso() {
  return new Date().toISOString();
}

function parseJsonOr(value, fallback) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function rowToBinding(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    fellowId: row.fellow_id,
    runtimeKind: row.runtime_kind,
    enabled: Number(row.enabled) === 1,
    config: parseJsonOr(row.config_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function createRuntimeBindingsStore(db) {
  const upsertStmt = db.prepare(`
    INSERT INTO fellow_runtime_bindings (
      user_id, fellow_id, runtime_kind, enabled, config_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, fellow_id, runtime_kind) DO UPDATE SET
      enabled = excluded.enabled,
      config_json = excluded.config_json,
      updated_at = excluded.updated_at
    RETURNING user_id, fellow_id, runtime_kind, enabled, config_json, created_at, updated_at
  `);
  const selectStmt = db.prepare(`
    SELECT user_id, fellow_id, runtime_kind, enabled, config_json, created_at, updated_at
    FROM fellow_runtime_bindings
    WHERE user_id = ? AND fellow_id = ? AND runtime_kind = ?
  `);
  const selectEnabledStmt = db.prepare(`
    SELECT user_id, fellow_id, runtime_kind, enabled, config_json, created_at, updated_at
    FROM fellow_runtime_bindings
    WHERE user_id = ? AND fellow_id = ? AND runtime_kind = ? AND enabled = 1
  `);

  function upsertBinding(args = {}) {
    const userId = String(args.userId || "").trim();
    const fellowId = String(args.fellowId || "").trim();
    const runtimeKind = String(args.runtimeKind || "").trim();
    if (!userId) throw new Error("upsertBinding: userId required");
    if (!fellowId) throw new Error("upsertBinding: fellowId required");
    if (!runtimeKind) throw new Error("upsertBinding: runtimeKind required");
    const existing = selectStmt.get(userId, fellowId, runtimeKind);
    const now = nowIso();
    return rowToBinding(upsertStmt.get(
      userId,
      fellowId,
      runtimeKind,
      args.enabled === false ? 0 : 1,
      JSON.stringify(args.config && typeof args.config === "object" ? args.config : {}),
      existing?.created_at || now,
      now
    ));
  }

  function getBinding(userId, fellowId, runtimeKind) {
    return rowToBinding(selectStmt.get(String(userId), String(fellowId), String(runtimeKind)));
  }

  function getEnabledBinding(userId, fellowId, runtimeKind) {
    return rowToBinding(selectEnabledStmt.get(String(userId), String(fellowId), String(runtimeKind)));
  }

  return { upsertBinding, getBinding, getEnabledBinding };
}

module.exports = { createRuntimeBindingsStore };
