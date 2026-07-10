"use strict";

const MODEL_SELECTION_KEYS = [
  "model",
  "providerConnectionId",
  "provider_connection_id",
  "modelProfileId",
  "model_profile_id",
  "profileId",
  "profile_id",
  "modelEntries",
  "provider",
  "modelProvider",
  "model_provider",
  "providerLabel",
  "provider_label",
  "authType",
  "auth_type",
  "apiKeyEnv",
  "api_key_env",
  "baseUrl",
  "base_url",
  "apiMode",
  "api_mode"
];

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function normalizedEngine(value) {
  return String(value || "").trim().toLowerCase().replace(/_/g, "-");
}

function clearModelSelection(config) {
  for (const key of MODEL_SELECTION_KEYS) delete config[key];
}

function applyTargetIntent(config, input) {
  const intent = objectValue(input);
  if (!intent) return;
  const previousEngine = firstText(config.agentEngine, config.agent_engine, config.engine);
  const agentEngine = firstText(intent.agentEngine, intent.agent_engine, intent.engine);
  if (agentEngine) {
    if (previousEngine && normalizedEngine(previousEngine) !== normalizedEngine(agentEngine)) {
      clearModelSelection(config);
    }
    config.agentEngine = agentEngine;
    delete config.agent_engine;
    delete config.engine;
  }
  const deviceId = firstText(intent.deviceId, intent.device_id, intent.targetDeviceId, intent.target_device_id);
  if (deviceId) config.deviceId = deviceId;
  const deviceName = firstText(intent.deviceName, intent.device_name, intent.targetDeviceName, intent.target_device_name);
  if (deviceName) config.deviceName = deviceName;
}

function normalizedControlField(value) {
  const field = String(value || "").trim();
  if (field === "effort" || field === "effort_level") return "effortLevel";
  if (field === "permission" || field === "permission_mode") return "permissionMode";
  return field;
}

function modelEntryValue(entry = {}) {
  return firstText(entry.id, entry.value, entry.model);
}

function applyModelControl(config, intent) {
  const value = String(intent.value || "").trim();
  if (!value) return;
  const entries = Array.isArray(intent.modelEntries)
    ? intent.modelEntries
    : (Array.isArray(intent.model_entries) ? intent.model_entries : []);
  const entry = entries.find((item) => modelEntryValue(item) === value) || null;
  config.model = firstText(entry?.model, entry?.id, entry?.value, value);
  const provider = firstText(entry?.provider, entry?.providerConnectionId, entry?.provider_connection_id);
  if (provider) config.provider = provider;
  const profileId = firstText(entry?.modelProfileId, entry?.model_profile_id, entry?.profileId, entry?.profile_id);
  if (profileId) config.modelProfileId = profileId;
  if (entries.length) config.modelEntries = entries;
}

function applyControlIntent(config, input) {
  const intent = objectValue(input);
  if (!intent) return;
  const field = normalizedControlField(intent.field);
  if (field === "model") {
    applyModelControl(config, intent);
  } else if (field === "effortLevel") {
    config.effortLevel = String(intent.value || "").trim();
  } else if (field === "permissionMode") {
    config.permissionMode = String(intent.value || "").trim();
  }
}

function hasRuntimeConfigIntent(body = {}) {
  const request = objectValue(body) || {};
  return [request.targetIntent, request.syncIntent, request.controlIntent]
    .some((value) => Boolean(objectValue(value)));
}

function runtimeConfigInputForRequest({ body = {}, existingConfig = {} } = {}) {
  const request = objectValue(body) || {};
  if (!hasRuntimeConfigIntent(request)) return objectValue(request.config) || {};
  const config = {
    ...(objectValue(existingConfig) || {}),
    ...(objectValue(request.config) || {})
  };
  applyTargetIntent(config, request.targetIntent);
  applyTargetIntent(config, request.syncIntent);
  applyControlIntent(config, request.controlIntent);
  return config;
}

module.exports = {
  hasRuntimeConfigIntent,
  runtimeConfigInputForRequest
};
