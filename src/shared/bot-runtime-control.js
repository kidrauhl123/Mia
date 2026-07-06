(function attachBotRuntimeControl(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaBotRuntimeControl = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function buildBotRuntimeControl() {
  function normalizeRuntimeKind(value, fallback = "cloud-claude-code") {
    const raw = String(value || fallback || "cloud-claude-code").trim();
    const kind = raw === "cloud-hermes" || raw === "cloud_hermes" ? "cloud-claude-code" : raw;
    return kind || fallback || "cloud-claude-code";
  }

  function botKeyFrom(options = {}) {
    const bot = options.bot || {};
    return String(options.botKey || options.botId || bot.key || bot.id || "").trim();
  }

  function runtimeCacheKey(botKey, runtimeKind = "cloud-claude-code") {
    return `${String(botKey || "").trim()}:${normalizeRuntimeKind(runtimeKind)}`;
  }

  function responsePayload(response) {
    if (response && response.ok === false) throw new Error(response.error || response.message || response.data?.error || "Bot runtime request failed");
    return response?.data || response || {};
  }

  function bindingFromPayload(payload) {
    return payload?.binding || payload?.data?.binding || null;
  }

  async function readRuntime(api, botKey, runtimeKind) {
    if (typeof api === "function") {
      return responsePayload(await api(`/api/me/bots/${encodeURIComponent(botKey)}/runtime?kind=${encodeURIComponent(runtimeKind)}`));
    }
    const runtimeApi = api?.social || api;
    if (typeof runtimeApi?.getBotRuntime === "function") {
      return responsePayload(await runtimeApi.getBotRuntime(botKey, runtimeKind));
    }
    throw new Error("Bot runtime read API is unavailable.");
  }

  async function writeRuntime(api, botKey, body) {
    if (typeof api === "function") {
      return responsePayload(await api(`/api/me/bots/${encodeURIComponent(botKey)}/runtime`, {
        method: "PUT",
        body
      }));
    }
    const runtimeApi = api?.social || api;
    if (typeof runtimeApi?.saveBotRuntime === "function") {
      return responsePayload(await runtimeApi.saveBotRuntime(botKey, body));
    }
    throw new Error("Bot runtime save API is unavailable.");
  }

  async function getBotRuntimeBinding({
    api,
    cache = null,
    botKey = "",
    botId = "",
    runtimeKind = "cloud-claude-code"
  } = {}) {
    const key = botKeyFrom({ botKey, botId });
    const kind = normalizeRuntimeKind(runtimeKind);
    if (!key) return null;
    const cacheKey = runtimeCacheKey(key, kind);
    if (cache?.has?.(cacheKey)) return cache.get(cacheKey);
    const payload = await readRuntime(api, key, kind);
    const binding = bindingFromPayload(payload);
    cache?.set?.(cacheKey, binding);
    return binding;
  }

  function modelEntryForValue(entries = [], value = "") {
    const wanted = String(value || "").trim();
    return (Array.isArray(entries) ? entries : [])
      .find((entry) => [entry?.id, entry?.value, entry?.model].some((item) => String(item || "").trim() === wanted)) || null;
  }

  function selectedModelFromEntry(entry, value) {
    if (entry && Object.prototype.hasOwnProperty.call(entry, "model")) return entry.model;
    return value;
  }

  function providerConnectionIdFromEntry(entry = {}) {
    return String(entry.providerConnectionId || entry.provider_connection_id || entry.provider || "").trim();
  }

  function modelProfileIdFromEntry(entry = {}, provider = "", model = "") {
    const explicit = String(entry.modelProfileId || entry.model_profile_id || entry.profileId || entry.profile_id || "").trim();
    if (explicit) return explicit;
    return provider && model ? `${provider}:${model}` : "";
  }

  function normalizedField(field = "") {
    if (field === "effort") return "effortLevel";
    if (field === "permission") return "permissionMode";
    return field;
  }

  function patchForRuntimeField(field, value, modelEntries = []) {
    const normalized = normalizedField(field);
    if (normalized === "model") {
      const entry = modelEntryForValue(modelEntries, value);
      const model = selectedModelFromEntry(entry, value);
      const providerConnectionId = providerConnectionIdFromEntry(entry);
      const modelProfileId = modelProfileIdFromEntry(entry, providerConnectionId, model);
      return {
        model,
        ...(providerConnectionId ? { providerConnectionId } : {}),
        ...(modelProfileId ? { modelProfileId } : {})
      };
    }
    if (normalized === "effortLevel" || normalized === "permissionMode") return { [normalized]: value };
    return {};
  }

  async function saveBotRuntimeConfig({
    api,
    cache = null,
    botKey = "",
    botId = "",
    runtimeKind = "cloud-claude-code",
    patch = {},
    current = undefined
  } = {}) {
    const key = botKeyFrom({ botKey, botId });
    const kind = normalizeRuntimeKind(runtimeKind);
    if (!key) return { saved: false, binding: null };
    const existing = current !== undefined
      ? current
      : await getBotRuntimeBinding({ api, cache, botKey: key, runtimeKind: kind });
    const base = existing || { botId: key, runtimeKind: kind, enabled: true, config: {} };
    const config = { ...(base.config || {}), ...(patch || {}) };
    const body = { runtimeKind: kind, enabled: true, config };
    const payload = await writeRuntime(api, key, body);
    const binding = bindingFromPayload(payload) || { ...base, runtimeKind: kind, enabled: true, config };
    cache?.set?.(runtimeCacheKey(key, kind), binding);
    return { saved: true, binding };
  }

  async function saveBotRuntimeControl({
    api,
    cache = null,
    bot = {},
    botKey = "",
    botId = "",
    runtimeKind = bot?.runtimeKind || bot?.runtime_kind || "cloud-claude-code",
    field = "",
    value = "",
    modelEntries = []
  } = {}) {
    const key = botKeyFrom({ bot, botKey, botId });
    const kind = normalizeRuntimeKind(runtimeKind);
    if (!key) return { saved: false, binding: null };
    const patch = patchForRuntimeField(field, value, modelEntries);
    if (!Object.keys(patch).length) return { saved: false, binding: null };
    return saveBotRuntimeConfig({ api, cache, botKey: key, runtimeKind: kind, patch });
  }

  return {
    runtimeCacheKey,
    getBotRuntimeBinding,
    saveBotRuntimeConfig,
    saveBotRuntimeControl,
    patchForRuntimeField,
    modelEntryForValue,
    normalizeRuntimeKind
  };
});
