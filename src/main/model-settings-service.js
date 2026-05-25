"use strict";

function createModelSettingsService({
  modelSettings,
  providerConnection,
  saveProviderConnection,
  writeModelSettings,
  restartEngineIfRunning,
  getRuntimeStatus
}) {
  async function saveModelSelection(settings = {}) {
    const current = modelSettings();
    const nextProvider = String(settings.provider || "").trim();
    const hasApiKey = Object.prototype.hasOwnProperty.call(settings || {}, "apiKey");
    const hasApiKeyEnv = Object.prototype.hasOwnProperty.call(settings || {}, "apiKeyEnv");
    const existingConnection = providerConnection(nextProvider);
    const submittedApiKey = hasApiKey ? String(settings.apiKey || "").trim() : "";
    const fallbackApiKey = existingConnection?.apiKey || (nextProvider === current.provider ? current.apiKey : "");
    const nextApiKeyEnv = String(
      hasApiKeyEnv
        ? settings.apiKeyEnv
        : (existingConnection?.apiKeyEnv || current.apiKeyEnv || "OPENAI_API_KEY")
    ).trim();
    const next = {
      provider: nextProvider,
      model: String(settings.model || "").trim(),
      apiKeyEnv: nextApiKeyEnv,
      apiKey: submittedApiKey || String(fallbackApiKey || "").trim(),
      baseUrl: String(settings.baseUrl || "").trim(),
      apiMode: String(settings.apiMode || "").trim()
    };
    if (next.provider && (submittedApiKey || next.apiKey || next.provider === "lmstudio")) {
      saveProviderConnection({
        provider: next.provider,
        providerLabel: String(settings.providerLabel || existingConnection?.providerLabel || next.provider).trim(),
        authType: String(settings.authType || existingConnection?.authType || (next.provider === "openai-codex" ? "oauth_external" : "api_key")).trim(),
        apiKeyEnv: next.apiKeyEnv,
        apiKey: next.apiKey,
        baseUrl: next.baseUrl,
        apiMode: next.apiMode
      });
    }
    writeModelSettings(next);
    if (submittedApiKey) return restartEngineIfRunning();
    return getRuntimeStatus();
  }

  return {
    saveModelSelection
  };
}

module.exports = {
  createModelSettingsService
};
