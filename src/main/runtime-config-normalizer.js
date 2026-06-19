"use strict";

function firstString(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function normalizeTurnRuntimeConfig(runtimeConfig = null) {
  if (!runtimeConfig || typeof runtimeConfig !== "object") return {};
  const config = {};
  const fields = [
    ["model", ["model"]],
    ["provider", ["provider", "modelProvider", "model_provider"]],
    ["providerLabel", ["providerLabel", "provider_label"]],
    ["authType", ["authType", "auth_type"]],
    ["modelProfileId", ["modelProfileId", "model_profile_id"]],
    ["apiKeyEnv", ["apiKeyEnv", "api_key_env"]],
    ["baseUrl", ["baseUrl", "base_url"]],
    ["apiMode", ["apiMode", "api_mode"]],
    ["effortLevel", ["effortLevel", "effort_level"]],
    ["permissionMode", ["permissionMode", "permission_mode"]]
  ];
  for (const [target, keys] of fields) {
    const value = firstString(runtimeConfig, keys);
    if (value) config[target] = value;
  }
  return config;
}

module.exports = {
  normalizeTurnRuntimeConfig
};
