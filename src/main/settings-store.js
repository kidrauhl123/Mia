// Settings store (main process)
// Extracted from src/main.js. Owns the on-disk settings JSON files —
// model / profile / appearance / permission / effort / daemon /
// cloud — including defaults, normalization, read, and write.
//
// CloudWorkspace JSON cache lives here too. daemonToken stays in main.js
// because it's an auth primitive that wires into HTTP/IPC authorization, not a
// user setting.

const fs = require("node:fs");
const path = require("node:path");

const { normalizeAgentEngine } = require("./chat-engine-registry");
const { normalizePermissionMode, permissionModeLabel } = require("../permission-modes");
const {
  enginePermissionStoreTarget,
  normalizeEnginePermissionMode
} = require("../shared/agent-engine-policy");

const APPEARANCE_FONT_PRESETS = ["system", "serif"];
const ATOMIC_REPLACE_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function defaultSleepSync(delayMs) {
  const ms = Math.max(0, Number(delayMs) || 0);
  if (!ms) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* fallback sleep */ }
  }
}

function isRetryableAtomicReplaceError(error) {
  return ATOMIC_REPLACE_RETRY_CODES.has(String(error?.code || ""));
}

function atomicReplaceJsonSync({
  fsImpl,
  targetPath,
  value,
  mode = 0o600,
  retries = 8,
  retryDelayMs = 25,
  sleepSync = defaultSleepSync
}) {
  const dir = path.dirname(targetPath);
  fsImpl.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  fsImpl.writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\n", { mode });
  for (let attempt = 0; ; attempt += 1) {
    try {
      fsImpl.renameSync(tmpPath, targetPath);
      return;
    } catch (error) {
      if (attempt >= retries || !isRetryableAtomicReplaceError(error)) {
        try { fsImpl.unlinkSync(tmpPath); } catch { /* best effort */ }
        throw error;
      }
      sleepSync(retryDelayMs * (attempt + 1));
    }
  }
}

function normalizeAppearanceFontPreset(value) {
  const preset = String(value || "").trim();
  return APPEARANCE_FONT_PRESETS.includes(preset) ? preset : "system";
}

function normalizeAppearanceBackgroundImage(value) {
  return "";
}

function normalizeAppearanceSelectionStyle() {
  return "solid";
}

