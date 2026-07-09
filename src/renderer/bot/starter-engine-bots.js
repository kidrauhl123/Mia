(function attachStarterEngineBots(global) {
  "use strict";

  const STARTER_ENGINE_ORDER = ["hermes", "codex", "claude-code"];
  const STARTER_STATUS_BADGE_IDS = Object.freeze({
    "cloud-claude-code": "rainbow-fire",
    hermes: "blue-fire",
    codex: "cyan-fire",
    "claude-code": "red-orange-fire"
  });
  const STARTER_AVATAR_IMAGES = Object.freeze({
    "cloud-claude-code": "./assets/mia-logo.png",
    hermes: "./assets/engine-icons/hermesagent.svg",
    codex: "./assets/engine-icons/codex-color.svg",
    "claude-code": "./assets/engine-icons/claudecode.svg"
  });
  const STALE_STARTER_AVATAR_IMAGES = Object.freeze({
    "./assets/engine-icons/hermesagent-starter.svg": "./assets/engine-icons/hermesagent.svg",
    "./assets/engine-icons/claudecode-starter.svg": "./assets/engine-icons/claudecode.svg"
  });
  const STARTER_ENGINE_META = Object.freeze({
    hermes: {
      name: "Hermes",
      color: "#2563eb",
      bio: "连接本机 Hermes，处理日常任务、文件和自动化。",
      personaText: "你是 Hermes。优先用本机可用能力推进用户的日常任务、文件处理和自动化请求。"
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
    const raw = String(value || "").trim().toLowerCase().replace(/_/g, "-");
    if (!raw) return "";
    if (["cloud-claude-code", "mia-cloud", "miacloud"].includes(raw)) return "cloud-claude-code";
    if (["claude", "claude-code", "claudecode"].includes(raw)) return "claude-code";
    if (raw === "openai-codex") return "codex";
    return raw;
  }

  function statusBadgeAssetsShared() {
    if (global?.miaStatusBadgeAssets) return global.miaStatusBadgeAssets;
    if (typeof require === "function") {
      try { return require("../../../packages/shared/status-badge-assets.js"); } catch { /* browser fallback below */ }
    }
    return null;
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

  function normalizeStarterAvatarImage(value = "") {
    const image = String(value || "").trim();
    return STALE_STARTER_AVATAR_IMAGES[image] || image;
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
      return { id: "claude-code", usableInMia: Boolean(engines.claudeCode?.available || engines["claude-code"]?.available) };
    }
    if (engineId === "codex") {
      return { id: "codex", usableInMia: Boolean(engines.codex?.available || engines.codex?.installed) };
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
          label: String(agent.label || meta.name || engineId).trim(),
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

  function cloudStarterSpec(runtime = {}) {
    const cloudRuntime = global.miaCloudRuntime?.cloudAgentRuntimeFromCloud?.(runtime.cloud || runtime) || {};
    if (!cloudRuntime.available || !cloudRuntime.agentEngine) return null;
    const cloudLabel = cloudRuntime.label || "Claude Code";
    return {
      engineId: "cloud-claude-code",
      keySuffix: "mia",
      runtimeKind: "cloud-claude-code",
      agentEngine: cloudRuntime.agentEngine,
      name: "Mia",
      color: "#16a34a",
      targetDeviceId: "",
      targetDeviceName: "Mia Cloud",
      avatarImage: starterAvatarImage("cloud-claude-code"),
      avatarCrop: null,
      bio: `云端 ${cloudLabel}，随时可用，不依赖本机 Agent。`,
      description: `Mia 云端助手，默认使用云端 ${cloudLabel} sandbox。`,
      personaText: `你是 Mia。用云端 ${cloudLabel} sandbox 简洁、可靠地帮助用户处理日常问题、创作、信息整理和自动化请求。`,
      statusBadge: starterStatusBadge("cloud-claude-code"),
      tagNames: ["云端"]
    };
  }

  function starterIdentitySpecs(runtime = {}) {
    const cloud = cloudStarterSpec(runtime);
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
    return [...(cloud ? [cloud] : []), ...localSpecs];
  }

  function starterBotSpecs(runtime = {}) {
    const cloud = cloudStarterSpec(runtime);
    return [...(cloud ? [cloud] : []), ...starterEngineBotSpecs(runtime)];
  }

  function coreBotRecord(summary = {}) {
    const identity = summary.identity && typeof summary.identity === "object" ? summary.identity : {};
    const capabilities = summary.capabilities && typeof summary.capabilities === "object" ? summary.capabilities : {};
    const key = String(summary.key || summary.id || "").trim();
    const name = String(identity.name || summary.displayName || summary.display_name || key).trim();
    const avatarImage = normalizeStarterAvatarImage(identity.avatarImage || identity.avatar_image || "");
    return {
      ...identity,
      ...(avatarImage ? { avatarImage } : {}),
      key,
      id: key,
      displayName: summary.displayName || summary.display_name || name,
      name,
      capabilities,
      sourceKinds: ["cloud"],
      runtimeKind: identity.runtimeKind || identity.runtime_kind || "",
      agentEngine: identity.agentEngine || identity.agent_engine || ""
    };
  }

  function hydrateSocialCacheFromCoreResponse(social, result = {}) {
    if (!social?.moduleState) return;
    if (result.settings && typeof result.settings === "object") {
      social.moduleState.cloudSettings = result.settings;
    }
    const entries = [
      ...(Array.isArray(result.created) ? result.created : []),
      ...(Array.isArray(result.updated) ? result.updated : [])
    ];
    if (!entries.length) return;
    const bots = Array.isArray(social.moduleState.bots) ? social.moduleState.bots : [];
    const byKey = new Map(bots.map((bot) => [String(bot?.key || bot?.id || ""), bot]));
    for (const entry of entries) {
      const record = coreBotRecord(entry.bot || {});
      if (!record.key) continue;
      byKey.set(record.key, { ...(byKey.get(record.key) || {}), ...record });
    }
    social.moduleState.bots = [...byKey.values()];
  }

  function socialApi(api = global?.mia) {
    return api?.social || api || null;
  }

  async function ensureStarterEngineBots({
    state = {},
    api = global?.mia,
    social = global?.miaSocial,
    now = () => new Date().toISOString()
  } = {}) {
    if (!state.runtime?.cloud?.enabled) return { skipped: true, created: [] };
    const socialBridge = socialApi(api);
    if (typeof socialBridge?.ensureStarterEngineBots !== "function") {
      return { skipped: true, created: [] };
    }
    const response = await socialBridge.ensureStarterEngineBots({
      runtime: state.runtime || {},
      userId: social?.moduleState?.myUserId || state.runtime?.cloud?.user?.id || state.runtime?.cloud?.userId || "",
      now: typeof now === "function" ? now() : undefined
    });
    if (response && response.ok === false) {
      throw new Error(response.error || "初始化 Starter Bot 失败");
    }
    const result = response?.data && typeof response.data === "object" ? response.data : (response || {});
    hydrateSocialCacheFromCoreResponse(social, result);
    return result;
  }

  const api = {
    STARTER_ENGINE_ORDER,
    normalizeEngineId,
    starterIdentitySpecs,
    starterEngineBotSpecs,
    starterBotSpecs,
    ensureStarterEngineBots
  };

  global.miaStarterEngineBots = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
