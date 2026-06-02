// Fellow manifest + persona helpers (main process)
// Extracted from src/main.js. Owns the read-side of the on-disk fellow
// data:
//   - fellows/manifest.json (the list + each fellow's normalized record)
//   - fellows/<key>.md (each fellow's persona prompt body)
//   - fellows/<key>.fellow.json (metadata sidecar)
//
// Plus the normalization helpers used everywhere (normalizeFellow,
// normalizeFellowEngineConfig, mergeFellowEngineConfig, etc.).
//
// Write-side CRUD lives in fellow-service.js, which composes these record
// helpers with cloud sync, task cleanup, chat cleanup, and pet cleanup.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  normalizeCapabilityIds,
  normalizeFellowColor,
  normalizeFellowCapabilities
} = require("../shared/fellow-identity.js");

function createFellowManifest(deps = {}) {
  const {
    runtimePaths,
    readJson,
    normalizeAgentEngine,
    settingsStore,
  } = deps;

  function defaultFellowManifest() {
    // Empty by design — first launch goes through an onboarding flow that asks
    // the user to create their initial fellow. No pre-baked placeholder.
    return {
      schema_version: 1,
      product: "mia",
      default_fellow: "",
      fellows: []
    };
  }

  function normalizeFellowAgentEngine(value) {
    return normalizeAgentEngine(value);
  }

  function normalizeFellowEngineConfig(input = {}) {
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

  function mergeFellowEngineConfig(current = {}, update = {}) {
    const next = normalizeFellowEngineConfig(current);
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
    const manifest = defaultFellowManifest();
    return {
      schema_version: manifest.schema_version,
      product: manifest.product,
      default_persona: manifest.default_fellow,
      personas: manifest.fellows
    };
  }

  function normalizeFellow(item) {
    const key = String(item?.key || item?.account_id || "").trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "_");
    const name = String(item?.name || item?.display_name || key || "Mia").trim();
    if (!key || !name) return null;
    const pinnedAt = String(item?.pinnedAt || item?.pinned_at || "").trim();
    const mutedAt = String(item?.mutedAt || item?.muted_at || "").trim();
    return {
      key,
      name,
      account_id: String(item?.account_id || key).trim() || key,
      route_profile: String(item?.route_profile || item?.account_id || key).trim() || key,
      agentEngine: normalizeFellowAgentEngine(item?.agentEngine || item?.agent_engine || item?.engine),
      engineConfig: normalizeFellowEngineConfig(item?.engineConfig || item?.engine_config),
      platform: String(item?.platform || "api_server").trim() || "api_server",
      color: normalizeFellowColor(item?.color || item?.avatarColor || item?.avatar_color),
      avatarImage: String(item?.avatarImage || item?.avatar_image || "").trim(),
      avatarCrop: normalizeAvatarCrop(item?.avatarCrop || item?.avatar_crop),
      pinned: Boolean(item?.pinned || item?.is_pinned || pinnedAt),
      pinnedAt,
      muted: Boolean(item?.muted || item?.is_muted || mutedAt),
      mutedAt,
      bio: String(item?.bio || item?.description || "").trim(),
      personaText: String(item?.personaText || item?.persona_text || "").trim(),
      capabilities: normalizeFellowCapabilities(item?.capabilities)
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

  function normalizeFellowManifest(input) {
    const source = input && typeof input === "object" ? input : defaultFellowManifest();
    const rawFellows = Array.isArray(source.fellows)
      ? source.fellows
      : Array.isArray(source.personas)
        ? source.personas
        : defaultFellowManifest().fellows;
    const fellows = rawFellows.map(normalizeFellow).filter(Boolean);
    return {
      schema_version: 1,
      product: "mia",
      default_fellow: String(source.default_fellow || source.default_persona || fellows[0]?.key || ""),
      fellows
    };
  }

  function loadFellowManifest() {
    const p = runtimePaths();
    if (fs.existsSync(p.fellowManifest)) {
      return normalizeFellowManifest(readJson(p.fellowManifest, defaultFellowManifest()));
    }
    if (fs.existsSync(p.legacyPersonaManifest)) {
      return normalizeFellowManifest(readJson(p.legacyPersonaManifest, defaultManifest()));
    }
    return defaultFellowManifest();
  }

  function saveFellowManifest(manifest) {
    const p = runtimePaths();
    const normalized = normalizeFellowManifest(manifest);
    fs.mkdirSync(path.dirname(p.fellowManifest), { recursive: true });
    fs.writeFileSync(p.fellowManifest, JSON.stringify(normalized, null, 2) + "\n");
    return normalized;
  }

  function fellowPersonaBody(name, description = "") {
    return [
      `# ${name}`,
      "",
      `你是${name}，Mia App 里的 Fellow。`,
      description ? String(description).trim() : "请保持清楚、可靠、可执行的沟通风格。",
      ""
    ].join("\n");
  }

  function fellowMetadata(fellow) {
    return {
      account_id: fellow.key,
      display_name: fellow.name,
      agent_engine: normalizeFellowAgentEngine(fellow.agentEngine || fellow.agent_engine),
      engine_config: normalizeFellowEngineConfig(fellow.engineConfig || fellow.engine_config),
      color: normalizeFellowColor(fellow.color || fellow.avatarColor || fellow.avatar_color),
      avatar_image: fellow.avatarImage || "",
      avatar_crop: fellow.avatarCrop || { x: 50, y: 50, zoom: 1 },
      pinned: Boolean(fellow.pinned),
      pinned_at: fellow.pinnedAt || "",
      muted: Boolean(fellow.muted),
      muted_at: fellow.mutedAt || "",
      bio: fellow.bio || "",
      persona_text: fellow.personaText || "",
      capabilities: normalizeFellowCapabilities(fellow.capabilities),
      created_at: new Date().toISOString()
    };
  }

  function fellowPersonaPath(key) {
    return path.join(runtimePaths().fellowDir, `${String(key || "").trim()}.md`);
  }

  function readFellowPersona(key, fallbackName = "Mia", fallbackBio = "") {
    const personaPath = fellowPersonaPath(key);
    try {
      return fs.readFileSync(personaPath, "utf8");
    } catch {
      return fellowPersonaBody(fallbackName, fallbackBio);
    }
  }

  function fellowKeyFromName(name) {
    const slug = String(name || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40);
    if (slug) return slug;
    const hash = crypto.createHash("sha1").update(String(name || "fellow")).digest("hex").slice(0, 10);
    return `fellow_${hash}`;
  }

  return {
    defaultFellowManifest,
    normalizeFellowAgentEngine,
    normalizeFellowEngineConfig,
    mergeFellowEngineConfig,
    normalizeCapabilityIds,
    normalizeFellowCapabilities,
    defaultManifest,
    normalizeFellow,
    normalizeAvatarCrop,
    normalizeFellowManifest,
    loadFellowManifest,
    saveFellowManifest,
    fellowPersonaBody,
    fellowMetadata,
    fellowPersonaPath,
    readFellowPersona,
    fellowKeyFromName,
  };
}

module.exports = { createFellowManifest };
