(function attachBotCommands(global) {
  "use strict";

  function slugFromBotName(name) {
    return String(name || "bot")
      .trim()
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "bot";
  }

  function cloudBotKeyFromName(name, existingKeys = []) {
    const used = new Set(existingKeys.map((key) => String(key || "").trim()).filter(Boolean));
    const base = slugFromBotName(name);
    let key = base;
    let index = 2;
    while (used.has(key)) {
      key = `${base}_${index}`;
      index += 1;
    }
    return key;
  }

  function existingBotKeys(state = {}, social = {}) {
    const local = [
      ...(Array.isArray(state.runtime?.bots) ? state.runtime.bots : [])
    ];
    const cloud = social?.moduleState?.bots || [];
    return [...local, ...cloud].map((item) => String(item?.key || item?.id || "").trim()).filter(Boolean);
  }

  function botIdentity() {
    if (global.miaBotIdentity) return global.miaBotIdentity;
    if (typeof require === "function") {
      try { return require("../../shared/bot-identity.js"); } catch { /* fallback below */ }
    }
    return null;
  }

  function serializableCapabilities(value) {
    const normalizer = botIdentity()?.normalizeBotCapabilities;
    return typeof normalizer === "function"
      ? normalizer(value)
      : (value && typeof value === "object" ? value : { legacyCapabilities: ["chat", "files", "terminal", "code"] });
  }

  function conversationFromResult(result) {
    return result?.data?.conversation || result?.conversation || null;
  }

  function savedBotFromResult(result, fallback) {
    return result?.data?.bot || result?.bot || fallback;
  }

  async function saveCloudHermesBot({
    state = {},
    api = global.mia,
    social = global.miaSocial,
    bot = {},
    isCreate = false,
    cloudModelEntries = () => []
  } = {}) {
    if (!state.runtime?.cloud?.enabled || typeof api?.social?.saveBotIdentity !== "function") {
      throw new Error("请先登录 Mia Cloud。");
    }
    const key = bot.key || cloudBotKeyFromName(bot.name, existingBotKeys(state, social));
    const identity = {
      name: String(bot.name || "").trim(),
      avatarImage: bot.avatarImage || "",
      avatarCrop: bot.avatarCrop || null,
      color: bot.color || "",
      bio: bot.description || bot.bio || "",
      personaText: bot.personaText || bot.description || bot.bio || "",
      capabilities: serializableCapabilities(bot.capabilities)
    };
    const saved = await api.social.saveBotIdentity(key, identity);
    if (!saved?.ok) throw new Error(saved?.error || "创建云端 Bot 失败");
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
    const cloudBot = { ...savedBotFromResult(saved, identity), key, id: key };
    if (social?.moduleState) {
      const bots = Array.isArray(social.moduleState.bots) ? social.moduleState.bots : [];
      social.moduleState.bots = [
        cloudBot,
        ...bots.filter((item) => String(item?.key || item?.id || "") !== key)
      ];
    }
    const conversation = social?.upsertBotConversation?.(conversationFromResult(ensured)) || conversationFromResult(ensured);
    return { key, bot: cloudBot, conversation, runtime: state.runtime };
  }

  async function saveDesktopLocalBot({
    api = global.mia,
    bot = {}
  } = {}) {
    if (typeof api?.saveBot !== "function") throw new Error("本机 Bot 保存接口不可用。");
    const runtime = await api.saveBot(bot);
    const bots = runtime?.bots || [];
    const saved = bot.key
      ? bots.find((item) => item.key === bot.key)
      : [...bots].reverse().find((item) => item.name === String(bot.name || "").trim()) || bots[0];
    return { key: saved?.key || "", bot: saved || null, conversation: null, runtime };
  }

  async function saveBot(options = {}) {
    const runtimeKind = String(options.runtimeKind || "desktop-local").trim();
    if (runtimeKind === "cloud-hermes") return saveCloudHermesBot(options);
    return saveDesktopLocalBot(options);
  }

  async function deleteCloudHermesBot({
    state = {},
    api = global.mia,
    social = global.miaSocial,
    bot = {}
  } = {}) {
    const key = String(bot.key || bot.id || "").trim();
    if (!key) return { deleted: false, runtime: state.runtime };
    if (typeof api?.social?.deleteBot !== "function") throw new Error("云端 Bot 删除接口不可用。");
    const result = await api.social.deleteBot(key);
    if (result && result.ok === false) throw new Error(result.error || "删除云端 Bot 失败");
    if (social?.moduleState) {
      const bots = Array.isArray(social.moduleState.bots) ? social.moduleState.bots : [];
      social.moduleState.bots = bots
        .filter((item) => String(item?.key || item?.id || "") !== key);
    }
    await social?.bootstrapAfterLogin?.();
    return { deleted: true, runtime: state.runtime };
  }

  async function deleteDesktopLocalBot({
    state = {},
    api = global.mia,
    bot = {}
  } = {}) {
    const key = String(bot.key || bot.id || "").trim();
    if (!key) return { deleted: false, runtime: state.runtime };
    if (typeof api?.deleteBot !== "function") throw new Error("本机 Bot 删除接口不可用。");
    const runtime = await api.deleteBot({ key });
    return { deleted: true, runtime };
  }

  async function deleteBot(options = {}) {
    const bot = options.bot || {};
    if (bot.canDelete === false) return { deleted: false, runtime: options.state?.runtime };
    const runtimeKind = String(bot.runtimeKind || options.runtimeKind || "desktop-local").trim();
    if (runtimeKind === "cloud-hermes") return deleteCloudHermesBot(options);
    return deleteDesktopLocalBot(options);
  }

  function identityForCapabilities(bot = {}, capabilities) {
    return {
      name: bot.name || bot.key || bot.id,
      avatarImage: bot.avatarImage || "",
      avatarCrop: bot.avatarCrop || null,
      bio: bot.bio || bot.description || "",
      personaText: bot.personaText || "",
      capabilities
    };
  }

  async function saveCloudHermesBotCapabilities({
    state = {},
    api = global.mia,
    social = global.miaSocial,
    bot = {},
    capabilities = []
  } = {}) {
    const key = String(bot.key || bot.id || "").trim();
    if (!key) return { key: "", bot: null, runtime: state.runtime };
    if (typeof api?.social?.saveBotIdentity !== "function") throw new Error("云端 Bot 保存接口不可用。");
    const response = await api.social.saveBotIdentity(key, identityForCapabilities(bot, capabilities));
    if (response && response.ok === false) throw new Error(response.error || "保存云端 Bot 能力失败");
    const saved = savedBotFromResult(response, { ...bot, capabilities });
    const nextBot = { ...saved, key: saved.key || saved.id || key, id: saved.id || saved.key || key };
    if (social?.moduleState) {
      const bots = Array.isArray(social.moduleState.bots) ? social.moduleState.bots : [];
      social.moduleState.bots = [
        nextBot,
        ...bots.filter((item) => String(item?.key || item?.id || "") !== key)
      ];
    }
    return { key, bot: nextBot, runtime: state.runtime };
  }

  async function saveDesktopLocalBotCapabilities({
    api = global.mia,
    bot = {},
    capabilities = []
  } = {}) {
    const key = String(bot.key || bot.id || "").trim();
    if (!key) return { key: "", bot: null, runtime: null };
    if (typeof api?.saveBot !== "function") throw new Error("本机 Bot 保存接口不可用。");
    const runtime = await api.saveBot({ ...bot, capabilities });
    const bots = runtime?.bots || [];
    const saved = bots.find((item) => item.key === key || item.id === key) || null;
    return { key, bot: saved, runtime };
  }

  async function saveBotCapabilities(options = {}) {
    const bot = options.bot || {};
    const runtimeKind = String(bot.runtimeKind || options.runtimeKind || "desktop-local").trim();
    if (runtimeKind === "cloud-hermes") return saveCloudHermesBotCapabilities(options);
    return saveDesktopLocalBotCapabilities(options);
  }

  function runtimeCacheKey(botKey, runtimeKind = "cloud-hermes") {
    return `${botKey}:${runtimeKind}`;
  }

  async function getBotRuntimeBinding({
    api = global.mia,
    cache = null,
    botKey = "",
    runtimeKind = "cloud-hermes"
  } = {}) {
    const key = String(botKey || "").trim();
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

  async function saveBotRuntimeConfig({
    api = global.mia,
    cache = null,
    botKey = "",
    runtimeKind = "cloud-hermes",
    patch = {}
  } = {}) {
    const key = String(botKey || "").trim();
    const kind = String(runtimeKind || "cloud-hermes").trim();
    if (!key || kind !== "cloud-hermes") return { saved: false, binding: null };
    const current = await getBotRuntimeBinding({ api, cache, botKey: key, runtimeKind: kind }) || {
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
    bot = {},
    engineContracts = global?.miaEngineContracts,
    modelSettings = global?.miaModelSettings,
    engineOptions = global?.miaEngineOptions
  } = {}) {
    const runtime = state.runtime || {};
    const engine = normalizeAgentEngine(bot?.agentEngine || bot?.agent_engine || "hermes", engineContracts);
    const engineConfig = bot?.engineConfig || bot?.engine_config || {};
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

  async function syncDesktopLocalBotRuntimeBinding({
    api = global?.mia?.social,
    state = {},
    bot = {},
    engineContracts = global?.miaEngineContracts,
    modelSettings = global?.miaModelSettings,
    engineOptions = global?.miaEngineOptions
  } = {}) {
    const botKey = String(bot?.key || bot?.id || "").trim();
    if (!botKey || typeof api?.saveBotRuntime !== "function") return null;
    const body = {
      runtimeKind: "desktop-local",
      enabled: true,
      config: desktopLocalRuntimeConfig({ state, bot, engineContracts, modelSettings, engineOptions })
    };
    const response = await api.saveBotRuntime(botKey, body);
    if (response && response.ok === false) throw new Error(response.error || "保存本机 Bot 运行配置失败");
    return response?.data?.binding || response?.binding || { botId: botKey, ...body };
  }

  async function ensureDesktopLocalBotConversation({
    api = global?.mia?.social,
    state = {},
    bot = {},
    engineContracts = global?.miaEngineContracts,
    modelSettings = global?.miaModelSettings,
    engineOptions = global?.miaEngineOptions,
    onConversation = null
  } = {}) {
    const botKey = String(bot?.key || bot?.id || "").trim();
    if (!botKey || typeof api?.ensureBotSessionConversation !== "function") return { key: botKey, conversation: null, binding: null };
    const result = await api.ensureBotSessionConversation(botKey, {
      botId: botKey,
      title: bot.name || bot.displayName || botKey,
      runtimeKind: "desktop-local"
    });
    const binding = await syncDesktopLocalBotRuntimeBinding({
      api,
      state,
      bot: { ...bot, key: botKey },
      engineContracts,
      modelSettings,
      engineOptions
    });
    if (result && result.ok === false) throw new Error(result.error || result.message || result.data?.error || "创建本机 Bot 云端会话失败");
    const conversation = conversationFromResult(result);
    const savedConversation = conversation && typeof onConversation === "function" ? onConversation(conversation) : conversation;
    return { key: botKey, conversation: savedConversation || null, binding };
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

  async function saveDesktopLocalBotRuntimeControl({
    api = global?.mia,
    bot = {},
    field = "",
    value = "",
    modelEntries = [],
    engineContracts = global?.miaEngineContracts
  } = {}) {
    const key = String(bot?.key || bot?.id || "").trim();
    const engine = normalizeAgentEngine(bot?.agentEngine || bot?.agent_engine || "hermes", engineContracts);
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

  async function saveBotRuntimeControl({
    api = global?.mia,
    cache = null,
    bot = {},
    runtimeKind = bot?.runtimeKind || bot?.runtime_kind || "desktop-local",
    field = "",
    value = "",
    modelEntries = [],
    engineContracts = global?.miaEngineContracts
  } = {}) {
    const kind = String(runtimeKind || bot?.runtimeKind || bot?.runtime_kind || "desktop-local").trim();
    const key = String(bot?.key || bot?.id || "").trim();
    if (!key) return { saved: false, runtime: null, binding: null };
    if (kind === "cloud-hermes") {
      const patch = patchForRuntimeField(field, value, modelEntries);
      if (!Object.keys(patch).length) return { saved: false, binding: null };
      return saveBotRuntimeConfig({ api, cache, botKey: key, runtimeKind: kind, patch });
    }
    return saveDesktopLocalBotRuntimeControl({
      api,
      bot: { ...bot, key, runtimeKind: kind },
      field,
      value,
      modelEntries,
      engineContracts
    });
  }

  const api = {
    slugFromBotName,
    cloudBotKeyFromName,
    existingBotKeys,
    saveCloudHermesBot,
    saveDesktopLocalBot,
    saveBot,
    deleteCloudHermesBot,
    deleteDesktopLocalBot,
    deleteBot,
    saveCloudHermesBotCapabilities,
    saveDesktopLocalBotCapabilities,
    saveBotCapabilities,
    runtimeCacheKey,
    getBotRuntimeBinding,
    saveBotRuntimeConfig,
    desktopLocalRuntimeConfig,
    syncDesktopLocalBotRuntimeBinding,
    ensureDesktopLocalBotConversation,
    saveDesktopLocalBotRuntimeControl,
    saveBotRuntimeControl
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  if (global) global.miaBotCommands = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null));
