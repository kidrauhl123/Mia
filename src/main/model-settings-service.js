"use strict";

function firstString(source = {}, keys = []) {
  for (const key of keys) {
    const value = String(source?.[key] || "").trim();
    if (value) return value;
  }
  return "";
}

function isCompactMiaManagedSettings(settings = {}) {
  const provider = firstString(settings, ["provider"]);
  const authType = firstString(settings, ["authType", "auth_type"]);
  const modelProfileId = firstString(settings, ["modelProfileId", "model_profile_id"]);
  const model = firstString(settings, ["model"]);
  return provider === "mia"
    || authType === "mia_account"
    || modelProfileId.startsWith("mia:")
    || model === "mia-auto"
    || model === "mia-default";
}

function createModelSettingsService({
  modelSettings,
  providerConnection,
  saveProviderConnection,
  writeModelSettings,
  restartEngineIfRunning,
  getRuntimeStatus
}) {
  async function saveModelSelection(settings = {}) {
    if (isCompactMiaManagedSettings(settings)) {
      const model = String(settings.model || "").trim();
      writeModelSettings({
        provider: "mia",
        providerConnectionId: String(settings.providerConnectionId || settings.provider || "mia").trim() || "mia",
        providerLabel: String(settings.providerLabel || "Mia").trim() || "Mia",
        authType: String(settings.authType || "mia_account").trim() || "mia_account",
        model,
        modelProfileId: String(settings.modelProfileId || (model ? `mia:${model}` : "mia:mia-default")).trim() || (model ? `mia:${model}` : "mia:mia-default")
      });
      return getRuntimeStatus();
    }
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
    const nextAuthType = String(settings.authType || existingConnection?.authType || (next.provider === "openai-codex" ? "oauth_external" : "api_key")).trim();
    const nextProviderLabel = String(settings.providerLabel || existingConnection?.providerLabel || next.provider).trim();
    if (next.provider && (submittedApiKey || next.apiKey || next.provider === "lmstudio" || nextAuthType !== "api_key")) {
      saveProviderConnection({
        provider: next.provider,
        providerLabel: nextProviderLabel,
        authType: nextAuthType,
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
