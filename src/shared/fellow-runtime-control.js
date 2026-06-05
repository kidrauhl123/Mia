(function attachFellowRuntimeControl(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaFellowRuntimeControl = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function buildFellowRuntimeControl() {
  function normalizeRuntimeKind(value, fallback = "cloud-hermes") {
    const kind = String(value || fallback || "cloud-hermes").trim();
    return kind || fallback || "cloud-hermes";
  }

  function fellowKeyFrom(options = {}) {
    const fellow = options.fellow || {};
    const bot = options.bot || {};
    return String(options.botKey || options.botId || bot.key || bot.id || options.fellowKey || fellow.key || fellow.id || fellow.fellowId || "").trim();
  }

  function runtimeCacheKey(fellowKey, runtimeKind = "cloud-hermes") {
    return `${String(fellowKey || "").trim()}:${normalizeRuntimeKind(runtimeKind)}`;
  }

  function responsePayload(response) {
    if (response && response.ok === false) throw new Error(response.error || response.message || response.data?.error || "Fellow runtime request failed");
    return response?.data || response || {};
  }

  function bindingFromPayload(payload) {
    return payload?.binding || payload?.data?.binding || null;
  }

  async function readRuntime(api, fellowKey, runtimeKind) {
    if (typeof api === "function") {
      return responsePayload(await api(`/api/me/bots/${encodeURIComponent(fellowKey)}/runtime?kind=${encodeURIComponent(runtimeKind)}`));
    }
    const runtimeApi = api?.social || api;
    if (typeof runtimeApi?.getBotRuntime === "function") {
      return responsePayload(await runtimeApi.getBotRuntime(fellowKey, runtimeKind));
    }
    if (typeof runtimeApi?.getFellowRuntime === "function") {
      return responsePayload(await runtimeApi.getFellowRuntime(fellowKey, runtimeKind));
    }
    throw new Error("Fellow runtime read API is unavailable.");
  }

  async function writeRuntime(api, fellowKey, body) {
    if (typeof api === "function") {
      return responsePayload(await api(`/api/me/bots/${encodeURIComponent(fellowKey)}/runtime`, {
        method: "PUT",
        body
      }));
    }
    const runtimeApi = api?.social || api;
    if (typeof runtimeApi?.saveBotRuntime === "function") {
      return responsePayload(await runtimeApi.saveBotRuntime(fellowKey, body));
    }
    if (typeof runtimeApi?.saveFellowRuntime === "function") {
      return responsePayload(await runtimeApi.saveFellowRuntime(fellowKey, body));
    }
    throw new Error("Fellow runtime save API is unavailable.");
  }

  async function getFellowRuntimeBinding({
    api,
    cache = null,
    fellowKey = "",
    runtimeKind = "cloud-hermes"
  } = {}) {
    const key = String(fellowKey || "").trim();
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

  function normalizedField(field = "") {
    if (field === "effort") return "effortLevel";
    if (field === "permission") return "permissionMode";
    return field;
  }

  function patchForRuntimeField(field, value, modelEntries = []) {
    const normalized = normalizedField(field);
    if (normalized === "model") {
      const entry = modelEntryForValue(modelEntries, value);
      return { model: selectedModelFromEntry(entry, value) };
    }
    if (normalized === "effortLevel" || normalized === "permissionMode") return { [normalized]: value };
    return {};
  }

  async function saveFellowRuntimeConfig({
    api,
    cache = null,
    fellowKey = "",
    runtimeKind = "cloud-hermes",
    patch = {},
    current = undefined
  } = {}) {
    const key = String(fellowKey || "").trim();
    const kind = normalizeRuntimeKind(runtimeKind);
    if (!key) return { saved: false, binding: null };
    const existing = current !== undefined
      ? current
      : await getFellowRuntimeBinding({ api, cache, fellowKey: key, runtimeKind: kind });
    const base = existing || { botId: key, runtimeKind: kind, enabled: true, config: {} };
    const config = { ...(base.config || {}), ...(patch || {}) };
    const body = { runtimeKind: kind, enabled: true, config };
    const payload = await writeRuntime(api, key, body);
    const binding = bindingFromPayload(payload) || { ...base, runtimeKind: kind, enabled: true, config };
    cache?.set?.(runtimeCacheKey(key, kind), binding);
    return { saved: true, binding };
  }

  async function saveFellowRuntimeControl({
    api,
    cache = null,
    bot = {},
    botKey = "",
    botId = "",
    fellow = {},
    fellowKey = "",
    runtimeKind = bot?.runtimeKind || bot?.runtime_kind || fellow?.runtimeKind || fellow?.runtime_kind || "cloud-hermes",
    field = "",
    value = "",
    modelEntries = []
  } = {}) {
    const key = fellowKeyFrom({ bot, botKey, botId, fellow, fellowKey });
    const kind = normalizeRuntimeKind(runtimeKind);
    if (!key) return { saved: false, binding: null };
    const patch = patchForRuntimeField(field, value, modelEntries);
    if (!Object.keys(patch).length) return { saved: false, binding: null };
    return saveFellowRuntimeConfig({ api, cache, fellowKey: key, runtimeKind: kind, patch });
  }

  return {
    runtimeCacheKey,
    getFellowRuntimeBinding,
    saveFellowRuntimeConfig,
    saveFellowRuntimeControl,
    patchForRuntimeField,
    modelEntryForValue,
    normalizeRuntimeKind
  };
});
