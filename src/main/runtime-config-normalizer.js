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
    ["agentEngine", ["agentEngine", "agent_engine"]],
    ["deviceId", ["deviceId", "device_id", "targetDeviceId", "target_device_id"]],
    ["deviceName", ["deviceName", "device_name", "targetDeviceName", "target_device_name"]],
    ["model", ["model"]],
    ["providerConnectionId", ["providerConnectionId", "provider_connection_id", "provider", "modelProvider", "model_provider"]],
    ["modelProfileId", ["modelProfileId", "model_profile_id"]],
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
