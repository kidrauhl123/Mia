(function attachBotCommands(global) {
  "use strict";

  function idsApi() {
    if (global?.miaIds) return global.miaIds;
    if (typeof require === "function") {
      try { return require("../../shared/ids.js"); } catch { /* browser fallback below */ }
    }
    return null;
  }

  function generateUntypedBotId(existingKeys = []) {
    const used = new Set(existingKeys.map((key) => String(key || "").trim()).filter(Boolean));
    const generate = idsApi()?.generatePrincipalId;
    if (typeof generate !== "function") throw new Error("无法生成 Bot 账号 ID。");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const id = String(generate() || "").trim();
      if (id && !used.has(id)) return id;
    }
    throw new Error("无法生成 Bot 账号 ID。");
  }

  function existingBotKeys(state = {}, social = {}) {
    const cloud = social?.moduleState?.bots || [];
    return [...cloud].map((item) => String(item?.key || item?.id || "").trim()).filter(Boolean);
  }

  function compactDeviceName(value = "") {
    return String(value || "")
      .trim()
      .replace(/\s*(?:·|-)?\s*Mia\s+(?:Desktop|Bridge)(?=\s*(?:·|-|$))/gi, "")
      .replace(/\.local(?=\s|$)/gi, "")
      .replace(/\s*(?:·|-)\s*(?:本机|在线|离线)\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  const LEGACY_RUNTIME_MODEL_FIELDS = [
    "provider",
    "modelProvider",
    "providerLabel",
    "authType",
    "apiKeyEnv",
    "baseUrl",
    "apiMode",
    "provider_label",
    "model_provider",
    "model_profile_id",
    "auth_type",
    "api_key_env",
    "base_url",
    "api_mode"
  ];
  const ENGINE_IDENTITY_NAMES = ["Claude Code", "Codex", "OpenClaw", "Hermes"];

  function botIdentity() {
    if (global.miaBotIdentity) return global.miaBotIdentity;
    if (typeof require === "function") {
      try { return require("../../shared/bot-identity.js"); } catch { /* fallback below */ }
    }
    return null;
  }

  function botDirectory() {
    if (global?.miaBotDirectory) return global.miaBotDirectory;
    if (typeof require === "function") {
      try { return require("./bot-directory.js"); } catch { /* fallback below */ }
    }
    return null;
  }

  function serializableCapabilities(value) {
    const normalizer = botIdentity()?.normalizeBotCapabilities;
    return typeof normalizer === "function"
      ? normalizer(value)
      : (value && typeof value === "object" ? value : { legacyCapabilities: ["chat", "files", "terminal", "code"] });
  }

  function escapeRegExp(value = "") {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function normalizedIdentityName(value = "") {
    return String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
  }

  function stripCopiedEngineIdentity(text = "", name = "") {
    let output = String(text || "").trim();
    if (!output) return "";
    const botName = normalizedIdentityName(name);
    for (const engineName of ENGINE_IDENTITY_NAMES) {
      if (normalizedIdentityName(engineName) === botName) continue;
      const escaped = escapeRegExp(engineName).replace(/\s+/g, "\\s+");
      output = output
        .replace(new RegExp(`^\\s*(?:你是|你叫|你的名字是)\\s*${escaped}\\s*[。.!！]?\\s*`, "i"), "")
        .replace(new RegExp(`^\\s*(?:You are|Your name is)\\s+${escaped}\\s*[。.!！]?\\s*`, "i"), "");
    }
    return output.trim();
  }

  function conversationFromResult(result) {
    return result?.data?.conversation || result?.conversation || null;
  }

  function savedBotFromResult(result, fallback) {
    return result?.data?.bot || result?.bot || fallback;
  }

  function cloudIdentityForBot(bot = {}) {
    const name = String(bot.name || bot.displayName || bot.key || bot.id || "").trim();
    return {
      name,
      avatarImage: bot.avatarImage || "",
      avatarCrop: bot.avatarCrop || null,
      color: bot.color || bot.avatarColor || bot.avatar_color || "",
      statusBadge: Object.prototype.hasOwnProperty.call(bot, "statusBadge") ? bot.statusBadge : (bot.status_badge || null),
      bio: bot.description || bot.bio || "",
      personaText: bot.personaText || bot.persona_text || bot.description || bot.bio || "",
      capabilities: serializableCapabilities(bot.capabilities)
    };
  }

  function cloudHermesIdentityForBot(bot = {}) {
    const identity = cloudIdentityForBot(bot);
    return {
      ...identity,
      bio: stripCopiedEngineIdentity(identity.bio, identity.name),
      personaText: stripCopiedEngineIdentity(identity.personaText, identity.name)
    };
  }

  function sourceKinds(bot = {}) {
    const fromDirectory = botDirectory()?.sourceKinds;
    if (typeof fromDirectory === "function") return fromDirectory(bot);
    const raw = Array.isArray(bot.sourceKinds)
      ? bot.sourceKinds
      : (bot.sourceKind || bot.source_kind ? [bot.sourceKind || bot.source_kind] : []);
    return [...new Set(raw.map((item) => String(item || "").trim()).filter(Boolean))];
  }

  function canUseCloudIdentity({ state = {}, api = global.mia } = {}) {
    return Boolean(state.runtime?.cloud?.enabled && typeof api?.social?.saveBotIdentity === "function");
  }

  function cloudRuntimeDefaults({
    current = null,
    cloudModelEntries = () => []
  } = {}) {
    const existing = current?.config && typeof current.config === "object" ? current.config : {};
    return {
      model: existing.model || cloudModelEntries()[0]?.id || "mia-auto",
      effortLevel: existing.effortLevel || "medium",
      permissionMode: existing.permissionMode || "ask"
    };
  }

  async function saveBotRuntimeTarget({
    state = {},
    api = global.mia,
    social = global.miaSocial,
    bot = {},
    isCreate = false,
    runtimeKind = bot?.runtimeKind || bot?.runtime_kind || "desktop-local",
    targetDeviceId = bot?.targetDeviceId || bot?.target_device_id || bot?.deviceId || bot?.device_id || "",
    targetDeviceName = bot?.targetDeviceName || bot?.target_device_name || bot?.deviceName || bot?.device_name || "",
    agentEngine = bot?.agentEngine || bot?.agent_engine || "hermes",
    cloudModelEntries = () => [],
    engineContracts = global?.miaEngineContracts,
    modelSettings = global?.miaModelSettings,
    engineOptions = global?.miaEngineOptions
  } = {}) {
    const explicitKey = String(bot.key || bot.id || "").trim();
    const key = explicitKey || (isCreate ? generateUntypedBotId(existingBotKeys(state, social)) : "");
    const kind = String(runtimeKind || "desktop-local").trim() === "cloud-hermes" ? "cloud-hermes" : "desktop-local";
    if (!key) return { saved: false, binding: null, conversation: null };
    if (!state.runtime?.cloud?.enabled || typeof api?.social?.saveBotIdentity !== "function") {
      throw new Error("请先登录 Mia Cloud。");
    }
    const identity = kind === "cloud-hermes"
      ? cloudHermesIdentityForBot({ ...bot, key })
      : cloudIdentityForBot({ ...bot, key });
    const saved = await api.social.saveBotIdentity(key, identity);
    if (saved && saved.ok === false) throw new Error(saved.error || "保存 Bot 身份失败");

    let config;
    if (kind === "cloud-hermes") {
      let current = null;
      try {
        current = typeof api.social.getBotRuntime === "function"
          ? (await api.social.getBotRuntime(key, "cloud-hermes"))?.data?.binding
          : null;
      } catch {
        current = null;
      }
      config = cloudRuntimeDefaults({ current, cloudModelEntries });
    } else {
      config = desktopLocalRuntimeConfig({
        state,
        bot: {
          ...bot,
          key,
          agentEngine,
          targetDeviceId,
          targetDeviceName
        },
        engineContracts,
        modelSettings,
        engineOptions
      });
    }

    if (typeof api?.social?.saveBotRuntime !== "function") throw new Error("Bot 运行绑定保存接口不可用。");
    const runtime = await api.social.saveBotRuntime(key, {
      runtimeKind: kind,
      enabled: true,
      activate: true,
      config
    });
    if (runtime && runtime.ok === false) throw new Error(runtime.error || "保存 Bot 运行设置失败");
    const ensured = await api.social.ensureBotSessionConversation?.(key, {
      botId: key,
      title: identity.name || key,
      runtimeKind: kind
    });
    if (ensured && ensured.ok === false) throw new Error(ensured.error || "更新 Bot 会话失败");

    const binding = runtime?.data?.binding || runtime?.binding || {
      botId: key,
      runtimeKind: kind,
      enabled: true,
      config
    };
    const bindingKind = binding.runtimeKind || binding.runtime_kind || kind;
    const bindingConfig = binding.config || binding.runtimeConfig || {};
    const bindingDeviceName = compactDeviceName(bindingConfig.deviceName || "");
    const conversation = social?.upsertBotConversation?.(conversationFromResult(ensured)) || conversationFromResult(ensured);
    const cloudBot = {
      ...savedBotFromResult(saved, { ...identity, id: key, key }),
      key,
      id: key,
      sourceKinds: [...new Set([...sourceKinds(bot), "cloud"])],
      runtimeKind: bindingKind,
      runtimeConfig: bindingConfig,
      agentEngine: bindingKind === "cloud-hermes" ? "hermes" : (bindingConfig.agentEngine || agentEngine),
      targetDeviceId: bindingConfig.deviceId || "",
      deviceId: bindingConfig.deviceId || "",
      deviceName: bindingDeviceName,
      runtimeLabel: bindingKind === "cloud-hermes" ? "Mia Cloud" : (bindingDeviceName || "当前设备")
    };
    if (social?.moduleState) {
      const bots = Array.isArray(social.moduleState.bots) ? social.moduleState.bots : [];
      social.moduleState.bots = [
        cloudBot,
        ...bots.filter((item) => String(item?.key || item?.id || "") !== key)
      ];
    }
    return { saved: true, key, bot: cloudBot, binding, conversation, runtime: state.runtime };
  }

  async function saveCloudHermesBot({
    state = {},
    api = global.mia,
    social = global.miaSocial,
    bot = {},
    isCreate = false,
    activateRuntime = false,
    cloudModelEntries = () => []
  } = {}) {
    if (!state.runtime?.cloud?.enabled || typeof api?.social?.saveBotIdentity !== "function") {
      throw new Error("请先登录 Mia Cloud。");
    }
    const key = bot.key || generateUntypedBotId(existingBotKeys(state, social));
    const identity = cloudHermesIdentityForBot({ ...bot, key });
    const saved = await api.social.saveBotIdentity(key, identity);
    if (!saved?.ok) throw new Error(saved?.error || "保存 Bot 身份失败");
    if (isCreate || activateRuntime) {
      const runtime = await api.social.saveBotRuntime(key, {
        runtimeKind: "cloud-hermes",
        enabled: true,
        activate: true,
        config: cloudRuntimeDefaults({ cloudModelEntries })
      });
      if (!runtime?.ok) throw new Error(runtime?.error || "保存 Mia Cloud 运行配置失败");
    }
    const ensured = await api.social.ensureBotSessionConversation(key, {
      botId: key,
      title: identity.name || key,
      runtimeKind: "cloud-hermes"
    });
    if (!ensured?.ok) throw new Error(ensured?.error || "创建 Bot 会话失败");
    const cloudBot = {
      ...savedBotFromResult(saved, identity),
      key,
      id: key,
      sourceKinds: [...new Set([...sourceKinds(bot), "cloud"])],
      runtimeKind: "cloud-hermes",
      runtimeLabel: "Mia Cloud",
      agentEngine: "hermes"
    };
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

  async function saveBot(options = {}) {
    const runtimeKind = String(options.runtimeKind || "desktop-local").trim();
    if (runtimeKind === "cloud-hermes") return saveCloudHermesBot(options);
    if (!canUseCloudIdentity(options)) throw new Error("请先登录 Mia Cloud。");
    return saveBotRuntimeTarget({ ...options, runtimeKind: "desktop-local" });
  }

  async function deleteCloudHermesBot({
    state = {},
    api = global.mia,
    social = global.miaSocial,
    bot = {}
  } = {}) {
    const key = String(bot.key || bot.id || "").trim();
    if (!key) return { deleted: false, runtime: state.runtime };
    if (typeof api?.social?.deleteBot !== "function") throw new Error("云端身份删除接口不可用。");
    const result = await api.social.deleteBot(key);
    if (result && result.ok === false) throw new Error(result.error || "删除 Bot 身份失败");
    if (social?.moduleState) {
      const bots = Array.isArray(social.moduleState.bots) ? social.moduleState.bots : [];
      social.moduleState.bots = bots
        .filter((item) => String(item?.key || item?.id || "") !== key);
    }
    await social?.bootstrapAfterLogin?.();
    return { deleted: true, runtime: state.runtime };
  }

  async function deleteBot(options = {}) {
    const bot = options.bot || {};
    if (bot.canDelete === false) return { deleted: false, runtime: options.state?.runtime };
    return deleteCloudHermesBot(options);
  }

  function identityForCapabilities(bot = {}, capabilities) {
    const identity = {
      name: bot.name || bot.key || bot.id,
      avatarImage: bot.avatarImage || "",
      avatarCrop: bot.avatarCrop || null,
      bio: bot.bio || bot.description || "",
      personaText: bot.personaText || "",
      capabilities
    };
    return String(bot.runtimeKind || bot.runtime_kind || "").trim() === "cloud-hermes"
      ? {
        ...identity,
        bio: stripCopiedEngineIdentity(identity.bio, identity.name),
        personaText: stripCopiedEngineIdentity(identity.personaText, identity.name)
      }
      : identity;
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
    if (typeof api?.social?.saveBotIdentity !== "function") throw new Error("云端身份保存接口不可用。");
    const response = await api.social.saveBotIdentity(key, identityForCapabilities(bot, capabilities));
    if (response && response.ok === false) throw new Error(response.error || "保存 Bot 能力失败");
    const saved = savedBotFromResult(response, { ...bot, capabilities });
    const nextBot = {
      ...bot,
      ...saved,
      key: saved.key || saved.id || key,
      id: saved.id || saved.key || key,
      sourceKinds: [...new Set([...sourceKinds(bot), "cloud"])],
      capabilities
    };
    if (social?.moduleState) {
      const bots = Array.isArray(social.moduleState.bots) ? social.moduleState.bots : [];
      social.moduleState.bots = [
        nextBot,
        ...bots.filter((item) => String(item?.key || item?.id || "") !== key)
      ];
    }
    return { key, bot: nextBot, runtime: state.runtime };
  }

  async function saveBotCapabilities(options = {}) {
    return saveCloudHermesBotCapabilities(options);
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
    if (!key) return null;
    const cacheKey = runtimeCacheKey(key, kind);
    if (cache?.has?.(cacheKey)) return cache.get(cacheKey);
    if (typeof api?.social?.getBotRuntime !== "function") throw new Error("Bot 运行绑定读取接口不可用。");
    const response = await api.social.getBotRuntime(key, kind);
    if (!response?.ok) throw new Error(response?.error || "读取 Bot 运行绑定失败");
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
    if (!key) return { saved: false, binding: null };
    const current = await getBotRuntimeBinding({ api, cache, botKey: key, runtimeKind: kind }) || {
      botId: key,
      runtimeKind: kind,
      enabled: true,
      config: {}
    };
    const mergedConfig = sanitizePersistedRuntimeConfig({ ...(current.config || {}), ...(patch || {}) });
    if (typeof api?.social?.saveBotRuntime !== "function") throw new Error("Bot 运行绑定保存接口不可用。");
    const response = await api.social.saveBotRuntime(key, {
      runtimeKind: kind,
      enabled: true,
      config: mergedConfig
    });
    if (!response?.ok) throw new Error(response?.error || "保存 Bot 运行绑定失败");
    const binding = response.data?.binding || {
      ...current,
      runtimeKind: kind,
      enabled: true,
      config: mergedConfig
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
    if (id === "openclaw" || id === "open-claw") return "openclaw";
    return "hermes";
  }

  function isExternalAgentEngine(engine, engineContracts = global?.miaEngineContracts, engineOptions = global?.miaEngineOptions) {
    if (typeof engineOptions?.isExternalAgentEngine === "function") return engineOptions.isExternalAgentEngine(engine);
    if (typeof engineContracts?.isExternalEngine === "function") return engineContracts.isExternalEngine(engine);
    return normalizeAgentEngine(engine, engineContracts) !== "hermes";
  }

  function normalizeModelEntry(entry = {}, fallbackProvider = "") {
    const normalized = {
      value: String(entry.model || entry.id || entry.value || "").trim(),
      label: String(entry.label || entry.model || entry.id || entry.value || "Default").trim(),
      model: String(entry.model || "").trim(),
      provider: String(entry.provider || fallbackProvider || "").trim(),
      providerLabel: String(entry.providerLabel || entry.provider_label || "").trim()
    };
    for (const [key, value] of Object.entries({
      authType: String(entry.authType || entry.auth_type || "").trim(),
      modelProfileId: String(entry.modelProfileId || entry.model_profile_id || entry.profileId || entry.profile_id || "").trim()
    })) {
      if (value) normalized[key] = value;
    }
    return normalized;
  }

  function shouldStripLegacyRuntimeModelFields(config = {}) {
    return Boolean(
      String(config?.providerConnectionId || config?.provider_connection_id || "").trim()
      || String(config?.modelProfileId || config?.model_profile_id || "").trim()
      || String(config?.provider || config?.modelProvider || config?.model_provider || "").trim() === "mia"
      || String(config?.authType || config?.auth_type || "").trim() === "mia_account"
      || String(config?.model || "").trim() === "mia-auto"
      || String(config?.model || "").trim() === "mia-default"
    );
  }

  function canonicalMiaModelId(model = "") {
    const id = String(model || "").trim();
    return id === "mia-default" ? "mia-auto" : id;
  }

  function canonicalMiaProfileId(profileId = "", model = "") {
    const raw = String(profileId || "").trim();
    if (!raw.startsWith("mia:")) return raw;
    const modelId = canonicalMiaModelId(raw.slice("mia:".length)) || canonicalMiaModelId(model);
    return modelId ? `mia:${modelId}` : raw;
  }

  function sanitizePersistedModelEntry(entry = {}) {
    const rawValue = String(entry?.value || entry?.model || entry?.id || "").trim();
    const rawModel = String(entry?.model || "").trim();
    const model = canonicalMiaModelId(rawModel);
    const sanitized = {
      value: canonicalMiaModelId(rawValue),
      label: String(entry?.label || entry?.model || entry?.id || entry?.value || "Default").trim(),
      model,
      provider: String(entry?.provider || "").trim(),
      providerLabel: String(entry?.providerLabel || entry?.provider_label || "").trim()
    };
    const authType = String(entry?.authType || entry?.auth_type || "").trim();
    const modelProfileId = canonicalMiaProfileId(
      entry?.modelProfileId || entry?.model_profile_id || entry?.profileId || entry?.profile_id || "",
      model || sanitized.value
    );
    if (authType) sanitized.authType = authType;
    if (modelProfileId) sanitized.modelProfileId = modelProfileId;
    return sanitized;
  }

  function sanitizePersistedRuntimeConfig(config = {}) {
    const next = { ...(config && typeof config === "object" ? config : {}) };
    if (Array.isArray(next.modelEntries)) {
      next.modelEntries = next.modelEntries.map((entry) => sanitizePersistedModelEntry(entry));
    }
    const model = canonicalMiaModelId(next.model);
    const profileId = canonicalMiaProfileId(next.modelProfileId || next.model_profile_id || "", model);
    if (
      String(next.provider || next.modelProvider || next.model_provider || "").trim() === "mia"
      || String(next.authType || next.auth_type || "").trim() === "mia_account"
      || profileId.startsWith("mia:")
      || model === "mia-auto"
      || model === "mia-default"
    ) {
      next.providerConnectionId = "mia";
      if (model) next.model = model;
      if (profileId) next.modelProfileId = profileId;
      else if (model) next.modelProfileId = `mia:${model}`;
    }
    if (shouldStripLegacyRuntimeModelFields(next)) {
      for (const key of LEGACY_RUNTIME_MODEL_FIELDS) delete next[key];
    }
    return next;
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

  function runtimeProfilePatch(entry = {}, fallbackValue = "") {
    const provider = String(
      entry?.providerConnectionId
      || entry?.provider_connection_id
      || entry?.provider
      || entry?.modelProvider
      || entry?.model_provider
      || ""
    ).trim();
    const model = String(entry?.model || fallbackValue || "").trim();
    const patch = { model };
    if (provider) patch.providerConnectionId = provider;
    const profileId = String(entry?.modelProfileId || entry?.model_profile_id || entry?.profileId || entry?.profile_id || "").trim();
    if (profileId) patch.modelProfileId = profileId;
    else if (provider && model) patch.modelProfileId = `${provider}:${model}`;
    return patch;
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
    const deviceId = String(
      bot?.targetDeviceId
      || bot?.target_device_id
      || bot?.deviceId
      || bot?.device_id
      || runtime.localDevice?.id
      || runtime.cloud?.deviceId
      || ""
    ).trim();
    const deviceName = compactDeviceName(
      bot?.targetDeviceName
      || bot?.target_device_name
      || bot?.deviceName
      || bot?.device_name
      || runtime.localDevice?.name
      || ""
    );
    const config = {
      agentEngine: engine,
      ...(deviceId ? { deviceId } : {}),
      ...(deviceName ? { deviceName } : {})
    };
    if (isExternalAgentEngine(engine, engineContracts, engineOptions)) {
      const modelEntries = externalModelEntries(engine, engineOptions);
      const modelPatch = patchForRuntimeField("model", String(engineConfig.model || "").trim(), modelEntries);
      Object.assign(config, modelPatch);
      config.effortLevel = String(engineConfig.effortLevel || "medium").trim();
      config.modelEntries = modelEntries;
      return config;
    }
    const modelEntries = localHermesModelEntries(runtime, modelSettings);
    const modelPatch = patchForRuntimeField("model", String(runtime.model?.model || "").trim(), modelEntries);
    Object.assign(config, modelPatch);
    if (!modelPatch.providerConnectionId) Object.assign(config, runtimeProfilePatch(runtime.model, String(runtime.model?.model || "").trim()));
    config.effortLevel = String(runtime.effort?.level || "medium").trim();
    config.permissionMode = String(runtime.permissions?.mode || "ask").trim();
    config.modelEntries = modelEntries;
    return config;
  }

  async function syncDesktopLocalBotRuntimeBinding({
    api = global?.mia?.social,
    state = {},
    bot = {},
    engineContracts = global?.miaEngineContracts,
    modelSettings = global?.miaModelSettings,
    engineOptions = global?.miaEngineOptions,
    activateRuntime = false
  } = {}) {
    const botKey = String(bot?.key || bot?.id || "").trim();
    if (!botKey || typeof api?.saveBotRuntime !== "function") return null;
    const body = {
      runtimeKind: "desktop-local",
      activate: activateRuntime,
      preserveEnabled: activateRuntime === false,
      enabled: true,
      config: desktopLocalRuntimeConfig({ state, bot, engineContracts, modelSettings, engineOptions })
    };
    const response = await api.saveBotRuntime(botKey, body);
    if (response && response.ok === false) throw new Error(response.error || "保存桌面运行配置失败");
    return response?.data?.binding || response?.binding || { botId: botKey, ...body };
  }

  async function ensureDesktopLocalBotConversation({
    api = global?.mia?.social,
    state = {},
    bot = {},
    engineContracts = global?.miaEngineContracts,
    modelSettings = global?.miaModelSettings,
    engineOptions = global?.miaEngineOptions,
    activateRuntime = false,
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
      engineOptions,
      activateRuntime
    });
    if (result && result.ok === false) throw new Error(result.error || result.message || result.data?.error || "创建桌面运行会话失败");
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
      return runtimeProfilePatch(entry || {}, entry?.model ?? value);
    }
    if (field === "effortLevel" || field === "permissionMode") return { [field]: value };
    return {};
  }

  async function saveBotRuntimeControl({
    api = global?.mia,
    cache = null,
    bot = {},
    runtimeKind = bot?.runtimeKind || bot?.runtime_kind || "desktop-local",
    field = "",
    value = "",
    modelEntries = [],
    engineContracts = global?.miaEngineContracts,
    engineOptions = global?.miaEngineOptions
  } = {}) {
    const kind = String(runtimeKind || bot?.runtimeKind || bot?.runtime_kind || "desktop-local").trim();
    const key = String(bot?.key || bot?.id || "").trim();
    if (!key) return { saved: false, runtime: null, binding: null };
    const normalizedField = field === "permission" ? "permissionMode" : field;
    const engine = normalizeAgentEngine(bot?.agentEngine || bot?.agent_engine || "hermes", engineContracts);
    if (kind === "desktop-local" && normalizedField === "permissionMode" && isExternalAgentEngine(engine, engineContracts, engineOptions)) {
      return { saved: false, runtime: null, binding: null };
    }
    const patch = patchForRuntimeField(field, value, modelEntries);
    if (!Object.keys(patch).length) return { saved: false, binding: null };
    return saveBotRuntimeConfig({ api, cache, botKey: key, runtimeKind: kind, patch });
  }

  const api = {
    generateUntypedBotId,
    existingBotKeys,
    saveCloudHermesBot,
    saveBotRuntimeTarget,
    saveBot,
    deleteCloudHermesBot,
    deleteBot,
    saveCloudHermesBotCapabilities,
    saveBotCapabilities,
    runtimeCacheKey,
    getBotRuntimeBinding,
    saveBotRuntimeConfig,
    desktopLocalRuntimeConfig,
    syncDesktopLocalBotRuntimeBinding,
    ensureDesktopLocalBotConversation,
    saveBotRuntimeControl
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  if (global) global.miaBotCommands = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null));
