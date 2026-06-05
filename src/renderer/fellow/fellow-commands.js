(function attachFellowCommands(global) {
  "use strict";

  function slugFromFellowName(name) {
    return String(name || "fellow")
      .trim()
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "fellow";
  }

  function cloudFellowKeyFromName(name, existingKeys = []) {
    const used = new Set(existingKeys.map((key) => String(key || "").trim()).filter(Boolean));
    const base = slugFromFellowName(name);
    let key = base;
    let index = 2;
    while (used.has(key)) {
      key = `${base}_${index}`;
      index += 1;
    }
    return key;
  }

  function existingFellowKeys(state = {}, social = {}) {
    const local = [
      ...(Array.isArray(state.runtime?.fellows) ? state.runtime.fellows : []),
      ...(Array.isArray(state.runtime?.personas) ? state.runtime.personas : [])
    ];
    const cloud = social?.moduleState?.fellows || [];
    return [...local, ...cloud].map((item) => String(item?.key || item?.id || "").trim()).filter(Boolean);
  }

  function fellowIdentity() {
    if (global.miaFellowIdentity) return global.miaFellowIdentity;
    if (typeof require === "function") {
      try { return require("../../shared/fellow-identity.js"); } catch { /* fallback below */ }
    }
    return null;
  }

  function serializableCapabilities(value) {
    const normalizer = fellowIdentity()?.normalizeFellowCapabilities;
    return typeof normalizer === "function"
      ? normalizer(value)
      : (value && typeof value === "object" ? value : { legacyCapabilities: ["chat", "files", "terminal", "code"] });
  }

  function conversationFromResult(result) {
    return result?.data?.conversation || result?.conversation || null;
  }

  function savedFellowFromResult(result, fallback) {
    return result?.data?.bot || result?.bot || fallback;
  }

  async function saveCloudHermesFellow({
    state = {},
    api = global.mia,
    social = global.miaSocial,
    fellow = {},
    isCreate = false,
    cloudModelEntries = () => []
  } = {}) {
    if (!state.runtime?.cloud?.enabled || typeof api?.social?.saveBotIdentity !== "function") {
      throw new Error("请先登录 Mia Cloud。");
    }
    const key = fellow.key || cloudFellowKeyFromName(fellow.name, existingFellowKeys(state, social));
    const identity = {
      name: String(fellow.name || "").trim(),
      avatarImage: fellow.avatarImage || "",
      avatarCrop: fellow.avatarCrop || null,
      color: fellow.color || "",
      bio: fellow.description || fellow.bio || "",
      personaText: fellow.personaText || fellow.description || fellow.bio || "",
      capabilities: serializableCapabilities(fellow.capabilities)
    };
    const saved = await api.social.saveBotIdentity(key, identity);
    if (!saved?.ok) throw new Error(saved?.error || "创建云端 Fellow 失败");
    if (isCreate) {
      const runtime = await api.social.saveBotRuntime(key, {
        runtimeKind: "cloud-hermes",
        enabled: true,
        config: {
          model: cloudModelEntries()[0]?.id || "mia-default",
          effortLevel: "medium",
          permissionMode: "ask"
        }
      });
      if (!runtime?.ok) throw new Error(runtime?.error || "保存云端运行配置失败");
    }
    const ensured = await api.social.ensureBotSessionConversation(key, {
      botId: key,
      title: identity.name || key,
      runtimeKind: "cloud-hermes"
    });
    if (!ensured?.ok) throw new Error(ensured?.error || "创建云端会话失败");
    const cloudFellow = { ...savedFellowFromResult(saved, identity), key, id: key };
    if (social?.moduleState) {
      social.moduleState.fellows = [
        cloudFellow,
        ...social.moduleState.fellows.filter((item) => String(item?.key || item?.id || "") !== key)
      ];
    }
    const conversation = social?.upsertFellowConversation?.(conversationFromResult(ensured)) || conversationFromResult(ensured);
    return { key, fellow: cloudFellow, conversation, runtime: state.runtime };
  }

  async function saveDesktopLocalFellow({
    api = global.mia,
    fellow = {}
  } = {}) {
    if (typeof api?.saveBot !== "function") throw new Error("本机 Bot 保存接口不可用。");
    const runtime = await api.saveBot(fellow);
    const fellows = runtime?.fellows || runtime?.personas || [];
    const saved = fellow.key
      ? fellows.find((item) => item.key === fellow.key)
      : [...fellows].reverse().find((item) => item.name === String(fellow.name || "").trim()) || fellows[0];
    return { key: saved?.key || "", fellow: saved || null, conversation: null, runtime };
  }

  async function saveFellow(options = {}) {
    const runtimeKind = String(options.runtimeKind || "desktop-local").trim();
    if (runtimeKind === "cloud-hermes") return saveCloudHermesFellow(options);
    return saveDesktopLocalFellow(options);
  }

  async function deleteCloudHermesFellow({
    state = {},
    api = global.mia,
    social = global.miaSocial,
    fellow = {}
  } = {}) {
    const key = String(fellow.key || fellow.id || "").trim();
    if (!key) return { deleted: false, runtime: state.runtime };
    if (typeof api?.social?.deleteBot !== "function") throw new Error("云端 Bot 删除接口不可用。");
    const result = await api.social.deleteBot(key);
    if (result && result.ok === false) throw new Error(result.error || "删除云端 Fellow 失败");
    if (social?.moduleState) {
      social.moduleState.fellows = social.moduleState.fellows
        .filter((item) => String(item?.key || item?.id || "") !== key);
    }
    await social?.bootstrapAfterLogin?.();
    return { deleted: true, runtime: state.runtime };
  }

  async function deleteDesktopLocalFellow({
    state = {},
    api = global.mia,
    fellow = {}
  } = {}) {
    const key = String(fellow.key || fellow.id || "").trim();
    if (!key) return { deleted: false, runtime: state.runtime };
    if (typeof api?.deleteBot !== "function") throw new Error("本机 Bot 删除接口不可用。");
    const runtime = await api.deleteBot({ key });
    return { deleted: true, runtime };
  }

  async function deleteFellow(options = {}) {
    const fellow = options.fellow || {};
    if (fellow.canDelete === false) return { deleted: false, runtime: options.state?.runtime };
    const runtimeKind = String(fellow.runtimeKind || options.runtimeKind || "desktop-local").trim();
    if (runtimeKind === "cloud-hermes") return deleteCloudHermesFellow(options);
    return deleteDesktopLocalFellow(options);
  }

  function identityForCapabilities(fellow = {}, capabilities) {
    return {
      name: fellow.name || fellow.key || fellow.id,
      avatarImage: fellow.avatarImage || "",
      avatarCrop: fellow.avatarCrop || null,
      bio: fellow.bio || fellow.description || "",
      personaText: fellow.personaText || "",
      capabilities
    };
  }

  async function saveCloudHermesFellowCapabilities({
    state = {},
    api = global.mia,
    social = global.miaSocial,
    fellow = {},
    capabilities = []
  } = {}) {
    const key = String(fellow.key || fellow.id || "").trim();
    if (!key) return { key: "", fellow: null, runtime: state.runtime };
    if (typeof api?.social?.saveBotIdentity !== "function") throw new Error("云端 Bot 保存接口不可用。");
    const response = await api.social.saveBotIdentity(key, identityForCapabilities(fellow, capabilities));
    if (response && response.ok === false) throw new Error(response.error || "保存云端 Fellow 能力失败");
    const saved = savedFellowFromResult(response, { ...fellow, capabilities });
    const nextFellow = { ...saved, key: saved.key || saved.id || key, id: saved.id || saved.key || key };
    if (social?.moduleState) {
      social.moduleState.fellows = [
        nextFellow,
        ...social.moduleState.fellows.filter((item) => String(item?.key || item?.id || "") !== key)
      ];
    }
    return { key, fellow: nextFellow, runtime: state.runtime };
  }

  async function saveDesktopLocalFellowCapabilities({
    api = global.mia,
    fellow = {},
    capabilities = []
  } = {}) {
    const key = String(fellow.key || fellow.id || "").trim();
    if (!key) return { key: "", fellow: null, runtime: null };
    if (typeof api?.saveBot !== "function") throw new Error("本机 Bot 保存接口不可用。");
    const runtime = await api.saveBot({ ...fellow, capabilities });
    const fellows = runtime?.fellows || runtime?.personas || [];
    const saved = fellows.find((item) => item.key === key || item.id === key) || null;
    return { key, fellow: saved, runtime };
  }

  async function saveFellowCapabilities(options = {}) {
    const fellow = options.fellow || {};
    const runtimeKind = String(fellow.runtimeKind || options.runtimeKind || "desktop-local").trim();
    if (runtimeKind === "cloud-hermes") return saveCloudHermesFellowCapabilities(options);
    return saveDesktopLocalFellowCapabilities(options);
  }

  function runtimeCacheKey(fellowKey, runtimeKind = "cloud-hermes") {
    return `${fellowKey}:${runtimeKind}`;
  }

  async function getFellowRuntimeBinding({
    api = global.mia,
    cache = null,
    fellowKey = "",
    runtimeKind = "cloud-hermes"
  } = {}) {
    const key = String(fellowKey || "").trim();
    const kind = String(runtimeKind || "cloud-hermes").trim();
    if (!key || kind !== "cloud-hermes") return null;
    const cacheKey = runtimeCacheKey(key, kind);
    if (cache?.has?.(cacheKey)) return cache.get(cacheKey);
    if (typeof api?.social?.getBotRuntime !== "function") throw new Error("云端 Bot 运行配置读取接口不可用。");
    const response = await api.social.getBotRuntime(key, kind);
    if (!response?.ok) throw new Error(response?.error || "读取云端运行配置失败");
    const binding = response.data?.binding || null;
    cache?.set?.(cacheKey, binding);
    return binding;
  }

  async function saveFellowRuntimeConfig({
    api = global.mia,
    cache = null,
    fellowKey = "",
    runtimeKind = "cloud-hermes",
    patch = {}
  } = {}) {
    const key = String(fellowKey || "").trim();
    const kind = String(runtimeKind || "cloud-hermes").trim();
    if (!key || kind !== "cloud-hermes") return { saved: false, binding: null };
    const current = await getFellowRuntimeBinding({ api, cache, fellowKey: key, runtimeKind: kind }) || {
      botId: key,
      runtimeKind: kind,
      enabled: true,
      config: {}
    };
    if (typeof api?.social?.saveBotRuntime !== "function") throw new Error("云端 Bot 运行配置保存接口不可用。");
    const response = await api.social.saveBotRuntime(key, {
      runtimeKind: kind,
      enabled: true,
      config: { ...(current.config || {}), ...(patch || {}) }
    });
    if (!response?.ok) throw new Error(response?.error || "保存云端运行配置失败");
    const binding = response.data?.binding || {
      ...current,
      runtimeKind: kind,
      enabled: true,
      config: { ...(current.config || {}), ...(patch || {}) }
    };
    cache?.set?.(runtimeCacheKey(key, kind), binding);
    return { saved: true, binding };
  }

  function normalizeAgentEngine(value, engineContracts = global?.miaEngineContracts) {
    const normalizer = engineContracts?.normalizeAgentEngine;
    if (typeof normalizer === "function") return normalizer(value);
    const id = String(value || "hermes").trim().toLowerCase().replace(/_/g, "-");
    if (id === "claude" || id === "claude-code") return "claude-code";
    if (id === "codex" || id === "openai-codex") return "codex";
    return "hermes";
  }

  function normalizeModelEntry(entry = {}, fallbackProvider = "") {
    return {
      value: String(entry.model || entry.id || entry.value || "").trim(),
      label: String(entry.label || entry.model || entry.id || entry.value || "Default").trim(),
      model: String(entry.model || "").trim(),
      provider: String(entry.provider || fallbackProvider || "").trim(),
      providerLabel: String(entry.providerLabel || entry.provider_label || "").trim()
    };
  }

  function localHermesModelEntries(runtime = {}, modelSettings = global?.miaModelSettings) {
    const entries = typeof modelSettings?.connectedModelEntries === "function"
      ? modelSettings.connectedModelEntries(runtime)
      : [];
    return (Array.isArray(entries) ? entries : [])
      .map((entry) => normalizeModelEntry(entry))
      .filter((entry) => entry.value);
  }

  function externalModelEntries(engine, engineOptions = global?.miaEngineOptions) {
    const entries = typeof engineOptions?.externalModelEntries === "function"
      ? engineOptions.externalModelEntries(engine)
      : [];
    return (Array.isArray(entries) ? entries : [])
      .map((entry) => normalizeModelEntry(entry, engine))
      .filter((entry) => entry.value || entry.model === "");
  }

  function desktopLocalRuntimeConfig({
    state = {},
    fellow = {},
    engineContracts = global?.miaEngineContracts,
    modelSettings = global?.miaModelSettings,
    engineOptions = global?.miaEngineOptions
  } = {}) {
    const runtime = state.runtime || {};
    const engine = normalizeAgentEngine(fellow?.agentEngine || fellow?.agent_engine || "hermes", engineContracts);
    const engineConfig = fellow?.engineConfig || fellow?.engine_config || {};
    const config = { agentEngine: engine };
    if (engine === "claude-code" || engine === "codex") {
      config.model = String(engineConfig.model || "").trim();
      config.effortLevel = String(engineConfig.effortLevel || "medium").trim();
      config.permissionMode = String(engineConfig.permissionMode || "default").trim();
      config.modelEntries = externalModelEntries(engine, engineOptions);
      return config;
    }
    config.model = String(runtime.model?.model || "").trim();
    config.effortLevel = String(runtime.effort?.level || "medium").trim();
    config.permissionMode = String(runtime.permissions?.mode || "ask").trim();
    config.modelEntries = localHermesModelEntries(runtime, modelSettings);
    return config;
  }

  async function syncDesktopLocalFellowRuntimeBinding({
    api = global?.mia?.social,
    state = {},
    fellow = {},
    engineContracts = global?.miaEngineContracts,
    modelSettings = global?.miaModelSettings,
    engineOptions = global?.miaEngineOptions
  } = {}) {
    const fellowKey = String(fellow?.key || fellow?.id || "").trim();
    if (!fellowKey || typeof api?.saveBotRuntime !== "function") return null;
    const body = {
      runtimeKind: "desktop-local",
      enabled: true,
      config: desktopLocalRuntimeConfig({ state, fellow, engineContracts, modelSettings, engineOptions })
    };
    const response = await api.saveBotRuntime(fellowKey, body);
    if (response && response.ok === false) throw new Error(response.error || "保存本机 Fellow 运行配置失败");
    return response?.data?.binding || response?.binding || { botId: fellowKey, ...body };
  }

  async function ensureDesktopLocalFellowConversation({
    api = global?.mia?.social,
    state = {},
    fellow = {},
    engineContracts = global?.miaEngineContracts,
    modelSettings = global?.miaModelSettings,
    engineOptions = global?.miaEngineOptions,
    onConversation = null
  } = {}) {
    const fellowKey = String(fellow?.key || fellow?.id || "").trim();
    if (!fellowKey || typeof api?.ensureBotSessionConversation !== "function") return { key: fellowKey, conversation: null, binding: null };
    const result = await api.ensureBotSessionConversation(fellowKey, {
      botId: fellowKey,
      title: fellow.name || fellow.displayName || fellowKey,
      runtimeKind: "desktop-local"
    });
    const binding = await syncDesktopLocalFellowRuntimeBinding({
      api,
      state,
      fellow: { ...fellow, key: fellowKey },
      engineContracts,
      modelSettings,
      engineOptions
    });
    if (result && result.ok === false) throw new Error(result.error || result.message || result.data?.error || "创建本机 Fellow 云端会话失败");
    const conversation = conversationFromResult(result);
    const savedConversation = conversation && typeof onConversation === "function" ? onConversation(conversation) : conversation;
    return { key: fellowKey, conversation: savedConversation || null, binding };
  }

  function modelEntryForValue(entries = [], value = "") {
    const wanted = String(value || "").trim();
    return (Array.isArray(entries) ? entries : [])
      .find((entry) => [entry?.id, entry?.value, entry?.model].some((item) => String(item || "").trim() === wanted)) || null;
  }

  function patchForRuntimeField(field, value, modelEntries = []) {
    if (field === "model") {
      const entry = modelEntryForValue(modelEntries, value);
      return { model: entry?.model ?? value };
    }
    if (field === "effortLevel" || field === "permissionMode") return { [field]: value };
    return {};
  }

  async function saveDesktopLocalFellowRuntimeControl({
    api = global?.mia,
    fellow = {},
    field = "",
    value = "",
    modelEntries = [],
    engineContracts = global?.miaEngineContracts
  } = {}) {
    const key = String(fellow?.key || fellow?.id || "").trim();
    const engine = normalizeAgentEngine(fellow?.agentEngine || fellow?.agent_engine || "hermes", engineContracts);
    if (!key) return { saved: false, runtime: null };

    if (engine === "claude-code" || engine === "codex") {
      if (typeof api?.saveBotEngine !== "function") return { saved: false, runtime: null };
      const engineConfig = patchForRuntimeField(field, value, modelEntries);
      if (!Object.keys(engineConfig).length) return { saved: false, runtime: null };
      const runtime = await api.saveBotEngine({
        key,
        agentEngine: engine,
        engineConfig
      });
      return { saved: true, runtime };
    }

    if (field === "model") {
      const entry = modelEntryForValue(modelEntries, value);
      if (!entry || typeof api?.saveModel !== "function") return { saved: false, runtime: null };
      const runtime = await api.saveModel({
        provider: entry.provider,
        model: entry.model,
        apiKeyEnv: entry.apiKeyEnv,
        baseUrl: entry.baseUrl,
        apiMode: entry.apiMode,
        providerLabel: entry.providerLabel,
        authType: entry.authType
      });
      return { saved: true, runtime };
    }
    if (field === "effortLevel") {
      if (typeof api?.saveEffort !== "function") return { saved: false, runtime: null };
      const runtime = await api.saveEffort({ level: value });
      return { saved: true, runtime };
    }
    if (field === "permissionMode") {
      if (typeof api?.savePermissions !== "function") return { saved: false, runtime: null };
      const runtime = await api.savePermissions({ mode: value });
      return { saved: true, runtime };
    }
    return { saved: false, runtime: null };
  }

  async function saveFellowRuntimeControl({
    api = global?.mia,
    cache = null,
    fellow = {},
    runtimeKind = fellow?.runtimeKind || fellow?.runtime_kind || "desktop-local",
    field = "",
    value = "",
    modelEntries = [],
    engineContracts = global?.miaEngineContracts
  } = {}) {
    const kind = String(runtimeKind || fellow?.runtimeKind || fellow?.runtime_kind || "desktop-local").trim();
    const key = String(fellow?.key || fellow?.id || "").trim();
    if (!key) return { saved: false, runtime: null, binding: null };
    if (kind === "cloud-hermes") {
      const patch = patchForRuntimeField(field, value, modelEntries);
      if (!Object.keys(patch).length) return { saved: false, binding: null };
      return saveFellowRuntimeConfig({ api, cache, fellowKey: key, runtimeKind: kind, patch });
    }
    return saveDesktopLocalFellowRuntimeControl({
      api,
      fellow: { ...fellow, key, runtimeKind: kind },
      field,
      value,
      modelEntries,
      engineContracts
    });
  }

  const api = {
    slugFromFellowName,
    cloudFellowKeyFromName,
    existingFellowKeys,
    saveCloudHermesFellow,
    saveDesktopLocalFellow,
    saveFellow,
    deleteCloudHermesFellow,
    deleteDesktopLocalFellow,
    deleteFellow,
    saveCloudHermesFellowCapabilities,
    saveDesktopLocalFellowCapabilities,
    saveFellowCapabilities,
    runtimeCacheKey,
    getFellowRuntimeBinding,
    saveFellowRuntimeConfig,
    desktopLocalRuntimeConfig,
    syncDesktopLocalFellowRuntimeBinding,
    ensureDesktopLocalFellowConversation,
    saveDesktopLocalFellowRuntimeControl,
    saveFellowRuntimeControl
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  if (global) global.miaFellowCommands = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null));
