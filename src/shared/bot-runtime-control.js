(function attachBotRuntimeControl(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaBotRuntimeControl = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function buildBotRuntimeControl() {
  function normalizeRuntimeKind(value, fallback = "cloud-claude-code") {
    const raw = String(value || "").trim();
    if (raw === "cloud-claude-code" || raw === "desktop-local") return raw;
    const normalizedFallback = String(fallback || "").trim();
    if (normalizedFallback === "cloud-claude-code" || normalizedFallback === "desktop-local") {
      return normalizedFallback;
    }
    return "";
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

  function normalizedField(field = "") {
    if (field === "effort") return "effortLevel";
    if (field === "permission") return "permissionMode";
    return field;
  }

  function runtimeControlModelEntriesIntent(entries = []) {
    return (Array.isArray(entries) ? entries : []).map((entry = {}) => {
      const normalized = {
        id: String(entry.id || "").trim(),
        value: String(entry.value || "").trim(),
        label: String(entry.label || "").trim(),
        model: String(entry.model || "").trim(),
        provider: String(entry.provider || entry.providerConnectionId || entry.provider_connection_id || "").trim(),
        providerLabel: String(entry.providerLabel || entry.provider_label || "").trim(),
        authType: String(entry.authType || entry.auth_type || "").trim(),
        modelProfileId: String(entry.modelProfileId || entry.model_profile_id || entry.profileId || entry.profile_id || "").trim(),
        profileId: String(entry.profileId || entry.profile_id || "").trim()
      };
      return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value));
    }).filter((entry) => entry.id || entry.value || entry.model);
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
    const normalized = normalizedField(field);
    if (!["model", "effortLevel", "permissionMode"].includes(normalized)) return { saved: false, binding: null };
    const controlIntent = {
      field: normalized,
      value: String(value || ""),
      modelEntries: normalized === "model" ? runtimeControlModelEntriesIntent(modelEntries) : []
    };
    const payload = await writeRuntime(api, key, {
      runtimeKind: kind,
      enabled: true,
      controlIntent
    });
    const binding = bindingFromPayload(payload) || {
      botId: key,
      runtimeKind: kind,
      enabled: true,
      controlIntent
    };
    cache?.set?.(runtimeCacheKey(key, kind), binding);
    return { saved: true, binding };
  }

  return {
    runtimeCacheKey,
    getBotRuntimeBinding,
    saveBotRuntimeControl,
    normalizeRuntimeKind
  };
});
