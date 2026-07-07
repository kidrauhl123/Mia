"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { CODEX_CHATGPT_BASE_URL } = require("./auth-service.js");

function createProviderConnections({
  runtimePaths,
  readJson,
  modelSettings = () => ({}),
  codexAuthStatus = () => ({ codexLoggedIn: false }),
  now = () => new Date().toISOString()
}) {
  function defaultStore() {
    return {
      schema_version: 1,
      providers: {}
    };
  }

  function normalize(provider, input = {}) {
    const id = String(input.provider || provider || "").trim();
    if (!id) return null;
    return {
      provider: id,
      providerLabel: String(input.providerLabel || input.label || id).trim() || id,
      authType: String(input.authType || "api_key").trim() || "api_key",
      apiKeyEnv: String(input.apiKeyEnv || "").trim(),
      apiKey: String(input.apiKey || "").trim(),
      baseUrl: String(input.baseUrl || "").trim(),
      apiMode: String(input.apiMode || "").trim(),
      connectedAt: String(input.connectedAt || now())
    };
  }

  function codexOAuthConnection(source = {}) {
    return {
      provider: "openai-codex",
      providerLabel: String(source.providerLabel || source.provider_label || source.label || "OpenAI Codex").trim() || "OpenAI Codex",
      authType: "oauth_external",
      apiKeyEnv: "",
      apiKey: "",
      baseUrl: String(source.baseUrl || source.base_url || CODEX_CHATGPT_BASE_URL).trim() || CODEX_CHATGPT_BASE_URL,
      apiMode: String(source.apiMode || source.api_mode || "codex_responses").trim() || "codex_responses",
      connectedAt: String(source.connectedAt || source.connected_at || "").trim(),
      hasApiKey: true
    };
  }

  function store() {
    const raw = readJson(runtimePaths().providerConnections, defaultStore());
    const providers = raw?.providers && typeof raw.providers === "object" ? raw.providers : {};
    const normalized = defaultStore();
    for (const [provider, value] of Object.entries(providers)) {
      const next = normalize(provider, value);
      if (next) normalized.providers[next.provider] = next;
    }
    return normalized;
  }

  function writeStore(nextStore) {
    const filePath = runtimePaths().providerConnections;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(nextStore, null, 2) + "\n", { mode: 0o600 });
  }

  function save(connection) {
    const current = store();
    const next = normalize(connection.provider, connection);
    if (!next) return current;
    current.providers[next.provider] = next;
    writeStore(current);
    return current;
  }

  function remove(provider) {
    const id = String(provider || "").trim();
    if (!id) return store();
    const current = store();
    delete current.providers[id];
    writeStore(current);
    return current;
  }

  function get(provider) {
    const id = String(provider || "").trim();
    if (!id) return null;
    const saved = store().providers[id] || null;
    if (id === "openai-codex" && codexAuthStatus()?.codexLoggedIn) {
      return codexOAuthConnection(saved || {});
    }
    return saved;
  }

  function connectedSummaries(codexAuth = codexAuthStatus()) {
    function isConnectedEntry(entry) {
      if (!entry?.provider) return false;
      if (entry.provider === "lmstudio") return true;
      if (entry.provider === "openai-codex") return Boolean(codexAuth?.codexLoggedIn);
      if (entry.authType !== "api_key") return true;
      return Boolean(entry.apiKey);
    }

    const summaries = Object.values(store().providers)
      .filter(isConnectedEntry)
      .map((entry) => ({
        provider: entry.provider,
        providerLabel: entry.providerLabel || entry.provider,
        authType: entry.authType || "api_key",
        apiKeyEnv: entry.apiKeyEnv || "",
        baseUrl: entry.baseUrl || "",
        apiMode: entry.apiMode || "",
        connectedAt: entry.connectedAt || "",
        hasApiKey: true
      }));

    if (codexAuth.codexLoggedIn && !summaries.some((entry) => entry.provider === "openai-codex")) {
      const codex = codexOAuthConnection();
      summaries.push({
        provider: codex.provider,
        providerLabel: codex.providerLabel,
        authType: codex.authType,
        apiKeyEnv: codex.apiKeyEnv,
        baseUrl: codex.baseUrl,
        apiMode: codex.apiMode,
        connectedAt: codex.connectedAt,
        hasApiKey: true
      });
    }

    const currentModel = modelSettings();
    if (currentModel.provider && currentModel.apiKey && !summaries.some((entry) => entry.provider === currentModel.provider)) {
      summaries.push({
        provider: currentModel.provider,
        providerLabel: currentModel.provider,
        authType: currentModel.provider === "openai-codex" ? "oauth_external" : "api_key",
        apiKeyEnv: currentModel.apiKeyEnv || "",
        baseUrl: currentModel.baseUrl || "",
        apiMode: currentModel.apiMode || "",
        connectedAt: "",
        hasApiKey: true
      });
    }

    return summaries.sort((a, b) => String(a.providerLabel).localeCompare(String(b.providerLabel)));
  }

  return {
    defaultStore,
    normalize,
    store,
    save,
    remove,
    get,
    connectedSummaries
  };
}

module.exports = {
  createProviderConnections
};
