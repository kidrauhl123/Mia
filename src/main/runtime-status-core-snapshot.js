"use strict";

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function firstString(source, keys = []) {
  const input = objectOrEmpty(source);
  for (const key of keys) {
    const value = input[key];
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function compactModelFromClientSettings(response = {}) {
  const settings = objectOrEmpty(objectOrEmpty(response).settings || response);
  const provider = firstString(settings, ["provider", "kind"]);
  const providerConnectionId = firstString(settings, ["providerConnectionId", "provider_connection_id"]) || provider;
  const model = firstString(settings, ["model"]);
  const modelProfileId = firstString(settings, ["modelProfileId", "model_profile_id"])
    || (providerConnectionId && model ? `${providerConnectionId}:${model}` : providerConnectionId);
  const providerLabel = firstString(settings, ["providerLabel", "provider_label", "displayName", "display_name"]) || provider;
  const authType = firstString(settings, ["authType", "auth_type"])
    || (provider === "mia" ? "mia_account" : provider === "openai-codex" ? "oauth_external" : "api_key");

  return {
    provider,
    providerConnectionId,
    providerLabel,
    authType,
    model,
    modelProfileId
  };
}

function providerMatchesModel(provider, model) {
  const entry = objectOrEmpty(provider);
  const current = objectOrEmpty(model);
  if (!entry.provider && !entry.providerConnectionId) return false;
  return entry.provider === current.provider
    || entry.providerConnectionId === current.providerConnectionId
    || entry.providerConnectionId === current.provider;
}

function providerSummaryFromCore(provider = {}, currentModel = {}) {
  const input = objectOrEmpty(provider);
  const kind = firstString(input, ["kind", "provider"]) || firstString(input, ["id"]);
  const id = firstString(input, ["id", "providerConnectionId", "provider_connection_id"]) || kind;
  const providerLabel = firstString(input, ["displayName", "display_name", "providerLabel", "provider_label"]) || kind || id;
  const authType = providerMatchesModel({ provider: kind, providerConnectionId: id }, currentModel)
    ? firstString(currentModel, ["authType", "auth_type"])
    : "";
  const models = Array.isArray(input.models)
    ? input.models.map((model) => String(model || "").trim()).filter(Boolean)
    : [];

  return {
    provider: kind,
    providerConnectionId: id,
    providerLabel,
    authType: authType || (kind === "openai-codex" ? "oauth_external" : kind === "mia" ? "mia_account" : "api_key"),
    hasApiKey: input.enabled !== false,
    models
  };
}

function coreProviderSummaries(response = {}, currentModel = {}, auth = {}) {
  const providers = Array.isArray(objectOrEmpty(response).providers) ? response.providers : [];
  const summaries = providers
    .map((provider) => providerSummaryFromCore(provider, currentModel))
    .filter((provider) => provider.provider || provider.providerConnectionId);

  if (auth?.codexLoggedIn && !summaries.some((provider) => provider.provider === "openai-codex")) {
    summaries.push({
      provider: "openai-codex",
      providerConnectionId: "openai-codex",
      providerLabel: "OpenAI Codex",
      authType: "oauth_external",
      hasApiKey: true,
      models: []
    });
  }

  return summaries.sort((a, b) => String(a.providerLabel).localeCompare(String(b.providerLabel)));
}

function codexModelSlugs(response = {}) {
  const models = Array.isArray(response)
    ? response
    : Array.isArray(objectOrEmpty(response).models)
      ? response.models
      : [];
  return models
    .map((model) => firstString(model, ["slug", "id", "model", "value", "name"]) || String(model || "").trim())
    .filter(Boolean);
}

function resolveCodexModelSelection(current = {}, codexModels = {}) {
  const existing = objectOrEmpty(current);
  const slugs = codexModelSlugs(codexModels);
  const currentModel = firstString(existing, ["model"]);
  const canKeepCurrent = existing.provider === "openai-codex"
    && currentModel
    && slugs.includes(currentModel);
  const model = canKeepCurrent ? currentModel : "";
  return {
    provider: "openai-codex",
    providerConnectionId: "openai-codex",
    providerLabel: "OpenAI Codex",
    authType: "oauth_external",
    model,
    modelProfileId: model ? `openai-codex:${model}` : ""
  };
}

function modelHasConnectedProvider(model = {}, providers = []) {
  const current = objectOrEmpty(model);
  if (current.provider === "mia") return true;
  return providers.some((provider) => provider.hasApiKey && providerMatchesModel(provider, current));
}

const DEFAULT_CACHE_TTL_MS = 30 * 1000;

function createRuntimeStatusCoreSnapshot({
  coreRequest,
  authStatus = () => ({}),
  ttlMs = DEFAULT_CACHE_TTL_MS,
  now = Date.now
} = {}) {
  if (typeof coreRequest !== "function") throw new Error("coreRequest dependency is required.");
  const cacheTtlMs = Number.isFinite(Number(ttlMs)) ? Math.max(0, Number(ttlMs)) : DEFAULT_CACHE_TTL_MS;
  const nowMs = typeof now === "function" ? now : Date.now;

  let cache = null;
  let pending = null;
  let generation = 0;

  function freshCache() {
    if (!cache || cacheTtlMs <= 0) return null;
    return nowMs() < cache.expiresAt ? cache.value : null;
  }

  async function readCoreSnapshot({ force = false } = {}) {
    if (!force) {
      const fresh = freshCache();
      if (fresh) return fresh;
      if (pending) return pending;
    }

    const requestGeneration = generation;
    const current = Promise.all([
      coreRequest({ method: "GET", route: "/api/settings/client" }),
      coreRequest({ method: "GET", route: "/api/providers" })
    ]).then(([settingsResponse, providersResponse]) => {
      const value = { settingsResponse, providersResponse };
      if (generation === requestGeneration && cacheTtlMs > 0) {
        cache = {
          value,
          expiresAt: nowMs() + cacheTtlMs
        };
      }
      return value;
    }).finally(() => {
      if (pending === current) pending = null;
    });

    pending = current;
    return current;
  }

  async function apply(status = {}, options = {}) {
    let snapshot;
    try {
      snapshot = await readCoreSnapshot({ force: Boolean(options.force) });
    } catch {
      return status;
    }

    const model = compactModelFromClientSettings(snapshot.settingsResponse);
    const connectedProviders = coreProviderSummaries(snapshot.providersResponse, model, authStatus());
    return {
      ...status,
      model: {
        ...model,
        hasApiKey: modelHasConnectedProvider(model, connectedProviders)
      },
      connectedProviders
    };
  }

  function invalidate() {
    generation += 1;
    cache = null;
    pending = null;
  }

  return {
    apply,
    compactModelFromClientSettings,
    coreProviderSummaries,
    invalidate
  };
}

module.exports = {
  compactModelFromClientSettings,
  coreProviderSummaries,
  createRuntimeStatusCoreSnapshot,
  DEFAULT_CACHE_TTL_MS,
  providerSummaryFromCore,
  resolveCodexModelSelection
};
