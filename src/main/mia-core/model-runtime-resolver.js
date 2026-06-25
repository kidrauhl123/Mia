"use strict";

function firstString(source = {}, keys = []) {
  for (const key of keys) {
    const value = String(source?.[key] || "").trim();
    if (value) return value;
  }
  return "";
}

function normalizeProfileId(value = "") {
  return String(value || "").trim();
}

function isBuiltinMiaModel(model = "") {
  const id = String(model || "").trim();
  return id === "mia-auto" || id === "mia-default";
}

function isMiaManagedReference(config = {}) {
  const provider = firstString(config, ["providerConnectionId", "provider_connection_id", "provider", "modelProvider", "model_provider"]);
  const authType = firstString(config, ["authType", "auth_type"]);
  const profileId = normalizeProfileId(firstString(config, ["modelProfileId", "model_profile_id", "profileId", "profile_id"]));
  const model = firstString(config, ["model"]);
  return provider === "mia" || authType === "mia_account" || profileId.startsWith("mia:") || isBuiltinMiaModel(model);
}

function isMiaManagedRuntime(runtime = {}) {
  return Boolean(runtime && (runtime.managedByMia === true || runtime.provider === "mia" || runtime.authType === "mia_account"));
}

function toMiaManagedReference(config = {}) {
  const model = firstString(config, ["model"]) || "mia-default";
  return {
    provider: "mia",
    providerConnectionId: "mia",
    providerLabel: firstString(config, ["providerLabel", "provider_label"]) || "Mia",
    authType: "mia_account",
    model,
    modelProfileId: firstString(config, ["modelProfileId", "model_profile_id"]) || `mia:${model}`
  };
}

function createMiaCoreModelRuntimeResolver(deps = {}) {
  const cloudStatus = typeof deps.cloudStatus === "function" ? deps.cloudStatus : () => ({ enabled: false });
  const normalizeCloudUrl = typeof deps.normalizeCloudUrl === "function"
    ? deps.normalizeCloudUrl
    : (value) => String(value || "").replace(/\/+$/, "");
  const providerConnection = typeof deps.providerConnection === "function" ? deps.providerConnection : () => null;
  const modelSettings = typeof deps.modelSettings === "function" ? deps.modelSettings : () => ({});

  function resolveMiaCloud(config = {}) {
    const cloud = cloudStatus(true);
    if (!cloud?.enabled || !cloud.token || !cloud.url) {
      throw new Error("请先登录 Mia Cloud，再使用 Mia 托管模型。");
    }
    const cloudBaseUrl = normalizeCloudUrl(cloud.url);
    return {
      ...toMiaManagedReference(config),
      apiKeyEnv: "MIA_CLOUD_MODEL_TOKEN",
      apiKey: cloud.token,
      baseUrl: `${cloudBaseUrl}/api/me/model-proxy/v1`,
      anthropicBaseUrl: `${cloudBaseUrl}/api/me/model-proxy`,
      apiMode: firstString(config, ["apiMode", "api_mode"]) || "chat_completions",
      managedByMia: true,
      source: "mia-core"
    };
  }

  function nativeCliDefault(config = {}, context = {}) {
    const engine = String(context?.engine || config.agentEngine || config.agent_engine || "").trim();
    const provider = firstString(config, ["providerConnectionId", "provider_connection_id", "provider"]);
    const model = firstString(config, ["model"]);
    return (engine === "codex" || engine === "claude-code" || engine === "openclaw")
      && (!model || model === "default")
      && (!provider
        || provider === engine
        || provider === "codex"
        || provider === "openclaw"
        || provider === "claude-code"
        || (engine === "codex" && provider === "openai-codex"));
  }

  function resolveProviderConnection(config = {}, context = {}) {
    if (nativeCliDefault(config, context)) return null;
    const providerId = firstString(config, ["providerConnectionId", "provider_connection_id", "provider", "modelProvider", "model_provider"]);
    if (!providerId) return null;
    const connection = providerConnection(providerId);
    if (!connection) return null;
    const model = firstString(config, ["model"]) || firstString(modelSettings(), ["model"]);
    return {
      provider: connection.provider || providerId,
      providerConnectionId: providerId,
      providerLabel: connection.providerLabel || connection.provider_label || connection.provider || providerId,
      authType: connection.authType || connection.auth_type || "api_key",
      model,
      modelProfileId: firstString(config, ["modelProfileId", "model_profile_id"]) || (model ? `${providerId}:${model}` : providerId),
      apiKeyEnv: connection.apiKeyEnv || connection.api_key_env || "",
      apiKey: connection.apiKey || connection.api_key || "",
      baseUrl: connection.baseUrl || connection.base_url || "",
      apiMode: connection.apiMode || connection.api_mode || "",
      managedByMia: false,
      source: "mia-core"
    };
  }

  function resolveModelRuntime(config = {}, context = {}) {
    if (!config || typeof config !== "object") return null;
    if (isMiaManagedReference(config)) return resolveMiaCloud(config);
    return resolveProviderConnection(config, context);
  }

  function resolveMiaManagedModelSettings(settings = {}) {
    if (!isMiaManagedReference(settings)) return settings;
    return toMiaManagedReference(settings);
  }

  return {
    resolveModelRuntime,
    resolveMiaManagedModelSettings
  };
}

module.exports = {
  createMiaCoreModelRuntimeResolver,
  isMiaManagedRuntime
};