function createSettingsStore(deps = {}) {
  const {
    runtimePaths,
    readJson,
    writeRuntimeConfig,
    readConfiguredPort,
    // `getEngineState` accessor: writeEffortSettings and Hermes permission
    // writes call writeRuntimeConfig(engineState.port || readConfiguredPort()),
    // and main.js reassigns engineState on every Hermes restart — capturing
    // the object would go stale.
    getEngineState,
    MIA_DAEMON_DEFAULT_PORT,
    MIA_CLOUD_DEFAULT_URL,
    normalizeAvatarCrop = (crop) => crop || defaultUserProfile().avatarCrop,
    env = process.env,
    fsImpl = fs,
    sleepSync = defaultSleepSync,
  } = deps;

  function defaultModelSettings() {
    return {
      provider: "",
      model: "",
      apiKeyEnv: "",
      apiKey: "",
      baseUrl: "",
      apiMode: ""
    };
  }

  function defaultUserProfile() {
    return {
      displayName: "",
      avatarText: "",
      // Empty = no user-set accent color → the avatar/name fall back to the id
      // hash. Only a color chosen in the profile editor is stored here.
      avatarColor: "",
      avatarImage: "",
      avatarCrop: { x: 50, y: 50, zoom: 1 },
      statusBadge: null
    };
  }

  function defaultAppearanceSettings() {
    return {
      theme: "light",
      fontPreset: "system",
      accentColor: "#318ad3",
      userBubbleColor: "#eeffde",
      showUserAvatar: false,
      showAssistantAvatar: false,
      showDesktopNotifications: true,
      listStyle: "card",
      selectionStyle: "solid",
      workspaceBackgroundColor: "",
      workspaceBackgroundImage: ""
    };
  }

  function defaultWindowSettings() {
    return {
      bounds: null,
      maximized: false
    };
  }

  function normalizeWindowBounds(bounds) {
    if (!bounds || typeof bounds !== "object") return null;
    const width = Number(bounds.width);
    const height = Number(bounds.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    const next = {
      width: Math.round(width),
      height: Math.round(height)
    };
    const x = Number(bounds.x);
    const y = Number(bounds.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      next.x = Math.round(x);
      next.y = Math.round(y);
    }
    return next;
  }

  function windowSettings() {
    const p = runtimePaths();
    const saved = readJson(p.windowSettings, {});
    return {
      bounds: normalizeWindowBounds(saved.bounds),
      maximized: Boolean(saved.maximized)
    };
  }

  function writeWindowSettings(settings = {}) {
    const p = runtimePaths();
    const current = windowSettings();
    const next = {
      bounds: Object.prototype.hasOwnProperty.call(settings, "bounds")
        ? normalizeWindowBounds(settings.bounds)
        : current.bounds,
      maximized: Object.prototype.hasOwnProperty.call(settings, "maximized")
        ? Boolean(settings.maximized)
        : current.maximized
    };
    fs.mkdirSync(path.dirname(p.windowSettings), { recursive: true });
    fs.writeFileSync(p.windowSettings, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    return next;
  }

  function userProfile() {
    const p = runtimePaths();
    return { ...defaultUserProfile(), ...readJson(p.userProfile, {}) };
  }

  function writeUserProfile(profile = {}) {
    const p = runtimePaths();
    const current = userProfile();
    const has = (key) => Object.prototype.hasOwnProperty.call(profile, key);
    const next = {
      displayName: String(has("displayName") ? profile.displayName : current.displayName).trim(),
      avatarText: String(has("avatarText") ? profile.avatarText : current.avatarText).trim().slice(0, 2).toUpperCase(),
      avatarColor: String(has("avatarColor") ? profile.avatarColor : current.avatarColor).trim(),
      avatarImage: String(has("avatarImage") ? profile.avatarImage : current.avatarImage).trim(),
      avatarCrop: normalizeAvatarCrop(has("avatarCrop") ? profile.avatarCrop : current.avatarCrop),
      statusBadge: has("statusBadge") ? (profile.statusBadge || null) : (current.statusBadge || null)
    };
    fs.mkdirSync(path.dirname(p.userProfile), { recursive: true });
    fs.writeFileSync(p.userProfile, JSON.stringify(next, null, 2) + "\n");
    return next;
  }

  function appearanceSettings() {
    const p = runtimePaths();
    const saved = readJson(p.appearanceSettings, {});
    const next = { ...defaultAppearanceSettings(), ...saved };
    next.fontPreset = normalizeAppearanceFontPreset(next.fontPreset);
    next.listStyle = "card";
    next.selectionStyle = normalizeAppearanceSelectionStyle(next.selectionStyle);
    delete next.showHoverBackground;
    delete next.glassOpacity;
    next.showDesktopNotifications = next.showDesktopNotifications !== false;
    next.workspaceBackgroundImage = "";
    return next;
  }

  function writeAppearanceSettings(settings = {}) {
    const p = runtimePaths();
    const current = appearanceSettings();
    const has = (key) => Object.prototype.hasOwnProperty.call(settings, key);
    const theme = String(settings.theme || current.theme || "light").trim();
    const fontPreset = String(settings.fontPreset || current.fontPreset || "system").trim();
    const accentColor = String(settings.accentColor || current.accentColor || "#318ad3").trim();
    const userBubbleColor = String(settings.userBubbleColor || current.userBubbleColor || "#eeffde").trim();
    const showUserAvatar = settings.showUserAvatar == null ? current.showUserAvatar === true : settings.showUserAvatar === true;
    const showAssistantAvatar = settings.showAssistantAvatar == null ? current.showAssistantAvatar === true : settings.showAssistantAvatar === true;
    const showDesktopNotifications = has("showDesktopNotifications")
      ? settings.showDesktopNotifications !== false
      : current.showDesktopNotifications !== false;
    const validHex = (value, fallback) => /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : fallback;
    const workspaceBackgroundColorInput = String(has("workspaceBackgroundColor") ? settings.workspaceBackgroundColor : (current.workspaceBackgroundColor || "")).trim();
    const workspaceBackgroundImageInput = has("workspaceBackgroundImage") ? settings.workspaceBackgroundImage : (current.workspaceBackgroundImage || "");
    const next = {
      theme: ["light", "dark"].includes(theme) ? theme : "light",
      fontPreset: normalizeAppearanceFontPreset(fontPreset),
      accentColor: validHex(accentColor, "#318ad3"),
      userBubbleColor: validHex(userBubbleColor, "#eeffde"),
      showUserAvatar,
      showAssistantAvatar,
      showDesktopNotifications,
      listStyle: "card",
      selectionStyle: normalizeAppearanceSelectionStyle(settings.selectionStyle || current.selectionStyle),
      workspaceBackgroundColor: workspaceBackgroundColorInput ? validHex(workspaceBackgroundColorInput, "") : "",
      workspaceBackgroundImage: normalizeAppearanceBackgroundImage(workspaceBackgroundImageInput)
    };
    fs.mkdirSync(path.dirname(p.appearanceSettings), { recursive: true });
    fs.writeFileSync(p.appearanceSettings, JSON.stringify(next, null, 2) + "\n");
    return next;
  }

  // Persisted override for the agent working directory. Empty path means "use
  // the Mia-owned default workspace" (see main agentWorkspaceDir).
  function agentWorkspace() {
    const p = runtimePaths();
    const saved = readJson(p.workspaceSettings, {});
    return { path: String(saved?.path || "").trim() };
  }

  function writeAgentWorkspace(workspacePath) {
    const p = runtimePaths();
    const next = { path: String(workspacePath || "").trim() };
    fs.mkdirSync(path.dirname(p.workspaceSettings), { recursive: true });
    fs.writeFileSync(p.workspaceSettings, JSON.stringify(next, null, 2) + "\n");
    return next;
  }

  function defaultPermissionSettings() {
    return {
      mode: "ask",
      engines: {}
    };
  }

  function normalizePermissionEngines(value = {}) {
    const source = value && typeof value === "object" ? value : {};
    const engines = {};
    for (const [engine, mode] of Object.entries(source)) {
      const normalizedEngine = normalizeAgentEngine(engine);
      if (!normalizedEngine || enginePermissionStoreTarget(normalizedEngine) !== "engine-map") continue;
      engines[normalizedEngine] = normalizeEnginePermissionMode(normalizedEngine, mode);
    }
    return engines;
  }

  function defaultDaemonSettings() {
    const port = Number.isInteger(MIA_DAEMON_DEFAULT_PORT) && MIA_DAEMON_DEFAULT_PORT > 0
      ? MIA_DAEMON_DEFAULT_PORT
      : 27861;
    return {
      enabled: true,
      host: env.MIA_DAEMON_HOST || "127.0.0.1",
      port
    };
  }

  function defaultEffortSettings() {
    return {
      level: "medium"
    };
  }

  function defaultMemorySettings() {
    return {
      enabled: true
    };
  }

  function memorySettings() {
    const saved = readJson(runtimePaths().memorySettings, {});
    return {
      ...defaultMemorySettings(),
      ...saved,
      enabled: saved.enabled !== false
    };
  }

  function writeMemorySettings(settings = {}) {
    const p = runtimePaths();
    const current = memorySettings();
    const next = {
      enabled: Object.prototype.hasOwnProperty.call(settings, "enabled")
        ? settings.enabled !== false
        : current.enabled !== false
    };
    fs.mkdirSync(path.dirname(p.memorySettings), { recursive: true });
    fs.writeFileSync(p.memorySettings, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    return next;
  }

  function normalizeEffortLevel(value, engine = "hermes") {
    const raw = String(value || "").trim().toLowerCase();
    const normalized = raw === "extra-high" || raw === "extra_high" ? "xhigh" : raw;
    const engineId = String(engine || "hermes").trim().toLowerCase().replace(/_/g, "-");
    const openClawValue = engineId === "openclaw" && normalized === "none" ? "off" : normalized;
    const valid = engineId === "claude-code"
      ? ["low", "medium", "high", "xhigh", "max"]
      : engineId === "codex"
        ? ["minimal", "low", "medium", "high", "xhigh"]
        : engineId === "openclaw"
          ? ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max"]
          : ["none", "minimal", "low", "medium", "high", "xhigh"];
    return valid.includes(openClawValue) ? openClawValue : (engineId === "openclaw" ? "off" : "medium");
  }

  function normalizeStoredEffortLevel(value) {
    const raw = String(value || "").trim().toLowerCase();
    const normalized = raw === "extra-high" || raw === "extra_high" ? "xhigh" : raw;
    return ["off", "none", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max"].includes(normalized) ? normalized : "medium";
  }

  function effortSettings() {
    const p = runtimePaths();
    const saved = readJson(p.effortSettings, {});
    return {
      ...defaultEffortSettings(),
      ...saved,
      level: normalizeEffortLevel(saved.level || defaultEffortSettings().level, "hermes")
    };
  }

  function effortStatus() {
    return { level: effortSettings().level };
  }

  function writeEffortSettings(settings = {}) {
    const p = runtimePaths();
    const next = {
      level: normalizeEffortLevel(settings.level || settings.effortLevel, "hermes")
    };
    fs.mkdirSync(path.dirname(p.effortSettings), { recursive: true });
    fs.writeFileSync(p.effortSettings, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    writeRuntimeConfig(getEngineState()?.port || readConfiguredPort());
    return next;
  }

  function permissionSettings() {
    const p = runtimePaths();
    const saved = readJson(p.permissionSettings, {});
    const mode = normalizePermissionMode(saved.mode || defaultPermissionSettings().mode);
    return {
      ...defaultPermissionSettings(),
      ...saved,
      mode,
      engines: normalizePermissionEngines(saved.engines)
    };
  }

  function permissionStatus() {
    const settings = permissionSettings();
    return {
      mode: settings.mode,
      engines: settings.engines,
      label: permissionModeLabel(settings.mode)
    };
  }

  function writePermissionSettings(settings = {}) {
    const p = runtimePaths();
    const current = permissionSettings();
    const engine = String(settings.engine || settings.agentEngine || settings.agent_engine || "").trim();
    const normalizedEngine = engine ? normalizeAgentEngine(engine) : "";
    const engines = { ...(current.engines || {}) };
    let mode = current.mode;
    const storeTarget = enginePermissionStoreTarget(normalizedEngine || "hermes");
    if (normalizedEngine && storeTarget === "engine-map") {
      engines[normalizedEngine] = normalizeEnginePermissionMode(normalizedEngine, settings.mode);
    } else {
      mode = normalizePermissionMode(settings.mode);
    }
    const next = {
      mode,
      engines: normalizePermissionEngines(engines)
    };
    fs.mkdirSync(path.dirname(p.permissionSettings), { recursive: true });
    fs.writeFileSync(p.permissionSettings, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    if (storeTarget === "root-mode") writeRuntimeConfig(getEngineState()?.port || readConfiguredPort());
    return next;
  }

  function enginePermissionMode(engine = "hermes") {
    const normalizedEngine = normalizeAgentEngine(engine);
    const settings = permissionSettings();
    if (enginePermissionStoreTarget(normalizedEngine) === "root-mode") return settings.mode;
    return normalizeEnginePermissionMode(
      normalizedEngine,
      settings.engines?.[normalizedEngine] || "default"
    );
  }

  function normalizeDaemonHost(value) {
    const host = String(value || "").trim();
    if (host === "0.0.0.0" || host === "::" || host === "127.0.0.1" || host === "localhost") return host;
    return "127.0.0.1";
  }

  function normalizeDaemonPort(value) {
    const port = Number(value);
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
    return defaultDaemonSettings().port;
  }

  function daemonSettings() {
    const saved = readJson(runtimePaths().daemonSettings, {});
    return {
      ...defaultDaemonSettings(),
      ...saved,
      enabled: true,
      host: normalizeDaemonHost(saved.host || defaultDaemonSettings().host),
      port: normalizeDaemonPort(saved.port || defaultDaemonSettings().port)
    };
  }

  function writeDaemonSettings(settings = {}) {
    const p = runtimePaths();
    const current = daemonSettings();
    const next = {
      enabled: true,
      host: normalizeDaemonHost(settings.host || current.host),
      port: normalizeDaemonPort(settings.port || current.port)
    };
    fs.mkdirSync(path.dirname(p.daemonSettings), { recursive: true });
    fs.writeFileSync(p.daemonSettings, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    return next;
  }

  function defaultCloudSettings() {
    return {
      enabled: false,
      url: MIA_CLOUD_DEFAULT_URL,
      token: "",
      user: null,
      agentRuntime: null,
      lastMemorySyncAt: ""
    };
  }

  function normalizeCloudUrl(value) {
    const raw = String(value || "").trim();
    try {
      const url = new URL(raw || MIA_CLOUD_DEFAULT_URL);
      if (url.protocol !== "http:" && url.protocol !== "https:") return MIA_CLOUD_DEFAULT_URL;
      url.hash = "";
      url.search = "";
      url.pathname = url.pathname.replace(/\/+$/, "");
      return url.toString().replace(/\/$/, "");
    } catch {
      return MIA_CLOUD_DEFAULT_URL;
    }
  }

  function cloudSettings() {
    const saved = readJson(runtimePaths().cloudSettings, {});
    return {
      ...defaultCloudSettings(),
      ...saved,
      enabled: Boolean(saved.enabled && saved.token),
      url: normalizeCloudUrl(saved.url),
      token: String(saved.token || ""),
      user: saved.user && typeof saved.user === "object" ? saved.user : null,
      agentRuntime: saved.agentRuntime && typeof saved.agentRuntime === "object" ? saved.agentRuntime : null,
      // Tracks the last user_events.seq this device has applied. Sent on
      // every WS connect via `?since_seq=N`; server replays everything
      // newer so disconnect/reconnect/replay is transparent (Phase 1.C).
      lastEventSeq: Number.isFinite(Number(saved.lastEventSeq)) ? Number(saved.lastEventSeq) : 0,
      lastMemorySyncAt: String(saved.lastMemorySyncAt || "")
    };
  }

  function writeCloudSettings(settings = {}) {
    const p = runtimePaths();
    const current = cloudSettings();
    // Foreground and daemon both rewrite this file on every cloud event (the
    // lastEventSeq cursor). If this read-modify-write starts from a failed read
    // (concurrent writer, partial file), `current.token` is empty and persisting
    // it would destroy a valid session — observed as random logouts. A write
    // that doesn't explicitly touch credentials must never be able to clear them.
    const touchesAuth = settings.token !== undefined || settings.user !== undefined || settings.enabled !== undefined;
    if (!touchesAuth && !current.token) return current;
    const next = {
      enabled: settings.enabled !== undefined ? Boolean(settings.enabled) : current.enabled,
      url: normalizeCloudUrl(settings.url || current.url),
      token: String(settings.token !== undefined ? settings.token : current.token || ""),
      user: settings.user !== undefined ? settings.user : current.user,
      agentRuntime: settings.agentRuntime !== undefined
        ? (settings.agentRuntime && typeof settings.agentRuntime === "object" ? settings.agentRuntime : null)
        : current.agentRuntime,
      lastEventSeq: settings.lastEventSeq !== undefined
        ? (Number.isFinite(Number(settings.lastEventSeq)) ? Number(settings.lastEventSeq) : current.lastEventSeq)
        : current.lastEventSeq,
      lastMemorySyncAt: settings.lastMemorySyncAt !== undefined
        ? String(settings.lastMemorySyncAt || "")
        : current.lastMemorySyncAt
    };
    if (!next.token) {
      next.enabled = false;
      next.user = null;
      next.agentRuntime = null;
      // Different user / logout → discard the seq cursor so the next
      // login replays from 0 instead of trying to resume someone else's.
      next.lastEventSeq = 0;
      next.lastMemorySyncAt = "";
    }
    // Atomic replace: a plain writeFileSync truncates first, so the other
    // process reading in that window sees partial JSON, falls back to empty
    // defaults, and its next cursor write would have persisted the wipe.
    // Windows can transiently lock the destination during file indexing,
    // antivirus scans, or a near-simultaneous owner handoff. Retry only the
    // atomic rename; auth-changing writes still fail if the lock persists.
    atomicReplaceJsonSync({
      fsImpl,
      targetPath: p.cloudSettings,
      value: next,
      mode: 0o600,
      sleepSync
    });
    return next;
  }

  // (readCloudWorkspace / writeCloudWorkspace removed in Phase 4 cutover.)

  return {
    defaultModelSettings,
    defaultUserProfile,
    defaultAppearanceSettings,
    defaultWindowSettings,
    windowSettings,
    writeWindowSettings,
    userProfile,
    writeUserProfile,
    appearanceSettings,
    writeAppearanceSettings,
    agentWorkspace,
    writeAgentWorkspace,
    defaultPermissionSettings,
    defaultDaemonSettings,
    defaultEffortSettings,
    defaultMemorySettings,
    normalizeEffortLevel,
    normalizeStoredEffortLevel,
    effortSettings,
    effortStatus,
    writeEffortSettings,
    memorySettings,
    writeMemorySettings,
    permissionSettings,
    permissionStatus,
    writePermissionSettings,
    enginePermissionMode,
    normalizeDaemonHost,
    normalizeDaemonPort,
    daemonSettings,
    writeDaemonSettings,
    defaultCloudSettings,
    normalizeCloudUrl,
    cloudSettings,
    writeCloudSettings,
  };
}

module.exports = { createSettingsStore };
