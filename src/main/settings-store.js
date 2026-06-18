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

const { normalizePermissionMode, permissionModeLabel } = require("../permission-modes");

const APPEARANCE_FONT_PRESETS = ["system", "pingfang", "serif"];
const MAX_APPEARANCE_BACKGROUND_IMAGE_LENGTH = 4 * 1024 * 1024;

function normalizeAppearanceFontPreset(value) {
  const preset = String(value || "").trim();
  return APPEARANCE_FONT_PRESETS.includes(preset) ? preset : "system";
}

function normalizeAppearanceBackgroundImage(value) {
  const image = String(value || "").trim();
  if (!image) return "";
  if (image.length > MAX_APPEARANCE_BACKGROUND_IMAGE_LENGTH) return "";
  return /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/i.test(image) ? image : "";
}

function createSettingsStore(deps = {}) {
  const {
    runtimePaths,
    readJson,
    writeRuntimeConfig,
    readConfiguredPort,
    // `getEngineState` accessor: writeEffortSettings + writePermissionSettings
    // call writeRuntimeConfig(engineState.port || readConfiguredPort()), and
    // main.js reassigns engineState on every Hermes restart — capturing the
    // object would go stale.
    getEngineState,
    MIA_DAEMON_DEFAULT_PORT,
    MIA_CLOUD_DEFAULT_URL,
    normalizeAvatarCrop = (crop) => crop || defaultUserProfile().avatarCrop,
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
      fontPreset: "pingfang",
      accentColor: "#318ad3",
      userBubbleColor: "#0162db",
      showHoverBackground: false,
      showUserAvatar: false,
      showAssistantAvatar: false,
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
    return next;
  }

  function writeAppearanceSettings(settings = {}) {
    const p = runtimePaths();
    const current = appearanceSettings();
    const has = (key) => Object.prototype.hasOwnProperty.call(settings, key);
    const theme = String(settings.theme || current.theme || "light").trim();
    const fontPreset = String(settings.fontPreset || current.fontPreset || "system").trim();
    const accentColor = String(settings.accentColor || current.accentColor || "#318ad3").trim();
    const userBubbleColor = String(settings.userBubbleColor || current.userBubbleColor || "#dedcff").trim();
    const showHoverBackground = settings.showHoverBackground == null ? current.showHoverBackground !== false : settings.showHoverBackground !== false;
    const showUserAvatar = settings.showUserAvatar == null ? current.showUserAvatar === true : settings.showUserAvatar === true;
    const showAssistantAvatar = settings.showAssistantAvatar == null ? current.showAssistantAvatar === true : settings.showAssistantAvatar === true;
    const selectionStyle = String(settings.selectionStyle || current.selectionStyle || "soft").trim();
    const validHex = (value, fallback) => /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : fallback;
    const workspaceBackgroundColorInput = String(has("workspaceBackgroundColor") ? settings.workspaceBackgroundColor : (current.workspaceBackgroundColor || "")).trim();
    const workspaceBackgroundImageInput = has("workspaceBackgroundImage") ? settings.workspaceBackgroundImage : (current.workspaceBackgroundImage || "");
    const next = {
      theme: ["light", "dark"].includes(theme) ? theme : "light",
      fontPreset: normalizeAppearanceFontPreset(fontPreset),
      accentColor: validHex(accentColor, "#318ad3"),
      userBubbleColor: validHex(userBubbleColor, "#dedcff"),
      showHoverBackground,
      showUserAvatar,
      showAssistantAvatar,
      listStyle: "card",
      selectionStyle: ["soft", "solid"].includes(selectionStyle) ? selectionStyle : "soft",
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
      mode: "ask"
    };
  }

  function defaultDaemonSettings() {
    const port = Number.isInteger(MIA_DAEMON_DEFAULT_PORT) && MIA_DAEMON_DEFAULT_PORT > 0
      ? MIA_DAEMON_DEFAULT_PORT
      : 27861;
    return {
      enabled: true,
      host: process.env.MIA_DAEMON_HOST || "127.0.0.1",
      port
    };
  }

  function defaultEffortSettings() {
    return {
      level: "medium"
    };
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
    return valid.includes(openClawValue) ? openClawValue : "medium";
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
    return {
      ...defaultPermissionSettings(),
      ...saved,
      mode: normalizePermissionMode(saved.mode || defaultPermissionSettings().mode)
    };
  }

  function permissionStatus() {
    const settings = permissionSettings();
    return {
      mode: settings.mode,
      label: permissionModeLabel(settings.mode)
    };
  }

  function writePermissionSettings(settings = {}) {
    const p = runtimePaths();
    const next = {
      mode: normalizePermissionMode(settings.mode)
    };
    fs.mkdirSync(path.dirname(p.permissionSettings), { recursive: true });
    fs.writeFileSync(p.permissionSettings, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    writeRuntimeConfig(getEngineState()?.port || readConfiguredPort());
    return next;
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
      user: null
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
      // Tracks the last user_events.seq this device has applied. Sent on
      // every WS connect via `?since_seq=N`; server replays everything
      // newer so disconnect/reconnect/replay is transparent (Phase 1.C).
      lastEventSeq: Number.isFinite(Number(saved.lastEventSeq)) ? Number(saved.lastEventSeq) : 0
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
      lastEventSeq: settings.lastEventSeq !== undefined
        ? (Number.isFinite(Number(settings.lastEventSeq)) ? Number(settings.lastEventSeq) : current.lastEventSeq)
        : current.lastEventSeq
    };
    if (!next.token) {
      next.enabled = false;
      next.user = null;
      // Different user / logout → discard the seq cursor so the next
      // login replays from 0 instead of trying to resume someone else's.
      next.lastEventSeq = 0;
    }
    fs.mkdirSync(path.dirname(p.cloudSettings), { recursive: true });
    // Atomic replace: a plain writeFileSync truncates first, so the other
    // process reading in that window sees partial JSON, falls back to empty
    // defaults, and its next cursor write would have persisted the wipe.
    const tmpPath = `${p.cloudSettings}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmpPath, p.cloudSettings);
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
    normalizeEffortLevel,
    normalizeStoredEffortLevel,
    effortSettings,
    effortStatus,
    writeEffortSettings,
    permissionSettings,
    permissionStatus,
    writePermissionSettings,
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
