(function attachStarterEngineBots(global) {
  "use strict";

  const STARTER_ENGINE_ORDER = ["hermes", "openclaw", "codex", "claude-code"];
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
    if (["claude", "claude_code", "claudecode"].includes(raw)) return "claude-code";
    if (["open-claw", "open_claw", "openclaw"].includes(raw)) return "openclaw";
    return raw;
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
          bio: meta.bio,
          description: meta.bio,
          personaText: meta.personaText
        };
      })
      .filter(Boolean);
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

  function hasMatchingBot(spec, bots = []) {
    return (Array.isArray(bots) ? bots : []).some((bot) =>
      botDisplayName(bot).toLowerCase() === spec.name.toLowerCase()
      && botEngineId(bot) === spec.engineId);
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

  async function retryMarkerOnConflict({ api, social, marker }) {
    const latest = await fetchSettings(api);
    if (starterMarker(latest).seededAt) return latest;
    return putStarterMarker({ api, social, settings: latest, marker });
  }

  async function ensureStarterEngineBots({
    state = {},
    api = global?.mia,
    social = global?.miaSocial,
    commands = global?.miaBotCommands,
    now = () => new Date().toISOString()
  } = {}) {
    if (!state.runtime?.cloud?.enabled) return { skipped: true, created: [] };
    if (typeof api?.social?.settingsGet !== "function" || typeof api?.social?.settingsPut !== "function") {
      return { skipped: true, created: [] };
    }
    if (typeof commands?.saveBot !== "function") return { skipped: true, created: [] };

    const settings = await fetchSettings(api);
    if (starterMarker(settings).seededAt) return { skipped: true, created: [] };

    const specs = starterEngineBotSpecs(state.runtime);
    if (!specs.length) return { skipped: true, created: [] };

    const existingBots = Array.isArray(social?.moduleState?.bots) ? social.moduleState.bots : [];
    const userId = social?.moduleState?.myUserId || state.runtime?.cloud?.user?.id || state.runtime?.cloud?.userId || "";
    const targetDeviceId = state.runtime?.localDevice?.id || state.runtime?.cloud?.deviceId || "";
    const targetDeviceName = state.runtime?.localDevice?.name || state.runtime?.cloud?.deviceName || "当前设备";
    const created = [];

    for (const spec of specs) {
      if (hasMatchingBot(spec, existingBots)) continue;
      const result = await commands.saveBot({
        state,
        api,
        social,
        runtimeKind: "desktop-local",
        isCreate: true,
        bot: {
          key: starterBotKey(userId, spec.engineId),
          name: spec.name,
          description: spec.description,
          bio: spec.bio,
          color: spec.color,
          personaText: spec.personaText,
          agentEngine: spec.engineId,
          targetDeviceId,
          targetDeviceName,
          capabilities: { inheritEngineDefaults: true }
        }
      });
      created.push({ engineId: spec.engineId, key: result?.key || starterBotKey(userId, spec.engineId), bot: result?.bot || null });
    }

    const marker = { seededAt: now(), engineIds: specs.map((spec) => spec.engineId) };
    try {
      await putStarterMarker({ api, social, settings, marker });
    } catch (error) {
      if (/409|version conflict/i.test(String(error?.message || ""))) {
        await retryMarkerOnConflict({ api, social, marker });
      } else {
        throw error;
      }
    }

    return { skipped: false, created };
  }

  const api = {
    STARTER_ENGINE_ORDER,
    normalizeEngineId,
    starterEngineBotSpecs,
    starterBotKey,
    ensureStarterEngineBots
  };

  global.miaStarterEngineBots = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
