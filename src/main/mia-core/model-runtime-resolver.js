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

function canonicalMiaModelId(model = "") {
  const id = String(model || "").trim();
  return id === "mia-default" ? "mia-auto" : id;
}

function canonicalMiaProfileId(profileId = "", model = "") {
  const raw = String(profileId || "").trim();
  if (!raw.startsWith("mia:")) return raw;
  const modelId = canonicalMiaModelId(raw.slice("mia:".length)) || canonicalMiaModelId(model);
  return modelId ? `mia:${modelId}` : raw;
}

function isMiaManagedReference(config = {}) {
  const explicitProviderId = explicitProviderConnectionId(config);
  const profileProviderId = providerFromProfileId(config);
  if (explicitProviderId) return explicitProviderId === "mia";
  if (profileProviderId) return profileProviderId === "mia";
  const provider = firstString(config, ["provider", "modelProvider", "model_provider"]);
  const authType = firstString(config, ["authType", "auth_type"]);
  const profileId = normalizeProfileId(firstString(config, ["modelProfileId", "model_profile_id", "profileId", "profile_id"]));
  const model = firstString(config, ["model"]);
  return provider === "mia" || authType === "mia_account" || profileId.startsWith("mia:") || isBuiltinMiaModel(model);
}

function isMiaManagedRuntime(runtime = {}) {
  return Boolean(runtime && (runtime.managedByMia === true || runtime.provider === "mia" || runtime.authType === "mia_account"));
}

function explicitProviderConnectionId(config = {}) {
  return firstString(config, ["providerConnectionId", "provider_connection_id"]);
}

function providerFromProfileId(config = {}) {
  const profileId = normalizeProfileId(firstString(config, ["modelProfileId", "model_profile_id", "profileId", "profile_id"]));
  const index = profileId.indexOf(":");
  return index > 0 ? profileId.slice(0, index) : "";
}

function isNativeCliEngine(engine = "") {
  return engine === "codex" || engine === "claude-code" || engine === "openclaw";
}

function isNativeCliProvider(engine = "", provider = "") {
  if (!provider) return true;
  if (provider === engine) return true;
  if (engine === "codex") return provider === "openai-codex";
  if (engine === "claude-code") return provider === "anthropic";
  return false;
}

function toMiaManagedReference(config = {}) {
  const rawProfileId = firstString(config, ["modelProfileId", "model_profile_id"]);
  const profileModel = rawProfileId.startsWith("mia:") ? rawProfileId.slice("mia:".length) : "";
  const model = canonicalMiaModelId(firstString(config, ["model"]) || profileModel) || "mia-auto";
  const profileId = canonicalMiaProfileId(rawProfileId, model);
  return {
    provider: "mia",
    providerConnectionId: "mia",
    providerLabel: firstString(config, ["providerLabel", "provider_label"]) || "Mia",
    authType: "mia_account",
    model,
    modelProfileId: profileId.startsWith("mia:") ? profileId : `mia:${model}`
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
    if (!isNativeCliEngine(engine)) return false;
    const provider = explicitProviderConnectionId(config)
      || providerFromProfileId(config)
      || firstString(config, ["provider", "modelProvider", "model_provider"]);
    return isNativeCliProvider(engine, provider);
  }

  function resolveProviderConnection(config = {}, context = {}) {
    if (nativeCliDefault(config, context)) return null;
    const explicitProviderId = explicitProviderConnectionId(config);
    const profileProviderId = providerFromProfileId(config);
    const providerId = explicitProviderId
      || profileProviderId
      || firstString(config, ["provider", "modelProvider", "model_provider"]);
    if (!providerId) return null;
    const connection = providerConnection(providerId);
    if (!connection) {
      if (explicitProviderId || profileProviderId) {
        throw new Error(`Provider connection ${providerId} is not available. Please reconnect it in Mia settings.`);
      }
      return null;
    }
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
  canonicalMiaModelId,
  canonicalMiaProfileId,
  createMiaCoreModelRuntimeResolver,
  isMiaManagedRuntime
};
