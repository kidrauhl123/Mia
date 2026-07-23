function nowIso() {
  return new Date().toISOString();
}

function normalizeDeepSeekModel(value) {
  const raw = String(value || "").trim();
  return raw.startsWith("deepseek/") ? raw.slice("deepseek/".length) : raw;
}

function rowToSettings(row) {
  if (!row) return null;
  return {
    id: row.id,
    mode: row.mode || "deepseek",
    modelId: row.model_id || "mia-auto",
    provider: row.provider || "deepseek",
    upstreamModel: row.provider === "deepseek" ? normalizeDeepSeekModel(row.upstream_model) : (row.upstream_model || ""),
    apiBase: row.api_base || "",
    apiKey: row.api_key || "",
    updatedAt: row.updated_at || ""
  };
}

function publicSettings(settings) {
  if (!settings) return null;
  const { apiKey, ...safe } = settings;
  return {
    ...safe,
    hasApiKey: Boolean(apiKey)
  };
}

function createModelGatewayStore(db) {
  const selectStmt = db.prepare(`
    SELECT id, mode, model_id, provider, upstream_model, api_base, api_key, updated_at
    FROM model_gateway_settings
    WHERE id = 'default'
  `);
  const upsertStmt = db.prepare(`
    INSERT INTO model_gateway_settings (
      id, mode, model_id, provider, upstream_model, api_base, api_key, updated_at
    ) VALUES ('default', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      mode = excluded.mode,
      model_id = excluded.model_id,
      provider = excluded.provider,
      upstream_model = excluded.upstream_model,
      api_base = excluded.api_base,
      api_key = CASE WHEN excluded.api_key = '' THEN model_gateway_settings.api_key ELSE excluded.api_key END,
      updated_at = excluded.updated_at
  `);

  function getSettings() {
    return rowToSettings(selectStmt.get());
  }

  function saveSettings(input = {}) {
    const existing = getSettings();
    const provider = String(input.provider || existing?.provider || "deepseek").trim() || "deepseek";
    const upstreamModel = provider === "deepseek"
      ? normalizeDeepSeekModel(input.upstreamModel || input.model || existing?.upstreamModel || "deepseek-chat")
      : String(input.upstreamModel || input.model || existing?.upstreamModel || "").trim();
    const hasApiBase = Object.prototype.hasOwnProperty.call(input, "apiBase");
    upsertStmt.run(
      String(input.mode || existing?.mode || "deepseek").trim() || "deepseek",
      String(input.modelId || input.modelName || existing?.modelId || "mia-auto").trim() || "mia-auto",
      provider,
      upstreamModel,
      String(hasApiBase ? input.apiBase : (existing?.apiBase || "")).trim().replace(/\/+$/, ""),
      String(input.apiKey || "").trim(),
      nowIso()
    );
    return getSettings();
  }

  return { getSettings, saveSettings, publicSettings };
}

module.exports = {
  createModelGatewayStore,
  normalizeDeepSeekModel,
  publicSettings
};
