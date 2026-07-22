(function attachBotCommands(global) {
  "use strict";

  function compactDeviceName(value = "") {
    return String(value || "")
      .trim()
      .replace(/\s*(?:·|-)?\s*Mia\s+(?:Desktop|Bridge)(?=\s*(?:·|-|$))/gi, "")
      .replace(/\.local(?=\s|$)/gi, "")
      .replace(/\s*(?:·|-)\s*(?:本机|在线|离线)\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  const ENGINE_IDENTITY_NAMES = ["Claude Code", "Codex", "Hermes"];
  const CLOUD_RUNTIME_KIND = "cloud-claude-code";

  function normalizeRuntimeKind(value, fallback = "desktop-local") {
    const raw = String(value || fallback || "").trim().toLowerCase().replace(/_/g, "-");
    if (raw === "cloud-claude-code" || raw === "mia-cloud" || raw === "miacloud") return CLOUD_RUNTIME_KIND;
    if (raw === "desktop-local") return "desktop-local";
    return fallback === CLOUD_RUNTIME_KIND ? CLOUD_RUNTIME_KIND : "desktop-local";
  }

  function cloudAgentRuntime(state = {}) {
    return global.miaCloudRuntime?.cloudAgentRuntimeFromState?.(state) || {
      runtimeKind: "",
      agentEngine: "",
      label: "",
      available: false
    };
  }

  function requireCloudAgentRuntime(state = {}) {
    if (global.miaCloudRuntime?.requireCloudAgentRuntime) return global.miaCloudRuntime.requireCloudAgentRuntime(state);
    const runtime = cloudAgentRuntime(state);
    if (!runtime.available) throw new Error("Mia Cloud 运行内核未同步，请刷新运行状态后重试。");
    return runtime;
  }

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

  function manualBotDefaultCapabilities() {
    const identity = botIdentity();
    if (typeof identity?.manualBotDefaultCapabilities === "function") {
      return identity.manualBotDefaultCapabilities();
    }
    return serializableCapabilities({
      enabledSkills: [
        "mia-scheduler",
        "mia-official:document-editor",
        "mia-official:meeting-notes",
        "mia-official:spreadsheet-organizer",
        "mia-official:xlsx"
      ]
    });
  }

  function botWithManualCreateDefaults(bot = {}, isCreate = false) {
    if (!isCreate || Object.prototype.hasOwnProperty.call(bot, "capabilities")) return bot;
    return {
      ...bot,
      capabilities: manualBotDefaultCapabilities()
    };
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

  function deletedConversationIdsFromResult(result = {}) {
    const ids = result?.data?.deletedConversationIds || result?.deletedConversationIds || [];
    return Array.isArray(ids) ? ids.map((id) => String(id || "").trim()).filter(Boolean) : [];
  }

  function conversationBotId(conversation = {}) {
    return String(
      conversation?.decorations?.botId
        || conversation?.decorations?.bot_id
        || conversation?.botId
        || conversation?.bot_id
        || ""
    ).trim();
  }

  function removeDeletedBotConversations(social, botKey, result = {}) {
    if (!social?.moduleState) return;
    const deletedIds = new Set(deletedConversationIdsFromResult(result));
    const key = String(botKey || "").trim();
    const conversations = Array.isArray(social.moduleState.conversations)
      ? social.moduleState.conversations
      : [];
    const removedIds = [];
    social.moduleState.conversations = conversations.filter((conversation) => {
      const conversationId = String(conversation?.id || "");
      const remove = deletedIds.has(conversationId)
        || (key && conversationBotId(conversation) === key);
      if (remove && conversationId) removedIds.push(conversationId);
      return !remove;
    });
    for (const conversationId of removedIds) {
      social.moduleState.messageCache?.delete?.(conversationId);
      social.moduleState.unreadByConversation?.delete?.(conversationId);
    }
    if (removedIds.includes(String(social.moduleState.activeConversationId || ""))) {
      social.moduleState.activeConversationId = null;
    }
  }

  function savedBotFromResult(result, fallback) {
    const saved = result?.data?.bot || result?.bot || null;
    if (!saved || !fallback || typeof fallback !== "object") return saved || fallback;
    const fallbackHasBadge = Object.prototype.hasOwnProperty.call(fallback, "statusBadge")
      || Object.prototype.hasOwnProperty.call(fallback, "status_badge");
    const savedHasBadge = Object.prototype.hasOwnProperty.call(saved, "statusBadge")
      || Object.prototype.hasOwnProperty.call(saved, "status_badge");
    if (!fallbackHasBadge || savedHasBadge) return saved;
    const fallbackBadge = Object.prototype.hasOwnProperty.call(fallback, "statusBadge")
      ? fallback.statusBadge
      : fallback.status_badge;
    return { ...saved, statusBadge: fallbackBadge };
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

  function idsApi() {
    if (global?.miaIds) return global.miaIds;
    if (typeof require === "function") {
      try { return require("../../shared/ids.js"); } catch { /* fallback below */ }
    }
    return null;
  }

  function existingBotIds({ state = {}, social = global.miaSocial } = {}) {
    const rows = [
      ...(Array.isArray(social?.moduleState?.bots) ? social.moduleState.bots : []),
      ...(Array.isArray(state?.runtime?.bots) ? state.runtime.bots : []),
      ...(Array.isArray(state?.bots) ? state.bots : [])
    ];
    return new Set(rows
      .flatMap((bot) => [bot?.key, bot?.id, bot?.accountId, bot?.account_id])
      .map((value) => String(value || "").trim())
      .filter(Boolean));
  }

  function generateCreateBotKey(options = {}) {
    const generate = idsApi()?.generatePrincipalId;
    if (typeof generate !== "function") throw new Error("无法生成 Bot 账号 ID。");
    const used = existingBotIds(options);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const id = String(generate() || "").trim();
      if (id && !used.has(id)) return id;
    }
    throw new Error("无法生成未占用的 Bot 账号 ID。");
  }

  function botKeyForSave({ state = {}, social = global.miaSocial, bot = {}, isCreate = false } = {}) {
    const key = String(bot.key || bot.id || "").trim();
    if (key || !isCreate) return key;
    return generateCreateBotKey({ state, social });
  }

  async function ensureSavedBotConversation({ api = global.mia, key = "", identity = {}, runtimeKind = "desktop-local" } = {}) {
    const body = {
      botId: key,
      title: identity.name || key,
      runtimeKind
    };
    if (runtimeKind !== CLOUD_RUNTIME_KIND && typeof api?.social?.ensureBotConversation === "function") {
      return api.social.ensureBotConversation(key, body);
    }
    return api?.social?.ensureBotSessionConversation?.(key, body);
  }

  function canUseCloudIdentity({ state = {}, api = global.mia } = {}) {
    return Boolean(state.runtime?.cloud?.enabled && typeof api?.social?.saveBotIdentity === "function");
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
    agentEngine = bot?.agentEngine || bot?.agent_engine || "hermes"
  } = {}) {
    bot = botWithManualCreateDefaults(bot, isCreate);
    const explicitKey = botKeyForSave({ state, social, bot, isCreate });
    let key = explicitKey;
    const kind = normalizeRuntimeKind(runtimeKind);
    if (!key && !isCreate) return { saved: false, binding: null, conversation: null };
    if (!state.runtime?.cloud?.enabled || typeof api?.social?.saveBotIdentity !== "function") {
      throw new Error("请先登录 Mia Cloud。");
    }
    const cloudRuntime = kind === CLOUD_RUNTIME_KIND ? requireCloudAgentRuntime(state) : null;
    const identity = kind === "cloud-claude-code"
      ? cloudHermesIdentityForBot({ ...bot, ...(key ? { key } : {}) })
      : cloudIdentityForBot({ ...bot, ...(key ? { key } : {}) });
    const saved = await api.social.saveBotIdentity(key, identity);
    if (saved && saved.ok === false) throw new Error(saved.error || "保存 Bot 身份失败");
    const savedBot = savedBotFromResult(saved, { ...identity, ...(key ? { id: key, key } : {}) });
    key = String(savedBot.key || savedBot.id || key || "").trim();
    if (!key) throw new Error("云端未返回 Bot 账号 ID。");

    if (typeof api?.social?.saveBotRuntime !== "function") throw new Error("Bot 运行绑定保存接口不可用。");
    const targetIntent = {
      agentEngine: kind === CLOUD_RUNTIME_KIND ? (cloudRuntime?.agentEngine || agentEngine || "") : agentEngine,
      deviceId: targetDeviceId,
      deviceName: targetDeviceName
    };
    const runtime = await api.social.saveBotRuntime(key, {
      runtimeKind: kind,
      enabled: true,
      activate: true,
      targetIntent
    });
    if (runtime && runtime.ok === false) throw new Error(runtime.error || "保存 Bot 运行设置失败");
    const ensured = await ensureSavedBotConversation({ api, key, identity, runtimeKind: kind });
    if (ensured && ensured.ok === false) throw new Error(ensured.error || "更新 Bot 会话失败");

    const binding = runtime?.data?.binding || runtime?.binding || {
      botId: key,
      runtimeKind: kind,
      enabled: true,
      agentEngine: targetIntent.agentEngine,
      targetDeviceId: targetIntent.deviceId,
      targetDeviceName: targetIntent.deviceName,
      runtimeLabel: kind === CLOUD_RUNTIME_KIND ? "Mia Cloud" : compactDeviceName(targetIntent.deviceName || "")
    };
    const bindingKind = normalizeRuntimeKind(binding.runtimeKind || binding.runtime_kind || kind);
    const bindingAgentEngine = binding.agentEngine || binding.agent_engine || targetIntent.agentEngine || "";
    const bindingDeviceId = bindingKind === CLOUD_RUNTIME_KIND
      ? ""
      : String(binding.targetDeviceId || binding.target_device_id || targetIntent.deviceId || "").trim();
    const bindingDeviceName = bindingKind === CLOUD_RUNTIME_KIND
      ? "Mia Cloud"
      : compactDeviceName(binding.targetDeviceName || binding.target_device_name || targetIntent.deviceName || "");
    const bindingRuntimeLabel = String(
      binding.runtimeLabel
      || binding.runtime_label
      || (bindingKind === CLOUD_RUNTIME_KIND ? "Mia Cloud" : bindingDeviceName || "当前设备")
    ).trim();
    const conversation = social?.upsertBotConversation?.(conversationFromResult(ensured)) || conversationFromResult(ensured);
    const identityBot = {
      ...savedBot,
      key,
      id: key,
      sourceKinds: [...new Set([...sourceKinds(bot), "cloud"])],
      runtimeKind: bindingKind,
      agentEngine: bindingKind === CLOUD_RUNTIME_KIND ? (bindingAgentEngine || cloudRuntime?.agentEngine || "") : (bindingAgentEngine || agentEngine),
      targetDeviceId: bindingDeviceId,
      targetDeviceName: bindingDeviceName,
      deviceId: bindingDeviceId,
      deviceName: bindingDeviceName,
      runtimeLabel: bindingRuntimeLabel
    };
    if (social?.moduleState) {
      const bots = Array.isArray(social.moduleState.bots) ? social.moduleState.bots : [];
      social.moduleState.bots = [
        identityBot,
        ...bots.filter((item) => String(item?.key || item?.id || "") !== key)
      ];
    }
    return { saved: true, key, bot: identityBot, binding, conversation, runtime: state.runtime };
  }

  async function saveCloudClaudeCodeBot({
    state = {},
    api = global.mia,
    social = global.miaSocial,
    bot = {},
    isCreate = false,
    activateRuntime = false
  } = {}) {
    if (!state.runtime?.cloud?.enabled || typeof api?.social?.saveBotIdentity !== "function") {
      throw new Error("请先登录 Mia Cloud。");
    }
    bot = botWithManualCreateDefaults(bot, isCreate);
    let key = botKeyForSave({ state, social, bot, isCreate });
    const cloudRuntime = requireCloudAgentRuntime(state);
    const identity = cloudHermesIdentityForBot({ ...bot, ...(key ? { key } : {}) });
    const saved = await api.social.saveBotIdentity(key, identity);
    if (!saved?.ok) throw new Error(saved?.error || "保存 Bot 身份失败");
    const savedBot = savedBotFromResult(saved, { ...identity, ...(key ? { id: key, key } : {}) });
    key = String(savedBot.key || savedBot.id || key || "").trim();
    if (!key) throw new Error("云端未返回 Bot 账号 ID。");
    if (isCreate || activateRuntime) {
      const runtime = await api.social.saveBotRuntime(key, {
        runtimeKind: CLOUD_RUNTIME_KIND,
        enabled: true,
        activate: true,
        targetIntent: {
          agentEngine: cloudRuntime.agentEngine
        }
      });
      if (!runtime?.ok) throw new Error(runtime?.error || "保存 Mia Cloud 运行配置失败");
    }
    const ensured = await api.social.ensureBotSessionConversation(key, {
      botId: key,
      title: identity.name || key,
      runtimeKind: CLOUD_RUNTIME_KIND
    });
    if (!ensured?.ok) throw new Error(ensured?.error || "创建 Bot 会话失败");
    const identityBot = {
      ...savedBot,
      key,
      id: key,
      sourceKinds: [...new Set([...sourceKinds(bot), "cloud"])],
      runtimeKind: CLOUD_RUNTIME_KIND,
      runtimeLabel: "Mia Cloud",
      agentEngine: cloudRuntime.agentEngine
    };
    if (social?.moduleState) {
      const bots = Array.isArray(social.moduleState.bots) ? social.moduleState.bots : [];
      social.moduleState.bots = [
        identityBot,
        ...bots.filter((item) => String(item?.key || item?.id || "") !== key)
      ];
    }
    const conversation = social?.upsertBotConversation?.(conversationFromResult(ensured)) || conversationFromResult(ensured);
    return { key, bot: identityBot, conversation, runtime: state.runtime };
  }

  async function saveBot(options = {}) {
    const runtimeKind = normalizeRuntimeKind(options.runtimeKind || "desktop-local");
    if (runtimeKind === CLOUD_RUNTIME_KIND) return saveCloudClaudeCodeBot(options);
    if (!canUseCloudIdentity(options)) throw new Error("请先登录 Mia Cloud。");
    return saveBotRuntimeTarget({ ...options, runtimeKind: "desktop-local" });
  }

  async function deleteBotIdentity({
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
      removeDeletedBotConversations(social, key, result);
    }
    await social?.bootstrapAfterLogin?.();
    return { deleted: true, runtime: state.runtime };
  }

  async function deleteBot(options = {}) {
    const bot = options.bot || {};
    if (bot.canDelete === false) return { deleted: false, runtime: options.state?.runtime };
    return deleteBotIdentity(options);
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
    return normalizeRuntimeKind(bot.runtimeKind || bot.runtime_kind || "") === CLOUD_RUNTIME_KIND
      ? {
        ...identity,
        bio: stripCopiedEngineIdentity(identity.bio, identity.name),
        personaText: stripCopiedEngineIdentity(identity.personaText, identity.name)
      }
      : identity;
  }

  async function saveBotIdentityCapabilities({
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
    return saveBotIdentityCapabilities(options);
  }

  function runtimeCacheKey(botKey, runtimeKind = "cloud-claude-code") {
    return `${botKey}:${runtimeKind}`;
  }

  function socialApi(api = global?.mia) {
    return api?.social || api || null;
  }

  async function getBotRuntimeBinding({
    api = global.mia,
    cache = null,
    botKey = "",
    runtimeKind = "cloud-claude-code"
  } = {}) {
    const key = String(botKey || "").trim();
    const kind = String(runtimeKind || "cloud-claude-code").trim();
    if (!key) return null;
    const cacheKey = runtimeCacheKey(key, kind);
    if (cache?.has?.(cacheKey)) return cache.get(cacheKey);
    const social = socialApi(api);
    if (typeof social?.getBotRuntime !== "function") throw new Error("Bot 运行绑定读取接口不可用。");
    const response = await social.getBotRuntime(key, kind);
    if (!response?.ok) throw new Error(response?.error || "读取 Bot 运行绑定失败");
    const binding = response.data?.binding || null;
    cache?.set?.(cacheKey, binding);
    return binding;
  }

  function normalizeAgentEngine(value, engineContracts = global?.miaEngineContracts) {
    const normalizer = engineContracts?.normalizeAgentEngine;
    if (typeof normalizer === "function") return normalizer(value);
    const id = String(value || "hermes").trim().toLowerCase().replace(/_/g, "-");
    if (id === "claude" || id === "claude-code") return "claude-code";
    if (id === "codex" || id === "openai-codex") return "codex";
    return "hermes";
  }

  function desktopLocalRuntimeSyncIntent({
    state = {},
    bot = {},
    engineContracts = global?.miaEngineContracts
  } = {}) {
    const runtime = state.runtime || {};
    const engine = normalizeAgentEngine(bot?.agentEngine || bot?.agent_engine || "hermes", engineContracts);
    const requestedDeviceId = String(
      bot?.targetDeviceId
      || bot?.target_device_id
      || bot?.deviceId
      || bot?.device_id
      || ""
    ).trim();
    const localDeviceId = String(runtime.localDevice?.id || runtime.cloud?.deviceId || "").trim();
    const deviceId = requestedDeviceId && requestedDeviceId !== "current-device"
      ? requestedDeviceId
      : localDeviceId;
    const targetsCurrentDevice = !requestedDeviceId
      || requestedDeviceId === "current-device"
      || (localDeviceId && requestedDeviceId === localDeviceId);
    const deviceName = compactDeviceName(
      targetsCurrentDevice
        ? (runtime.localDevice?.name
          || bot?.targetDeviceName
          || bot?.target_device_name
          || bot?.deviceName
          || bot?.device_name
          || "")
        : (bot?.targetDeviceName
          || bot?.target_device_name
          || bot?.deviceName
          || bot?.device_name
          || "")
    );
    const intent = {
      agentEngine: engine,
      ...(deviceId ? { deviceId } : {}),
      ...(deviceName ? { deviceName } : {})
    };
    return intent;
  }

  async function syncDesktopLocalBotRuntimeBinding({
    api = global?.mia?.social,
    state = {},
    bot = {},
    engineContracts = global?.miaEngineContracts,
    activateRuntime = false
  } = {}) {
    const botKey = String(bot?.key || bot?.id || "").trim();
    const social = socialApi(api);
    if (!botKey || typeof social?.saveBotRuntime !== "function") return null;
    const runtimeStatus = String(bot?.runtimeStatus || bot?.runtime_status || "").trim();
    const explicitEngine = String(
      bot?.agentEngine
      || bot?.agent_engine
      || bot?.runtimeConfig?.agentEngine
      || bot?.runtime_config?.agent_engine
      || ""
    ).trim();
    if (runtimeStatus === "invalid_config" && !explicitEngine) return null;
    const body = {
      runtimeKind: "desktop-local",
      activate: activateRuntime,
      preserveEnabled: activateRuntime === false,
      enabled: true,
      syncIntent: desktopLocalRuntimeSyncIntent({ state, bot, engineContracts })
    };
    const response = await social.saveBotRuntime(botKey, body);
    if (response && response.ok === false) throw new Error(response.error || "保存桌面运行配置失败");
    return response?.data?.binding || response?.binding || { botId: botKey, ...body };
  }

  async function ensureDesktopLocalBotConversation({
    api = global?.mia?.social,
    state = {},
    bot = {},
    engineContracts = global?.miaEngineContracts,
    activateRuntime = false,
    onConversation = null
  } = {}) {
    const botKey = String(bot?.key || bot?.id || "").trim();
    const social = socialApi(api);
    if (!botKey || (typeof social?.ensureBotConversation !== "function" && typeof social?.ensureBotSessionConversation !== "function")) {
      return { key: botKey, conversation: null, binding: null };
    }
    const body = {
      botId: botKey,
      title: bot.name || bot.displayName || botKey,
      runtimeKind: "desktop-local"
    };
    const result = typeof social.ensureBotConversation === "function"
      ? await social.ensureBotConversation(botKey, body)
      : await social.ensureBotSessionConversation(botKey, body);
    if (result && result.ok === false) throw new Error(result.error || result.message || result.data?.error || "创建桌面运行会话失败");
    const binding = await syncDesktopLocalBotRuntimeBinding({
      api: social,
      state,
      bot: { ...bot, key: botKey },
      engineContracts,
      activateRuntime
    });
    const conversation = conversationFromResult(result);
    const savedConversation = conversation && typeof onConversation === "function" ? onConversation(conversation) : conversation;
    return { key: botKey, conversation: savedConversation || null, binding };
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
    api = global?.mia,
    cache = null,
    bot = {},
    runtimeKind = bot?.runtimeKind || bot?.runtime_kind || "desktop-local",
    field = "",
    value = "",
    modelEntries = []
  } = {}) {
    const kind = String(runtimeKind || bot?.runtimeKind || bot?.runtime_kind || "desktop-local").trim();
    const key = String(bot?.key || bot?.id || "").trim();
    if (!key) return { saved: false, runtime: null, binding: null };
    const normalizedField = field === "permission" ? "permissionMode" : field;
    if (!["model", "effortLevel", "permissionMode"].includes(normalizedField)) return { saved: false, binding: null };
    const social = socialApi(api);
    if (typeof social?.saveBotRuntime !== "function") throw new Error("Bot 运行绑定保存接口不可用。");
    const controlIntent = {
      field: normalizedField,
      value: String(value || ""),
      modelEntries: normalizedField === "model" ? runtimeControlModelEntriesIntent(modelEntries) : []
    };
    const response = await social.saveBotRuntime(key, {
      runtimeKind: kind,
      enabled: true,
      controlIntent
    });
    if (!response?.ok) throw new Error(response?.error || "保存 Bot 运行绑定失败");
    const binding = response.data?.binding || response.binding || {
      botId: key,
      runtimeKind: kind,
      enabled: true,
      config: {},
      controlIntent
    };
    cache?.set?.(runtimeCacheKey(key, kind), binding);
    return { saved: true, binding };
  }

  const api = {
    saveCloudClaudeCodeBot,
    saveBotRuntimeTarget,
    saveBot,
    deleteBotIdentity,
    deleteBot,
    saveBotIdentityCapabilities,
    saveBotCapabilities,
    runtimeCacheKey,
    getBotRuntimeBinding,
    syncDesktopLocalBotRuntimeBinding,
    ensureDesktopLocalBotConversation,
    saveBotRuntimeControl
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  if (global) global.miaBotCommands = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null));
