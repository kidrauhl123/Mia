// Bot manifest + persona helpers (main process)
// Extracted from src/main.js. Owns the read-side of the on-disk bot
// data:
//   - bots/manifest.json (the list + each bot's normalized record)
//   - bots/<key>.md (each bot's persona prompt body)
//   - bots/<key>.bot.json (metadata sidecar)
//
// Plus the normalization helpers used everywhere (normalizeBot,
// normalizeBotEngineConfig, mergeBotEngineConfig, etc.).
//
// Write-side CRUD lives in bot-service.js, which composes these record
// helpers with cloud sync, task cleanup, chat cleanup, and pet cleanup.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  normalizeCapabilityIds,
  normalizeBotColor,
  normalizeBotCapabilities
} = require("../shared/bot-identity.js");

function createBotManifest(deps = {}) {
  const {
    runtimePaths,
    readJson,
    normalizeAgentEngine,
    settingsStore,
  } = deps;

  function defaultBotManifest() {
    // Empty by design — first launch goes through an onboarding flow that asks
    // the user to create their initial bot. No pre-baked placeholder.
    return {
      schema_version: 1,
      product: "mia",
      default_bot: "",
      bots: []
    };
  }

  function normalizeBotAgentEngine(value) {
    return normalizeAgentEngine(value);
  }

  function normalizeBotEngineConfig(input = {}) {
    const value = input && typeof input === "object" ? input : {};
    const next = {};
    const model = String(value.model || "").trim();
    const permissionMode = String(value.permissionMode || value.permission_mode || "").trim();
    const effortLevel = String(value.effortLevel || value.effort_level || value.reasoningEffort || value.reasoning_effort || "").trim();
    if (model) next.model = model;
    if (permissionMode) next.permissionMode = permissionMode;
    if (effortLevel) next.effortLevel = settingsStore.normalizeStoredEffortLevel(effortLevel);
    return next;
  }

  function mergeBotEngineConfig(current = {}, update = {}) {
    const next = normalizeBotEngineConfig(current);
    if (Object.prototype.hasOwnProperty.call(update || {}, "model")) {
      const model = String(update.model || "").trim();
      if (model) next.model = model;
      else delete next.model;
    }
    if (Object.prototype.hasOwnProperty.call(update || {}, "permissionMode")
      || Object.prototype.hasOwnProperty.call(update || {}, "permission_mode")) {
      const permissionMode = String(update.permissionMode || update.permission_mode || "").trim();
      if (permissionMode) next.permissionMode = permissionMode;
      else delete next.permissionMode;
    }
    if (Object.prototype.hasOwnProperty.call(update || {}, "effortLevel")
      || Object.prototype.hasOwnProperty.call(update || {}, "effort_level")
      || Object.prototype.hasOwnProperty.call(update || {}, "reasoningEffort")
      || Object.prototype.hasOwnProperty.call(update || {}, "reasoning_effort")) {
      const effortLevel = String(update.effortLevel || update.effort_level || update.reasoningEffort || update.reasoning_effort || "").trim();
      if (effortLevel) next.effortLevel = settingsStore.normalizeStoredEffortLevel(effortLevel);
      else delete next.effortLevel;
    }
    return next;
  }

  function defaultManifest() {
    const manifest = defaultBotManifest();
    return {
      schema_version: manifest.schema_version,
      product: manifest.product,
      default_bot: manifest.default_bot,
      bots: manifest.bots
    };
  }

  function normalizeBot(item) {
    const key = String(item?.key || item?.id || item?.account_id || "").trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "_");
    const name = String(item?.name || item?.displayName || item?.display_name || key || "Mia").trim();
    if (!key || !name) return null;
    const pinnedAt = String(item?.pinnedAt || item?.pinned_at || "").trim();
    const mutedAt = String(item?.mutedAt || item?.muted_at || "").trim();
    return {
      key,
      name,
      account_id: String(item?.account_id || key).trim() || key,
      route_profile: String(item?.route_profile || item?.account_id || key).trim() || key,
      agentEngine: normalizeBotAgentEngine(item?.agentEngine || item?.agent_engine || item?.engine),
      engineConfig: normalizeBotEngineConfig(item?.engineConfig || item?.engine_config),
      platform: String(item?.platform || "api_server").trim() || "api_server",
      color: normalizeBotColor(item?.color || item?.avatarColor || item?.avatar_color),
      avatarImage: String(item?.avatarImage || item?.avatar_image || "").trim(),
      avatarCrop: normalizeAvatarCrop(item?.avatarCrop || item?.avatar_crop),
      pinned: Boolean(item?.pinned || item?.is_pinned || pinnedAt),
      pinnedAt,
      muted: Boolean(item?.muted || item?.is_muted || mutedAt),
      mutedAt,
      bio: String(item?.bio || item?.description || "").trim(),
      personaText: String(item?.personaText || item?.persona_text || "").trim(),
      capabilities: normalizeBotCapabilities(item?.capabilities)
    };
  }

  function normalizeAvatarCrop(input = {}) {
    const value = input && typeof input === "object" ? input : {};
    const num = (raw, fallback, min, max) => {
      const next = Number(raw);
      if (!Number.isFinite(next)) return fallback;
      return Math.max(min, Math.min(max, next));
    };
    const normalized = {
      x: num(value.x, 50, 0, 100),
      y: num(value.y, 50, 0, 100),
      zoom: num(value.zoom, 1, 1, 2.4)
    };
    if (
      Object.prototype.hasOwnProperty.call(value, "start")
      || Object.prototype.hasOwnProperty.call(value, "duration")
      || Object.prototype.hasOwnProperty.call(value, "trimStart")
      || Object.prototype.hasOwnProperty.call(value, "trimDuration")
    ) {
      normalized.start = Math.round(Math.max(0, Number(value.start ?? value.trimStart ?? 0) || 0) * 100) / 100;
      const duration = Number(value.duration ?? value.trimDuration ?? 3);
      normalized.duration = Math.round(Math.max(1, Math.min(5, Number.isFinite(duration) ? duration : 3)) * 100) / 100;
    }
    return normalized;
  }

  function normalizeBotManifest(input) {
    const source = input && typeof input === "object" ? input : defaultBotManifest();
    const rawBots = Array.isArray(source.bots)
      ? source.bots
      : defaultBotManifest().bots;
    const bots = rawBots.map(normalizeBot).filter(Boolean);
    return {
      schema_version: 1,
      product: "mia",
      default_bot: String(source.default_bot || bots[0]?.key || ""),
      bots
    };
  }

  function loadBotManifest() {
    const p = runtimePaths();
    if (fs.existsSync(p.botManifest)) {
      return normalizeBotManifest(readJson(p.botManifest, defaultBotManifest()));
    }
    return defaultBotManifest();
  }

  function saveBotManifest(manifest) {
    const p = runtimePaths();
    const normalized = normalizeBotManifest(manifest);
    fs.mkdirSync(path.dirname(p.botManifest), { recursive: true });
    fs.writeFileSync(p.botManifest, JSON.stringify(normalized, null, 2) + "\n");
    return normalized;
  }

  function botPersonaBody(name, description = "") {
    return [
      `# ${name}`,
      "",
      `你是${name}，Mia App 里的 Bot。`,
      description ? String(description).trim() : "请保持清楚、可靠、可执行的沟通风格。",
      ""
    ].join("\n");
  }

  function botMetadata(bot) {
    return {
      account_id: bot.key,
      display_name: bot.name,
      agent_engine: normalizeBotAgentEngine(bot.agentEngine || bot.agent_engine),
      engine_config: normalizeBotEngineConfig(bot.engineConfig || bot.engine_config),
      color: normalizeBotColor(bot.color || bot.avatarColor || bot.avatar_color),
      avatar_image: bot.avatarImage || "",
      avatar_crop: bot.avatarCrop || { x: 50, y: 50, zoom: 1 },
      pinned: Boolean(bot.pinned),
      pinned_at: bot.pinnedAt || "",
      muted: Boolean(bot.muted),
      muted_at: bot.mutedAt || "",
      bio: bot.bio || "",
      persona_text: bot.personaText || "",
      capabilities: normalizeBotCapabilities(bot.capabilities),
      created_at: new Date().toISOString()
    };
  }

  function botPersonaPath(key) {
    return path.join(runtimePaths().botDir, `${String(key || "").trim()}.md`);
  }

  function readBotPersona(key, fallbackName = "Mia", fallbackBio = "") {
    const personaPath = botPersonaPath(key);
    try {
      return fs.readFileSync(personaPath, "utf8");
    } catch {
      return botPersonaBody(fallbackName, fallbackBio);
    }
  }

  function botKeyFromName(name) {
    const slug = String(name || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40);
    if (slug) return slug;
    const hash = crypto.createHash("sha1").update(String(name || "bot")).digest("hex").slice(0, 10);
    return `bot_${hash}`;
  }

  return {
    defaultBotManifest,
    normalizeBotAgentEngine,
    normalizeBotEngineConfig,
    mergeBotEngineConfig,
    normalizeCapabilityIds,
    normalizeBotCapabilities,
    defaultManifest,
    normalizeBot,
    normalizeAvatarCrop,
    normalizeBotManifest,
    loadBotManifest,
    saveBotManifest,
    botPersonaBody,
    botMetadata,
    botPersonaPath,
    readBotPersona,
    botKeyFromName,
  };
}

module.exports = { createBotManifest };
