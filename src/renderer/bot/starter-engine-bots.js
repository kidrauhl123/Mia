(function attachStarterEngineBots(global) {
  "use strict";

  const STARTER_ENGINE_ORDER = ["hermes", "openclaw", "codex", "claude-code"];
  const CLOUD_MIA_TAG_NAME = "云端";
  const STARTER_STATUS_BADGE_IDS = Object.freeze({
    "cloud-claude-code": "rainbow-fire",
    hermes: "blue-fire",
    openclaw: "pink-fire",
    codex: "cyan-fire",
    "claude-code": "red-orange-fire"
  });
  const STARTER_AVATAR_IMAGES = Object.freeze({
    "cloud-claude-code": "./assets/mia-logo.png",
    hermes: "./assets/engine-icons/hermesagent.svg",
    openclaw: "./assets/provider-icons/openclaw-color.svg",
    codex: "./assets/engine-icons/codex-color.svg",
    "claude-code": "./assets/engine-icons/claudecode.svg"
  });
  const CLOUD_MIA_STARTER = Object.freeze({
    engineId: "cloud-claude-code",
    keySuffix: "mia",
    runtimeKind: "cloud-claude-code",
    name: "Mia",
    color: "#16a34a",
    targetDeviceId: "",
    targetDeviceName: "Mia Cloud",
    tagNames: Object.freeze([CLOUD_MIA_TAG_NAME])
  });
  const STARTER_ENGINE_META = Object.freeze({
    hermes: {
      name: "Hermes",
      color: "#2563eb",
      bio: "连接本机 Hermes，处理日常任务、文件和自动化。",
      personaText: "你是 Hermes。优先用本机可用能力推进用户的日常任务、文件处理和自动化请求。"
    },
    openclaw: {
      name: "OpenClaw",
      color: "#0f766e",
      bio: "连接本机 OpenClaw，适合开放模型和本地工具链任务。",
      personaText: "你是 OpenClaw。优先使用本机 OpenClaw 能力，简洁地完成开放模型、本地工具链和自动化任务。"
    },
    codex: {
      name: "Codex",
      color: "#111827",
      bio: "连接本机 Codex，适合代码、调试和工程自动化。",
      personaText: "你是 Codex。专注代码阅读、修改、调试、测试和工程自动化，先理解上下文再行动。"
    },
    "claude-code": {
      name: "Claude Code",
      color: "#7c2d12",
      bio: "连接本机 Claude Code，适合代码任务和长上下文协作。",
      personaText: "你是 Claude Code。专注代码任务、重构、解释和长上下文协作，保持清晰、稳健和可验证。"
    }
  });

  function normalizeEngineId(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) return "";
    if (["cloud-claude-code", "cloud_claude_code", "cloud-hermes", "cloud_hermes", "mia-cloud", "miacloud"].includes(raw)) return "cloud-claude-code";
    if (["claude", "claude_code", "claudecode"].includes(raw)) return "claude-code";
    if (["open-claw", "open_claw", "openclaw"].includes(raw)) return "openclaw";
    return raw;
  }

  function conversationTagsShared() {
    if (global?.miaConversationTags) return global.miaConversationTags;
    if (typeof require === "function") {
      try { return require("../../shared/conversation-tags.js"); } catch { /* browser fallback below */ }
    }
    return {
      defaultConversationTags: () => ({ items: [], assignments: {} }),
      normalizeConversationTags: (value) => value && typeof value === "object" ? value : { items: [], assignments: {} },
      assignTagNames: (tags) => tags && typeof tags === "object" ? tags : { items: [], assignments: {} }
    };
  }

  function statusBadgeAssetsShared() {
    if (global?.miaStatusBadgeAssets) return global.miaStatusBadgeAssets;
    if (typeof require === "function") {
      try { return require("../../../packages/shared/status-badge-assets.js"); } catch { /* browser fallback below */ }
    }
    return null;
  }

  function avatarResolveShared() {
    if (global?.miaAvatarResolve) return global.miaAvatarResolve;
    if (typeof require === "function") {
      try { return require("../../shared/avatar-resolve.js"); } catch { /* browser fallback below */ }
    }
    return { normalizeAvatarImage: (value) => String(value || "").trim() };
  }

  function starterStatusBadge(engineId) {
    const assetId = STARTER_STATUS_BADGE_IDS[normalizeEngineId(engineId)] || "";
    if (!assetId) return null;
    const badge = statusBadgeAssetsShared()?.statusBadgeForValue?.(assetId);
    return badge || { kind: "lottie", assetId, loop: "always" };
  }

  function starterAvatarImage(engineId) {
    return STARTER_AVATAR_IMAGES[normalizeEngineId(engineId)] || "";
  }

  function labelForEngine(engineId, fallback = "") {
    return STARTER_ENGINE_META[engineId]?.name || String(fallback || engineId || "").trim();
  }

  function legacyAgentFromRuntime(runtime = {}, engineId) {
    const engines = runtime.agentEngines || {};
    if (engineId === "hermes") {
      return {
        id: "hermes",
        usableInMia: Boolean(
          runtime.engineInstalled
          || runtime.engineRunning
          || engines.hermes?.available
          || engines.hermes?.installed
        )
      };
    }
    if (engineId === "claude-code") {
      return { id: "claude-code", usableInMia: Boolean(engines.claudeCode?.available) };
    }
    if (engineId === "codex") {
      return { id: "codex", usableInMia: Boolean(engines.codex?.available) };
    }
    if (engineId === "openclaw") {
      return { id: "openclaw", usableInMia: Boolean(engines.openClaw?.available || engines.openClaw?.installed) };
    }
    return null;
  }

  function agentMapFromRuntime(runtime = {}) {
    const agents = Array.isArray(runtime.agentInventory?.agents) ? runtime.agentInventory.agents : [];
    const byId = new Map();
    for (const agent of agents) {
      const id = normalizeEngineId(agent?.id);
      if (id) byId.set(id, agent);
    }
    for (const engineId of STARTER_ENGINE_ORDER) {
      if (!byId.has(engineId)) {
        const legacy = legacyAgentFromRuntime(runtime, engineId);
        if (legacy) byId.set(engineId, legacy);
      }
    }
    return byId;
  }

  function starterEngineBotSpecs(runtime = {}) {
    const byId = agentMapFromRuntime(runtime);
    return STARTER_ENGINE_ORDER
      .map((engineId) => {
        const agent = byId.get(engineId);
        if (!agent || agent.usableInMia !== true) return null;
        const meta = STARTER_ENGINE_META[engineId];
        return {
          engineId,
          name: meta.name,
          label: labelForEngine(engineId, agent.label),
          color: meta.color,
          avatarImage: starterAvatarImage(engineId),
          avatarCrop: null,
          bio: meta.bio,
          description: meta.bio,
          personaText: meta.personaText,
          statusBadge: starterStatusBadge(engineId)
        };
      })
      .filter(Boolean);
  }

  function starterIdentitySpecs(runtime = {}) {
    const localSpecs = STARTER_ENGINE_ORDER.map((engineId) => {
      const meta = STARTER_ENGINE_META[engineId];
      return {
        engineId,
        keySuffix: engineId,
        name: meta.name,
        label: meta.name,
        color: meta.color,
        avatarImage: starterAvatarImage(engineId),
        avatarCrop: null,
        bio: meta.bio,
        description: meta.bio,
        personaText: meta.personaText,
        statusBadge: starterStatusBadge(engineId)
      };
    });
    const cloudRuntime = global.miaCloudRuntime?.cloudAgentRuntimeFromCloud?.(runtime.cloud || runtime) || {};
    const cloudLabel = cloudRuntime.label || "";
    const cloudStarter = cloudRuntime.available
      ? {
        ...CLOUD_MIA_STARTER,
        agentEngine: cloudRuntime.agentEngine || "claude-code",
        avatarImage: starterAvatarImage("cloud-claude-code"),
        avatarCrop: null,
        bio: `云端 ${cloudLabel}，随时可用，不依赖本机 Agent。`,
        description: `Mia 云端助手，默认使用云端 ${cloudLabel} sandbox。`,
        personaText: `你是 Mia。用云端 ${cloudLabel} sandbox 简洁、可靠地帮助用户处理日常问题、创作、信息整理和自动化请求。`,
        statusBadge: starterStatusBadge("cloud-claude-code")
      }
      : null;
    return [...(cloudStarter ? [cloudStarter] : []), ...localSpecs];
  }

  function starterBotSpecs(runtime = {}) {
    const cloudRuntime = global.miaCloudRuntime?.cloudAgentRuntimeFromCloud?.(runtime.cloud || runtime) || {};
    const cloudLabel = cloudRuntime.label || "";
    const cloudStarter = cloudRuntime.available && cloudRuntime.agentEngine
      ? {
        ...CLOUD_MIA_STARTER,
        agentEngine: cloudRuntime.agentEngine,
        avatarImage: starterAvatarImage("cloud-claude-code"),
        avatarCrop: null,
        bio: `云端 ${cloudLabel}，随时可用，不依赖本机 Agent。`,
        description: `Mia 云端助手，默认使用云端 ${cloudLabel} sandbox。`,
        personaText: `你是 Mia。用云端 ${cloudLabel} sandbox 简洁、可靠地帮助用户处理日常问题、创作、信息整理和自动化请求。`,
        statusBadge: starterStatusBadge("cloud-claude-code")
      }
      : null;
    return [...(cloudStarter ? [cloudStarter] : []), ...starterEngineBotSpecs(runtime)];
  }

  function settingsFromResponse(response) {
    if (response?.settings && typeof response.settings === "object") return response.settings;
    if (response?.data?.settings && typeof response.data.settings === "object") return response.data.settings;
    if (response?.data && typeof response.data === "object" && !Array.isArray(response.data)) return response.data;
    return response && typeof response === "object" ? response : {};
  }

  function starterMarker(settings = {}) {
    const marker = settings.starterEngineBots;
    return marker && typeof marker === "object" && !Array.isArray(marker) ? marker : {};
  }

  function seededStarterEngineIds(marker = {}) {
    return new Set(Array.isArray(marker.engineIds) ? marker.engineIds.map(normalizeEngineId).filter(Boolean) : []);
  }

  function stableUserKey(userId) {
    const clean = String(userId || "local")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48);
    return clean || "local";
  }

  function starterBotKey(userId, engineId) {
    return `starter_${stableUserKey(userId)}_${normalizeEngineId(engineId).replace(/[^a-z0-9]+/g, "_")}`;
  }

  function botDisplayName(bot = {}) {
    return String(bot.name || bot.displayName || bot.display_name || bot.username || "").trim();
  }

  function botEngineId(bot = {}) {
    return normalizeEngineId(
      bot.agentEngine
      || bot.agent_engine
      || bot.runtimeConfig?.agentEngine
      || bot.runtime_config?.agentEngine
      || bot.runtime_config?.agent_engine
    );
  }

  function botRuntimeKind(bot = {}) {
    return String(
      bot.runtimeKind
      || bot.runtime_kind
      || bot.runtimeConfig?.runtimeKind
      || bot.runtime_config?.runtimeKind
      || bot.runtime_config?.runtime_kind
      || ""
    ).trim();
  }

  function hasMatchingBot(spec, bots = []) {
    return Boolean(matchingBotForSpec(spec, bots));
  }

  function matchingBotForSpec(spec, bots = []) {
    return (Array.isArray(bots) ? bots : []).find((bot) =>
      botDisplayName(bot).toLowerCase() === spec.name.toLowerCase()
      && (spec.runtimeKind === "cloud-claude-code"
        ? ["cloud-claude-code", "cloud-hermes"].includes(botRuntimeKind(bot))
          || botKey(bot).endsWith(`_${spec.keySuffix || "mia"}`)
        : botEngineId(bot) === spec.engineId
          || botKey(bot).endsWith(`_${spec.keySuffix || spec.engineId}`))) || null;
  }

  function botKey(bot = {}) {
    return String(bot.key || bot.id || bot.accountId || bot.account_id || "").trim();
  }

  function botStatusBadge(bot = {}) {
    if (Object.prototype.hasOwnProperty.call(bot, "statusBadge")) return bot.statusBadge;
    if (Object.prototype.hasOwnProperty.call(bot, "status_badge")) return bot.status_badge;
    return null;
  }

  function botAvatarImage(bot = {}) {
    return avatarResolveShared().normalizeAvatarImage(
      bot.avatarImage || bot.avatar_image || ""
    );
  }

  function botAvatarCrop(bot = {}) {
    return Object.prototype.hasOwnProperty.call(bot, "avatarCrop")
      ? bot.avatarCrop
      : (Object.prototype.hasOwnProperty.call(bot, "avatar_crop") ? bot.avatar_crop : null);
  }

  function botIdentityForStarterBackfill(bot = {}, spec = {}, overrides = {}) {
    const bio = String(bot.bio || bot.description || "").trim();
    return {
      name: botDisplayName(bot) || spec.name,
      avatarImage: Object.prototype.hasOwnProperty.call(overrides, "avatarImage")
        ? overrides.avatarImage
        : botAvatarImage(bot),
      avatarCrop: Object.prototype.hasOwnProperty.call(overrides, "avatarCrop")
        ? overrides.avatarCrop
        : botAvatarCrop(bot),
      color: bot.color || bot.avatarColor || bot.avatar_color || spec.color || "",
      statusBadge: Object.prototype.hasOwnProperty.call(overrides, "statusBadge")
        ? overrides.statusBadge
        : botStatusBadge(bot),
      bio,
      personaText: String(bot.personaText || bot.persona_text || bio || spec.personaText || "").trim(),
      capabilities: bot.capabilities || { inheritEngineDefaults: true }
    };
  }

  async function backfillStarterIdentity({ api, social, specs = [], existingBots = [] } = {}) {
    if (typeof api?.social?.saveBotIdentity !== "function") return [];
    const updated = [];
    for (const spec of specs) {
      const bot = matchingBotForSpec(spec, existingBots);
      if (!bot) continue;
      const missingStatusBadge = Boolean(spec?.statusBadge) && !botStatusBadge(bot);
      const missingAvatar = Boolean(spec?.avatarImage) && !botAvatarImage(bot);
      if (!missingStatusBadge && !missingAvatar) continue;
      const key = botKey(bot);
      if (!key) continue;
      const response = await api.social.saveBotIdentity(key, botIdentityForStarterBackfill(bot, spec, {
        avatarImage: missingAvatar ? spec.avatarImage : botAvatarImage(bot),
        avatarCrop: missingAvatar ? (Object.prototype.hasOwnProperty.call(spec, "avatarCrop") ? spec.avatarCrop : null) : botAvatarCrop(bot),
        statusBadge: missingStatusBadge ? (spec.statusBadge || null) : botStatusBadge(bot)
      }));
      if (response && response.ok === false) throw new Error(response.error || "保存 Starter Bot 身份失败");
      const savedBot = response?.data?.bot || response?.bot || null;
      const nextBot = {
        ...bot,
        ...(savedBot || {}),
        key: savedBot?.key || savedBot?.id || key,
        id: savedBot?.id || savedBot?.key || key
      };
      if (missingStatusBadge) nextBot.statusBadge = savedBot?.statusBadge || savedBot?.status_badge || spec.statusBadge;
      if (missingAvatar) {
        nextBot.avatarImage = botAvatarImage(savedBot) || spec.avatarImage || "";
        nextBot.avatarCrop = Object.prototype.hasOwnProperty.call(savedBot || {}, "avatarCrop")
          ? savedBot.avatarCrop
          : (Object.prototype.hasOwnProperty.call(savedBot || {}, "avatar_crop") ? savedBot.avatar_crop : (Object.prototype.hasOwnProperty.call(spec, "avatarCrop") ? spec.avatarCrop : null));
      }
      if (Array.isArray(social?.moduleState?.bots)) {
        const index = social.moduleState.bots.indexOf(bot);
        if (index >= 0) social.moduleState.bots[index] = nextBot;
      }
      updated.push({ engineId: spec.engineId, key, bot: nextBot });
    }
    return updated;
  }

  function settingsPutBody(settings = {}, starterEngineBots = {}) {
    return {
      pins: Array.isArray(settings.pins) ? settings.pins : [],
      readMarks: settings.readMarks && typeof settings.readMarks === "object" ? settings.readMarks : {},
      mutedConversations: Array.isArray(settings.mutedConversations) ? settings.mutedConversations : [],
      unreadOverrides: settings.unreadOverrides && typeof settings.unreadOverrides === "object" ? settings.unreadOverrides : {},
      appearance: settings.appearance && typeof settings.appearance === "object" ? settings.appearance : {},
      tags: settings.tags && typeof settings.tags === "object" ? settings.tags : { items: [], assignments: {} },
      starterEngineBots,
      expectedVersion: Number(settings.version) || 0
    };
  }

  async function putStarterMarker({ api, social, settings, marker }) {
    const body = settingsPutBody(settings, marker);
    const response = await api.social.settingsPut(body);
    const updated = settingsFromResponse(response);
    if (updated && typeof updated === "object" && social?.moduleState) {
      social.moduleState.cloudSettings = updated;
    }
    return updated;
  }

  async function fetchSettings(api) {
    if (typeof api?.social?.settingsGet !== "function") return {};
    return settingsFromResponse(await api.social.settingsGet());
  }

  async function retryMarkerOnConflict({ api, social, marker, tagAssignments = [] }) {
    const latest = await fetchSettings(api);
    if (starterMarker(latest).seededAt) return latest;
    const settingsForWrite = tagAssignments.length
      ? { ...latest, tags: assignStarterConversationTags(latest, tagAssignments) }
      : latest;
    return putStarterMarker({ api, social, settings: settingsForWrite, marker });
  }

  function conversationIdFromSaveResult(result, fallbackKey = "") {
    return String(result?.conversation?.id || result?.data?.conversation?.id || (fallbackKey ? `botc_${fallbackKey}` : "")).trim();
  }

  function starterKeyForSpec(userId, spec = {}) {
    return starterBotKey(userId, spec.keySuffix || spec.engineId);
  }

  function assignStarterConversationTags(settings = {}, assignments = []) {
    const tagApi = conversationTagsShared();
    let tags = settings.tags && typeof settings.tags === "object" ? settings.tags : tagApi.defaultConversationTags();
    for (const assignment of assignments) {
      if (!assignment?.conversationId || !Array.isArray(assignment.tagNames) || !assignment.tagNames.length) continue;
      tags = tagApi.assignTagNames(tags, assignment.conversationId, assignment.tagNames);
    }
    return tagApi.normalizeConversationTags(tags);
  }

  async function ensureStarterEngineBots({
    state = {},
    api = global?.mia,
    social = global?.miaSocial,
    commands = global?.miaBotCommands,
    now = () => new Date().toISOString()
  } = {}) {
    if (!state.runtime?.cloud?.enabled) return { skipped: true, created: [] };
    if (typeof api?.social?.settingsGet !== "function") {
      return { skipped: true, created: [] };
    }

    const settings = await fetchSettings(api);
    const existingMarker = starterMarker(settings);
    const seededIds = seededStarterEngineIds(existingMarker);
    const allSpecs = starterBotSpecs(state.runtime);
    const backfillSpecs = starterIdentitySpecs(state.runtime);
    const existingBots = Array.isArray(social?.moduleState?.bots) ? social.moduleState.bots : [];
    const updated = await backfillStarterIdentity({ api, social, specs: backfillSpecs, existingBots });
    const specs = existingMarker.seededAt
      ? allSpecs.filter((spec) => spec.engineId === "cloud-claude-code" && !seededIds.has(spec.engineId))
      : allSpecs;
    if (!specs.length) {
      return updated.length ? { skipped: false, created: [], updated } : { skipped: true, created: [] };
    }
    if (typeof api?.social?.settingsPut !== "function" || typeof commands?.saveBot !== "function") {
      return updated.length ? { skipped: true, created: [], updated } : { skipped: true, created: [] };
    }

    const userId = social?.moduleState?.myUserId || state.runtime?.cloud?.user?.id || state.runtime?.cloud?.userId || "";
    const targetDeviceId = state.runtime?.localDevice?.id || state.runtime?.cloud?.deviceId || "";
    const targetDeviceName = state.runtime?.localDevice?.name || state.runtime?.cloud?.deviceName || "当前设备";
    const created = [];
    const tagAssignments = [];

    for (const spec of specs) {
      if (hasMatchingBot(spec, existingBots)) continue;
      const key = starterKeyForSpec(userId, spec);
      const runtimeKind = spec.runtimeKind || "desktop-local";
      const result = await commands.saveBot({
        state,
        api,
        social,
        runtimeKind,
        isCreate: true,
        bot: {
          key,
          name: spec.name,
          description: spec.description,
          bio: spec.bio,
          color: spec.color,
          avatarImage: spec.avatarImage || "",
          avatarCrop: Object.prototype.hasOwnProperty.call(spec, "avatarCrop") ? spec.avatarCrop : null,
          statusBadge: spec.statusBadge || null,
          personaText: spec.personaText,
          agentEngine: spec.agentEngine || spec.engineId,
          targetDeviceId: spec.targetDeviceId ?? targetDeviceId,
          targetDeviceName: spec.targetDeviceName ?? targetDeviceName,
          capabilities: { inheritEngineDefaults: true }
        }
      });
      if (spec.tagNames?.length) {
        const conversationId = conversationIdFromSaveResult(result, result?.key || key);
        if (conversationId) tagAssignments.push({ conversationId, tagNames: spec.tagNames });
      }
      created.push({ engineId: spec.engineId, key: result?.key || key, bot: result?.bot || null });
    }

    const marker = {
      seededAt: existingMarker.seededAt || now(),
      engineIds: [...new Set([
        ...[...seededIds],
        ...(existingMarker.seededAt ? specs : allSpecs).map((spec) => spec.engineId)
      ])]
    };
    const settingsForWrite = tagAssignments.length
      ? { ...settings, tags: assignStarterConversationTags(settings, tagAssignments) }
      : settings;
    try {
      await putStarterMarker({ api, social, settings: settingsForWrite, marker });
    } catch (error) {
      if (/409|version conflict/i.test(String(error?.message || ""))) {
        await retryMarkerOnConflict({ api, social, marker, tagAssignments });
      } else {
        throw error;
      }
    }

    return updated.length ? { skipped: false, created, updated } : { skipped: false, created };
  }

  const api = {
    STARTER_ENGINE_ORDER,
    normalizeEngineId,
    starterIdentitySpecs,
    starterEngineBotSpecs,
    starterBotSpecs,
    starterBotKey,
    ensureStarterEngineBots
  };

  global.miaStarterEngineBots = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
