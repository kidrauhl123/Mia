"use strict";

const fs = require("node:fs");
const path = require("node:path");

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
    return store().providers[id] || null;
  }

  function connectedSummaries(codexAuth = codexAuthStatus()) {
    const summaries = Object.values(store().providers)
      .filter((entry) => entry.provider && (entry.apiKey || entry.authType !== "api_key" || entry.provider === "lmstudio"))
      .map((entry) => ({
        provider: entry.provider,
        providerLabel: entry.providerLabel || entry.provider,
        authType: entry.authType || "api_key",
        apiKeyEnv: entry.apiKeyEnv || "",
        baseUrl: entry.baseUrl || "",
        apiMode: entry.apiMode || "",
        connectedAt: entry.connectedAt || "",
        hasApiKey: Boolean(entry.apiKey) || entry.authType !== "api_key" || entry.provider === "lmstudio"
      }));

    if (codexAuth.codexLoggedIn && !summaries.some((entry) => entry.provider === "openai-codex")) {
      summaries.push({
        provider: "openai-codex",
        providerLabel: "OpenAI Codex",
        authType: "oauth_external",
        apiKeyEnv: "",
        baseUrl: "",
        apiMode: "codex_responses",
        connectedAt: "",
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
