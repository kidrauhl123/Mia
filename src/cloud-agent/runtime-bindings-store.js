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
    botId: row.bot_id,
    runtimeKind: row.runtime_kind,
    enabled: Number(row.enabled) === 1,
    config: parseJsonOr(row.config_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function createRuntimeBindingsStore(db) {
  const upsertStmt = db.prepare(`
    INSERT INTO bot_runtime_bindings (
      user_id, bot_id, runtime_kind, enabled, config_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, bot_id, runtime_kind) DO UPDATE SET
      enabled = excluded.enabled,
      config_json = excluded.config_json,
      updated_at = excluded.updated_at
    RETURNING user_id, bot_id, runtime_kind, enabled, config_json, created_at, updated_at
  `);
  const selectStmt = db.prepare(`
    SELECT user_id, bot_id, runtime_kind, enabled, config_json, created_at, updated_at
    FROM bot_runtime_bindings
    WHERE user_id = ? AND bot_id = ? AND runtime_kind = ?
  `);
  const selectEnabledStmt = db.prepare(`
    SELECT user_id, bot_id, runtime_kind, enabled, config_json, created_at, updated_at
    FROM bot_runtime_bindings
    WHERE user_id = ? AND bot_id = ? AND runtime_kind = ? AND enabled = 1
  `);
  const selectActiveStmt = db.prepare(`
    SELECT user_id, bot_id, runtime_kind, enabled, config_json, created_at, updated_at
    FROM bot_runtime_bindings
    WHERE user_id = ? AND bot_id = ? AND enabled = 1
    ORDER BY updated_at DESC
    LIMIT 1
  `);
  const listStmt = db.prepare(`
    SELECT user_id, bot_id, runtime_kind, enabled, config_json, created_at, updated_at
    FROM bot_runtime_bindings
    WHERE user_id = ? AND bot_id = ?
    ORDER BY enabled DESC, updated_at DESC
  `);
  const listDesktopForDeviceStmt = db.prepare(`
    SELECT user_id, bot_id, runtime_kind, enabled, config_json, created_at, updated_at
    FROM bot_runtime_bindings
    WHERE user_id = ? AND runtime_kind = 'desktop-local'
  `);
  const updateConfigStmt = db.prepare(`
    UPDATE bot_runtime_bindings
    SET config_json = ?, updated_at = ?
    WHERE user_id = ? AND bot_id = ? AND runtime_kind = 'desktop-local'
  `);
  const disableOtherKindsStmt = db.prepare(`
    UPDATE bot_runtime_bindings
    SET enabled = 0, updated_at = ?
    WHERE user_id = ? AND bot_id = ? AND runtime_kind <> ?
  `);

  function hasActiveBinding(userId, botId) {
    return Boolean(selectActiveStmt.get(userId, botId));
  }

  function upsertBinding(args = {}) {
    const userId = String(args.userId || "").trim();
    const botId = String(args.botId || "").trim();
    const runtimeKind = String(args.runtimeKind || "").trim();
    if (!userId) throw new Error("upsertBinding: userId required");
    if (!botId) throw new Error("upsertBinding: botId required");
    if (!runtimeKind) throw new Error("upsertBinding: runtimeKind required");
    const existing = selectStmt.get(userId, botId, runtimeKind);
    const now = nowIso();
    const activate = args.activate === true || args.active === true;
    const activateIfEmpty = args.activate === "if-empty" || args.active === "if-empty";
    const hadActiveBinding = hasActiveBinding(userId, botId);
    const shouldActivate = activate || (activateIfEmpty && !hadActiveBinding);
    if (shouldActivate) disableOtherKindsStmt.run(now, userId, botId, runtimeKind);
    const enabled = shouldActivate
      ? 1
      : (activateIfEmpty && hadActiveBinding && !existing
        ? 0
        : (args.preserveEnabled && existing
        ? existing.enabled
        : (args.enabled === false ? 0 : 1)));
    return rowToBinding(upsertStmt.get(
      userId,
      botId,
      runtimeKind,
      enabled,
      JSON.stringify(args.config && typeof args.config === "object" ? args.config : {}),
      existing?.created_at || now,
      now
    ));
  }

  function getBinding(userId, botId, runtimeKind) {
    return rowToBinding(selectStmt.get(String(userId), String(botId), String(runtimeKind)));
  }

  function getEnabledBinding(userId, botId, runtimeKind) {
    return rowToBinding(selectEnabledStmt.get(String(userId), String(botId), String(runtimeKind)));
  }

  function getActiveBinding(userId, botId) {
    return rowToBinding(selectActiveStmt.get(String(userId), String(botId)));
  }

  function listBindings(userId, botId) {
    return listStmt.all(String(userId), String(botId)).map(rowToBinding);
  }

  function syncDeviceName(userId, deviceId, deviceName) {
    const ownerId = String(userId || "").trim();
    const targetDeviceId = String(deviceId || "").trim();
    const targetDeviceName = String(deviceName || "").trim();
    if (!ownerId || !targetDeviceId || !targetDeviceName) return [];
    const updated = [];
    for (const row of listDesktopForDeviceStmt.all(ownerId)) {
      const config = parseJsonOr(row.config_json, {});
      const configuredDeviceId = String(
        config.deviceId
        || config.device_id
        || config.targetDeviceId
        || config.target_device_id
        || ""
      ).trim();
      if (configuredDeviceId !== targetDeviceId) continue;
      const currentDeviceName = String(config.deviceName || config.device_name || "").trim();
      if (currentDeviceName === targetDeviceName && !config.device_name) continue;
      const nextConfig = {
        ...config,
        deviceName: targetDeviceName
      };
      delete nextConfig.device_name;
      updateConfigStmt.run(
        JSON.stringify(nextConfig),
        nowIso(),
        ownerId,
        row.bot_id
      );
      updated.push(rowToBinding(selectStmt.get(ownerId, row.bot_id, "desktop-local")));
    }
    return updated;
  }

  return { upsertBinding, getBinding, getEnabledBinding, getActiveBinding, listBindings, syncDeviceName };
}

module.exports = { createRuntimeBindingsStore };
