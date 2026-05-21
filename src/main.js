const { app, BrowserWindow, ipcMain, shell, Menu } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const yaml = require("js-yaml");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");
const QRCode = require("qrcode");
const WebSocket = require("ws");
const { normalizePermissionMode, permissionModeLabel } = require("./permission-modes");
const runtimeResources = require("./runtime-resource-paths");
const { createGroupStore } = require("./main/group-store.js");
const { buildHermesGroupHeader, injectGroupContextForSdk } = require("./main/group-adapters.js");
const {
  adapterForEngine,
  normalizeAgentEngine,
  resolveChatEngineAdapter
} = require("./main/chat-engine-registry.js");
const {
  createChatEngineAdapters,
  createStatelessChatEngineAdapters,
  sendWithChatEngineAdapter,
  sendWithStatelessChatEngineAdapter
} = require("./main/chat-engine-adapters.js");
const { createChatEventEmitter } = require("./main/chat-events.js");
const { chatCompletionResponse, responseMessageContent } = require("./main/chat-response.js");
const { requireFellow } = require("./main/fellow-registry.js");
const { createClaudeCodeChatAdapter } = require("./main/claude-code-chat-adapter.js");
const { createCodexChatAdapter } = require("./main/codex-chat-adapter.js");
const { createHermesChatAdapter } = require("./main/hermes-chat-adapter.js");
const { createRuntimeLifecycleService } = require("./main/runtime-lifecycle-service.js");
const { createStartupTimer } = require("./main/startup-timing.js");
const { createChatStore } = require("./main/chat-store.js");
const { createFellowManifest } = require("./main/fellow-manifest.js");
const { createRuntimePaths } = require("./main/runtime-paths.js");
const { createSettingsStore } = require("./main/settings-store.js");
const { createSkillsLoader } = require("./main/skills-loader.js");
const { createTasksStore } = require("./main/tasks-store.js");
const { createScheduler } = require("./main/scheduler.js");
const { createFireRunner } = require("./main/scheduler-fire.js");
const { createTasksEventBus } = require("./main/tasks-events.js");
const { createTasksRoutes } = require("./main/tasks-routes.js");
const { createSchedulerMcp } = require("./main/scheduler-mcp.js");
const {
  cloudConversationFromDesktopSession,
  cloudMessageFromDesktopMessage,
  desktopSessionFromCloudConversation
} = require("./cloud/desktop-sync.js");

app.setName("Aimashi");
const isolatedUserDataDir = String(process.env.AIMASHI_USER_DATA_DIR || "").trim();
if (isolatedUserDataDir) {
  app.setPath("userData", path.resolve(isolatedUserDataDir));
}
const startupTimer = createStartupTimer({ scope: "startup" });

const OFFICIAL_ENGINE_PACKAGE = process.env.AIMASHI_ENGINE_PACKAGE || "hermes-agent";
const OFFICIAL_ENGINE_REPO_URL = process.env.AIMASHI_ENGINE_REPO || "https://github.com/NousResearch/hermes-agent";
const OFFICIAL_ENGINE_REF = process.env.AIMASHI_ENGINE_REF || "main";
const OFFICIAL_ENGINE_URL = process.env.AIMASHI_ENGINE_URL || "";
const OFFICIAL_ENGINE_EXTRAS = process.env.AIMASHI_ENGINE_EXTRAS || "web";
const OFFICIAL_ENGINE_PYTHON = process.env.AIMASHI_PYTHON || "";
const DEV_ENGINE_SOURCE = process.env.AIMASHI_ENGINE_SOURCE || "";
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_DEVICE_URL = "https://auth.openai.com/codex/device";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const AIMASHI_GATEWAY_SERVICE_LABEL = "ai.aimashi.hermes.gateway";
const AIMASHI_DAEMON_SERVICE_LABEL = "ai.aimashi.daemon";
const AIMASHI_DAEMON_DEFAULT_PORT = Number(process.env.AIMASHI_DAEMON_PORT || 27861);
const MOBILE_ASSET_VERSION = "mobile-slash-commands-1";
const AIMASHI_CLOUD_DEFAULT_URL = process.env.AIMASHI_CLOUD_URL || "https://aiweb.buytb01.com";
const IS_DAEMON_PROCESS = process.argv.includes("--daemon") || process.env.AIMASHI_DAEMON === "1";
const ALLOW_MULTIPLE_INSTANCES = process.env.AIMASHI_ALLOW_MULTIPLE_INSTANCES === "1";
let shouldRunDesktopInstance = true;
if (!IS_DAEMON_PROCESS && !ALLOW_MULTIPLE_INSTANCES) {
  const singleInstanceLock = app.requestSingleInstanceLock();
  if (!singleInstanceLock) {
    shouldRunDesktopInstance = false;
    app.quit();
  } else {
    app.on("second-instance", () => {
      const existing = BrowserWindow.getAllWindows()[0];
      if (existing) {
        if (existing.isMinimized()) existing.restore();
        existing.show();
        existing.focus();
      } else if (app.isReady()) {
        createWindow();
      }
    });
  }
}
let engineProcess = null;
let engineState = {
  running: false,
  starting: false,
  baseUrl: "",
  port: 0,
  managedBy: "",
  lastError: "",
  logs: []
};

const runtimePathsModule = createRuntimePaths({
  app,
  runtimeResources,
  AIMASHI_GATEWAY_SERVICE_LABEL,
  AIMASHI_DAEMON_SERVICE_LABEL,
});
const {
  runtimePaths,
  venvPythonPath,
  bundledHermesRuntimeDir,
  bundledPython,
  bundledSitePackages,
  buildPythonPath,
  engineMarkerPath,
} = runtimePathsModule;

const settingsStore = createSettingsStore({
  runtimePaths,
  readJson,
  writeRuntimeConfig,
  readConfiguredPort,
  getEngineState: () => engineState,
  AIMASHI_DAEMON_DEFAULT_PORT,
  AIMASHI_CLOUD_DEFAULT_URL,
});

const fellowManifestModule = createFellowManifest({
  runtimePaths,
  readJson,
  normalizeAgentEngine,
  settingsStore,
});
const {
  defaultFellowManifest,
  normalizeFellowAgentEngine,
  normalizeFellowEngineConfig,
  mergeFellowEngineConfig,
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
} = fellowManifestModule;

const chatStoreModule = createChatStore({
  runtimePaths,
  readJson,
  normalizeAttachments,
});
const {
  defaultChatStore,
  cleanSessionTitle,
  fallbackSessionTitle,
  normalizeMessageReply,
  normalizeMessageTranslation,
  chatMessageMergeKey,
  mergeChatMessageRecord,
  normalizeChatStore,
  loadChatStore,
  saveChatStore,
  createChatSession,
  ensurePersonaSession,
} = chatStoreModule;

const skillsLoader = createSkillsLoader({
  runtimePaths,
  readJson,
  officialLibraryManifestPath,
  resolveOfficialLibraryRoot,
  getEngineState: () => engineState,
  apiKey,
  appendEngineLog,
  isChildPath,
});
let authProcess = null;
let codexOAuthCancelled = false;
let claudeAgentSdkModule = null;
let codexSdkModule = null;
let authState = {
  codexStarting: false,
  codexLoggedIn: false,
  oauthProvider: "",
  oauthProviderLabel: "",
  codexLastError: "",
  codexUserCode: "",
  codexVerificationUrl: CODEX_DEVICE_URL,
  logs: []
};
let activeChatAbortController = null;
let controlServer = null;
let controlServerState = {
  running: false,
  starting: false,
  host: "",
  port: 0,
  baseUrl: "",
  lastError: "",
  logs: []
};
let relayClient = null;
let relayReconnectTimer = null;
let relayState = {
  enabled: false,
  connected: false,
  connecting: false,
  url: "",
  deviceId: "",
  mobilePeers: 0,
  lastError: "",
  logs: []
};
let cloudBridgeClient = null;
let cloudBridgeReconnectTimer = null;
let cloudEventsClient = null;
let cloudEventsReconnectTimer = null;
const cloudBridgeAbortControllers = new Map();
let cloudBridgeState = {
  connecting: false,
  connected: false,
  deviceId: "",
  lastError: "",
  logs: []
};
const petWindows = new Map();
const petMessageTimers = new Map();
const petJobs = new Map();
let agentEngineCache = { at: 0, value: null };

function writeFileIfMissing(filePath, content, mode) {
  if (fs.existsSync(filePath)) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode });
  return true;
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

let _groupStore = null;
function ensureGroupStore() {
  if (_groupStore) return _groupStore;
  _groupStore = createGroupStore(runtimePaths().groupsDir);
  return _groupStore;
}



function officialEngineUrl() {
  if (String(OFFICIAL_ENGINE_URL || "").trim()) return OFFICIAL_ENGINE_URL.trim();
  const repo = String(OFFICIAL_ENGINE_REPO_URL || "https://github.com/NousResearch/hermes-agent").replace(/\/+$/, "");
  const ref = encodeURIComponent(String(OFFICIAL_ENGINE_REF || "main").trim());
  return `${repo}/archive/${ref}.tar.gz`;
}

function officialEngineRequirement(extras = "") {
  const name = String(OFFICIAL_ENGINE_PACKAGE || "hermes-agent").trim();
  const extraPart = extras ? `[${extras}]` : "";
  return `${name}${extraPart} @ ${officialEngineUrl()}`;
}

function pythonVersion(command) {
  const result = spawnSync(command, [
    "-c",
    "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')"
  ], {
    encoding: "utf8"
  });
  if (result.error || result.status !== 0) return null;
  const version = String(result.stdout || "").trim();
  const [major, minor] = version.split(".").map((part) => Number(part));
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return { version, major, minor };
}

function selectOfficialEnginePython() {
  const candidates = [
    OFFICIAL_ENGINE_PYTHON,
    "python3.13",
    "python3.12",
    "python3.11",
    "python3"
  ].filter(Boolean);
  for (const command of candidates) {
    const info = pythonVersion(command);
    if (info && (info.major > 3 || (info.major === 3 && info.minor >= 11))) {
      return command;
    }
  }
  throw new Error("Official Hermes requires Python 3.11+. Set AIMASHI_PYTHON=/path/to/python3.11 or newer.");
}

function isEngineInstalled() {
  // Bundled runtime → installed by definition.
  if (bundledPython() && bundledSitePackages()) return true;
  const p = runtimePaths();
  const sourceEntrypoint = path.join(p.engine, "hermes_cli", "main.py");
  const venvPython = venvPythonPath();
  const marker = readJson(engineMarkerPath(), {});
  if (marker?.source === "official-github-archive" || marker?.source === "official-python-package") {
    return fs.existsSync(venvPython);
  }
  if (marker?.source === "maintained-local-source") {
    return fs.existsSync(sourceEntrypoint);
  }
  return false;
}

function daemonToken() {
  const p = runtimePaths();
  if (!fs.existsSync(p.daemonToken)) {
    fs.mkdirSync(path.dirname(p.daemonToken), { recursive: true });
    fs.writeFileSync(p.daemonToken, `${crypto.randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  }
  return fs.readFileSync(p.daemonToken, "utf8").trim();
}

function mergeCloudWorkspaceIntoChatStore(workspace) {
  if (!workspace || !Array.isArray(workspace.conversations)) return loadChatStore();
  const manifest = loadFellowManifest();
  const fellowKeys = new Set(
    (Array.isArray(manifest.fellows) ? manifest.fellows : [])
      .map((fellow) => String(fellow?.key || "").trim())
      .filter(Boolean)
  );
  const defaultPersonaKey = String(manifest.default_fellow || "aimashi");
  const store = loadChatStore();
  // Each conversation is merged under the persona it was originally
  // attached to (carried via `conversation.personaKey` from the
  // desktop-sync encoder). Conversations whose source persona no longer
  // exists fall back to the manifest default so they don't disappear.
  const touchedPersonas = new Set();
  for (const conversation of workspace.conversations) {
    const requested = String(conversation?.personaKey || "").trim();
    const personaKey = requested && fellowKeys.has(requested)
      ? requested
      : defaultPersonaKey;
    if (!store.sessions[personaKey]) store.sessions[personaKey] = [];
    touchedPersonas.add(personaKey);
    const incoming = desktopSessionFromCloudConversation(conversation, personaKey);
    const existing = store.sessions[personaKey].find((session) => session.id === incoming.id);
    if (!existing) {
      store.sessions[personaKey].push(incoming);
      continue;
    }
    const messagesByKey = new Map();
    for (const message of existing.messages || []) {
      messagesByKey.set(chatMessageMergeKey(message), message);
    }
    for (const message of incoming.messages || []) {
      const key = chatMessageMergeKey(message);
      const previous = messagesByKey.get(key);
      messagesByKey.set(key, previous ? mergeChatMessageRecord(previous, message) : message);
    }
    existing.title = incoming.title || existing.title;
    existing.titleGenerated = Boolean(existing.titleGenerated || incoming.titleGenerated);
    existing.updatedAt = [existing.updatedAt, incoming.updatedAt].filter(Boolean).sort().at(-1) || new Date().toISOString();
    existing.messages = [...messagesByKey.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }
  for (const personaKey of touchedPersonas) {
    store.sessions[personaKey].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
  return saveChatStore(store);
}

const CLI_PATH_SEGMENTS = [
  path.join(os.homedir(), ".local", "bin"),
  path.join(os.homedir(), ".npm-global", "bin"),
  path.join(os.homedir(), ".bun", "bin"),
  path.join(os.homedir(), ".deno", "bin"),
  path.join(os.homedir(), ".cargo", "bin"),
  path.join(os.homedir(), "Library", "pnpm"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin"
];

function cliPathEnv() {
  const current = String(process.env.PATH || "");
  const segments = [
    ...CLI_PATH_SEGMENTS,
    ...current.split(path.delimiter)
  ].filter(Boolean);
  return [...new Set(segments)].join(path.delimiter);
}

function processEnvWithCliPath() {
  return {
    ...process.env,
    PATH: cliPathEnv()
  };
}

function commandNameOnly(command) {
  const value = String(command || "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(value)) return "";
  return value;
}

function executablePath(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return filePath;
  } catch {
    return "";
  }
}

function shellCommandPath(command) {
  const name = commandNameOnly(command);
  if (!name) return "";
  const result = spawnSync("zsh", ["-lc", `command -v ${name}`], {
    encoding: "utf8",
    timeout: 1500,
    env: processEnvWithCliPath()
  });
  if (!result.error && result.status === 0) {
    const found = String(result.stdout || "").split(/\r?\n/)[0]?.trim() || "";
    if (found) return found;
  }
  for (const dir of CLI_PATH_SEGMENTS) {
    const found = executablePath(path.join(dir, name));
    if (found) return found;
  }
  return "";
}

function commandVersion(commandPath) {
  if (!commandPath) return "";
  const result = spawnSync(commandPath, ["--version"], {
    encoding: "utf8",
    timeout: 2000,
    env: processEnvWithCliPath()
  });
  if (result.error) return "";
  return String(result.stdout || result.stderr || "").split(/\r?\n/)[0]?.trim() || "";
}

function readShebangPython(scriptPath) {
  if (!scriptPath) return "";
  try {
    const fd = fs.openSync(scriptPath, "r");
    const buf = Buffer.alloc(256);
    const bytes = fs.readSync(fd, buf, 0, 256, 0);
    fs.closeSync(fd);
    const head = buf.slice(0, bytes).toString("utf8");
    if (!head.startsWith("#!")) return "";
    const firstLine = head.split(/\r?\n/, 1)[0].slice(2).trim();
    if (!firstLine) return "";
    const tokens = firstLine.split(/\s+/);
    if (tokens[0].endsWith("/env") && tokens[1]) {
      return shellCommandPath(tokens[1]) || tokens[1];
    }
    return tokens[0];
  } catch {
    return "";
  }
}

function systemHermesCachePath() {
  return path.join(runtimePaths().home, "aimashi-system-hermes.json");
}

function loadSystemHermesCache() {
  const cached = readJson(systemHermesCachePath(), null);
  if (!cached || typeof cached !== "object") {
    return { available: false, pending: true };
  }
  return cached;
}

function persistSystemHermesCache(value) {
  const filePath = systemHermesCachePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

function broadcastEnginesChanged() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try { win.webContents.send("runtime:engines-changed"); } catch { /* ignore */ }
    }
  }
}

function broadcastRendererEvent(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try { win.webContents.send(channel, payload); } catch { /* ignore */ }
    }
  }
}

let systemHermesRefreshing = false;
const SYSTEM_HERMES_PROBE = [
  "import json, sys, os",
  "result = {'python': sys.executable}",
  "try:",
  "    import hermes_cli",
  "    result['hermesImport'] = True",
  "    result['version'] = getattr(hermes_cli, '__version__', '') or ''",
  "    result['hermesFile'] = getattr(hermes_cli, '__file__', '')",
  "except Exception as exc:",
  "    result['hermesImport'] = False",
  "    result['hermesError'] = repr(exc)",
  "try:",
  "    from gateway.platforms.api_server import APIServerAdapter",
  "    result['hookAvailable'] = True",
  "except Exception as exc:",
  "    result['hookAvailable'] = False",
  "    result['hookError'] = repr(exc)",
  "try:",
  "    from hermes_cli.config import get_hermes_home",
  "    result['hermesHome'] = str(get_hermes_home())",
  "except Exception:",
  "    result['hermesHome'] = os.path.expanduser('~/.hermes')",
  "print(json.dumps(result))"
].join("\n");

async function refreshSystemHermesAsync() {
  // System-hermes detection is disabled: hermes's per-profile lock mechanism
  // doesn't tolerate aimashi running an extra gateway alongside the user's
  // launchd one (mutual --replace SIGTERMs). aimashi only manages its own
  // standalone Hermes from here on. CC/Codex unaffected.
  persistSystemHermesCache({ available: false, checkedAt: new Date().toISOString(), disabled: true });
  agentEngineCache = { at: 0, value: null };
  return;
  // eslint-disable-next-line no-unreachable
  if (systemHermesRefreshing) return;
  systemHermesRefreshing = true;
  const checkedAt = new Date().toISOString();
  try {
    const hermesPath = shellCommandPath("hermes");
    if (!hermesPath) {
      persistSystemHermesCache({ available: false, checkedAt });
      agentEngineCache = { at: 0, value: null };
      broadcastEnginesChanged();
      return;
    }
    let pythonPath = readShebangPython(hermesPath);
    if (!pythonPath || !fs.existsSync(pythonPath)) {
      pythonPath = shellCommandPath("python3") || shellCommandPath("python");
    }
    if (!pythonPath) {
      persistSystemHermesCache({
        available: false,
        hermesPath,
        lastError: "未能确定 hermes 使用的 Python 解释器",
        checkedAt
      });
      agentEngineCache = { at: 0, value: null };
      broadcastEnginesChanged();
      return;
    }
    const probeResult = await new Promise((resolve) => {
      const child = spawn(pythonPath, ["-c", SYSTEM_HERMES_PROBE], {
        env: processEnvWithCliPath(),
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }, 8000);
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ error: err.message });
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          resolve({ error: stderr.trim() || `python exited ${code}` });
          return;
        }
        try {
          const line = stdout.trim().split(/\r?\n/).pop() || "{}";
          resolve({ parsed: JSON.parse(line) });
        } catch (exc) {
          resolve({ error: `probe 输出无法解析: ${exc.message}` });
        }
      });
    });
    let value;
    if (probeResult.error) {
      value = {
        available: false,
        hermesPath,
        pythonPath,
        lastError: probeResult.error,
        checkedAt
      };
    } else {
      const parsed = probeResult.parsed || {};
      const hermesImport = Boolean(parsed.hermesImport);
      const hookAvailable = Boolean(parsed.hookAvailable);
      value = {
        available: hermesImport,
        compatible: hermesImport && hookAvailable,
        hermesPath,
        pythonPath: parsed.python || pythonPath,
        hermesFile: parsed.hermesFile || "",
        hermesHome: parsed.hermesHome || "",
        version: parsed.version || "",
        hookAvailable,
        hookError: parsed.hookError || "",
        importError: parsed.hermesError || "",
        lastError: hermesImport
          ? (hookAvailable ? "" : "缺少 gateway.platforms.api_server.APIServerAdapter（aimashi 插件 hook 不可用）")
          : "无法 import hermes_cli",
        checkedAt
      };
    }
    persistSystemHermesCache(value);
    agentEngineCache = { at: 0, value: null };
    if (value.compatible) {
      try { importFromSystemHermes(); } catch (err) { appendEngineLog(`importFromSystemHermes failed: ${err.message}`); }
    }
    broadcastEnginesChanged();
  } finally {
    systemHermesRefreshing = false;
  }
}

function localAgentEngines() {
  const now = Date.now();
  if (agentEngineCache.value && now - agentEngineCache.at < 15000) return agentEngineCache.value;
  const claudePath = shellCommandPath("claude");
  const codexPath = shellCommandPath("codex");
  const value = {
    hermes: {
      id: "hermes",
      label: "默认",
      available: true,
      system: { available: false, disabled: true }
    },
    claudeCode: {
      id: "claude-code",
      label: "Claude Code",
      available: Boolean(claudePath),
      path: claudePath,
      version: commandVersion(claudePath)
    },
    codex: {
      id: "codex",
      label: "Codex",
      available: Boolean(codexPath),
      path: codexPath,
      version: commandVersion(codexPath)
    }
  };
  agentEngineCache = { at: now, value };
  return value;
}

function loadAgentSessionMap() {
  const raw = readJson(runtimePaths().agentSessions, {});
  return raw && typeof raw === "object" ? raw : {};
}

function saveAgentSessionMap(store) {
  const p = runtimePaths();
  fs.mkdirSync(path.dirname(p.agentSessions), { recursive: true });
  fs.writeFileSync(p.agentSessions, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
}

function agentSessionKey(engine, fellowKey, sessionId) {
  return [
    normalizeFellowAgentEngine(engine),
    String(fellowKey || "aimashi").trim() || "aimashi",
    String(sessionId || "default").trim() || "default"
  ].join(":");
}

function getAgentSessionId(engine, fellowKey, sessionId) {
  return getAgentSessionEntry(engine, fellowKey, sessionId).id;
}

function setAgentSessionId(engine, fellowKey, sessionId, externalSessionId) {
  setAgentSessionEntry(engine, fellowKey, sessionId, externalSessionId, "");
}

function getAgentSessionEntry(engine, fellowKey, sessionId) {
  const store = loadAgentSessionMap();
  const entry = store[agentSessionKey(engine, fellowKey, sessionId)];
  if (!entry) return { id: "", fingerprint: "" };
  if (typeof entry === "string") return { id: entry.trim(), fingerprint: "" };
  return {
    id: String(entry.id || "").trim(),
    fingerprint: String(entry.fingerprint || "").trim()
  };
}

function setAgentSessionEntry(engine, fellowKey, sessionId, externalSessionId, fingerprint) {
  const id = String(externalSessionId || "").trim();
  if (!id) return;
  const fp = String(fingerprint || "").trim();
  const store = loadAgentSessionMap();
  store[agentSessionKey(engine, fellowKey, sessionId)] = fp ? { id, fingerprint: fp } : id;
  saveAgentSessionMap(store);
}

async function claudeAgentSdk() {
  if (!claudeAgentSdkModule) claudeAgentSdkModule = await import("@anthropic-ai/claude-agent-sdk");
  return claudeAgentSdkModule;
}

async function codexSdk() {
  if (!codexSdkModule) codexSdkModule = await import("@openai/codex-sdk");
  return codexSdkModule;
}

function processEnvStrings() {
  return Object.fromEntries(Object.entries(processEnvWithCliPath()).filter(([, value]) => typeof value === "string"));
}

// ---------------------------------------------------------------------------
// Scheduler MCP helpers
// ---------------------------------------------------------------------------

let _cachedNodePath = null;
function resolveNodePath() {
  if (_cachedNodePath !== null) return _cachedNodePath;
  try {
    const result = require("node:child_process").spawnSync("zsh", ["-lc", "command -v node"], {
      encoding: "utf8", timeout: 1000, env: processEnvWithCliPath()
    });
    _cachedNodePath = String(result.stdout || "").trim();
  } catch {
    _cachedNodePath = "";
  }
  return _cachedNodePath;
}

function schedulerMcpContextPath() {
  return path.join(runtimePaths().runtime, "scheduler-mcp", "context.json");
}

function schedulerMcpServerScriptPath() {
  return path.join(__dirname, "main", "scheduler-mcp-server.js");
}

/**
 * Write per-turn context for the scheduler MCP server.
 * The MCP server reads this file on every tools/call to inject
 * fellowId / sessionId / originMessageId into task creation requests.
 */
function writeSchedulerMcpContext({ fellowId = "", sessionId = "", originMessageId = "" } = {}) {
  const contextPath = schedulerMcpContextPath();
  fs.mkdirSync(path.dirname(contextPath), { recursive: true });
  fs.writeFileSync(contextPath, JSON.stringify({ fellowId, sessionId, originMessageId }, null, 2), "utf8");
}

/**
 * Returns the McpStdioServerConfig for the scheduler server, to be passed
 * directly in the Claude Code SDK query options mcpServers map.
 * Returns null if the daemon is not yet running (no baseUrl).
 */
// In daemon mode controlServerState.baseUrl is populated by our own HTTP
// server. In GUI mode the daemon runs in a separate process and this state is
// empty — fall back to the saved daemon settings so MCP wiring can still
// reach the daemon over the network.
function resolveDaemonBaseUrl() {
  if (controlServerState.baseUrl) return controlServerState.baseUrl;
  const settings = settingsStore.daemonSettings();
  if (settings?.host && settings?.port) {
    return `http://${settings.host}:${settings.port}`;
  }
  return "";
}

function getSchedulerMcpSpec() {
  const baseUrl = resolveDaemonBaseUrl();
  if (!baseUrl) return null;
  const scriptPath = schedulerMcpServerScriptPath();
  if (!fs.existsSync(scriptPath)) return null;
  const nodePath = resolveNodePath();
  if (!nodePath) return null;
  return {
    type: "stdio",
    command: nodePath,
    args: [scriptPath],
    env: {
      AIMASHI_DAEMON_URL: baseUrl,
      AIMASHI_DAEMON_TOKEN: daemonToken(),
      AIMASHI_SCHEDULER_CONTEXT_FILE: schedulerMcpContextPath()
    },
    // Without this, Claude Code defers MCP tools behind a tool-search meta tool
    // and the AI never sees schedule_* unless it explicitly searches.
    alwaysLoad: true
  };
}

/**
 * Ensure aimashi's private CODEX_HOME directory exists with a config.toml
 * that includes the aimashi-scheduler MCP server config.
 * Copies auth.json from the user's ~/.codex if present so API keys survive.
 * Returns the path to the aimashi codex home, or "" on failure.
 */
function ensureCodexHome() {
  const baseUrl = resolveDaemonBaseUrl();
  if (!baseUrl) return "";
  const scriptPath = schedulerMcpServerScriptPath();
  if (!fs.existsSync(scriptPath)) return "";
  const nodePath = resolveNodePath();
  if (!nodePath) return "";

  const aimashiCodexHome = path.join(runtimePaths().runtime, "codex-home");
  fs.mkdirSync(aimashiCodexHome, { recursive: true });

  // Symlink everything in user's ~/.codex into our private home EXCEPT
  // config.toml — we own config.toml so we can append our MCP server entry,
  // but auth, sessions, history, cache, logs, plugins, skills, etc. all
  // stay live-linked to the user's real ~/.codex. This keeps thread/resume
  // working (rollouts live in ~/.codex/sessions/), and survives key rotation.
  const userCodexHome = path.join(require("node:os").homedir(), ".codex");
  if (fs.existsSync(userCodexHome)) {
    let entries = [];
    try { entries = fs.readdirSync(userCodexHome); } catch { /* ignore */ }
    for (const name of entries) {
      if (name === "config.toml") continue;
      const target = path.join(userCodexHome, name);
      const link = path.join(aimashiCodexHome, name);
      let existing = null;
      try { existing = fs.lstatSync(link); } catch { /* missing is fine */ }
      if (existing) {
        // Drop stale non-symlinks (e.g., auth.json copied by older builds).
        if (!existing.isSymbolicLink()) {
          try { fs.rmSync(link, { recursive: true, force: true }); }
          catch { /* ignore */ }
        } else {
          continue;
        }
      }
      try {
        let stat = null;
        try { stat = fs.statSync(target); } catch { /* broken target, skip */ }
        if (!stat) continue;
        fs.symlinkSync(target, link, stat.isDirectory() ? "dir" : "file");
      } catch { /* ignore individual symlink failures */ }
    }
  }

  // Merge user's config.toml (model, auth, etc.) with our MCP server section.
  // Strategy: read user config, strip any existing aimashi-scheduler block, append ours.
  const userConfigPath = path.join(userCodexHome, "config.toml");
  let baseConfig = "";
  try {
    baseConfig = fs.readFileSync(userConfigPath, "utf8");
  } catch { /* no user config */ }

  // Remove existing [mcp_servers.aimashi-scheduler] block if present
  // Simple line-by-line approach: drop lines between the section header and next [section]
  const lines = baseConfig.split("\n");
  const filtered = [];
  let inOurSection = false;
  for (const line of lines) {
    if (line.trim() === "[mcp_servers.aimashi-scheduler]") {
      inOurSection = true;
      continue;
    }
    if (inOurSection && line.trimStart().startsWith("[")) {
      inOurSection = false;
    }
    if (!inOurSection) filtered.push(line);
  }

  // Escape backslashes and double-quotes for TOML string values
  function toTomlStr(s) {
    return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  const mcpSection = [
    "",
    "[mcp_servers.aimashi-scheduler]",
    `command = ${toTomlStr(nodePath)}`,
    `args = [${toTomlStr(scriptPath)}]`,
    "",
    "[mcp_servers.aimashi-scheduler.env]",
    `AIMASHI_DAEMON_URL = ${toTomlStr(baseUrl)}`,
    `AIMASHI_DAEMON_TOKEN = ${toTomlStr(daemonToken())}`,
    `AIMASHI_SCHEDULER_CONTEXT_FILE = ${toTomlStr(schedulerMcpContextPath())}`,
    ""
  ].join("\n");

  const finalConfig = filtered.join("\n").trimEnd() + mcpSection;
  const configPath = path.join(aimashiCodexHome, "config.toml");
  fs.writeFileSync(configPath, finalConfig, "utf8");

  return aimashiCodexHome;
}

function appearanceSettings() {
  const p = runtimePaths();
  const saved = readJson(p.appearanceSettings, {});
  return { ...settingsStore.defaultAppearanceSettings(), ...saved };
}




function fellowPetId(key) {
  const cleaned = String(key || "")
    .trim()
    .toLowerCase()
    .replace(/[_]+/g, "-")
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `aimashi-${cleaned || "fellow"}`;
}

function legacyFellowPetId(key) {
  const cleaned = String(key || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `aimashi-${cleaned || "fellow"}`;
}

function petIdAliasesForKey(key) {
  const raw = String(key || "").trim();
  const values = [
    fellowPetId(raw),
    legacyFellowPetId(raw),
    raw,
    raw.replace(/_/g, "-"),
    raw.replace(/-/g, "_")
  ].filter(Boolean);
  return [...new Set(values)];
}

function readPetManifest(petDir) {
  const manifestPath = path.join(petDir, "pet.json");
  const manifest = readJson(manifestPath, null);
  if (!manifest || typeof manifest !== "object") return null;
  const sheet = String(manifest.spritesheetPath || "spritesheet.webp").trim();
  const sheetPath = path.join(petDir, sheet);
  if (!fs.existsSync(sheetPath)) return null;
  return {
    id: String(manifest.id || path.basename(petDir)),
    displayName: String(manifest.displayName || manifest.name || path.basename(petDir)),
    description: String(manifest.description || ""),
    dir: petDir,
    manifestPath,
    spritesheetPath: sheetPath
  };
}

function petRootCandidates() {
  const p = runtimePaths();
  return [
    p.petDir,
    path.join(app.getPath("home"), ".alkaka", "pets"),
    path.join(app.getPath("home"), ".codex", "pets")
  ];
}

function findFellowPetPackage(key) {
  const ids = petIdAliasesForKey(key);
  for (const root of petRootCandidates()) {
    for (const id of ids) {
      const pet = readPetManifest(path.join(root, id));
      if (pet) return pet;
    }
  }
  return null;
}

function petStatusForFellow(key) {
  const pet = findFellowPetPackage(key);
  return {
    key,
    petId: pet?.id || fellowPetId(key),
    hasAsset: Boolean(pet),
    placed: petWindows.has(String(key || "")),
    displayName: pet?.displayName || "",
    packageDir: pet?.dir || "",
    spritesheetPath: pet?.spritesheetPath || ""
  };
}

function petStatusesForFellows(fellows = []) {
  return Object.fromEntries((fellows || []).map((fellow) => [fellow.key, petStatusForFellow(fellow.key)]));
}

function getFellowDetails(key) {
  initializeRuntime();
  const id = String(key || "").trim();
  const manifest = loadFellowManifest();
  const { fellow } = requireFellow(manifest, id, "Fellow not found.", { fallback: false });
  return {
    fellow,
    personaText: readFellowPersona(fellow.key, fellow.name, fellow.bio),
    pet: petStatusForFellow(fellow.key)
  };
}

function dataUrlToBuffer(value) {
  const match = String(value || "").match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!match) return null;
  const mime = match[1] || "image/png";
  const ext = mimeToExtension(mime);
  const data = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]));
  return { data, ext, mime };
}

function mimeToExtension(mimeValue) {
  const mime = String(mimeValue || "").toLowerCase();
  if (mime.includes("jpeg")) return ".jpg";
  if (mime.includes("png")) return ".png";
  if (mime.includes("webp")) return ".webp";
  if (mime.includes("gif")) return ".gif";
  if (mime.includes("pdf")) return ".pdf";
  if (mime.includes("json")) return ".json";
  if (mime.includes("markdown")) return ".md";
  if (mime.startsWith("text/")) return ".txt";
  return "";
}

function materializePetReference(rawValue, outDir, index) {
  const raw = String(rawValue || "").trim();
  if (!raw) return null;
  fs.mkdirSync(outDir, { recursive: true });
  const data = dataUrlToBuffer(raw);
  if (data) {
    const target = path.join(outDir, `reference-${String(index).padStart(2, "0")}${data.ext}`);
    fs.writeFileSync(target, data.data);
    return target;
  }
  let source = raw;
  if (/^file:/i.test(raw)) {
    source = fileURLToPath(raw);
  } else if (raw.startsWith("./") || raw.startsWith("../")) {
    source = path.join(__dirname, "renderer", raw);
  }
  if (!path.isAbsolute(source) || !fs.existsSync(source)) return null;
  const ext = path.extname(source) || ".png";
  const target = path.join(outDir, `reference-${String(index).padStart(2, "0")}${ext}`);
  fs.copyFileSync(source, target);
  return target;
}

function sanitizeAttachmentName(value, fallback = "attachment") {
  const raw = path.basename(String(value || fallback)).replace(/[^\w.\-()[\] \u4e00-\u9fff]+/g, "_").trim();
  return raw || fallback;
}

function normalizeAttachment(input = {}) {
  const rawPath = String(input.path || "").trim();
  let filePath = rawPath;
  if (/^file:/i.test(filePath)) {
    try {
      filePath = fileURLToPath(filePath);
    } catch {
      filePath = "";
    }
  }
  const name = sanitizeAttachmentName(input.name || filePath || "attachment");
  const mime = String(input.mime || input.type || "").trim();
  const size = Number(input.size) || (filePath && fs.existsSync(filePath) ? fs.statSync(filePath).size : 0);
  const kind = String(input.kind || "").trim() || attachmentKind({ mime, name });
  const thumbnailDataUrl = normalizeAttachmentThumbnail(input.thumbnailDataUrl || input.thumbnail || input.previewDataUrl);
  const dataUrl = normalizeAttachmentDataUrl(input.dataUrl);
  const url = String(input.url || "").trim();
  const next = {
    id: String(input.id || crypto.randomUUID()),
    name,
    path: filePath,
    mime,
    size,
    kind
  };
  if (/^\/api\/files\/[a-zA-Z0-9_-]+$/.test(url) || /^https?:\/\//i.test(url)) next.url = url;
  if (thumbnailDataUrl && kind === "image") next.thumbnailDataUrl = thumbnailDataUrl;
  if (dataUrl && kind === "image") next.dataUrl = dataUrl;
  return next;
}

function normalizeAttachmentDataUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 35 * 1024 * 1024) return "";
  if (!/^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(raw)) return "";
  return raw.replace(/\s+/g, "");
}

function normalizeAttachmentThumbnail(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 700 * 1024) return "";
  if (!/^data:image\/(?:png|jpe?g|webp);base64,[a-z0-9+/=\s]+$/i.test(raw)) return "";
  return raw.replace(/\s+/g, "");
}

function attachmentKind({ mime = "", name = "" } = {}) {
  const type = String(mime || "").toLowerCase();
  const ext = path.extname(String(name || "")).toLowerCase();
  if (type.startsWith("image/") || [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type.includes("pdf") || ext === ".pdf") return "pdf";
  if (type.startsWith("text/") || [".txt", ".md", ".json", ".csv", ".log", ".js", ".ts", ".tsx", ".jsx", ".py", ".html", ".css"].includes(ext)) return "text";
  return "file";
}

function normalizeAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map(normalizeAttachment).filter((item) => item.name || item.path);
}

function attachmentSummaryLine(attachment, index) {
  const parts = [
    `${index + 1}. ${attachment.name}`,
    `类型：${attachment.mime || attachment.kind || "未知"}`,
    attachment.size ? `大小：${attachment.size} bytes` : "",
    attachment.path ? `本地路径：${attachment.path}` : ""
  ].filter(Boolean);
  return parts.join("；");
}

function textPreviewForAttachment(attachment) {
  if (attachment.kind !== "text" || !attachment.path || !fs.existsSync(attachment.path)) return "";
  const stat = fs.statSync(attachment.path);
  if (stat.size > 1024 * 1024) return "";
  try {
    return fs.readFileSync(attachment.path, "utf8").slice(0, 12000);
  } catch {
    return "";
  }
}

function attachmentContext(attachments = []) {
  const normalized = normalizeAttachments(attachments).filter((item) => item.path || item.name);
  if (!normalized.length) return "";
  const lines = [
    "本轮用户附带了以下本地附件。可以直接读取本地路径；如果当前引擎不能读取二进制图片，请根据文件名、类型和用户文字继续处理，并说明限制。",
    ...normalized.map(attachmentSummaryLine)
  ];
  const previews = normalized
    .map((attachment, index) => {
      const preview = textPreviewForAttachment(attachment);
      return preview ? `附件 ${index + 1} 文本预览（${attachment.name}）：\n${preview}` : "";
    })
    .filter(Boolean);
  return [...lines, ...previews].join("\n\n");
}

function saveChatAttachment(input = {}) {
  initializeRuntime();
  const data = dataUrlToBuffer(input.dataUrl);
  if (!data) throw new Error("Attachment data is invalid.");
  if (data.data.length > 25 * 1024 * 1024) throw new Error("附件超过 25MB，暂时不能内嵌保存。");
  const p = runtimePaths();
  fs.mkdirSync(p.attachmentsDir, { recursive: true });
  const name = sanitizeAttachmentName(input.name || `attachment${data.ext || ""}`);
  const ext = path.extname(name) || data.ext || "";
  const base = path.basename(name, path.extname(name));
  const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${sanitizeAttachmentName(base, "attachment")}${ext}`;
  const target = path.join(p.attachmentsDir, fileName);
  fs.writeFileSync(target, data.data, { mode: 0o600 });
  return normalizeAttachment({
    id: crypto.randomUUID(),
    name,
    path: target,
    mime: input.mime || data.mime,
    size: data.data.length,
    thumbnailDataUrl: input.thumbnailDataUrl || input.thumbnail || input.previewDataUrl
  });
}

function mimeForFilePath(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  const map = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".csv": "text/csv",
    ".log": "text/plain",
    ".js": "text/javascript",
    ".ts": "text/typescript",
    ".tsx": "text/typescript",
    ".jsx": "text/javascript",
    ".py": "text/x-python",
    ".html": "text/html",
    ".css": "text/css",
    ".zip": "application/zip"
  };
  return map[ext] || "application/octet-stream";
}

function readLocalFileAttachment(input = {}) {
  initializeRuntime();
  const rawPath = String(input.path || input.filePath || "").trim();
  if (!rawPath) throw new Error("File path is required.");
  let filePath = rawPath;
  if (/^file:/i.test(filePath)) filePath = fileURLToPath(filePath);
  filePath = path.resolve(filePath);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error("File not found.");
  }
  const stat = fs.statSync(filePath);
  if (stat.size > 25 * 1024 * 1024) {
    throw new Error("文件超过 25MB，暂时不能通过手机传回。");
  }
  const mime = mimeForFilePath(filePath);
  const data = fs.readFileSync(filePath);
  const dataUrl = `data:${mime};base64,${data.toString("base64")}`;
  const attachment = normalizeAttachment({
    id: crypto.randomUUID(),
    name: path.basename(filePath),
    path: filePath,
    mime,
    size: stat.size,
    thumbnailDataUrl: mime.startsWith("image/") ? dataUrl : ""
  });
  return {
    ...attachment,
    dataUrl
  };
}

function safeReadLocalFileAttachment(input = {}) {
  try {
    return readLocalFileAttachment(input);
  } catch (error) {
    return {
      error: true,
      message: String(error?.message || error),
      path: String(input.path || input.filePath || "")
    };
  }
}

async function fetchCloudFileAttachment(input = {}) {
  const urlPath = String(input.url || input.path || "").trim();
  if (!/^\/api\/files\/[a-zA-Z0-9_-]+$/.test(urlPath)) throw new Error("Cloud file URL is invalid.");
  const settings = settingsStore.cloudSettings();
  if (!settings.enabled || !settings.token) throw new Error("请先登录 Aimashi Cloud。");
  const response = await fetch(`${settingsStore.normalizeCloudUrl(settings.url)}${urlPath}`, {
    headers: { Authorization: `Bearer ${settings.token}` },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Aimashi Cloud ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  const data = Buffer.from(arrayBuffer);
  if (data.length > 25 * 1024 * 1024) throw new Error("文件超过 25MB，暂时不能内嵌预览。");
  const mime = response.headers.get("content-type") || "application/octet-stream";
  const name = sanitizeAttachmentName(input.name || path.basename(urlPath));
  const dataUrl = `data:${mime};base64,${data.toString("base64")}`;
  return {
    id: String(input.id || crypto.randomUUID()),
    name,
    path: "",
    url: urlPath,
    mime,
    size: data.length,
    kind: attachmentKind({ mime, name }),
    thumbnailDataUrl: mime.startsWith("image/") ? dataUrl : "",
    dataUrl
  };
}

async function safeFetchFileAttachment(input = {}) {
  try {
    const cloudUrl = String(input.url || input.path || "").trim();
    if (/^\/api\/files\/[a-zA-Z0-9_-]+$/.test(cloudUrl)) {
      return await fetchCloudFileAttachment(input);
    }
    return readLocalFileAttachment(input);
  } catch (error) {
    return {
      error: true,
      message: String(error?.message || error),
      path: String(input.path || input.filePath || input.url || "")
    };
  }
}

function styleSettingsForPet(stylePreset) {
  const preset = String(stylePreset || "codex").trim();
  if (preset === "alkaka") {
    const styleReference = path.join(petGeneratorRoot(), "alkaka-friend-pet", "assets", "alkaka-style-reference.jpg");
    return {
      styleNotes: "Alkaka Q版贴纸风：紧凑可爱的伙伴桌宠，清晰线条，大眼睛，保留头像身份特征，适合 192x208 小尺寸动画。",
      styleContract: "Cute anime sticker-like partner desktop pet, compact chibi proportions, clean dark linework, soft cel shading, readable at 192x208 cells. Avoid realistic rendering, scene backgrounds, tiny noisy detail, shadows, glows, text, and UI elements.",
      styleReferences: fs.existsSync(styleReference) ? [styleReference] : []
    };
  }
  if (preset === "soft") {
    return {
      styleNotes: "柔和 Q 版桌宠：圆润、轻量、少装饰，保留头像主要发色、服饰和气质。",
      styleContract: "Soft cute digital pet sprite style with simple readable silhouette, flat colors, clean outline, no scene background, no glossy illustration effects.",
      styleReferences: []
    };
  }
  return {
    styleNotes: "Codex 内置桌宠风：小体积、像素感边缘、粗轮廓、有限色板、动作清楚但不花哨。",
    styleContract: "Codex built-in digital pet style: small pixel-art-adjacent mascot, compact chibi proportions, chunky readable silhouette, thick dark outline, limited palette, flat cel shading, transparent sprite atlas.",
    styleReferences: []
  };
}

function petRemoteCodexSettings() {
  const saved = readJson(runtimePaths().petRemoteSettings, {});
  const disabled = process.env.AIMASHI_PET_REMOTE_DISABLED === "1" || saved.enabled === false;
  const host = disabled
    ? ""
    : String(process.env.AIMASHI_PET_REMOTE_HOST || saved.host || DEFAULT_PET_REMOTE_HOST).trim();
  const root = String(process.env.AIMASHI_PET_REMOTE_ROOT || saved.root || DEFAULT_PET_REMOTE_ROOT).trim();
  return { host, root, enabled: Boolean(host) };
}

function petGeneratorRoot() {
  const candidates = [
    path.join(app.getAppPath(), "resources", "pet-generator"),
    path.join(process.resourcesPath || "", "pet-generator"),
    path.join(__dirname, "..", "resources", "pet-generator")
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(path.join(candidate, "hatch_generate.py"))) || candidates[0];
}

function aimashiSkillsRoot() {
  const candidates = [
    path.join(process.resourcesPath || "", "skills"),
    path.join(app.getAppPath(), "skills"),
    path.join(__dirname, "..", "skills")
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(path.join(candidate, "pet-generator", "SKILL.md"))) || candidates[0];
}

function officialLibraryManifestPath() {
  const candidates = [
    path.join(app.getAppPath(), "resources", "official-library", "library.json"),
    path.join(process.resourcesPath || "", "official-library", "library.json"),
    path.join(__dirname, "..", "resources", "official-library", "library.json")
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || candidates[0];
}

function resolveOfficialLibraryRoot(root = "") {
  const value = String(root || "").trim();
  if (!value) return "";
  if (path.isAbsolute(value)) return value;
  if (value === "pet-generator" || value.startsWith("pet-generator/")) {
    const rel = value.slice("pet-generator".length).replace(/^[\\/]/, "");
    return path.join(petGeneratorRoot(), rel);
  }
  if (value === "skills" || value.startsWith("skills/")) {
    const rel = value.slice("skills".length).replace(/^[\\/]/, "");
    return path.join(aimashiSkillsRoot(), rel);
  }
  return path.join(path.dirname(officialLibraryManifestPath()), value);
}

function buildFellowPetPrompt(fellow, userPrompt = "") {
  const extra = String(userPrompt || "").trim();
  const base = [
    `把 Aimashi Fellow「${fellow.name}」做成可以放在桌面的本地小伙伴。`,
    "参考图是角色原始形象图；保留主要发色、脸部气质、服装和装饰识别点。",
    "做成小体积、清晰轮廓、适合 192x208 动画格子的 Q 版桌宠。",
    "不要加文字、背景、光效、场景或 UI 元素。"
  ].join("\n");
  return extra ? `${base}\n\n用户补充描述：\n${extra}` : base;
}

const PET_JOB_STEPS = [
  { id: "base", label: "基础形象", rel: path.join("decoded", "base.png") },
  { id: "idle", label: "待机动作", rel: path.join("decoded", "idle.png") },
  { id: "waving", label: "招手动作", rel: path.join("decoded", "waving.png") },
  { id: "jumping", label: "跳跃动作", rel: path.join("decoded", "jumping.png") },
  { id: "failed", label: "失败动作", rel: path.join("decoded", "failed.png") },
  { id: "waiting", label: "等待动作", rel: path.join("decoded", "waiting.png") },
  { id: "review", label: "检查动作", rel: path.join("decoded", "review.png") }
];

function filePreview(pathValue) {
  if (!pathValue || !fs.existsSync(pathValue)) return null;
  const stat = fs.statSync(pathValue);
  return {
    path: pathValue,
    url: pathToFileURL(pathValue).toString(),
    updatedAt: stat.mtime.toISOString()
  };
}

function petRunProgress(runDir) {
  const root = String(runDir || "");
  if (!root) return { total: PET_JOB_STEPS.length, complete: 0, current: "base", steps: [] };
  const steps = PET_JOB_STEPS.map((step) => {
    const preview = filePreview(path.join(root, step.rel));
    return {
      id: step.id,
      label: step.label,
      status: preview ? "complete" : "pending",
      preview
    };
  });
  const complete = steps.filter((step) => step.status === "complete").length;
  const current = steps.find((step) => step.status !== "complete")?.id || "finalizing";
  return {
    total: steps.length,
    complete,
    current,
    steps,
    preview: filePreview(path.join(root, "preview", "spritesheet.png")),
    final: filePreview(path.join(root, "final", "spritesheet.png")),
    contactSheet: filePreview(path.join(root, "qa", "contact-sheet.png"))
  };
}

function petJobSnapshot(job) {
  return {
    id: job.id,
    fellowKey: job.fellowKey,
    fellowName: job.fellowName,
    petId: job.petId,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || "",
    error: job.error || "",
    runDir: job.runDir,
    packageDir: job.packageDir || "",
    logPath: job.logPath || "",
    prompt: job.userPrompt || "",
    stylePreset: job.stylePreset || "codex",
    referenceImages: job.referenceImages || [],
    progress: petRunProgress(job.runDir),
    logs: (job.logs || []).slice(-40)
  };
}

function getPetJobs() {
  return Array.from(petJobs.values())
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .map(petJobSnapshot);
}

function startFellowPetGeneration(input = {}) {
  initializeRuntime();
  const key = String(input.fellowKey || input.key || "").trim();
  const manifest = loadFellowManifest();
  const fellow = (manifest.fellows || []).find((item) => item.key === key);
  if (!fellow) throw new Error("Fellow not found.");
  const generatorRoot = petGeneratorRoot();
  const script = path.join(generatorRoot, "hatch_generate.py");
  if (!fs.existsSync(script)) throw new Error(`Aimashi pet generator not found: ${script}`);

  const p = runtimePaths();
  const jobId = crypto.randomUUID();
  const petId = fellowPetId(fellow.key);
  const runDir = path.join(p.petJobsDir, `${petId}-${jobId.slice(0, 8)}`);
  const refDir = path.join(runDir, "aimashi-references");
  const referenceImages = Array.isArray(input.referenceImages) ? input.referenceImages : [];
  const references = referenceImages
    .map((value, index) => materializePetReference(value, refDir, index + 1))
    .filter(Boolean);
  const stylePreset = String(input.stylePreset || "codex").trim() || "codex";
  const userPrompt = String(input.prompt || "").trim();
  const style = styleSettingsForPet(stylePreset);
  const prompt = buildFellowPetPrompt(fellow, userPrompt);
  const job = {
    id: jobId,
    fellowKey: fellow.key,
    fellowName: fellow.name,
    petId,
    status: "running",
    startedAt: new Date().toISOString(),
    runDir,
    packageDir: path.join(p.petDir, petId),
    logPath: path.join(runDir, "generation.log"),
    userPrompt,
    stylePreset,
    referenceImages,
    logs: []
  };
  petJobs.set(jobId, job);
  fs.mkdirSync(runDir, { recursive: true });

  const args = [
    script,
    "--prompt", prompt,
    "--pet-id", petId,
    "--display-name", fellow.name,
    "--description", `${fellow.name} 的 Aimashi 桌宠。`,
    "--style-notes", style.styleNotes,
    "--style-contract", style.styleContract,
    "--row-concurrency", "3",
    "--run-dir", runDir,
    "--package-dir", path.join(p.petDir, petId),
    "--no-partial-preview"
  ];
  const remote = petRemoteCodexSettings();
  if (remote.host) {
    args.push("--remote-host", remote.host);
    if (remote.root) args.push("--remote-root", remote.root);
  }
  for (const reference of references) args.push("--reference", reference);
  for (const reference of style.styleReferences) args.push("--style-reference", reference);

  const child = spawn("python3", args, {
    cwd: generatorRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const append = (chunk) => {
    const text = String(chunk || "");
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      job.logs.push(line);
      if (job.logs.length > 160) job.logs.shift();
    }
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("error", (error) => {
    job.status = "failed";
    job.error = error.message;
    job.finishedAt = new Date().toISOString();
  });
  child.on("close", (code) => {
    job.finishedAt = new Date().toISOString();
    if (code === 0 && findFellowPetPackage(fellow.key)) {
      job.status = "completed";
    } else {
      job.status = "failed";
      job.error = code === 0 ? "生成结束，但没有找到可用的 pet.json + spritesheet。" : `生成进程退出：${code}`;
    }
  });
  return petJobSnapshot(job);
}

const PET_WINDOW_COMPACT = { width: 144, height: 150 };
const PET_WINDOW_MESSAGE = { width: 260, height: 220 };
const PET_MESSAGE_DURATION_MS = 8500;
const DEFAULT_PET_REMOTE_HOST = "root@23.95.43.168";
const DEFAULT_PET_REMOTE_ROOT = "~/.aimashi/pet-runs";

function resizePetWindow(win, size) {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  win.setBounds({
    x: bounds.x + bounds.width - size.width,
    y: bounds.y + bounds.height - size.height,
    width: size.width,
    height: size.height
  }, false);
}

function notifyFellowPetMessage(fellowKey, text) {
  const key = String(fellowKey || "").trim();
  const content = String(text || "").trim();
  if (!key || !content) return;
  const win = petWindows.get(key);
  if (!win || win.isDestroyed()) return;

  resizePetWindow(win, PET_WINDOW_MESSAGE);
  try {
    win.webContents.send("pet:message", {
      fellowKey: key,
      text: content,
      durationMs: PET_MESSAGE_DURATION_MS,
      ts: Date.now()
    });
  } catch {
    // Ignore closed-window IPC races.
  }

  const existingTimer = petMessageTimers.get(key);
  if (existingTimer) clearTimeout(existingTimer);
  const timer = setTimeout(() => {
    petMessageTimers.delete(key);
    const current = petWindows.get(key);
    if (current && !current.isDestroyed()) resizePetWindow(current, PET_WINDOW_COMPACT);
  }, PET_MESSAGE_DURATION_MS + 400);
  petMessageTimers.set(key, timer);
}

function placeFellowPet(key) {
  initializeRuntime();
  const id = String(key || "").trim();
  const pet = findFellowPetPackage(id);
  if (!pet) throw new Error("这个 Fellow 还没有可用桌宠资产。");
  const existing = petWindows.get(id);
  if (existing && !existing.isDestroyed()) return petStatusForFellow(id);
  const petWindowWidth = PET_WINDOW_COMPACT.width;
  const petWindowHeight = PET_WINDOW_COMPACT.height;

  const win = new BrowserWindow({
    width: petWindowWidth,
    height: petWindowHeight,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, "pet-preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  petWindows.set(id, win);
  if (process.platform === "darwin") {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  } else {
    win.setVisibleOnAllWorkspaces(true);
  }
  win.setAlwaysOnTop(true, "floating");
  const display = require("electron").screen.getPrimaryDisplay().workArea;
  win.setBounds({
    x: display.x + display.width - petWindowWidth - 24,
    y: display.y + display.height - petWindowHeight - 24,
    width: petWindowWidth,
    height: petWindowHeight
  }, false);
  const url = pathToFileURL(path.join(__dirname, "renderer", "pet.html"));
  url.searchParams.set("sheet", pathToFileURL(pet.spritesheetPath).toString());
  url.searchParams.set("name", pet.displayName);
  win.loadURL(url.toString());
  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) win.showInactive();
  });
  win.on("closed", () => {
    if (petWindows.get(id) === win) petWindows.delete(id);
    const timer = petMessageTimers.get(id);
    if (timer) clearTimeout(timer);
    petMessageTimers.delete(id);
  });
  return petStatusForFellow(id);
}

function recallFellowPet(key) {
  const id = String(key || "").trim();
  const win = petWindows.get(id);
  if (win && !win.isDestroyed()) win.close();
  petWindows.delete(id);
  const timer = petMessageTimers.get(id);
  if (timer) clearTimeout(timer);
  petMessageTimers.delete(id);
  return petStatusForFellow(id);
}


function migrateLegacyPersonas(created) {
  const p = runtimePaths();
  const manifest = loadFellowManifest();
  const hadFellowManifest = fs.existsSync(p.fellowManifest);
  saveFellowManifest(manifest);
  if (!hadFellowManifest) {
    created.push("runtime/engine-home/fellows/manifest.json");
  }

  for (const fellow of manifest.fellows) {
    const mdPath = path.join(p.fellowDir, `${fellow.key}.md`);
    const metaPath = path.join(p.fellowDir, `${fellow.key}.fellow.json`);
    const legacyMdPath = path.join(p.legacyPersonaDir, `${fellow.key}.md`);
    let body = "";
    if (fs.existsSync(mdPath)) {
      body = fs.readFileSync(mdPath, "utf8");
    } else if (fs.existsSync(legacyMdPath)) {
      body = fs.readFileSync(legacyMdPath, "utf8");
    } else {
      body = fellowPersonaBody(fellow.name, fellow.bio);
    }
    if (writeFileIfMissing(mdPath, body)) {
      created.push(`runtime/engine-home/fellows/${fellow.key}.md`);
    }
    if (writeFileIfMissing(metaPath, JSON.stringify(fellowMetadata(fellow), null, 2) + "\n")) {
      created.push(`runtime/engine-home/fellows/${fellow.key}.fellow.json`);
    }
  }
}

function ensureClaudeBridgePlugin() {
  const p = runtimePaths();
  const bridgeDir = path.join(p.runtime, "claude-bridge-plugin");
  const manifestDir = path.join(bridgeDir, ".claude-plugin");
  const manifestPath = path.join(manifestDir, "plugin.json");
  const bridgeSkillsDir = path.join(bridgeDir, "skills");

  fs.mkdirSync(manifestDir, { recursive: true });
  if (!fs.existsSync(manifestPath)) {
    fs.writeFileSync(manifestPath, JSON.stringify({
      name: "aimashi-skills",
      version: "1.0.0",
      description: "Aimashi bridge: surfaces Hermes runtime skills to Claude Code engine."
    }, null, 2) + "\n");
  }

  fs.rmSync(bridgeSkillsDir, { recursive: true, force: true });
  fs.mkdirSync(bridgeSkillsDir, { recursive: true });

  const sourceRoots = [
    { key: "aimashi", root: path.join(p.home, "skills") }
  ];
  const seen = new Set();
  for (const source of sourceRoots) {
    const root = source.root;
    if (!fs.existsSync(root)) continue;
    let categories = [];
    try { categories = fs.readdirSync(root); } catch { continue; }
    for (const category of categories) {
      const categoryPath = path.join(root, category);
      let stat;
      try { stat = fs.statSync(categoryPath); } catch { continue; }
      if (!stat.isDirectory()) continue;
      let skills = [];
      try { skills = fs.readdirSync(categoryPath); } catch { continue; }
      for (const skill of skills) {
        const skillPath = path.join(categoryPath, skill);
        let skillStat;
        try { skillStat = fs.statSync(skillPath); } catch { continue; }
        if (!skillStat.isDirectory()) continue;
        if (!fs.existsSync(path.join(skillPath, "SKILL.md"))) continue;
        const candidates = [
          skill,
          `${source.key}-${skill}`,
          skill.startsWith(`${category}-`) ? `${source.key}-${category}-${skill}` : `${category}-${skill}`
        ];
        const linkName = candidates.find((candidate) => !seen.has(candidate));
        if (!linkName) continue;
        seen.add(linkName);
        try {
          fs.symlinkSync(skillPath, path.join(bridgeSkillsDir, linkName), "dir");
        } catch {
          // ignore individual symlink failures (FS permission, exists, etc.)
        }
      }
    }
  }
  const fingerprint = crypto
    .createHash("sha256")
    .update([...seen].sort().join("\n"))
    .digest("hex")
    .slice(0, 16);
  return { path: bridgeDir, fingerprint };
}

function initializeRuntimeCore() {
  const p = runtimePaths();
  const created = [];
  fs.mkdirSync(p.engine, { recursive: true });
  fs.mkdirSync(p.home, { recursive: true });
  fs.mkdirSync(p.pluginsDir, { recursive: true });
  fs.mkdirSync(p.fellowDir, { recursive: true });
  fs.rmSync(path.join(p.home, "souls"), { recursive: true, force: true });
  fs.mkdirSync(p.petDir, { recursive: true });
  fs.mkdirSync(p.petJobsDir, { recursive: true });
  ensureEnginePlugins();

  if (writeFileIfMissing(path.join(p.engine, "README.md"), [
    "# Aimashi Hermes Engine",
    "",
    "This directory is reserved for Aimashi's bundled or downloaded Hermes engine.",
    "The demo intentionally does not inspect or modify any user-installed Hermes checkout.",
    ""
  ].join("\n"))) {
    created.push("runtime/hermes-engine/README.md");
  }

  let apiKey = "";
  if (!fs.existsSync(p.apiKey)) {
    apiKey = crypto.randomBytes(32).toString("hex");
    writeFileIfMissing(p.apiKey, `${apiKey}\n`, 0o600);
    created.push("runtime/engine-home/api-server.key");
  } else {
    apiKey = fs.readFileSync(p.apiKey, "utf8").trim();
  }

  const configExisted = fs.existsSync(p.config);
  writeRuntimeConfig(readConfiguredPort());
  if (!configExisted) {
    created.push("runtime/engine-home/config.yaml");
  }

  if (writeFileIfMissing(p.modelSettings, JSON.stringify({
    ...settingsStore.defaultModelSettings()
  }, null, 2) + "\n", 0o600)) {
    created.push("runtime/engine-home/aimashi-model.json");
  }

  if (writeFileIfMissing(p.providerConnections, JSON.stringify(defaultProviderStore(), null, 2) + "\n", 0o600)) {
    created.push("runtime/engine-home/aimashi-providers.json");
  }

  importFromSystemHermes();

  if (writeFileIfMissing(p.permissionSettings, JSON.stringify(settingsStore.defaultPermissionSettings(), null, 2) + "\n", 0o600)) {
    created.push("runtime/engine-home/aimashi-permissions.json");
  }

  if (writeFileIfMissing(p.effortSettings, JSON.stringify(settingsStore.defaultEffortSettings(), null, 2) + "\n", 0o600)) {
    created.push("runtime/engine-home/aimashi-effort.json");
  }

  if (writeFileIfMissing(p.daemonSettings, JSON.stringify(settingsStore.defaultDaemonSettings(), null, 2) + "\n", 0o600)) {
    created.push("runtime/engine-home/aimashi-daemon.json");
  }

  if (writeFileIfMissing(p.daemonToken, `${crypto.randomBytes(32).toString("hex")}\n`, 0o600)) {
    created.push("runtime/engine-home/aimashi-daemon.key");
  }

  if (writeFileIfMissing(p.relaySettings, JSON.stringify(settingsStore.defaultRelaySettings(), null, 2) + "\n", 0o600)) {
    created.push("runtime/engine-home/aimashi-relay.json");
  }

  if (writeFileIfMissing(p.userProfile, JSON.stringify(settingsStore.defaultUserProfile(), null, 2) + "\n")) {
    created.push("runtime/engine-home/aimashi-user.json");
  }

  if (writeFileIfMissing(p.appearanceSettings, JSON.stringify(settingsStore.defaultAppearanceSettings(), null, 2) + "\n")) {
    created.push("runtime/engine-home/aimashi-appearance.json");
  }

  if (writeFileIfMissing(p.chatSessions, JSON.stringify(defaultChatStore(), null, 2) + "\n", 0o600)) {
    created.push("runtime/engine-home/aimashi-sessions.json");
  }

  if (writeFileIfMissing(p.soul, [
    "# Aimashi Shared Soul",
    "",
    "你是 Aimashi 应用中的本地伙伴。这里是所有 Fellow 共享的基础语气。",
    "具体名字、身份和关系写在 fellows/<fellow_id>.md。",
    "",
    "## Style",
    "- 直接、清楚、少客套",
    "- 不假装已经连接外部账号",
    "- 优先说明当前可执行的下一步",
    ""
  ].join("\n"))) {
    created.push("runtime/engine-home/SOUL.md");
  }

  migrateLegacyPersonas(created);

  try {
    ensureClaudeBridgePlugin();
  } catch (error) {
    appendEngineLog(`Claude bridge plugin setup failed: ${error?.message || error}`);
  }

  return getRuntimeStatus(created);
}

let runtimeLifecycleService = null;
function runtimeLifecycle() {
  if (!runtimeLifecycleService) {
    runtimeLifecycleService = createRuntimeLifecycleService({
      appendDaemonLog,
      appendEngineLog,
      getRuntimeStatus,
      initializeRuntimeCore,
      isDaemonProcess: IS_DAEMON_PROCESS,
      refreshSystemHermesAsync,
      setDaemonLastError: (message) => { controlServerState.lastError = message; },
      setEngineLastError: (message) => { engineState.lastError = message; },
      startDaemonService,
      startEngine,
      timer: startupTimer
    });
  }
  return runtimeLifecycleService;
}

function initializeRuntime() {
  return runtimeLifecycle().initializeRuntime();
}

function apiKey() {
  const p = runtimePaths();
  if (!fs.existsSync(p.apiKey)) {
    fs.mkdirSync(path.dirname(p.apiKey), { recursive: true });
    fs.writeFileSync(p.apiKey, `${crypto.randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  }
  return fs.readFileSync(p.apiKey, "utf8").trim();
}

function modelSettings() {
  const p = runtimePaths();
  const saved = readJson(p.modelSettings, {});
  if (!saved.provider && !saved.model && !saved.apiKey) return settingsStore.defaultModelSettings();
  return { ...settingsStore.defaultModelSettings(), ...saved };
}

function defaultProviderStore() {
  return {
    schema_version: 1,
    providers: {}
  };
}

function normalizeProviderConnection(provider, input = {}) {
  const id = String(input.provider || provider || "").trim();
  if (!id) return null;
  return {
    provider: id,
    providerLabel: String(input.providerLabel || input.label || id).trim() || id,
    authType: String(input.authType || "api_key").trim() || "api_key",
    apiKeyEnv: String(input.apiKeyEnv || "").trim(),
    apiKey: String(input.apiKey || "").trim(),
    baseUrl: String(input.baseUrl || "").trim(),
    apiMode: String(input.apiMode || "").trim(),
    connectedAt: String(input.connectedAt || new Date().toISOString())
  };
}

function providerConnectionStore() {
  const raw = readJson(runtimePaths().providerConnections, defaultProviderStore());
  const providers = raw?.providers && typeof raw.providers === "object" ? raw.providers : {};
  const normalized = defaultProviderStore();
  for (const [provider, value] of Object.entries(providers)) {
    const next = normalizeProviderConnection(provider, value);
    if (next) normalized.providers[next.provider] = next;
  }
  return normalized;
}

function saveProviderConnection(connection) {
  const p = runtimePaths();
  const store = providerConnectionStore();
  const next = normalizeProviderConnection(connection.provider, connection);
  if (!next) return store;
  store.providers[next.provider] = next;
  fs.mkdirSync(path.dirname(p.providerConnections), { recursive: true });
  fs.writeFileSync(p.providerConnections, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  return store;
}

function removeProviderConnection(provider) {
  const id = String(provider || "").trim();
  if (!id) return providerConnectionStore();
  const p = runtimePaths();
  const store = providerConnectionStore();
  delete store.providers[id];
  fs.mkdirSync(path.dirname(p.providerConnections), { recursive: true });
  fs.writeFileSync(p.providerConnections, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  return store;
}

function providerConnection(provider) {
  const id = String(provider || "").trim();
  if (!id) return null;
  return providerConnectionStore().providers[id] || null;
}

function connectedProviderSummaries(codexAuth = getCodexAuthStatus()) {
  const store = providerConnectionStore();
  const summaries = Object.values(store.providers)
    .filter((entry) => entry.provider && (entry.apiKey || entry.authType !== "api_key" || entry.provider === "lmstudio"))
    .map((entry) => ({
      provider: entry.provider,
      providerLabel: entry.providerLabel || entry.provider,
      authType: entry.authType || "api_key",
      apiKeyEnv: entry.apiKeyEnv || "",
      baseUrl: entry.baseUrl || "",
      apiMode: entry.apiMode || "",
      connectedAt: entry.connectedAt || "",
      hasApiKey: Boolean(entry.apiKey) || entry.authType !== "api_key" || entry.provider === "lmstudio"
    }));
  if (codexAuth.codexLoggedIn && !summaries.some((entry) => entry.provider === "openai-codex")) {
    summaries.push({
      provider: "openai-codex",
      providerLabel: "OpenAI Codex",
      authType: "oauth_external",
      apiKeyEnv: "",
      baseUrl: "",
      apiMode: "codex_responses",
      connectedAt: "",
      hasApiKey: true
    });
  }
  const current = modelSettings();
  if (current.provider && current.apiKey && !summaries.some((entry) => entry.provider === current.provider)) {
    summaries.push({
      provider: current.provider,
      providerLabel: current.provider,
      authType: current.provider === "openai-codex" ? "oauth_external" : "api_key",
      apiKeyEnv: current.apiKeyEnv || "",
      baseUrl: current.baseUrl || "",
      apiMode: current.apiMode || "",
      connectedAt: "",
      hasApiKey: true
    });
  }
  return summaries.sort((a, b) => String(a.providerLabel).localeCompare(String(b.providerLabel)));
}

function externalSkillDirs() {
  const candidates = [];
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      if (fs.statSync(candidate).isDirectory()) result.push(candidate);
    } catch {
      // skip missing/inaccessible paths
    }
  }
  return result;
}

function atomicWriteFile(filePath, content, mode = 0o600) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, content, { mode });
  fs.renameSync(tmpPath, filePath);
}

function writeRuntimeConfig(port) {
  const p = runtimePaths();
  const settings = modelSettings();
  const provider = String(settings.provider || "").trim();
  const model = String(settings.model || "").trim();
  const baseUrl = String(settings.baseUrl || "").trim();
  const apiMode = String(settings.apiMode || "").trim();
  const approvalsMode = settingsStore.permissionSettings().mode;
  const reasoningEffort = settingsStore.effortSettings().level;
  const source = engineSource();
  const configPath = path.join(effectiveHermesHome(), "config.yaml");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });

  // aimashi always writes its OWN private config.yaml (effectiveHermesHome is private).
  fs.mkdirSync(p.home, { recursive: true });
  const lines = [
    "model:",
    `  provider: ${JSON.stringify(provider)}`,
    `  default: ${JSON.stringify(model)}`,
  ];
  if (baseUrl) lines.push(`  base_url: ${JSON.stringify(baseUrl)}`);
  if (apiMode) lines.push(`  api_mode: ${JSON.stringify(apiMode)}`);
  lines.push(
    "",
    "platforms:",
    "  api_server:",
    "    enabled: true",
    "    host: 127.0.0.1",
    `    port: ${port}`,
    `    key: ${apiKey()}`,
    "  feishu:",
    "    enabled: false",
    "  telegram:",
    "    enabled: false",
    "  discord:",
    "    enabled: false",
    "",
    "approvals:",
    `  mode: ${JSON.stringify(approvalsMode)}`,
    "  timeout: 60",
    "",
    "agent:",
    `  reasoning_effort: ${JSON.stringify(reasoningEffort)}`,
    ""
  );
  const extDirs = externalSkillDirs();
  if (extDirs.length) {
    lines.push("skills:");
    lines.push("  external_dirs:");
    for (const dir of extDirs) lines.push(`    - ${JSON.stringify(dir)}`);
    lines.push("");
  }
  lines.push(
    "aimashi:",
    "  runtime_schema: 1",
    "  fellows_manifest: fellows/manifest.json",
    ""
  );
  atomicWriteFile(configPath, lines.join("\n"), 0o600);
}

function daemonConnectUrls(settings = settingsStore.daemonSettings()) {
  const port = settingsStore.normalizeDaemonPort(settings.port);
  const host = settingsStore.normalizeDaemonHost(settings.host);
  if (host !== "0.0.0.0" && host !== "::") {
    return [`http://${host}:${port}`];
  }
  const urls = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (!entry || entry.internal || entry.family !== "IPv4") continue;
      if (/^169\.254\./.test(entry.address)) continue;
      if (/^198\.(18|19)\./.test(entry.address)) continue;
      urls.push(`http://${entry.address}:${port}`);
    }
  }
  return urls.length ? urls : [`http://127.0.0.1:${port}`];
}

function daemonPingUrls(settings = settingsStore.daemonSettings()) {
  const urls = daemonConnectUrls(settings);
  const port = settingsStore.normalizeDaemonPort(settings.port);
  const host = settingsStore.normalizeDaemonHost(settings.host);
  const localUrl = `http://127.0.0.1:${port}`;
  const candidates = host === "0.0.0.0" || host === "::" || host === "localhost"
    ? [localUrl, ...urls]
    : urls;
  return candidates.filter((url, index, list) => url && list.indexOf(url) === index);
}

function getDaemonStatus() {
  const settings = settingsStore.daemonSettings();
  return {
    processMode: IS_DAEMON_PROCESS ? "daemon" : "desktop",
    serviceLabel: AIMASHI_DAEMON_SERVICE_LABEL,
    settings,
    running: Boolean(controlServerState.running),
    starting: Boolean(controlServerState.starting),
    host: controlServerState.host || settings.host,
    port: controlServerState.port || settings.port,
    baseUrl: controlServerState.baseUrl || `http://${settings.host}:${settings.port}`,
    connectUrls: daemonConnectUrls(settings),
    launchAgent: runtimePaths().daemonLaunchAgent,
    lastError: controlServerState.lastError,
    logs: controlServerState.logs.slice(-80)
  };
}

function getDaemonPairingInfo() {
  const status = getDaemonStatus();
  const token = daemonToken();
  const links = status.connectUrls.map((baseUrl) => `${baseUrl}/mobile/#token=${encodeURIComponent(token)}`);
  return {
    ...status,
    token,
    links
  };
}

async function getObservedDaemonStatus(timeoutMs = 500) {
  const status = getDaemonStatus();
  if (controlServerState.running) return status;
  const ping = await pingDaemon(settingsStore.daemonSettings(), timeoutMs);
  return {
    ...status,
    running: ping.ok,
    baseUrl: ping.baseUrl || status.baseUrl
  };
}

function relayHttpOrigin(wsUrl) {
  try {
    const url = new URL(wsUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function relayPairingLink(settings = settingsStore.relaySettings()) {
  const origin = relayHttpOrigin(settings.url);
  if (!origin) return "";
  const params = new URLSearchParams({
    mode: "relay",
    device: settings.deviceId,
    relay: settings.url,
    v: MOBILE_ASSET_VERSION
  });
  return `${origin}/mobile/?${params.toString()}#secret=${encodeURIComponent(settings.secret)}`;
}

function relayStatus(includeSecret = false) {
  const settings = settingsStore.relaySettings();
  return {
    enabled: settings.enabled,
    connected: Boolean(relayState.connected),
    connecting: Boolean(relayState.connecting),
    url: settings.url,
    deviceId: settings.deviceId,
    mobilePeers: relayState.mobilePeers || 0,
    pairingLink: relayPairingLink(settings),
    lastError: relayState.lastError,
    logs: relayState.logs.slice(-80),
    ...(includeSecret ? { secret: settings.secret } : {})
  };
}

function getRuntimeStatus(created = []) {
  const p = runtimePaths();
  const manifest = loadFellowManifest();
  const codexAuth = getCodexAuthStatus();
  const settings = settingsWithoutSecret();
  const connectedProviders = connectedProviderSummaries(codexAuth);
  const fellows = Array.isArray(manifest.fellows) ? manifest.fellows : defaultFellowManifest().fellows;
  return {
    appData: p.root,
    runtimeRoot: p.runtime,
    engineRoot: p.engine,
    hermesHome: p.home,
    manifestPath: p.fellowManifest,
    configPath: p.config,
    created,
    engineInstalled: isEngineInstalled(),
    engineSource: engineSource(),
    managedVenvExists: fs.existsSync(venvPythonPath()),
    engineRunning: engineState.running,
    engineStarting: engineState.starting,
    engineBaseUrl: engineState.baseUrl,
    enginePort: engineState.port,
    engineManagedBy: engineState.managedBy,
    engineServiceLabel: AIMASHI_GATEWAY_SERVICE_LABEL,
    engineLastError: engineState.lastError,
    engineLogs: engineState.logs.slice(-80),
    daemon: getDaemonStatus(),
    relay: relayStatus(false),
    cloud: cloudStatus(false),
    auth: codexAuth,
    user: { ...settingsStore.defaultUserProfile(), ...readJson(p.userProfile, {}) },
    appearance: appearanceSettings(),
    agentEngines: localAgentEngines(),
    permissions: settingsStore.permissionStatus(),
    effort: settingsStore.effortStatus(),
    model: {
      provider: settings.provider,
      model: settings.model,
      apiKeyEnv: settings.apiKeyEnv,
      baseUrl: settings.baseUrl,
      apiMode: settings.apiMode,
      hasApiKey: connectedProviders.some((entry) => entry.provider === settings.provider && entry.hasApiKey)
    },
    connectedProviders,
    fellows,
    personas: fellows,
    pets: petStatusesForFellows(fellows),
    petJobs: getPetJobs()
  };
}

function getCodexAuthStatus() {
  const p = runtimePaths();
  const auth = readJson(p.authJson, {});
  const providers = auth && typeof auth.providers === "object" ? auth.providers : {};
  const codexState = providers ? providers["openai-codex"] : null;
  let poolCount = 0;
  const pool = auth && typeof auth.credential_pool === "object" ? auth.credential_pool : {};
  const codexPool = pool ? pool["openai-codex"] : null;
  if (Array.isArray(codexPool?.entries)) poolCount = codexPool.entries.length;
  else if (Array.isArray(codexPool)) poolCount = codexPool.length;

  const providerTokens = Boolean(codexState?.tokens?.access_token);
  const loggedIn = providerTokens || poolCount > 0;
  authState.codexLoggedIn = loggedIn;
  return {
    codexStarting: authState.codexStarting,
    codexLoggedIn: loggedIn,
    oauthProvider: authState.oauthProvider,
    oauthProviderLabel: authState.oauthProviderLabel,
    codexAuthPath: p.authJson,
    codexVerificationUrl: authState.codexVerificationUrl,
    codexUserCode: authState.codexUserCode,
    codexLastError: authState.codexLastError,
    codexLogs: authState.logs.slice(-120)
  };
}

function settingsWithoutSecret() {
  const settings = modelSettings();
  return {
    provider: settings.provider || "",
    model: settings.model || "",
    apiKeyEnv: settings.apiKeyEnv || "OPENAI_API_KEY",
    baseUrl: settings.baseUrl || "",
    apiMode: settings.apiMode || ""
  };
}

function fallbackModelCatalog() {
  return [
    {
      id: "openai-codex::gpt-5.3-codex",
      provider: "openai-codex",
      providerLabel: "OpenAI Codex",
      model: "gpt-5.3-codex",
      label: "gpt-5.3-codex",
      authType: "oauth_external",
      apiKeyEnv: "",
      baseUrl: "",
      apiMode: "codex_responses"
    },
    {
      id: "xai::grok-4.1-fast",
      provider: "xai",
      providerLabel: "xAI",
      model: "grok-4.1-fast",
      label: "grok-4.1-fast",
      authType: "api_key",
      apiKeyEnv: "XAI_API_KEY",
      baseUrl: "",
      apiMode: "chat_completions"
    },
    {
      id: "openrouter::anthropic/claude-sonnet-4.6",
      provider: "openrouter",
      providerLabel: "OpenRouter",
      model: "anthropic/claude-sonnet-4.6",
      label: "anthropic/claude-sonnet-4.6",
      authType: "api_key",
      apiKeyEnv: "OPENROUTER_API_KEY",
      baseUrl: "",
      apiMode: "chat_completions"
    },
    {
      id: "anthropic::claude-sonnet-4-6",
      provider: "anthropic",
      providerLabel: "Anthropic",
      model: "claude-sonnet-4-6",
      label: "claude-sonnet-4-6",
      authType: "api_key",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      baseUrl: "",
      apiMode: "anthropic_messages"
    },
    {
      id: "deepseek::deepseek-chat",
      provider: "deepseek",
      providerLabel: "DeepSeek",
      model: "deepseek-chat",
      label: "deepseek-chat",
      authType: "api_key",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      baseUrl: "",
      apiMode: "chat_completions"
    }
  ];
}

async function loadHermesModelCatalog() {
  if (!isEngineInstalled()) return fallbackModelCatalog();
  return timeEngineStepAsync("Load Hermes model catalog", () => loadHermesModelCatalogInner());
}

function loadCodexModels() {
  // Codex CLI caches its model list at ~/.codex/models_cache.json after the first
  // authenticated session. Read it so aimashi's picker tracks what `codex` actually
  // supports today, instead of a hardcoded snapshot. Returns [] on any failure;
  // the renderer falls back to a built-in list.
  try {
    const cachePath = path.join(app.getPath("home"), ".codex", "models_cache.json");
    const raw = fs.readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(raw);
    const models = Array.isArray(parsed?.models) ? parsed.models : [];
    return models
      .filter((m) => m && typeof m.slug === "string" && m.slug && m.visibility !== "hide")
      .map((m) => ({
        slug: String(m.slug),
        displayName: String(m.display_name || m.slug),
        priority: Number.isFinite(m.priority) ? m.priority : 0
      }))
      .sort((a, b) => a.priority - b.priority);
  } catch {
    return [];
  }
}

async function loadHermesModelCatalogInner() {
  const p = runtimePaths();
  const script = String.raw`
import json

def choose_env(envs):
    values = [str(item or "").strip() for item in (envs or []) if str(item or "").strip()]
    preferred = [item for item in values if item.endswith("_API_KEY")]
    return (preferred or values or [""])[0]

try:
    from hermes_cli.models import CANONICAL_PROVIDERS
    from hermes_cli import models as hermes_models
    from hermes_cli.providers import get_provider, determine_api_mode
except Exception:
    import models as hermes_models
    from models import CANONICAL_PROVIDERS
    from providers import get_provider, determine_api_mode

rows = []
seen = set()
static_provider_models = getattr(hermes_models, "_PROVIDER_MODELS", {}) or {}
openrouter_models = getattr(hermes_models, "OPENROUTER_MODELS", []) or []
for entry in CANONICAL_PROVIDERS:
    provider = str(entry.slug)
    pdef = get_provider(provider)
    provider_label = str(getattr(entry, "label", "") or getattr(pdef, "name", "") or provider)
    auth_type = str(getattr(pdef, "auth_type", "") or "api_key")
    api_key_env = choose_env(getattr(pdef, "api_key_env_vars", ()) if pdef else ())
    base_url = str(getattr(pdef, "base_url", "") or "")
    api_mode = determine_api_mode(provider, base_url)
    if provider == "openrouter":
        models = [item[0] if isinstance(item, (tuple, list)) and item else item for item in openrouter_models]
    else:
        models = list(static_provider_models.get(provider, []))
    if not models:
        models = [""]
    for model in models:
        model_id = str(model or "").strip()
        key = f"{provider}::{model_id}"
        if key in seen:
            continue
        seen.add(key)
        rows.append({
            "id": key,
            "provider": provider,
            "providerLabel": provider_label,
            "model": model_id,
            "label": model_id or "LM Studio 当前加载模型",
            "authType": auth_type,
            "apiKeyEnv": "" if auth_type.startswith("oauth") else api_key_env,
            "baseUrl": base_url,
            "apiMode": api_mode,
        })
print(json.dumps(rows, ensure_ascii=False))
`;
  const result = await runPythonScript(["-c", script], {
    cwd: p.engine,
    env: {
      ...process.env,
      HERMES_HOME: effectiveHermesHome(),
      AIMASHI_HOME: p.home,
      PYTHONPATH: buildPythonPath()
    },
    encoding: "utf8",
    timeout: 15000
  });
  if (result.status !== 0) {
    appendEngineLog(`Model catalog fallback: ${result.stderr || `python exited ${result.status}`}`);
    return fallbackModelCatalog();
  }
  try {
    const rows = JSON.parse(String(result.stdout || "[]"));
    if (Array.isArray(rows) && rows.length) return rows;
  } catch (error) {
    appendEngineLog(`Model catalog parse failed: ${error.message}`);
  }
  return fallbackModelCatalog();
}

async function loadEngineCapabilities() {
  if (!isEngineInstalled()) {
    return { approvalModes: ["ask", "yolo", "deny"], effortLevels: ["low", "medium", "high"] };
  }
  const p = runtimePaths();
  const script = String.raw`
import json
result = {"approvalModes": ["ask", "yolo", "deny"], "effortLevels": ["low", "medium", "high"]}
try:
    from hermes_cli.web_server import SETTINGS_SCHEMA
    if "approvals.mode" in SETTINGS_SCHEMA and "options" in SETTINGS_SCHEMA["approvals.mode"]:
        result["approvalModes"] = list(SETTINGS_SCHEMA["approvals.mode"]["options"])
    if "agent.reasoning_effort" in SETTINGS_SCHEMA and "options" in SETTINGS_SCHEMA["agent.reasoning_effort"]:
        result["effortLevels"] = list(SETTINGS_SCHEMA["agent.reasoning_effort"]["options"])
except Exception:
    pass
print(json.dumps(result))
`;
  try {
    const r = await runPythonScript(["-c", script], {
      cwd: p.engine,
      env: {
        ...process.env,
        HERMES_HOME: effectiveHermesHome(),
        AIMASHI_HOME: p.home,
        PYTHONPATH: buildPythonPath()
      },
      encoding: "utf8",
      timeout: 8000
    });
    if (r.status === 0) {
      const parsed = JSON.parse(String(r.stdout || "{}"));
      if (Array.isArray(parsed.approvalModes) && parsed.approvalModes.length
          && Array.isArray(parsed.effortLevels) && parsed.effortLevels.length) {
        return parsed;
      }
    }
  } catch { /* fall through */ }
  return { approvalModes: ["ask", "yolo", "deny"], effortLevels: ["low", "medium", "high"] };
}

function fallbackSlashCommands() {
  return [
    { command: "/new", description: "Start a new session (fresh session ID + history)" },
    { command: "/topic", description: "Enable or inspect Telegram DM topic sessions" },
    { command: "/retry", description: "Retry the last message (resend to agent)" },
    { command: "/undo", description: "Remove the last user/assistant exchange" },
    { command: "/title", description: "Set a title for the current session" },
    { command: "/branch", description: "Branch the current session (explore a different path)" },
    { command: "/compress", description: "Manually compress conversation context" },
    { command: "/rollback", description: "List or restore filesystem checkpoints" },
    { command: "/stop", description: "Kill all running background processes" },
    { command: "/status", description: "Show session info" },
    { command: "/model", description: "Switch model for this session" },
    { command: "/personality", description: "Set a predefined personality" },
    { command: "/reasoning", description: "Manage reasoning effort and display" },
    { command: "/fast", description: "Toggle fast mode" },
    { command: "/yolo", description: "Toggle YOLO mode" },
    { command: "/voice", description: "Toggle voice mode" },
    { command: "/agents", description: "Show active agents and running tasks" },
    { command: "/goal", description: "Set a standing goal Hermes works on across turns" },
    { command: "/subgoal", description: "Add or manage checklist items on the active goal" },
    { command: "/usage", description: "Show token usage and rate limits for the current session" },
    { command: "/insights", description: "Show usage insights and analytics" },
    { command: "/commands", description: "Browse all commands and skills" },
    { command: "/help", description: "Show available commands" }
  ];
}

const externalAgentBuiltInCommands = [
  { command: "/help", name: "/help", description: "显示本地外部 Agent 命令帮助", namespace: "builtin", type: "builtin" },
  { command: "/clear", name: "/clear", description: "清空当前对话历史", namespace: "builtin", type: "builtin" },
  { command: "/model", name: "/model", description: "查看当前本地引擎模型", namespace: "builtin", type: "builtin" },
  { command: "/cost", name: "/cost", description: "查看本次 GUI 可见的用量信息", namespace: "builtin", type: "builtin" },
  { command: "/memory", name: "/memory", description: "查看当前项目 CLAUDE.md 记忆文件状态", namespace: "builtin", type: "builtin" },
  { command: "/config", name: "/config", description: "查看当前 Fellow 的本地引擎配置入口", namespace: "builtin", type: "builtin" },
  { command: "/status", name: "/status", description: "查看本地 CLI、模型、权限和外部会话", namespace: "builtin", type: "builtin" },
  { command: "/permissions", name: "/permissions", description: "查看当前本地引擎权限", namespace: "builtin", type: "builtin" },
  { command: "/resume", name: "/resume", description: "把当前 Aimashi 会话绑定到指定外部 session", namespace: "builtin", type: "builtin" },
  { command: "/rewind", name: "/rewind", description: "提示如何回退当前对话", namespace: "builtin", type: "builtin" }
];

function parseCommandFrontmatter(markdown = "") {
  const raw = String(markdown || "");
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) return { data: {}, content: raw };
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: {}, content: raw };
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/);
    if (!item) continue;
    let value = item[2] || "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    data[item[1]] = value;
  }
  return { data, content: raw.slice(match[0].length) };
}

function commandFromMarkdownFile(filePath, baseDir, namespace) {
  const content = fs.readFileSync(filePath, "utf8");
  const parsed = parseCommandFrontmatter(content);
  const relativePath = path.relative(baseDir, filePath);
  const command = `/${relativePath.replace(/\.md$/i, "").replace(/\\/g, "/")}`;
  const firstLine = parsed.content.trim().split(/\r?\n/)[0] || "";
  const description = String(parsed.data.description || firstLine.replace(/^#+\s*/, "").trim() || "自定义 Claude Code 命令");
  return {
    command,
    name: command,
    path: filePath,
    relativePath,
    description,
    namespace,
    type: "custom",
    metadata: parsed.data
  };
}

function scanAgentCommandsDirectory(dir, baseDir, namespace) {
  const commands = [];
  try {
    if (!fs.existsSync(dir)) return commands;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        commands.push(...scanAgentCommandsDirectory(fullPath, baseDir, namespace));
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        try {
          commands.push(commandFromMarkdownFile(fullPath, baseDir, namespace));
        } catch (error) {
          appendEngineLog(`Agent command parse failed: ${fullPath}: ${error.message}`);
        }
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "EACCES") {
      appendEngineLog(`Agent command scan failed: ${dir}: ${error.message}`);
    }
  }
  return commands;
}

function agentCommandRoots(engine, projectPath = process.cwd()) {
  const normalized = normalizeFellowAgentEngine(engine);
  if (normalized !== "claude-code") return [];
  const roots = [];
  const project = String(projectPath || "").trim() || process.cwd();
  if (project) roots.push({ namespace: "project", root: path.join(project, ".claude", "commands") });
  roots.push({ namespace: "user", root: path.join(app.getPath("home"), ".claude", "commands") });
  return roots;
}

function loadExternalAgentCommands(input = {}) {
  const engine = normalizeFellowAgentEngine(input.engine);
  const projectPath = String(input.projectPath || process.cwd()).trim() || process.cwd();
  const builtIn = externalAgentBuiltInCommands.map((item) => ({ ...item, engine }));
  const custom = [];
  for (const root of agentCommandRoots(engine, projectPath)) {
    custom.push(...scanAgentCommandsDirectory(root.root, root.root, root.namespace));
  }
  custom.sort((a, b) => a.command.localeCompare(b.command));
  const rows = [...builtIn, ...custom.map((item) => ({ ...item, engine }))];
  return { builtIn, custom: custom.map((item) => ({ ...item, engine })), count: rows.length, rows };
}

function splitCommandInvocation(text = "") {
  const input = String(text || "").trim();
  const command = input.split(/\s+/)[0]?.toLowerCase() || "";
  const argText = input.slice(command.length).trim();
  const args = argText ? argText.split(/\s+/).filter(Boolean) : [];
  return { command, argText, args };
}

function assertAllowedAgentCommandPath(commandPath, engine, projectPath = process.cwd()) {
  const resolved = path.resolve(String(commandPath || ""));
  if (!resolved || !fs.existsSync(resolved)) throw new Error("Command file not found.");
  const roots = agentCommandRoots(engine, projectPath).map((item) => path.resolve(item.root));
  if (!roots.some((root) => isChildPath(root, resolved))) {
    throw new Error("Command must be inside an allowed .claude/commands directory.");
  }
  return resolved;
}

function executeExternalAgentCommand(input = {}) {
  const engine = normalizeFellowAgentEngine(input.engine);
  const command = String(input.commandName || input.command || "").trim().toLowerCase();
  const args = Array.isArray(input.args) ? input.args.map(String) : [];
  const projectPath = String(input.context?.projectPath || input.projectPath || process.cwd()).trim() || process.cwd();
  if (externalAgentBuiltInCommands.some((item) => item.command === command)) {
    return {
      type: "builtin",
      command,
      content: runExternalSlashCommand({
        text: [command, ...args].join(" "),
        fellow: input.context?.fellow || {},
        engine,
        sessionId: input.context?.sessionId || ""
      })
    };
  }
  const commandPath = assertAllowedAgentCommandPath(input.commandPath, engine, projectPath);
  const raw = fs.readFileSync(commandPath, "utf8");
  const parsed = parseCommandFrontmatter(raw);
  let content = parsed.content;
  const argsString = args.join(" ");
  content = content.replace(/\$ARGUMENTS/g, argsString);
  args.forEach((arg, index) => {
    content = content.replace(new RegExp(`\\$${index + 1}\\b`, "g"), arg);
  });
  return {
    type: "custom",
    command,
    content,
    metadata: parsed.data,
    hasFileIncludes: content.includes("@"),
    hasBashCommands: content.includes("!")
  };
}

async function loadHermesSlashCommands() {
  initializeRuntime();
  return timeEngineStepAsync("Load Hermes slash commands", () => loadHermesSlashCommandsInner());
}

async function loadHermesSlashCommandsInner() {
  const p = runtimePaths();
  const script = `
import json
try:
    from hermes_cli.commands import telegram_menu_commands
    commands, hidden = telegram_menu_commands(100)
    rows = [{"command": "/" + name, "description": desc} for name, desc in commands]
except Exception:
    rows = []
print(json.dumps(rows, ensure_ascii=False))
`;
  const result = await runPythonScript(["-c", script], {
    cwd: p.engine,
    env: {
      ...process.env,
      HERMES_HOME: effectiveHermesHome(),
      AIMASHI_HOME: p.home,
      PYTHONPATH: buildPythonPath()
    },
    encoding: "utf8",
    timeout: 15000
  });
  if (result.status !== 0) {
    appendEngineLog(`Slash command fallback: ${result.stderr || `python exited ${result.status}`}`);
    return fallbackSlashCommands();
  }
  try {
    const rows = JSON.parse(String(result.stdout || "[]"));
    if (Array.isArray(rows) && rows.length) {
      return rows
        .filter((item) => item && item.command && item.description)
        .map((item) => ({
          command: String(item.command).startsWith("/") ? String(item.command) : `/${item.command}`,
          description: String(item.description)
        }));
    }
  } catch (error) {
    appendEngineLog(`Slash command parse failed: ${error.message}`);
  }
  return fallbackSlashCommands();
}

function skillRoots() {
  const p = runtimePaths();
  return [
    { source: "aimashi", label: "Aimashi Runtime", root: path.join(p.home, "skills") }
  ];
}

function isChildPath(parentPath, targetPath) {
  const parent = path.resolve(parentPath);
  const target = path.resolve(targetPath);
  const relative = path.relative(parent, target);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}


function isSlashCommandText(messages) {
  const normalized = normalizeRunMessages(messages);
  const dialogue = normalized.filter((message) => message.role !== "system");
  const lastUserIndex = dialogue.map((message) => message.role).lastIndexOf("user");
  if (lastUserIndex < 0) return "";
  const input = dialogue[lastUserIndex].content.trim();
  return /^\/[A-Za-z0-9_/-]+(?:\s|$)/.test(input) ? input : "";
}

function externalAgentStatus({ fellow, engine, sessionId }) {
  const info = localAgentEngines();
  const engineInfo = engine === "claude-code" ? info.claudeCode : info.codex;
  const config = normalizeFellowEngineConfig(fellow.engineConfig);
  const model = config.model || (engine === "claude-code" ? "Claude Code 默认模型" : "Codex 默认模型");
  const permission = config.permissionMode || "default";
  const effort = settingsStore.normalizeEffortLevel(config.effortLevel || "medium", engine);
  const externalSessionId = getAgentSessionId(engine, fellow.key, sessionId) || "尚未创建";
  const label = engine === "claude-code" ? "Claude Code" : "Codex";
  return [
    `${fellow.name || "当前 Fellow"} 使用 ${label} 本地引擎。`,
    `模型：${model}`,
    `推理强度：${effort}`,
    `权限：${permission}`,
    `CLI：${engineInfo?.path || "未检测到"}`,
    engineInfo?.version ? `版本：${engineInfo.version}` : "",
    `外部会话：${externalSessionId}`
  ].filter(Boolean).join("\n");
}

function runExternalSlashCommand({ text, fellow, engine, sessionId }) {
  const command = String(text || "").trim().split(/\s+/)[0].toLowerCase();
  const args = String(text || "").trim().slice(command.length).trim();
  if (command === "/status") return externalAgentStatus({ fellow, engine, sessionId });
  if (command === "/model") {
    const config = normalizeFellowEngineConfig(fellow.engineConfig);
    return `当前模型：${config.model || (engine === "claude-code" ? "Claude Code 默认模型" : "Codex 默认模型")}。\n可以用底部模型选择器切换这个 Fellow 的本地引擎模型。`;
  }
  if (command === "/permissions" || command === "/permission") {
    const config = normalizeFellowEngineConfig(fellow.engineConfig);
    return `当前权限模式：${config.permissionMode || "default"}。\n可以用底部权限选择器切换这个 Fellow 的本地引擎权限。`;
  }
  if (command === "/clear") {
    return "Aimashi 还没有把 /clear 接到当前会话清空动作。现在可以用顶部新对话按钮开启干净会话。";
  }
  if (command === "/cost") {
    return "当前 GUI 通道暂未保存外部 CLI 的 token/cost 汇总。Claude Code 或 Codex CLI 自己的用量以本机 CLI 配置为准。";
  }
  if (command === "/memory") {
    const memoryPath = path.join(process.cwd(), "CLAUDE.md");
    return fs.existsSync(memoryPath)
      ? `当前项目记忆文件：${memoryPath}`
      : `当前项目未找到 CLAUDE.md：${memoryPath}`;
  }
  if (command === "/config") {
    return "本地外部引擎的模型和权限在输入框下方选择器里查看和切换；更底层的账号、默认模型、权限策略仍以用户本机 CLI 配置为准。";
  }
  if (command === "/resume") {
    const current = getAgentSessionId(engine, fellow.key, sessionId);
    const next = args.split(/\s+/).filter(Boolean)[0] || "";
    if (!next) {
      return [
        `当前绑定的外部会话：${current || "尚未创建"}`,
        "用法：/resume <session-id>",
        "说明：Claude Code 的交互式 session picker 不能直接嵌进当前非交互 SDK 通道；这里支持用明确 session id 切换绑定。"
      ].join("\n");
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(next)) {
      return "session-id 看起来不是有效 UUID。用法：/resume <session-id>";
    }
    setAgentSessionId(engine, fellow.key, sessionId, next);
    return `已把当前 Aimashi 会话绑定到外部 session：${next}\n下一条消息会从这个 session 继续。`;
  }
  if (command === "/rewind") {
    return `Aimashi 还没有把 /rewind 接到会话回退动作。参数：${args || "默认 1 步"}。`;
  }
  if (command === "/help") {
    return [
      "当前是本地外部 Agent 引擎，可用命令：",
      "/status - 查看本地 CLI、模型、权限和外部会话",
      "/model - 查看当前模型",
      "/permissions - 查看当前权限模式",
      "/clear - 提示如何开启干净会话",
      "/cost - 查看 GUI 可见的用量状态",
      "/memory - 查看当前项目 CLAUDE.md 状态",
      "/config - 查看当前配置入口",
      "/resume <session-id> - 切换当前 Aimashi 会话绑定的外部 session",
      "/rewind - 提示如何回退对话",
      "Claude Code 自定义命令会从 .claude/commands 和 ~/.claude/commands 扫描。"
    ].join("\n");
  }
  return null;
}

function runHermesSlashCommand({ text, fellow, sessionId }) {
  const p = runtimePaths();
  const sessionKey = cleanRunSessionId(sessionId, fellow.key);
  const payload = JSON.stringify({
    text,
    sessionKey,
    chatName: fellow.name || "Aimashi",
    userName: readJson(p.userProfile, settingsStore.defaultUserProfile()).displayName || "Aimashi"
  });
  const script = `
import asyncio, json, sys
from agent import i18n as _aimashi_i18n
from gateway.config import Platform
from gateway.platforms.base import MessageEvent, MessageType
from gateway.run import GatewayRunner
from gateway.session import SessionSource

payload = json.loads(sys.argv[1])

_AIMASHI_ZH_I18N = {
    "gateway.help.header": "可用命令：",
    "gateway.help.skill_header": "技能命令（{count} 个）：",
    "gateway.help.more_use_commands": "还有 {count} 个技能命令，输入 /commands 查看更多。",
    "gateway.commands.header": "命令列表（共 {total} 条，第 {page}/{total_pages} 页）",
    "gateway.commands.skill_header": "技能命令：",
    "gateway.commands.default_desc": "无描述",
    "gateway.commands.none": "没有可用命令。",
    "gateway.commands.usage": "用法：/commands [页码]",
    "gateway.commands.nav_prev": "上一页：/commands {page}",
    "gateway.commands.nav_next": "下一页：/commands {page}",
    "gateway.commands.out_of_range": "第 {requested} 页不存在，已显示第 {page} 页。",
    "gateway.model.current_label": "当前模型：{model}（{provider}）",
    "gateway.model.current_tag": "（当前）",
    "gateway.model.more_models_suffix": " 等 {count} 个模型",
    "gateway.model.usage_switch_model": "切换模型：/model <模型名>",
    "gateway.model.usage_switch_provider": "切换提供商：/model --provider <提供商>",
    "gateway.model.usage_persist": "保存为默认：/model <模型名> --global",
    "gateway.model.provider_label": "提供商：{provider}",
    "gateway.model.context_label": "上下文：{tokens} tokens",
    "gateway.model.max_output_label": "最大输出：{tokens} tokens",
    "gateway.model.cost_label": "价格：{cost}",
    "gateway.model.capabilities_label": "能力：{capabilities}",
    "gateway.model.session_only_hint": "仅对当前会话生效。",
    "gateway.model.switched": "已切换到 {model}（{provider}）。",
    "gateway.model.saved_global": "已保存为默认模型。",
    "gateway.model.error_prefix": "模型切换失败：",
    "gateway.model.warning_prefix": "提示：",
    "gateway.status.header": "会话状态",
    "gateway.status.session_id": "会话 ID：{session_id}",
    "gateway.status.title": "标题：{title}",
    "gateway.status.created": "创建时间：{created}",
    "gateway.status.last_activity": "最近活动：{last_activity}",
    "gateway.status.tokens": "Token：{tokens}",
    "gateway.status.platforms": "平台：{platforms}",
    "gateway.status.agent_running": "Agent 正在运行。",
    "gateway.status.state_yes": "是",
    "gateway.status.state_no": "否",
    "gateway.stop.no_active": "没有正在运行的任务。",
    "gateway.stop.stopped": "已停止当前任务。",
    "gateway.stop.stopped_pending": "已停止正在启动的任务。",
    "gateway.retry.no_previous": "没有可重试的上一条消息。",
    "gateway.undo.nothing": "没有可撤销的消息。",
    "gateway.undo.removed": "已撤销上一轮对话。",
    "gateway.title.current_no_title": "当前会话还没有标题。",
    "gateway.title.current_with_title": "当前标题：{title}",
    "gateway.title.empty_after_clean": "标题不能为空。",
    "gateway.title.set_to": "标题已设置为：{title}",
    "gateway.profile.header": "当前配置",
    "gateway.profile.home": "Hermes Home：{home}",
    "gateway.usage.no_data": "当前会话还没有用量数据。",
    "gateway.usage.header_session": "当前会话用量",
    "gateway.usage.header_session_info": "会话信息",
    "gateway.usage.label_model": "模型",
    "gateway.usage.label_messages": "消息",
    "gateway.usage.label_input_tokens": "输入 tokens",
    "gateway.usage.label_output_tokens": "输出 tokens",
    "gateway.usage.label_total": "总计",
    "gateway.usage.label_cost": "费用",
    "gateway.usage.rate_limits": "速率限制",
}
with _aimashi_i18n._catalog_lock:
    _aimashi_i18n._catalog_cache.setdefault("zh", {}).update(_AIMASHI_ZH_I18N)
    _aimashi_i18n._catalog_cache.setdefault("en", {}).update(_AIMASHI_ZH_I18N)

async def main():
    runner = GatewayRunner()
    source = SessionSource(
        platform=Platform.WEBHOOK,
        chat_id=payload["sessionKey"],
        chat_name=payload.get("chatName") or "Aimashi",
        chat_type="dm",
        user_id="aimashi-user",
        user_name=payload.get("userName") or "Aimashi",
    )
    event = MessageEvent(
        text=payload["text"],
        message_type=MessageType.TEXT,
        source=source,
        internal=True,
    )
    result = await runner._handle_message(event)
    if isinstance(result, dict):
        content = result.get("final_response") or result.get("content") or json.dumps(result, ensure_ascii=False)
    elif result is None:
        content = ""
    else:
        content = str(result)
    print(json.dumps({"content": content}, ensure_ascii=False))

asyncio.run(main())
`;
  const result = spawnSync(enginePython(), ["-c", script, payload], {
    cwd: p.engine,
    env: {
      ...process.env,
      HERMES_HOME: effectiveHermesHome(),
      AIMASHI_HOME: p.home,
      HERMES_LANGUAGE: process.env.HERMES_LANGUAGE || "zh",
      GATEWAY_ALLOW_ALL_USERS: "true",
      PYTHONPATH: buildPythonPath()
    },
    encoding: "utf8",
    timeout: 45000
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr || `Hermes command exited ${result.status}`);
  }
  const lines = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  const parsed = JSON.parse(lines[lines.length - 1] || "{}");
  return String(parsed.content || "");
}

function appendEngineLog(line) {
  const redacted = String(line)
    .replace(/(API_SERVER_KEY=)[^\s]+/g, "$1[REDACTED]")
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/(OPENAI_API_KEY|ANTHROPIC_API_KEY|XAI_API_KEY|DEEPSEEK_API_KEY|OPENROUTER_API_KEY)=([^\s]+)/g, "$1=[REDACTED]");
  engineState.logs.push(redacted);
  if (engineState.logs.length > 200) engineState.logs = engineState.logs.slice(-200);
}

function appendAuthLog(line) {
  const clean = String(line)
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/(access_token|refresh_token)["']?\s*[:=]\s*["']?[^"',\s]+/gi, "$1=[REDACTED]");
  const codeMatch = clean.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,8}\b/);
  if (codeMatch) authState.codexUserCode = codeMatch[0];
  const urlMatch = clean.match(/https?:\/\/[^\s)]+/);
  if (urlMatch) authState.codexVerificationUrl = urlMatch[0];
  authState.logs.push(clean);
  if (authState.logs.length > 240) authState.logs = authState.logs.slice(-240);
}

function appendCommandOutput(output) {
  for (const line of String(output || "").split(/\r?\n/).filter(Boolean)) {
    appendEngineLog(line);
  }
}

function runPythonScript(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(enginePython(), args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = options.timeout
      ? setTimeout(() => {
        if (settled) return;
        child.kill("SIGTERM");
        settled = true;
        resolve({ status: 124, stdout, stderr: stderr || `Timed out after ${options.timeout}ms` });
      }, options.timeout)
      : null;
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ status: code ?? (signal ? 128 : 0), signal, stdout, stderr });
    });
  });
}

function timeEngineStep(label, fn) {
  const start = Date.now();
  try {
    const result = fn();
    appendEngineLog(`${label}: ${Date.now() - start}ms`);
    return result;
  } catch (error) {
    appendEngineLog(`${label}: failed after ${Date.now() - start}ms (${error.message})`);
    throw error;
  }
}

async function timeEngineStepAsync(label, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    appendEngineLog(`${label}: ${Date.now() - start}ms`);
    return result;
  } catch (error) {
    appendEngineLog(`${label}: failed after ${Date.now() - start}ms (${error.message})`);
    throw error;
  }
}

function runEngineInstallCommand(command, args, cwd) {
  const p = runtimePaths();
  appendEngineLog(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    env: {
      ...process.env,
      PIP_DISABLE_PIP_VERSION_CHECK: "1",
      PYTHONPATH: buildPythonPath()
    },
    encoding: "utf8"
  });
  appendCommandOutput(result.stdout);
  appendCommandOutput(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${result.status}`);
  }
  return result;
}

function aimashiPluginFiles() {
  return {
    "__init__.py": [
      "import os",
      "import sys",
      "",
      "sys.stderr.write(f\"[aimashi_plugins] loaded (HERMES_HOME={os.environ.get('HERMES_HOME', '<unset>')})\\n\")",
      "sys.stderr.flush()",
      "",
      "from . import fellow_overlay  # noqa: F401,E402",
      ""
    ].join("\n"),
    "__main__.py": [
      "import json",
      "import os",
      "import runpy",
      "import sys",
      "",
      "def _load_aimashi_env():",
      "    home = os.environ.get('AIMASHI_HOME') or os.environ.get('HERMES_HOME')",
      "    if not home:",
      "        return",
      "    paths = [",
      "        os.path.join(home, 'aimashi-model.json'),",
      "        os.path.join(home, 'aimashi-providers.json'),",
      "    ]",
      "    try:",
      "        model = json.load(open(paths[0], encoding='utf-8')) if os.path.exists(paths[0]) else {}",
      "    except Exception:",
      "        model = {}",
      "    if isinstance(model, dict):",
      "        env_name = str(model.get('apiKeyEnv') or '').strip()",
      "        api_key = str(model.get('apiKey') or '').strip()",
      "        if env_name and api_key and not os.environ.get(env_name):",
      "            os.environ[env_name] = api_key",
      "    try:",
      "        store = json.load(open(paths[1], encoding='utf-8')) if os.path.exists(paths[1]) else {}",
      "    except Exception:",
      "        store = {}",
      "    providers = store.get('providers') if isinstance(store, dict) else {}",
      "    if isinstance(providers, dict):",
      "        for connection in providers.values():",
      "            if not isinstance(connection, dict):",
      "                continue",
      "            env_name = str(connection.get('apiKeyEnv') or '').strip()",
      "            api_key = str(connection.get('apiKey') or '').strip()",
      "            if env_name and api_key and not os.environ.get(env_name):",
      "                os.environ[env_name] = api_key",
      "",
      "_load_aimashi_env()",
      "sys.argv[0] = 'hermes_cli.main'",
      "runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)",
      ""
    ].join("\n"),
    "fellow_overlay.py": [
      "\"\"\"Per-Fellow persona overlay for Aimashi.",
      "",
      "Reads X-Aimashi-Fellow (or X-Alkaka-Fellow) on Hermes api_server",
      "requests, loads <HERMES_HOME>/fellows/<fellow_id>.md, and prepends it",
      "to vanilla Hermes's ephemeral_system_prompt. Hermes core remains",
      "unmodified.",
      "",
      "Also reads X-Aimashi-Group-Context (base64-encoded JSON payload) and",
      "injects the contextBlock into the system prompt so the engine is aware",
      "of which group conversation it is serving.",
      "\"\"\"",
      "",
      "from __future__ import annotations",
      "",
      "import base64",
      "import contextvars",
      "import json",
      "import logging",
      "import os",
      "import re",
      "from pathlib import Path",
      "from typing import Optional",
      "",
      "from gateway.platforms.api_server import APIServerAdapter",
      "",
      "logger = logging.getLogger(__name__)",
      "_FELLOW_ID_RE = re.compile(r'^[A-Za-z0-9_.-]{1,64}$')",
      "_current_fellow: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar('aimashi_fellow_id', default=None)",
      "_current_group_context: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar('aimashi_group_context', default=None)",
      "",
      "def _read_persona(fellow_id: str) -> Optional[str]:",
      "    home = os.environ.get('AIMASHI_HOME') or os.environ.get('HERMES_HOME')",
      "    if not home or not _FELLOW_ID_RE.match(fellow_id):",
      "        return None",
      "    path = Path(home) / 'fellows' / f'{fellow_id}.md'",
      "    if not path.is_file():",
      "        return None",
      "    try:",
      "        text = path.read_text(encoding='utf-8').strip()",
      "    except OSError as exc:",
      "        logger.warning('aimashi fellow overlay cannot read %s: %s', path, exc)",
      "        return None",
      "    return text or None",
      "",
      "def _prepend(persona: str, ephemeral: Optional[str]) -> str:",
      "    base = (ephemeral or '').strip()",
      "    return f'{persona}\\n\\n{base}' if base else persona",
      "",
      "def _join_parts(*parts: Optional[str]) -> str:",
      "    \"\"\"Join non-empty string parts with double newlines.\"\"\"",
      "    kept = [p for p in parts if p]",
      "    if not kept:",
      "        return ''",
      "    if len(kept) == 1:",
      "        return kept[0]",
      "    return '\\n\\n'.join(p.strip() for p in kept)",
      "",
      "def _header_fellow_id(request) -> Optional[str]:",
      "    headers = getattr(request, 'headers', {})",
      "    value = headers.get('X-Aimashi-Fellow') or headers.get('X-Alkaka-Fellow') or ''",
      "    return str(value).strip() or None",
      "",
      "def _header_group_context(request) -> Optional[str]:",
      "    headers = getattr(request, 'headers', {})",
      "    raw = headers.get('X-Aimashi-Group-Context') or headers.get('x-aimashi-group-context') or ''",
      "    raw = str(raw).strip()",
      "    if not raw:",
      "        return None",
      "    try:",
      "        payload = json.loads(base64.b64decode(raw).decode('utf-8'))",
      "    except Exception:",
      "        return None",
      "    if not isinstance(payload, dict) or payload.get('v') != 1:",
      "        return None",
      "    block = payload.get('contextBlock')",
      "    if not isinstance(block, str) or not block.strip():",
      "        return None",
      "    return block",
      "",
      "def _wrap_handler(handler):",
      "    async def wrapped(self, request):",
      "        token_fellow = _current_fellow.set(_header_fellow_id(request))",
      "        token_group = _current_group_context.set(_header_group_context(request))",
      "        try:",
      "            return await handler(self, request)",
      "        finally:",
      "            _current_group_context.reset(token_group)",
      "            _current_fellow.reset(token_fellow)",
      "    wrapped.__name__ = handler.__name__",
      "    wrapped.__qualname__ = handler.__qualname__",
      "    return wrapped",
      "",
      "def _patch_run_agent() -> None:",
      "    if not hasattr(APIServerAdapter, '_run_agent'):",
      "        return",
      "    original = APIServerAdapter._run_agent",
      "    async def patched(self, *args, ephemeral_system_prompt=None, **kwargs):",
      "        fellow_id = _current_fellow.get()",
      "        group_context = _current_group_context.get()",
      "        persona = _read_persona(fellow_id) if fellow_id else None",
      "        ephemeral_system_prompt = _join_parts(persona, group_context, ephemeral_system_prompt) or ephemeral_system_prompt",
      "        return await original(self, *args, ephemeral_system_prompt=ephemeral_system_prompt, **kwargs)",
      "    APIServerAdapter._run_agent = patched",
      "",
      "def _patch_create_agent() -> None:",
      "    if not hasattr(APIServerAdapter, '_create_agent'):",
      "        return",
      "    original = APIServerAdapter._create_agent",
      "    def patched(self, *args, ephemeral_system_prompt=None, **kwargs):",
      "        fellow_id = _current_fellow.get()",
      "        group_context = _current_group_context.get()",
      "        persona = _read_persona(fellow_id) if fellow_id else None",
      "        ephemeral_system_prompt = _join_parts(persona, group_context, ephemeral_system_prompt) or ephemeral_system_prompt",
      "        return original(self, *args, ephemeral_system_prompt=ephemeral_system_prompt, **kwargs)",
      "    APIServerAdapter._create_agent = patched",
      "",
      "def install() -> None:",
      "    for name in ('_handle_chat_completions', '_handle_runs', '_handle_responses'):",
      "        if hasattr(APIServerAdapter, name):",
      "            setattr(APIServerAdapter, name, _wrap_handler(getattr(APIServerAdapter, name)))",
      "    _patch_run_agent()",
      "    _patch_create_agent()",
      "",
      "install()",
      ""
    ].join("\n")
  };
}

function ensureEnginePlugins() {
  const p = runtimePaths();
  const pluginDir = path.join(p.pluginsDir, "aimashi_plugins");
  fs.mkdirSync(pluginDir, { recursive: true });
  for (const [fileName, content] of Object.entries(aimashiPluginFiles())) {
    fs.writeFileSync(path.join(pluginDir, fileName), content);
  }
  const legacyDir = path.join(p.engine, "aimashi_plugins");
  if (legacyDir !== pluginDir) {
    try { fs.rmSync(legacyDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function installEngineFromDevSource() {
  initializeRuntime();
  stopEngine();
  const p = runtimePaths();
  if (!fs.existsSync(DEV_ENGINE_SOURCE)) {
    throw new Error(`Hermes source missing: ${DEV_ENGINE_SOURCE}`);
  }

  fs.rmSync(p.engine, { recursive: true, force: true });
  const skip = new Set([
    ".git",
    ".pytest_cache",
    ".ruff_cache",
    "__pycache__",
    "node_modules",
    "tests",
    "website",
    "ui-tui",
    "demo"
  ]);
  fs.cpSync(DEV_ENGINE_SOURCE, p.engine, {
    recursive: true,
    dereference: false,
    filter: (source) => !skip.has(path.basename(source))
  });
  fs.writeFileSync(engineMarkerPath(), JSON.stringify({
    product: "aimashi",
    source: "maintained-local-source",
    source_path: DEV_ENGINE_SOURCE,
    installed_at: new Date().toISOString()
  }, null, 2) + "\n");
  ensureEnginePlugins();
  return getRuntimeStatus(["runtime/hermes-engine"]);
}

function installEngineFromOfficialPackage() {
  initializeRuntime();
  stopEngine();
  const p = runtimePaths();
  const packageSpec = officialEngineRequirement(OFFICIAL_ENGINE_EXTRAS);
  const basePackageSpec = officialEngineRequirement("");
  const python = selectOfficialEnginePython();

  engineState.logs = [];
  fs.rmSync(p.engine, { recursive: true, force: true });
  fs.mkdirSync(p.engine, { recursive: true });
  fs.writeFileSync(path.join(p.engine, "README.md"), [
    "# Aimashi Hermes Engine",
    "",
    `This runtime installs the official Hermes source archive: ${officialEngineUrl()}`,
    `Python executable used for installation: ${python}`,
    "Set AIMASHI_ENGINE_SOURCE only for local Hermes development builds.",
    ""
  ].join("\n"));

  runEngineInstallCommand(python, ["-m", "venv", ".venv"], p.engine);
  runEngineInstallCommand(venvPythonPath(), ["-m", "pip", "install", "--upgrade", "pip"], p.engine);
  try {
    runEngineInstallCommand(venvPythonPath(), ["-m", "pip", "install", "--upgrade", packageSpec], p.engine);
  } catch (error) {
    if (!OFFICIAL_ENGINE_EXTRAS) throw error;
    appendEngineLog(`Official Hermes install with extras failed; retrying base install: ${error.message}`);
    runEngineInstallCommand(venvPythonPath(), ["-m", "pip", "install", "--upgrade", basePackageSpec], p.engine);
  }
  runEngineInstallCommand(venvPythonPath(), ["-c", "import hermes_cli.main, fastapi, uvicorn; print('hermes_cli + web deps import OK')"], p.engine);
  ensureEnginePlugins();
  runEngineInstallCommand(venvPythonPath(), ["-c", "import aimashi_plugins; print('aimashi_plugins import OK')"], p.engine);

  fs.writeFileSync(engineMarkerPath(), JSON.stringify({
    product: "aimashi",
    source: "official-github-archive",
    package: OFFICIAL_ENGINE_PACKAGE,
    repo: OFFICIAL_ENGINE_REPO_URL,
    ref: OFFICIAL_ENGINE_REF,
    url: officialEngineUrl(),
    extras: OFFICIAL_ENGINE_EXTRAS || null,
    python,
    spec: packageSpec,
    installed_at: new Date().toISOString()
  }, null, 2) + "\n");
  return getRuntimeStatus(["runtime/hermes-engine"]);
}

function installEngine() {
  if (DEV_ENGINE_SOURCE) return installEngineFromDevSource();
  return installEngineFromOfficialPackage();
}

function choosePort(preferred = 18642, attempts = 40) {
  // Start outside hermes's traditional 8642 range so aimashi never collides
  // with a user-managed hermes gateway running on the default port.
  const start = preferred;
  return new Promise((resolve) => {
    let index = 0;
    const tryNext = () => {
      if (index >= attempts) {
        resolve(0);
        return;
      }
      const port = start + index;
      index += 1;
      const server = net.createServer();
      server.once("error", tryNext);
      server.listen(port, "127.0.0.1", () => {
        const selected = server.address().port;
        server.close(() => resolve(selected));
      });
    };
    tryNext();
  });
}

function enginePython() {
  // Prefer the runtime shipped inside the .app (no install needed).
  const bundled = bundledPython();
  if (bundled) return bundled;
  // Fallback: user previously ran `Install Engine` and we built a venv.
  const venvPython = venvPythonPath();
  if (fs.existsSync(venvPython)) return venvPython;
  return "python3";
}

function engineSource() {
  // System-Hermes detection disabled. aimashi has 3 sources of Python+Hermes:
  //   "bundled" — shipped inside .app/Contents/Resources/hermes-runtime (preferred)
  //   "managed" — user ran "Install Engine" which built a venv to user data
  //   "none"    — nothing available; onboarding shows "Install Hermes"
  if (bundledPython() && bundledSitePackages()) return "bundled";
  if (fs.existsSync(venvPythonPath())) return "managed";
  return "none";
}

// aimashi always uses its private HERMES_HOME for spawning. In system mode we
// IMPORT user's keys + model choice into aimashi's state (see importFromSystemHermes),
// but never share the config.yaml — that prevents port conflicts and writes to
// user's hermes files.
function effectiveHermesHome() {
  return runtimePaths().home;
}

function userHermesHomePath() {
  const sys = loadSystemHermesCache();
  if (sys.hermesHome && fs.existsSync(sys.hermesHome)) return sys.hermesHome;
  return "";
}

function userHasCustomizedAimashiModel() {
  const p = runtimePaths();
  const current = readJson(p.modelSettings, null);
  if (current && typeof current === "object" && String(current.apiKey || "").length > 0) return true;
  const store = providerConnectionStore();
  return Object.keys(store.providers).length > 0;
}

function importFromSystemHermes() {
  // No-op: system Hermes detection is disabled. Kept for callsite stability.
  return;
  // eslint-disable-next-line no-unreachable
  if (engineSource() !== "system") return;
  const userHome = userHermesHomePath();
  if (!userHome) return;
  const userConfigPath = path.join(userHome, "config.yaml");
  if (!fs.existsSync(userConfigPath)) return;
  let userConfig = {};
  try {
    const parsed = yaml.load(fs.readFileSync(userConfigPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) userConfig = parsed;
  } catch {
    return;
  }
  if (userHasCustomizedAimashiModel()) return;

  const userModel = userConfig.model && typeof userConfig.model === "object" ? userConfig.model : {};
  const provider = String(userModel.provider || "").trim();
  const model = String(userModel.default || "").trim();
  if (!provider || !model) return;
  const baseUrl = String(userModel.base_url || "").trim();
  const apiMode = String(userModel.api_mode || "").trim();

  const apiKeyEnvForProvider = {
    deepseek: "DEEPSEEK_API_KEY",
    openai: "OPENAI_API_KEY",
    "openai-codex": "",
    chatgpt: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    xai: "XAI_API_KEY",
    gemini: "GEMINI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    copilot: "COPILOT_API_KEY",
    lmstudio: ""
  };
  const apiKeyEnv = apiKeyEnvForProvider[provider] || "";
  const p = runtimePaths();
  atomicWriteFile(p.modelSettings, JSON.stringify({
    provider,
    model,
    apiKeyEnv,
    apiKey: "",
    baseUrl,
    apiMode
  }, null, 2) + "\n", 0o600);

  // Populate aimashi-providers.json with providers reachable from user's hermes.
  const dotenv = loadHermesDotenv();
  const userProviders = userConfig.providers && typeof userConfig.providers === "object" ? userConfig.providers : {};
  const store = providerConnectionStore();
  const addProvider = (name, cfg = {}) => {
    if (!name) return;
    const envName = apiKeyEnvForProvider[name];
    if (!envName) return;
    const key = cfg.api_key || dotenv[envName] || "";
    if (!key) return;
    if (store.providers[name]) return;
    store.providers[name] = normalizeProviderConnection(name, {
      provider: name,
      providerLabel: name,
      authType: "api_key",
      apiKeyEnv: envName,
      apiKey: key,
      baseUrl: cfg.base_url || "",
      apiMode: ""
    });
  };
  // Active model.provider — guaranteed to be the user's working choice.
  addProvider(provider, { ...userModel });
  // Plus all enabled providers from the providers: section.
  for (const [providerName, cfg] of Object.entries(userProviders)) {
    if (!cfg || typeof cfg !== "object") continue;
    if (cfg.enabled !== true) continue;
    addProvider(providerName, cfg);
  }
  atomicWriteFile(p.providerConnections, JSON.stringify(store, null, 2) + "\n", 0o600);
}

// Strip ANSI escape sequences (cursor moves, color codes etc) that sometimes
// end up in shell-written .env values when user typed with arrow-key edits.
function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

function loadHermesDotenv() {
  const userHome = userHermesHomePath();
  if (!userHome) return {};
  const envPath = path.join(userHome, ".env");
  if (!fs.existsSync(envPath)) return {};
  try {
    const raw = fs.readFileSync(envPath, "utf8");
    const out = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      let key = stripAnsi(trimmed.slice(0, eq).trim());
      if (key.startsWith("export ")) key = key.slice(7).trim();
      let value = stripAnsi(trimmed.slice(eq + 1).trim());
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function readConfiguredPort() {
  const configPath = path.join(effectiveHermesHome(), "config.yaml");
  if (!fs.existsSync(configPath)) return 18642;
  try {
    const parsed = yaml.load(fs.readFileSync(configPath, "utf8"));
    const port = Number(parsed?.platforms?.api_server?.port);
    if (Number.isInteger(port) && port > 0) return port;
  } catch {
    // fall through
  }
  return 18642;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function launchdDomain() {
  if (typeof process.getuid !== "function") return "";
  return `gui/${process.getuid()}`;
}

function runLaunchctl(args, { ignoreFailure = false } = {}) {
  const result = spawnSync("launchctl", args, { encoding: "utf8" });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (output) appendEngineLog(`launchctl ${args.join(" ")}: ${output}`);
  if (result.error) {
    if (ignoreFailure) return result;
    throw result.error;
  }
  if (result.status !== 0 && !ignoreFailure) {
    throw new Error(`launchctl ${args.join(" ")} exited with code ${result.status}`);
  }
  return result;
}

function launchAgentEnvironment() {
  const p = runtimePaths();
  return {
    HERMES_HOME: effectiveHermesHome(),
      AIMASHI_HOME: p.home,
    HERMES_LANGUAGE: process.env.HERMES_LANGUAGE || "zh",
    HERMES_ACCEPT_HOOKS: "1",
    GATEWAY_ALLOW_ALL_USERS: "true",
    PYTHONUNBUFFERED: "1",
    PYTHONPATH: buildPythonPath()
  };
}

function gatewayProgramArguments() {
  return [
    enginePython(),
    "-m",
    "aimashi_plugins",
    "gateway",
    "run",
    "--replace",
    "--accept-hooks"
  ];
}

function launchAgentPlist() {
  const p = runtimePaths();
  const env = launchAgentEnvironment();
  const envEntries = Object.entries(env)
    .map(([key, value]) => `      <key>${xmlEscape(key)}</key>\n      <string>${xmlEscape(value)}</string>`)
    .join("\n");
  const programArguments = gatewayProgramArguments()
    .map((value) => `    <string>${xmlEscape(value)}</string>`)
    .join("\n");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${AIMASHI_GATEWAY_SERVICE_LABEL}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    programArguments,
    `  </array>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${xmlEscape(p.engine)}</string>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    envEntries,
    `  </dict>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <true/>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${xmlEscape(path.join(p.logsDir, "gateway.log"))}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${xmlEscape(path.join(p.logsDir, "gateway.error.log"))}</string>`,
    `</dict>`,
    `</plist>`,
    ``
  ].join("\n");
}

function writeLaunchAgentPlist() {
  const p = runtimePaths();
  fs.mkdirSync(path.dirname(p.launchAgent), { recursive: true });
  fs.mkdirSync(p.logsDir, { recursive: true });
  fs.writeFileSync(p.launchAgent, launchAgentPlist(), { mode: 0o600 });
  return p.launchAgent;
}

function stopLaunchAgent() {
  if (process.platform !== "darwin") return;
  const p = runtimePaths();
  const domain = launchdDomain();
  if (!domain) return;
  runLaunchctl(["bootout", domain, p.launchAgent], { ignoreFailure: true });
  runLaunchctl(["bootout", `${domain}/${AIMASHI_GATEWAY_SERVICE_LABEL}`], { ignoreFailure: true });
}

function startLaunchAgent() {
  const p = runtimePaths();
  const domain = launchdDomain();
  if (process.platform !== "darwin" || !domain) {
    throw new Error("Aimashi background service is currently implemented for macOS launchd.");
  }
  const plist = writeLaunchAgentPlist();
  stopLaunchAgent();
  runLaunchctl(["bootstrap", domain, plist]);
  runLaunchctl(["kickstart", "-k", `${domain}/${AIMASHI_GATEWAY_SERVICE_LABEL}`], { ignoreFailure: true });
}

function appendDaemonLog(line) {
  const clean = String(line || "").replace(new RegExp(daemonToken(), "g"), "[REDACTED]");
  controlServerState.logs.push(clean);
  if (controlServerState.logs.length > 200) controlServerState.logs = controlServerState.logs.slice(-200);
}

function daemonProgramArguments() {
  const args = [process.execPath];
  if (process.defaultApp) args.push(app.getAppPath());
  args.push("--daemon");
  return args;
}

function daemonLaunchAgentEnvironment() {
  const p = runtimePaths();
  return {
    AIMASHI_DAEMON: "1",
    HERMES_HOME: effectiveHermesHome(),
      AIMASHI_HOME: p.home,
    HERMES_LANGUAGE: process.env.HERMES_LANGUAGE || "zh",
    PATH: process.env.PATH || "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    PYTHONUNBUFFERED: "1"
  };
}

function daemonLaunchAgentPlist() {
  const p = runtimePaths();
  const envEntries = Object.entries(daemonLaunchAgentEnvironment())
    .map(([key, value]) => `      <key>${xmlEscape(key)}</key>\n      <string>${xmlEscape(value)}</string>`)
    .join("\n");
  const programArguments = daemonProgramArguments()
    .map((value) => `    <string>${xmlEscape(value)}</string>`)
    .join("\n");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${AIMASHI_DAEMON_SERVICE_LABEL}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    programArguments,
    `  </array>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${xmlEscape(app.getAppPath())}</string>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    envEntries,
    `  </dict>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <true/>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${xmlEscape(path.join(p.logsDir, "daemon.log"))}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${xmlEscape(path.join(p.logsDir, "daemon.error.log"))}</string>`,
    `</dict>`,
    `</plist>`,
    ``
  ].join("\n");
}

function writeDaemonLaunchAgentPlist() {
  const p = runtimePaths();
  fs.mkdirSync(path.dirname(p.daemonLaunchAgent), { recursive: true });
  fs.mkdirSync(p.logsDir, { recursive: true });
  fs.writeFileSync(p.daemonLaunchAgent, daemonLaunchAgentPlist(), { mode: 0o600 });
  return p.daemonLaunchAgent;
}

function stopDaemonLaunchAgent() {
  if (process.platform !== "darwin") return;
  const p = runtimePaths();
  const domain = launchdDomain();
  if (!domain) return;
  runLaunchctl(["bootout", domain, p.daemonLaunchAgent], { ignoreFailure: true });
  runLaunchctl(["bootout", `${domain}/${AIMASHI_DAEMON_SERVICE_LABEL}`], { ignoreFailure: true });
}

function startDaemonLaunchAgent() {
  const domain = launchdDomain();
  if (process.platform !== "darwin" || !domain) {
    throw new Error("Aimashi daemon LaunchAgent is currently implemented for macOS launchd.");
  }
  const plist = writeDaemonLaunchAgentPlist();
  stopDaemonLaunchAgent();
  runLaunchctl(["bootstrap", domain, plist]);
  runLaunchctl(["kickstart", "-k", `${domain}/${AIMASHI_DAEMON_SERVICE_LABEL}`], { ignoreFailure: true });
}

function requestAuthToken(req, url) {
  const header = String(req.headers.authorization || "");
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  const explicit = req.headers["x-aimashi-token"];
  if (typeof explicit === "string") return explicit.trim();
  return String(url.searchParams.get("token") || "").trim();
}

function isControlRequestAuthorized(req, url) {
  return requestAuthToken(req, url) === daemonToken();
}

function writeControlJson(res, statusCode, payload) {
  const text = JSON.stringify(payload ?? {}, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type, x-aimashi-token",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  });
  res.end(text);
}

function writeControlText(res, statusCode, text, contentType) {
  const body = String(text || "");
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function writeControlBuffer(res, statusCode, body, contentType) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body || "");
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": buffer.length,
    "Cache-Control": "public, max-age=3600"
  });
  res.end(buffer);
}

function contentTypeForAsset(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

function serveMobileAsset(pathname, res) {
  if (pathname.startsWith("/assets/")) {
    const root = path.join(__dirname, "renderer", "assets");
    const requested = path.normalize(path.join(root, pathname.replace(/^\/assets\//, "")));
    if (!requested.startsWith(`${root}${path.sep}`) || !fs.existsSync(requested) || !fs.statSync(requested).isFile()) {
      return false;
    }
    writeControlBuffer(res, 200, fs.readFileSync(requested), contentTypeForAsset(requested));
    return true;
  }

  let asset = "index.html";
  if (pathname === "/mobile" || pathname === "/mobile/") asset = "index.html";
  else if (pathname === "/mobile/app.js") asset = "app.js";
  else if (pathname === "/mobile/styles.css") asset = "styles.css";
  else if (pathname === "/mobile/manifest.json") {
    writeControlText(res, 200, JSON.stringify({
      name: "Aimashi Mobile",
      short_name: "Aimashi",
      start_url: "/mobile/",
      scope: "/mobile/",
      display: "standalone",
      orientation: "portrait",
      background_color: "#ffffff",
      theme_color: "#5e5ce6"
    }, null, 2), "application/manifest+json; charset=utf-8");
    return true;
  } else {
    return false;
  }
  const filePath = path.join(__dirname, "mobile", asset);
  if (!fs.existsSync(filePath)) return false;
  const type = asset.endsWith(".js")
    ? "application/javascript; charset=utf-8"
    : asset.endsWith(".css")
      ? "text/css; charset=utf-8"
      : "text/html; charset=utf-8";
  writeControlText(res, 200, fs.readFileSync(filePath, "utf8"), type);
  return true;
}

function readControlBody(req, maxBytes = 48 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      body += String(chunk);
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function normalizeRemoteUserMessage(input) {
  const message = input && typeof input === "object" ? input : { content: input };
  return {
    role: "user",
    content: String(message.content || message.text || "").trim(),
    attachments: normalizeAttachments(message.attachments),
    createdAt: message.createdAt || new Date().toISOString()
  };
}

function resolveRemoteChatSession({ fellowKey, sessionId }) {
  initializeRuntime();
  const manifest = loadFellowManifest();
  const fellows = Array.isArray(manifest.fellows) ? manifest.fellows : [];
  const key = String(fellowKey || manifest.default_fellow || fellows[0]?.key || "aimashi").trim();
  const fellow = fellows.find((item) => item.key === key) || fellows[0] || defaultFellowManifest().fellows[0];
  const store = loadChatStore();
  if (!store.sessions[fellow.key]) store.sessions[fellow.key] = [];
  let session = sessionId
    ? store.sessions[fellow.key].find((item) => item.id === String(sessionId))
    : null;
  if (!session) {
    session = ensurePersonaSession(store, fellow.key);
  }
  return { fellow, store, session };
}

function collectChatTraceEnvelope(trace, envelope = {}) {
  if (!trace || !envelope || typeof envelope !== "object") return;
  const { kind, data } = envelope;
  switch (kind) {
    case "reasoning_delta":
      trace.reasoning += String(data?.text || "");
      if (trace.reasoning && !trace.reasoning.endsWith("\n")) trace.reasoning += "\n";
      break;
    case "tool_call_started": {
      const tool = {
        id: String(data?.id || `tool_${trace.tools.length}`),
        name: String(data?.name || "工具"),
        preview: String(data?.preview || ""),
        status: "running",
        duration: null,
        error: false
      };
      trace.tools.push(tool);
      trace.toolsById.set(tool.id, tool);
      const queue = trace.toolsByName.get(tool.name) || [];
      queue.push(tool);
      trace.toolsByName.set(tool.name, queue);
      break;
    }
    case "tool_call_delta": {
      const id = String(data?.id || "");
      const name = String(data?.name || "");
      let tool = id ? trace.toolsById.get(id) : null;
      if (!tool && name) {
        const queue = trace.toolsByName.get(name);
        tool = queue && queue.find((item) => item.status === "running");
      }
      if (tool) tool.preview = String(data?.preview || tool.preview || "");
      break;
    }
    case "tool_call_completed": {
      const id = String(data?.id || "");
      const name = String(data?.name || "");
      let tool = id ? trace.toolsById.get(id) : null;
      if (!tool && name) {
        const queue = trace.toolsByName.get(name);
        tool = queue && queue.find((item) => item.status === "running");
      }
      if (tool) {
        tool.status = data?.error ? "error" : "completed";
        tool.duration = typeof data?.duration === "number" ? data.duration : null;
        tool.error = Boolean(data?.error);
        if (data?.preview) tool.preview = String(data.preview);
      }
      break;
    }
    default:
      break;
  }
}

async function runRemoteChatRequest(body, eventSink = null) {
  const explicitMessages = Array.isArray(body?.messages) ? body.messages : [];
  const lastExplicitUser = [...explicitMessages].reverse().find((message) => message?.role === "user");
  const userMessage = normalizeRemoteUserMessage(lastExplicitUser || { content: body?.text, attachments: body?.attachments });
  if (!userMessage.content && !userMessage.attachments.length) {
    throw new Error("text or a user message is required.");
  }

  const { fellow, store, session } = resolveRemoteChatSession({
    fellowKey: body?.fellowKey || body?.personaKey,
    sessionId: body?.sessionId
  });
  const now = new Date().toISOString();
  const history = Array.isArray(session.messages) ? session.messages : [];
  const runMessages = explicitMessages.length
    ? explicitMessages
    : [...history, userMessage].map((message) => ({
      role: message.role,
      content: message.content,
      attachments: normalizeAttachments(message.attachments)
    }));
  const trace = {
    reasoning: "",
    tools: [],
    toolsById: new Map(),
    toolsByName: new Map()
  };
  const tracedEventSink = eventSink ? {
    isDestroyed: () => Boolean(eventSink.isDestroyed?.()),
    send: (channel, envelope) => {
      collectChatTraceEnvelope(trace, envelope);
      eventSink.send(channel, envelope);
    }
  } : null;

  const response = await sendChat({
    fellowKey: fellow.key,
    sessionId: session.id,
    messages: runMessages,
    webContents: tracedEventSink
  });
  const responseMessage = response?.choices?.[0]?.message || {};
  const assistantText = responseMessageContent(response);
  const assistantAttachments = normalizeAttachments(responseMessage.attachments);
  const userMessageId = "msg-" + crypto.randomBytes(6).toString("hex");
  const assistantMessageId = "msg-" + crypto.randomBytes(6).toString("hex");
  const savedUser = {
    id: userMessageId,
    role: "user",
    content: String(body?.displayText || "").trim() || userMessage.content || "请查看附件。",
    createdAt: userMessage.createdAt || now
  };
  if (userMessage.attachments.length) savedUser.attachments = userMessage.attachments;
  if (body?.meta) savedUser.meta = { ...body.meta, fired: true };
  const savedAssistant = {
    id: assistantMessageId,
    role: "assistant",
    content: assistantText,
    createdAt: new Date().toISOString()
  };
  if (assistantAttachments.length) savedAssistant.attachments = assistantAttachments;
  if (body?.meta) savedAssistant.meta = body.meta;
  const reasoning = String(trace.reasoning || "").trim();
  if (reasoning) savedAssistant.reasoning = reasoning;
  if (trace.tools.length) {
    savedAssistant.tools = trace.tools.map((tool) => ({
      id: String(tool.id || ""),
      name: String(tool.name || ""),
      preview: String(tool.preview || ""),
      status: tool.status || "completed",
      duration: typeof tool.duration === "number" ? tool.duration : null,
      error: Boolean(tool.error)
    }));
  }
  // Append to the in-memory session we resolved at the top. The store is the
  // one resolveRemoteChatSession returned; mutating session.messages on it and
  // saving it preserves any new-session we just created via ensurePersonaSession.
  // (Concurrent writes to the same session can still race — tracked in
  // docs/superpowers/known-issues/2026-05-20-aimashi-task-rail-deferrals.md.)
  session.messages = [
    ...(Array.isArray(session.messages) ? session.messages : []),
    savedUser,
    savedAssistant
  ];
  session.updatedAt = new Date().toISOString();
  if (!session.titleGenerated) {
    session.title = fallbackSessionTitle(session.messages);
  }
  saveChatStore(store);
  return { fellow, session, response, userMessageId, assistantMessageId };
}

async function handleControlRequest(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  if (req.method === "OPTIONS") {
    writeControlJson(res, 204, {});
    return;
  }
  if (req.method === "GET" && url.pathname === "/favicon.ico") {
    res.writeHead(204, { "Cache-Control": "public, max-age=86400" });
    res.end();
    return;
  }
  if (req.method === "GET" && serveMobileAsset(url.pathname, res)) {
    return;
  }
  if (req.method === "GET" && url.pathname === "/health") {
    writeControlJson(res, 200, {
      status: "ok",
      service: "aimashi-daemon",
      pid: process.pid,
      uptime: Math.round(process.uptime()),
      mode: IS_DAEMON_PROCESS ? "daemon" : "desktop"
    });
    return;
  }
  if (!isControlRequestAuthorized(req, url)) {
    writeControlJson(res, 401, { error: "Unauthorized" });
    return;
  }
  try {
    if (req.method === "GET" && url.pathname === "/api/runtime/status") {
      writeControlJson(res, 200, getRuntimeStatus());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/fellows") {
      const manifest = loadFellowManifest();
      writeControlJson(res, 200, { fellows: manifest.fellows || [], defaultFellow: manifest.default_fellow || "aimashi" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/chat/sessions") {
      writeControlJson(res, 200, loadChatSessions());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/model/catalog") {
      writeControlJson(res, 200, { models: await loadHermesModelCatalog() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/codex/models") {
      writeControlJson(res, 200, { models: loadCodexModels() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/engine/capabilities") {
      writeControlJson(res, 200, await loadEngineCapabilities());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/commands/slash") {
      writeControlJson(res, 200, { rows: await loadHermesSlashCommands() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/commands/agent-list") {
      writeControlJson(res, 200, loadExternalAgentCommands({ engine: url.searchParams.get("engine") || "" }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/relay/status") {
      writeControlJson(res, 200, relayStatus(false));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/relay/start") {
      const body = await readControlBody(req);
      settingsStore.writeRelaySettings({ ...body, enabled: true });
      await startRelayClient();
      writeControlJson(res, 200, relayStatus(false));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/relay/stop") {
      settingsStore.writeRelaySettings({ enabled: false });
      writeControlJson(res, 200, stopRelayClient());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/chat/session") {
      const body = await readControlBody(req);
      writeControlJson(res, 200, newChatSession(body));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/chat/session/save") {
      const body = await readControlBody(req);
      writeControlJson(res, 200, saveChatSession(body));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/chat/attachment") {
      const body = await readControlBody(req);
      writeControlJson(res, 200, saveChatAttachment(body));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/file/fetch") {
      const body = await readControlBody(req);
      writeControlJson(res, 200, readLocalFileAttachment(body));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/commands/agent-execute") {
      const body = await readControlBody(req);
      writeControlJson(res, 200, executeExternalAgentCommand(body));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/fellow/engine") {
      const body = await readControlBody(req);
      writeControlJson(res, 200, saveFellowEngineConfig(body));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/model/save") {
      const body = await readControlBody(req);
      const current = modelSettings();
      const nextProvider = String(body.provider || "").trim();
      const existingConnection = providerConnection(nextProvider);
      const next = {
        provider: nextProvider,
        model: String(body.model || "").trim(),
        apiKeyEnv: String(body.apiKeyEnv || existingConnection?.apiKeyEnv || current.apiKeyEnv || "OPENAI_API_KEY").trim(),
        apiKey: String(existingConnection?.apiKey || (nextProvider === current.provider ? current.apiKey : "") || "").trim(),
        baseUrl: String(body.baseUrl || "").trim(),
        apiMode: String(body.apiMode || "").trim()
      };
      writeModelSettings(next);
      writeControlJson(res, 200, getRuntimeStatus());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/effort/save") {
      const body = await readControlBody(req);
      settingsStore.writeEffortSettings(body);
      writeControlJson(res, 200, getRuntimeStatus());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/permissions/save") {
      const body = await readControlBody(req);
      settingsStore.writePermissionSettings(body);
      writeControlJson(res, 200, getRuntimeStatus());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/chat/stop") {
      writeControlJson(res, 200, stopChat());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/chat/send") {
      const body = await readControlBody(req);
      const result = await runRemoteChatRequest(body);
      writeControlJson(res, 200, {
        fellow: result.fellow,
        session: result.session,
        response: result.response
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/chat/stream") {
      const body = await readControlBody(req);
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*"
      });
      const eventSink = {
        isDestroyed: () => res.destroyed || res.writableEnded,
        send: (_channel, envelope) => {
          if (res.destroyed || res.writableEnded) return;
          res.write(`event: chat\n`);
          res.write(`data: ${JSON.stringify(envelope)}\n\n`);
        }
      };
      try {
        const result = await runRemoteChatRequest(body, eventSink);
        res.write(`event: result\n`);
        res.write(`data: ${JSON.stringify({ fellow: result.fellow, session: result.session, response: result.response })}\n\n`);
        res.end();
      } catch (error) {
        res.write(`event: error\n`);
        res.write(`data: ${JSON.stringify({ error: String(error?.message || error) })}\n\n`);
        res.end();
      }
      return;
    }
    // Route: tasks subsystem
    if (url.pathname === "/api/tasks/events" && req.method === "GET") {
      initSchedulerSubsystem();
      tasksRoutes.handleEventsStream(req, res);
      return;
    }
    if (url.pathname.startsWith("/api/tasks")) {
      initSchedulerSubsystem();
      const body = ["POST", "PATCH"].includes(req.method) ? await readControlBody(req) : null;
      const handled = await tasksRoutes.handle(req, res, body);
      if (handled) return;
    }
    writeControlJson(res, 404, { error: "Not found" });
  } catch (error) {
    writeControlJson(res, 500, { error: String(error?.message || error) });
  }
}

let tasksStore = null;
let tasksEvents = null;
let scheduler = null;
let tasksRoutes = null;
let schedulerMcp = null;

function initSchedulerSubsystem() {
  if (tasksStore) return; // idempotent
  const p = runtimePaths();
  tasksStore = createTasksStore(p.tasks);
  tasksEvents = createTasksEventBus();
  const fireRunner = createFireRunner({
    store: tasksStore,
    runRemoteChatRequest,
    emit: (type, payload) => tasksEvents.emit(type, payload)
  });
  scheduler = createScheduler({
    store: tasksStore,
    onFire: (task) => fireRunner.fire(task)
  });
  tasksRoutes = createTasksRoutes({
    store: tasksStore,
    events: tasksEvents,
    runNow: async (id) => {
      const task = tasksStore.get(id);
      if (!task) throw new Error("task not found");
      const run = await fireRunner.fire(task);
      return { runId: run.id };
    },
    onChange: () => scheduler.rescan()
  });
  schedulerMcp = createSchedulerMcp({
    store: tasksStore,
    scheduler,
    events: tasksEvents
  });
  // schedulerMcp is created here so the MCP server object exists alongside the
  // other subsystem state, but it is not yet started or exposed. Wiring it into
  // the Claude Code / Codex bridge requires a stdio MCP server contract that
  // the current `ensureClaudeBridgePlugin` (SKILL.md symlinks) does not cover.
  // TODO(scheduler-mcp-bridge): expose schedule.* tools via stdio MCP server.
  if (IS_DAEMON_PROCESS) {
    sweepExpiredOneshotTasks(tasksStore);
    scheduler.start();
    appendDaemonLog("Scheduler started");
  }
}

// Per spec §9: oneshot tasks whose 'at' has passed while daemon was down
// transition to status="failed" with a recorded run noting "daemon offline".
function sweepExpiredOneshotTasks(store) {
  const now = Date.now();
  for (const task of store.list()) {
    if (task.status !== "active") continue;
    if (task.trigger.type !== "oneshot") continue;
    const at = new Date(task.trigger.at).getTime();
    if (Number.isNaN(at) || at > now) continue;
    store.recordRun(task.id, {
      firedAt: at,
      finishedAt: now,
      status: "failed",
      error: "missed: daemon offline at scheduled time"
    });
    store.update(task.id, { status: "failed" });
  }
}

async function startControlServer(options = {}) {
  initializeRuntime();
  if (controlServer && controlServerState.running) return getDaemonStatus();
  const settings = { ...settingsStore.daemonSettings(), ...options };
  const host = settingsStore.normalizeDaemonHost(settings.host);
  const preferredPort = settingsStore.normalizeDaemonPort(settings.port);
  const port = await choosePort(preferredPort, 20);
  if (!port) throw new Error("No available local port for Aimashi daemon.");
  controlServerState = {
    ...controlServerState,
    running: false,
    starting: true,
    host,
    port,
    baseUrl: `http://${host}:${port}`,
    lastError: ""
  };
  controlServer = http.createServer((req, res) => {
    handleControlRequest(req, res).catch((error) => {
      writeControlJson(res, 500, { error: String(error?.message || error) });
    });
  });
  await new Promise((resolve, reject) => {
    controlServer.once("error", reject);
    controlServer.listen(port, host, resolve);
  });
  initSchedulerSubsystem();
  controlServerState.running = true;
  controlServerState.starting = false;
  settingsStore.writeDaemonSettings({ ...settings, host, port });
  appendDaemonLog(`Aimashi daemon listening at ${controlServerState.baseUrl}`);
  if (settingsStore.relaySettings().enabled) {
    startRelayClient().catch((error) => {
      relayState.lastError = String(error?.message || error);
      appendRelayLog(`Relay auto-start failed: ${relayState.lastError}`);
    });
  }
  return getDaemonStatus();
}

function stopControlServer() {
  if (!controlServer) {
    controlServerState.running = false;
    controlServerState.starting = false;
    return getDaemonStatus();
  }
  const server = controlServer;
  controlServer = null;
  server.close(() => {});
  controlServerState.running = false;
  controlServerState.starting = false;
  appendDaemonLog("Aimashi daemon stopped");
  return getDaemonStatus();
}

async function pingDaemon(settings = settingsStore.daemonSettings(), timeoutMs = 1200) {
  const urls = daemonPingUrls(settings);
  for (const baseUrl of urls) {
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) return { ok: true, baseUrl };
    } catch {
      // Try the next candidate URL.
    }
  }
  return { ok: false, baseUrl: urls[0] || "" };
}

async function notifyDaemonRelay(action, body = {}) {
  const ping = await pingDaemon(settingsStore.daemonSettings(), 500);
  if (!ping.ok || !ping.baseUrl) return null;
  const response = await fetch(`${ping.baseUrl}/api/relay/${action}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${daemonToken()}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(1200)
  });
  if (!response.ok) return null;
  return response.json();
}

async function fetchDaemonRelayStatus() {
  const ping = await pingDaemon(settingsStore.daemonSettings(), 500);
  if (!ping.ok || !ping.baseUrl) return null;
  const response = await fetch(`${ping.baseUrl}/api/relay/status`, {
    headers: { Authorization: `Bearer ${daemonToken()}` },
    signal: AbortSignal.timeout(1200)
  });
  if (!response.ok) return null;
  return response.json();
}

async function startDaemonService() {
  if (!IS_DAEMON_PROCESS && process.env.AIMASHI_DISABLE_BACKGROUND_STARTUP === "1") {
    return { ...getDaemonStatus(), running: false, disabled: true };
  }
  initializeRuntime();
  const settings = settingsStore.daemonSettings();
  if (IS_DAEMON_PROCESS) return startControlServer(settings);
  const existing = await pingDaemon(settings, 500);
  if (existing.ok) return { ...getDaemonStatus(), running: true, baseUrl: existing.baseUrl };
  if (process.platform === "darwin") {
    startDaemonLaunchAgent();
    for (let i = 0; i < 20; i += 1) {
      const ping = await pingDaemon(settings, 500);
      if (ping.ok) return { ...getDaemonStatus(), running: true, baseUrl: ping.baseUrl };
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error("Timed out waiting for Aimashi daemon LaunchAgent.");
  }
  return startControlServer(settings);
}

function stopDaemonService() {
  if (process.platform === "darwin" && !IS_DAEMON_PROCESS) {
    stopDaemonLaunchAgent();
  }
  return stopControlServer();
}

function appendCloudLog(line) {
  const settings = settingsStore.cloudSettings();
  const token = String(settings.token || "");
  const clean = String(line || "").replace(token ? new RegExp(token, "g") : /$a/, "[REDACTED]");
  cloudBridgeState.logs.push(clean);
  if (cloudBridgeState.logs.length > 200) cloudBridgeState.logs = cloudBridgeState.logs.slice(-200);
}

function cloudStatus(includeToken = false) {
  const settings = settingsStore.cloudSettings();
  const cloudWorkspace = settingsStore.readCloudWorkspace();
  const workspace = cloudWorkspace?.workspace || null;
  return {
    enabled: Boolean(settings.enabled && settings.token),
    connected: Boolean(cloudBridgeState.connected),
    connecting: Boolean(cloudBridgeState.connecting),
    url: settings.url,
    user: settings.user,
    workspaceRevision: Number(workspace?.revision || 0),
    conversationCount: Array.isArray(workspace?.conversations) ? workspace.conversations.length : 0,
    lastSyncAt: cloudWorkspace?.syncedAt || "",
    deviceId: cloudBridgeState.deviceId,
    lastError: cloudBridgeState.lastError,
    logs: cloudBridgeState.logs.slice(-80),
    ...(includeToken ? { token: settings.token } : {})
  };
}

async function cloudApi(pathSegment, { method = "GET", body = null, token = "" } = {}) {
  const settings = settingsStore.cloudSettings();
  const baseUrl = settingsStore.normalizeCloudUrl(settings.url);
  const headers = { "Content-Type": "application/json" };
  const bearer = token || settings.token;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const response = await fetch(`${baseUrl}${pathSegment}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Aimashi Cloud ${response.status}`);
  return data;
}

async function syncAimashiCloudWorkspace() {
  const settings = settingsStore.cloudSettings();
  if (!settings.enabled || !settings.token) return cloudStatus(false);
  const data = await cloudApi("/api/me");
  settingsStore.writeCloudSettings({ user: data.user || settings.user });
  settingsStore.writeCloudWorkspace(data.workspace || null);
  mergeCloudWorkspaceIntoChatStore(data.workspace || null);
  return cloudStatus(false);
}

async function pushDesktopMessageToCloud({ session, message, fellowKey = "" } = {}) {
  const settings = settingsStore.cloudSettings();
  if (!settings.enabled || !settings.token || !session?.id || !message) return cloudStatus(false);
  const fellow = loadFellowManifest().fellows.find((item) => item.key === fellowKey || item.id === fellowKey) || {};
  const conversation = cloudConversationFromDesktopSession(session, fellow);
  await cloudApi("/api/conversations", {
    method: "POST",
    body: { conversation }
  });
  const pushed = await cloudApi("/api/messages", {
    method: "POST",
    body: {
      conversationId: conversation.id,
      ...cloudMessageFromDesktopMessage(message)
    }
  });
  settingsStore.writeCloudWorkspace(pushed.workspace || null);
  mergeCloudWorkspaceIntoChatStore(pushed.workspace || null);
  return cloudStatus(false);
}

async function loginAimashiCloud({ username, password, mode = "login", url = "" } = {}) {
  const nextUrl = settingsStore.normalizeCloudUrl(url || settingsStore.cloudSettings().url);
  settingsStore.writeCloudSettings({ url: nextUrl, enabled: false, token: "", user: null });
  const pathSegment = mode === "register" ? "/api/auth/register" : "/api/auth/login";
  const data = await cloudApi(pathSegment, {
    method: "POST",
    body: { username: String(username || "").trim(), password: String(password || "") },
    token: ""
  });
  settingsStore.writeCloudSettings({ url: nextUrl, enabled: true, token: data.token, user: data.user || null });
  settingsStore.writeCloudWorkspace(data.workspace || null);
  mergeCloudWorkspaceIntoChatStore(data.workspace || null);
  startCloudEvents();
  startCloudBridge();
  return cloudStatus(false);
}

async function logoutAimashiCloud() {
  try {
    if (settingsStore.cloudSettings().token) await cloudApi("/api/auth/logout", { method: "POST", body: {} });
  } catch {
    // Local logout should still clear the desktop token.
  }
  settingsStore.writeCloudSettings({ enabled: false, token: "", user: null });
  stopCloudEvents();
  stopCloudBridge();
  return cloudStatus(false);
}

function cloudWebSocketUrl(pathname, settings = settingsStore.cloudSettings()) {
  const url = new URL(settings.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = pathname;
  url.search = "";
  return url;
}

function cloudWebSocketProtocols(settings = settingsStore.cloudSettings()) {
  return [`aimashi-token.${settings.token}`];
}

function cloudEventsUrl(settings = settingsStore.cloudSettings()) {
  return cloudWebSocketUrl("/api/events", settings).toString();
}

function cloudBridgeUrl(settings = settingsStore.cloudSettings()) {
  const url = cloudWebSocketUrl("/api/bridge", settings);
  url.searchParams.set("deviceName", `${os.hostname()} Aimashi Desktop`);
  url.searchParams.set("engine", "codex");
  url.searchParams.set("capabilities", JSON.stringify({
    chat: true,
    attachments: true,
    generatedImages: true,
    cancellation: true,
    streaming: true,
    engines: ["codex"],
    app: "Aimashi Desktop",
    appVersion: app.getVersion(),
    hostname: os.hostname()
  }));
  return url.toString();
}

function stopCloudEvents() {
  if (cloudEventsReconnectTimer) {
    clearTimeout(cloudEventsReconnectTimer);
    cloudEventsReconnectTimer = null;
  }
  const ws = cloudEventsClient;
  cloudEventsClient = null;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    ws.close(1000, "cloud disabled");
  }
  return cloudStatus(false);
}

function scheduleCloudEventsReconnect() {
  if (cloudEventsReconnectTimer) return;
  const settings = settingsStore.cloudSettings();
  if (!settings.enabled || !settings.token) return;
  cloudEventsReconnectTimer = setTimeout(() => {
    cloudEventsReconnectTimer = null;
    startCloudEvents();
  }, 3000);
}

function handleCloudWorkspaceEvent(message = {}) {
  const workspace = message.workspace || null;
  if (!workspace) return;
  settingsStore.writeCloudWorkspace(workspace);
  mergeCloudWorkspaceIntoChatStore(workspace);
  broadcastRendererEvent("cloud:event", {
    type: String(message.type || "workspace_updated"),
    cloud: cloudStatus(false)
  });
}

function handleCloudEventsMessage(raw) {
  let message = null;
  try {
    message = JSON.parse(String(raw || ""));
  } catch {
    appendCloudLog("Cloud events sent invalid JSON.");
    return;
  }
  if (message.type === "events_ready") {
    appendCloudLog("Aimashi Cloud events connected.");
    broadcastRendererEvent("cloud:event", { type: "events_ready", cloud: cloudStatus(false) });
    return;
  }
  if (message.type === "workspace_updated" || message.type === "message_created") {
    handleCloudWorkspaceEvent(message);
    return;
  }
  if (message.type === "bridge_run_updated" || message.type === "device_updated") {
    broadcastRendererEvent("cloud:event", {
      type: String(message.type || "cloud_event"),
      cloud: cloudStatus(false)
    });
  }
}

function startCloudEvents() {
  const settings = settingsStore.cloudSettings();
  if (!settings.enabled || !settings.token) return cloudStatus(false);
  if (cloudEventsClient && [WebSocket.CONNECTING, WebSocket.OPEN].includes(cloudEventsClient.readyState)) {
    return cloudStatus(false);
  }
  const ws = new WebSocket(cloudEventsUrl(settings), cloudWebSocketProtocols(settings));
  cloudEventsClient = ws;
  ws.on("open", () => {
    appendCloudLog(`Listening to Aimashi Cloud events: ${settings.url}`);
  });
  ws.on("message", (raw) => handleCloudEventsMessage(raw));
  ws.on("error", (error) => {
    appendCloudLog(`Cloud events socket error: ${error?.message || error}`);
  });
  ws.on("close", () => {
    if (cloudEventsClient === ws) cloudEventsClient = null;
    appendCloudLog("Aimashi Cloud events disconnected.");
    scheduleCloudEventsReconnect();
  });
  return cloudStatus(false);
}

function stopCloudBridge() {
  if (cloudBridgeReconnectTimer) {
    clearTimeout(cloudBridgeReconnectTimer);
    cloudBridgeReconnectTimer = null;
  }
  const ws = cloudBridgeClient;
  cloudBridgeClient = null;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    ws.close(1000, "cloud disabled");
  }
  cloudBridgeState = {
    ...cloudBridgeState,
    connecting: false,
    connected: false,
    deviceId: ""
  };
  return cloudStatus(false);
}

function scheduleCloudBridgeReconnect() {
  if (cloudBridgeReconnectTimer) return;
  const settings = settingsStore.cloudSettings();
  if (!settings.enabled || !settings.token) return;
  cloudBridgeReconnectTimer = setTimeout(() => {
    cloudBridgeReconnectTimer = null;
    startCloudBridge();
  }, 3000);
}

function sendCloudBridgeRunEvent(ws, runId, kind, payload = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !runId) return;
  ws.send(JSON.stringify({
    type: "run_event",
    runId,
    event: {
      kind: String(kind || "status"),
      ...payload
    }
  }));
}

async function runCloudBridgeRequest(ws, message = {}) {
  const runId = String(message.runId || crypto.randomUUID());
  const abortController = new AbortController();
  cloudBridgeAbortControllers.set(runId, abortController);
  const adapter = createActiveCodexChatAdapter();
  try {
    sendCloudBridgeRunEvent(ws, runId, "status", { text: "本机 Codex 已开始运行。" });
    const response = await adapter.sendChat({
      fellow: {
        key: "aimashi_cloud_codex",
        name: "Codex",
        bio: "",
        engineConfig: {
          effortLevel: "medium",
          permissionMode: "default"
        }
      },
      sessionId: `cloud:${String(message.conversationId || "default")}`,
      messages: [{
        role: "user",
        content: String(message.text || ""),
        attachments: Array.isArray(message.attachments) ? message.attachments : []
      }],
      signal: abortController.signal,
      emit: (kind, payload) => sendCloudBridgeRunEvent(ws, runId, kind, payload),
      utility: false
    });
    const assistant = response.choices?.[0]?.message || {};
    const attachments = (assistant.attachments || []).map((attachment) => ({
      id: attachment.id || `att_${crypto.randomUUID()}`,
      type: attachment.type || attachment.kind || "file",
      name: attachment.name || "附件",
      mimeType: attachment.mimeType || attachment.mime || "",
      dataUrl: attachment.dataUrl || attachment.thumbnailDataUrl || "",
      url: attachment.url || ""
    })).filter((attachment) => attachment.dataUrl || attachment.url);
    return {
      text: String(assistant.content || "").trim() || (attachments.length ? "图片已生成。" : "本机 Codex 已完成。"),
      attachments
    };
  } finally {
    cloudBridgeAbortControllers.delete(runId);
  }
}

function handleCloudBridgeMessage(ws, raw) {
  let message = null;
  try {
    message = JSON.parse(String(raw || ""));
  } catch {
    appendCloudLog("Cloud bridge sent invalid JSON.");
    return;
  }
  if (message.type === "bridge_ready") {
    cloudBridgeState.connected = true;
    cloudBridgeState.connecting = false;
    cloudBridgeState.deviceId = String(message.deviceId || "");
    cloudBridgeState.lastError = "";
    appendCloudLog("Aimashi Cloud Bridge connected.");
    return;
  }
  if (message.type === "cancel") {
    cloudBridgeAbortControllers.get(String(message.runId || ""))?.abort();
    return;
  }
  if (message.type !== "run") return;
  const runId = String(message.runId || "");
  runCloudBridgeRequest(ws, message)
    .then((result) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "run_result", runId, ok: true, ...result }));
    })
    .catch((error) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "run_result", runId, ok: false, error: String(error?.message || error) }));
      }
      appendCloudLog(`Cloud run failed: ${error?.message || error}`);
    });
}

function startCloudBridge() {
  const settings = settingsStore.cloudSettings();
  if (!settings.enabled || !settings.token) return cloudStatus(false);
  if (cloudBridgeClient && [WebSocket.CONNECTING, WebSocket.OPEN].includes(cloudBridgeClient.readyState)) {
    return cloudStatus(false);
  }
  cloudBridgeState.connecting = true;
  cloudBridgeState.connected = false;
  cloudBridgeState.lastError = "";
  const ws = new WebSocket(cloudBridgeUrl(settings), cloudWebSocketProtocols(settings));
  cloudBridgeClient = ws;
  ws.on("open", () => {
    appendCloudLog(`Connecting to Aimashi Cloud: ${settings.url}`);
  });
  ws.on("message", (raw) => handleCloudBridgeMessage(ws, raw));
  ws.on("error", (error) => {
    cloudBridgeState.lastError = String(error?.message || error);
    appendCloudLog(`Cloud bridge socket error: ${cloudBridgeState.lastError}`);
  });
  ws.on("close", () => {
    if (cloudBridgeClient === ws) cloudBridgeClient = null;
    cloudBridgeState.connected = false;
    cloudBridgeState.connecting = false;
    cloudBridgeState.deviceId = "";
    appendCloudLog("Aimashi Cloud Bridge disconnected.");
    scheduleCloudBridgeReconnect();
  });
  return cloudStatus(false);
}

function appendRelayLog(line) {
  const settings = settingsStore.relaySettings();
  const clean = String(line || "")
    .replace(new RegExp(settings.secret, "g"), "[REDACTED]")
    .replace(new RegExp(daemonToken(), "g"), "[REDACTED]");
  relayState.logs.push(clean);
  if (relayState.logs.length > 200) relayState.logs = relayState.logs.slice(-200);
}

function relaySend(payload) {
  if (!relayClient || relayClient.readyState !== WebSocket.OPEN) return false;
  relayClient.send(JSON.stringify(payload));
  return true;
}

function scheduleRelayReconnect() {
  if (relayReconnectTimer) return;
  const settings = settingsStore.relaySettings();
  if (!settings.enabled) return;
  relayReconnectTimer = setTimeout(() => {
    relayReconnectTimer = null;
    startRelayClient().catch((error) => {
      relayState.lastError = String(error?.message || error);
      appendRelayLog(`Relay reconnect failed: ${relayState.lastError}`);
      scheduleRelayReconnect();
    });
  }, 2500);
}

function stopRelayClient() {
  if (relayReconnectTimer) {
    clearTimeout(relayReconnectTimer);
    relayReconnectTimer = null;
  }
  const ws = relayClient;
  relayClient = null;
  if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, "remote disabled");
  relayState = {
    ...relayState,
    enabled: settingsStore.relaySettings().enabled,
    connected: false,
    connecting: false,
    mobilePeers: 0
  };
  return relayStatus(true);
}

function relayRpcResult(clientId, id, ok, payload) {
  relaySend({
    type: "rpc_result",
    clientId,
    id,
    ok,
    ...(ok ? { data: payload } : { error: String(payload?.message || payload || "Request failed.") })
  });
}

function relayRpcStream(clientId, id, event, data) {
  relaySend({
    type: "rpc_stream",
    clientId,
    id,
    event,
    data
  });
}

async function handleRelayRpc(message = {}) {
  const id = String(message.id || crypto.randomUUID());
  const clientId = String(message.clientId || "");
  const method = String(message.method || "GET").toUpperCase();
  const requestPath = String(message.path || "/");
  const body = message.body && typeof message.body === "object" ? message.body : {};
  try {
    if (method === "GET" && requestPath === "/health") {
      relayRpcResult(clientId, id, true, {
        status: "ok",
        service: "aimashi-daemon",
        mode: IS_DAEMON_PROCESS ? "daemon" : "desktop"
      });
      return;
    }
    if (method === "GET" && requestPath === "/api/runtime/status") {
      relayRpcResult(clientId, id, true, getRuntimeStatus());
      return;
    }
    if (method === "GET" && requestPath === "/api/fellows") {
      const manifest = loadFellowManifest();
      relayRpcResult(clientId, id, true, { fellows: manifest.fellows || [], defaultFellow: manifest.default_fellow || "aimashi" });
      return;
    }
    if (method === "GET" && requestPath === "/api/chat/sessions") {
      relayRpcResult(clientId, id, true, loadChatSessions());
      return;
    }
    if (method === "GET" && requestPath === "/api/model/catalog") {
      relayRpcResult(clientId, id, true, { models: await loadHermesModelCatalog() });
      return;
    }
    if (method === "GET" && requestPath === "/api/codex/models") {
      relayRpcResult(clientId, id, true, { models: loadCodexModels() });
      return;
    }
    if (method === "GET" && requestPath === "/api/engine/capabilities") {
      relayRpcResult(clientId, id, true, await loadEngineCapabilities());
      return;
    }
    if (method === "GET" && requestPath.startsWith("/api/commands/slash")) {
      relayRpcResult(clientId, id, true, { rows: await loadHermesSlashCommands() });
      return;
    }
    if (method === "GET" && requestPath.startsWith("/api/commands/agent-list")) {
      const rpcUrl = new URL(requestPath, "http://127.0.0.1");
      relayRpcResult(clientId, id, true, loadExternalAgentCommands({ engine: rpcUrl.searchParams.get("engine") || "" }));
      return;
    }
    if (method === "POST" && requestPath === "/api/chat/session") {
      relayRpcResult(clientId, id, true, newChatSession(body));
      return;
    }
    if (method === "POST" && requestPath === "/api/chat/session/save") {
      relayRpcResult(clientId, id, true, saveChatSession(body));
      return;
    }
    if (method === "POST" && requestPath === "/api/chat/attachment") {
      relayRpcResult(clientId, id, true, saveChatAttachment(body));
      return;
    }
    if (method === "POST" && requestPath === "/api/file/fetch") {
      relayRpcResult(clientId, id, true, readLocalFileAttachment(body));
      return;
    }
    if (method === "POST" && requestPath === "/api/commands/agent-execute") {
      relayRpcResult(clientId, id, true, executeExternalAgentCommand(body));
      return;
    }
    if (method === "POST" && requestPath === "/api/fellow/engine") {
      relayRpcResult(clientId, id, true, saveFellowEngineConfig(body));
      return;
    }
    if (method === "POST" && requestPath === "/api/model/save") {
      const current = modelSettings();
      const nextProvider = String(body.provider || "").trim();
      const existingConnection = providerConnection(nextProvider);
      const next = {
        provider: nextProvider,
        model: String(body.model || "").trim(),
        apiKeyEnv: String(body.apiKeyEnv || existingConnection?.apiKeyEnv || current.apiKeyEnv || "OPENAI_API_KEY").trim(),
        apiKey: String(existingConnection?.apiKey || (nextProvider === current.provider ? current.apiKey : "") || "").trim(),
        baseUrl: String(body.baseUrl || "").trim(),
        apiMode: String(body.apiMode || "").trim()
      };
      writeModelSettings(next);
      relayRpcResult(clientId, id, true, getRuntimeStatus());
      return;
    }
    if (method === "POST" && requestPath === "/api/effort/save") {
      settingsStore.writeEffortSettings(body);
      relayRpcResult(clientId, id, true, getRuntimeStatus());
      return;
    }
    if (method === "POST" && requestPath === "/api/permissions/save") {
      settingsStore.writePermissionSettings(body);
      relayRpcResult(clientId, id, true, getRuntimeStatus());
      return;
    }
    if (method === "POST" && requestPath === "/api/chat/stop") {
      relayRpcResult(clientId, id, true, stopChat());
      return;
    }
    if (method === "POST" && requestPath === "/api/chat/send") {
      const result = await runRemoteChatRequest(body);
      relayRpcResult(clientId, id, true, {
        fellow: result.fellow,
        session: result.session,
        response: result.response
      });
      return;
    }
    if (method === "POST" && requestPath === "/api/chat/stream") {
      const eventSink = {
        isDestroyed: () => !relayClient || relayClient.readyState !== WebSocket.OPEN,
        send: (_channel, envelope) => {
          relayRpcStream(clientId, id, "chat", envelope);
        }
      };
      const result = await runRemoteChatRequest(body, eventSink);
      relayRpcStream(clientId, id, "result", {
        fellow: result.fellow,
        session: result.session,
        response: result.response
      });
      relayRpcResult(clientId, id, true, { done: true });
      return;
    }
    relayRpcResult(clientId, id, false, "Not found.");
  } catch (error) {
    if (method === "POST" && requestPath === "/api/chat/stream") {
      relayRpcStream(clientId, id, "error", { error: String(error?.message || error) });
    }
    relayRpcResult(clientId, id, false, error);
  }
}

function handleRelayMessage(raw) {
  let message = null;
  try {
    message = JSON.parse(String(raw || ""));
  } catch {
    appendRelayLog("Relay sent invalid JSON.");
    return;
  }
  if (message.type === "ready") {
    relayState.connected = true;
    relayState.connecting = false;
    relayState.mobilePeers = Number(message.device?.mobilePeers || 0);
    relayState.lastError = "";
    appendRelayLog("Relay connected.");
    return;
  }
  if (message.type === "peer_count") {
    relayState.mobilePeers = Number(message.count || 0);
    return;
  }
  if (message.type === "rpc") {
    handleRelayRpc(message).catch((error) => {
      relayRpcResult(message.clientId, message.id, false, error);
    });
    return;
  }
  if (message.type === "error") {
    relayState.lastError = String(message.error || "Relay error.");
    appendRelayLog(`Relay error: ${relayState.lastError}`);
  }
}

async function startRelayClient() {
  initializeRuntime();
  const settings = settingsStore.relaySettings();
  relayState = {
    ...relayState,
    enabled: settings.enabled,
    url: settings.url,
    deviceId: settings.deviceId
  };
  if (!settings.enabled) return relayStatus(true);
  if (relayClient && [WebSocket.CONNECTING, WebSocket.OPEN].includes(relayClient.readyState)) return relayStatus(true);
  if (relayReconnectTimer) {
    clearTimeout(relayReconnectTimer);
    relayReconnectTimer = null;
  }
  relayState.connecting = true;
  relayState.connected = false;
  relayState.lastError = "";
  const ws = new WebSocket(settings.url);
  relayClient = ws;
  ws.on("open", () => {
    relayState.connecting = false;
    relaySend({
      type: "hello",
      role: "desktop",
      deviceId: settings.deviceId,
      secret: settings.secret,
      name: os.hostname() || "Aimashi Desktop"
    });
  });
  ws.on("message", handleRelayMessage);
  ws.on("error", (error) => {
    relayState.lastError = String(error?.message || error);
    appendRelayLog(`Relay socket error: ${relayState.lastError}`);
  });
  ws.on("close", () => {
    if (relayClient === ws) relayClient = null;
    relayState.connected = false;
    relayState.connecting = false;
    relayState.mobilePeers = 0;
    appendRelayLog("Relay disconnected.");
    scheduleRelayReconnect();
  });
  return relayStatus(true);
}

async function isEngineHealthy(baseUrl, timeoutMs = 1200) {
  try {
    // /health is an unauthenticated liveness check on hermes — won't 401 even
    // with a wrong API_SERVER_KEY. To verify we're talking to an aimashi-owned
    // gateway (not the user's own launchd hermes), hit an authenticated route
    // (any 401 confirms the gateway runs but isn't ours; any 200 means it's
    // ours since only our key would be accepted).
    const auth = { Authorization: `Bearer ${apiKey()}` };
    const probe = await fetch(`${baseUrl}/v1/runs/_aimashi_probe/events`, {
      method: "GET",
      headers: auth,
      signal: AbortSignal.timeout(timeoutMs)
    });
    // 404 = our gateway (route exists but run id unknown). 401/403 = not ours.
    // 200 = also ours (unlikely for a fake run id but defensive).
    return probe.status === 404 || probe.status === 200;
  } catch {
    return false;
  }
}

async function adoptRunningEngine() {
  // Only check the port we know aimashi configured to bind to. Never scan 8642
  // (user's launchd hermes default port) to avoid accidentally adopting it.
  const configuredPort = readConfiguredPort();
  const ports = [engineState.port, configuredPort]
    .filter((port, index, list) => Number.isInteger(port) && port > 0 && list.indexOf(port) === index);
  for (const port of ports) {
    const baseUrl = `http://127.0.0.1:${port}`;
    if (await isEngineHealthy(baseUrl)) {
      engineState = {
        ...engineState,
        running: true,
        starting: false,
        baseUrl,
        port,
        managedBy: "process",
        lastError: ""
      };
      return true;
    }
  }
  return false;
}

async function waitForHealth(baseUrl, timeoutMs = 45000, requireChildProcess = false) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health`, {
        headers: { Authorization: `Bearer ${apiKey()}` }
      });
      if (response.ok && (!requireChildProcess || (engineProcess && engineProcess.exitCode === null))) return true;
    } catch {
      // Keep polling until the process is ready or times out.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function startEngine() {
  initializeRuntime();
  const p = runtimePaths();
  if (!isEngineInstalled()) {
    throw new Error("Hermes engine is not installed in Aimashi runtime.");
  }
  if (engineProcess && engineState.running) return getRuntimeStatus();
  ensureEnginePlugins();
  if (await adoptRunningEngine()) return getRuntimeStatus();

  const port = await choosePort();
  if (!port) throw new Error("No available local port for Aimashi Hermes API.");

  writeRuntimeConfig(port);
  const settings = modelSettings();
  const dotenv = loadHermesDotenv();
  const env = {
    ...process.env,
    ...dotenv,
    HERMES_HOME: effectiveHermesHome(),
    AIMASHI_HOME: p.home,
    HERMES_ACCEPT_HOOKS: "1",
    API_SERVER_ENABLED: "true",
    API_SERVER_HOST: "127.0.0.1",
    API_SERVER_PORT: String(port),
    API_SERVER_KEY: apiKey(),
    PYTHONPATH: buildPythonPath()
  };
  if (settings.apiKey && settings.apiKeyEnv) {
    env[settings.apiKeyEnv] = settings.apiKey;
  }
  for (const connection of Object.values(providerConnectionStore().providers)) {
    if (connection.apiKey && connection.apiKeyEnv) {
      env[connection.apiKeyEnv] = connection.apiKey;
    }
  }

  const source = engineSource();
  const useLaunchd = process.platform === "darwin" && source === "managed";
  engineState = {
    ...engineState,
    running: false,
    starting: true,
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    managedBy: useLaunchd ? "launchd" : "process",
    lastError: "",
    logs: []
  };

  if (useLaunchd) {
    startLaunchAgent();
    const ok = await waitForHealth(engineState.baseUrl, 45000, false);
    engineState.starting = false;
    engineState.running = ok;
    if (!ok) {
      engineState.lastError = "Timed out waiting for Aimashi Hermes launchd service.";
      throw new Error(engineState.lastError);
    }
    appendEngineLog(`Aimashi Hermes service running at ${engineState.baseUrl}`);
    return getRuntimeStatus();
  }

  engineProcess = spawn(enginePython(), gatewayProgramArguments().slice(1), {
    cwd: p.engine,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  engineProcess.stdout.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) appendEngineLog(line);
  });
  engineProcess.stderr.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) appendEngineLog(line);
  });
  engineProcess.on("exit", (code, signal) => {
    engineState.running = false;
    engineState.starting = false;
    if (code !== 0 && signal !== "SIGTERM") {
      engineState.lastError = `Hermes exited with code ${code ?? "null"} signal ${signal ?? "null"}`;
    }
    engineProcess = null;
  });

  const ok = await waitForHealth(engineState.baseUrl, 45000, true);
  engineState.starting = false;
  engineState.running = ok;
  if (!ok) {
    engineState.lastError = "Timed out waiting for Hermes API health.";
    stopEngine();
    throw new Error(engineState.lastError);
  }
  return getRuntimeStatus();
}

function stopEngine() {
  if (engineProcess) {
    engineProcess.kill("SIGTERM");
    engineProcess = null;
  }
  stopLaunchAgent();
  engineState.running = false;
  engineState.starting = false;
  engineState.managedBy = "";
  return getRuntimeStatus();
}

function uninstallStandaloneEngine() {
  stopEngine();
  const p = runtimePaths();
  try { fs.rmSync(p.launchAgent, { force: true }); } catch { /* plist may not exist */ }
  try { fs.rmSync(p.engine, { recursive: true, force: true }); } catch { /* engine dir may not exist */ }
  fs.mkdirSync(p.engine, { recursive: true });
  agentEngineCache = { at: 0, value: null };
  appendEngineLog("Standalone Hermes copy uninstalled.");
  return getRuntimeStatus();
}

function writeModelSettings(next) {
  const p = runtimePaths();
  fs.writeFileSync(p.modelSettings, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  writeRuntimeConfig(engineState.port || 8642);
  // NOTE: aimashi never writes back to user's ~/.hermes/config.yaml. The user's
  // hermes setup stays read-only; aimashi's model choice only affects aimashi's
  // own private gateway.
}

function applyCodexModelSettings() {
  const current = modelSettings();
  saveProviderConnection({
    provider: "openai-codex",
    providerLabel: "OpenAI Codex",
    authType: "oauth_external",
    apiKeyEnv: "",
    apiKey: "",
    baseUrl: "",
    apiMode: "codex_responses"
  });
  writeModelSettings({
    provider: "openai-codex",
    model: current.provider === "openai-codex" && current.model ? current.model : "gpt-5.3-codex",
    apiKeyEnv: "",
    apiKey: "",
    baseUrl: "",
    apiMode: "codex_responses"
  });
}

function saveCodexTokens(tokens) {
  const p = runtimePaths();
  const auth = readJson(p.authJson, { version: 2, providers: {} });
  if (!auth || typeof auth !== "object") throw new Error("Invalid auth store.");
  if (!auth.providers || typeof auth.providers !== "object") auth.providers = {};
  auth.providers["openai-codex"] = {
    ...(auth.providers["openai-codex"] || {}),
    tokens,
    last_refresh: new Date().toISOString().replace("+00:00", "Z"),
    auth_mode: "chatgpt"
  };
  auth.active_provider = "openai-codex";
  auth.version = auth.version || 2;
  auth.updated_at = new Date().toISOString();
  fs.mkdirSync(path.dirname(p.authJson), { recursive: true });
  fs.writeFileSync(p.authJson, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
}

async function restartEngineIfRunning() {
  const shouldRestart = Boolean(engineProcess || engineState.running || engineState.starting);
  if (!shouldRestart) return getRuntimeStatus();
  stopEngine();
  return startEngine();
}

async function requestCodexDeviceCode() {
  const response = await fetch("https://auth.openai.com/api/accounts/deviceauth/usercode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID })
  });
  if (!response.ok) {
    throw new Error(`Device code request failed: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  if (!data.user_code || !data.device_auth_id) {
    throw new Error("Device code response missing user_code or device_auth_id.");
  }
  return data;
}

async function pollCodexAuthorization(deviceAuthId, userCode, intervalSeconds) {
  const intervalMs = Math.max(3000, Number(intervalSeconds || 5) * 1000);
  const started = Date.now();
  while (!codexOAuthCancelled && Date.now() - started < 15 * 60 * 1000) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const response = await fetch("https://auth.openai.com/api/accounts/deviceauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_auth_id: deviceAuthId,
        user_code: userCode
      })
    });
    if (response.ok) return response.json();
    if (response.status === 403 || response.status === 404) continue;
    throw new Error(`Device auth polling failed: ${response.status} ${response.statusText}`);
  }
  if (codexOAuthCancelled) throw new Error("Codex OAuth cancelled.");
  throw new Error("Codex OAuth timed out after 15 minutes.");
}

async function exchangeCodexTokens(codeResponse) {
  const authorizationCode = codeResponse.authorization_code || "";
  const codeVerifier = codeResponse.code_verifier || "";
  if (!authorizationCode || !codeVerifier) {
    throw new Error("Device auth response missing authorization_code or code_verifier.");
  }
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: authorizationCode,
    redirect_uri: "https://auth.openai.com/deviceauth/callback",
    client_id: CODEX_OAUTH_CLIENT_ID,
    code_verifier: codeVerifier
  });
  const response = await fetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form
  });
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status} ${response.statusText}`);
  }
  const tokens = await response.json();
  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error("Token exchange did not return access_token and refresh_token.");
  }
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token
  };
}

async function finishCodexOAuth(deviceData) {
  try {
    const codeResponse = await pollCodexAuthorization(
      deviceData.device_auth_id,
      deviceData.user_code,
      deviceData.interval
    );
    const tokens = await exchangeCodexTokens(codeResponse);
    saveCodexTokens(tokens);
    applyCodexModelSettings();
    authState.codexStarting = false;
    authState.codexLoggedIn = true;
    authState.codexUserCode = "";
    authState.oauthProvider = "";
    authState.oauthProviderLabel = "";
    appendAuthLog("OpenAI Codex OAuth login completed.");
    await restartEngineIfRunning();
  } catch (error) {
    authState.codexStarting = false;
    if (!codexOAuthCancelled) {
      authState.codexLastError = error.message;
      appendAuthLog(`OpenAI Codex OAuth failed: ${error.message}`);
    }
  } finally {
    authProcess = null;
  }
}

async function startCodexOAuth() {
  initializeRuntime();
  if (!isEngineInstalled()) {
    throw new Error("Hermes engine is not installed in Aimashi runtime.");
  }
  if (authProcess || authState.codexStarting) return getRuntimeStatus();

  codexOAuthCancelled = false;
  authState = {
    ...authState,
    codexStarting: true,
    oauthProvider: "openai-codex",
    oauthProviderLabel: "OpenAI Codex",
    codexLastError: "",
    codexUserCode: "",
    codexVerificationUrl: CODEX_DEVICE_URL,
    logs: []
  };
  appendAuthLog("Requesting OpenAI Codex device code...");
  const deviceData = await requestCodexDeviceCode();
  authState.codexUserCode = String(deviceData.user_code || "");
  appendAuthLog(`Open ${CODEX_DEVICE_URL}`);
  appendAuthLog(`Enter device code: ${authState.codexUserCode}`);
  shell.openExternal(CODEX_DEVICE_URL).catch(() => {});
  authProcess = { kind: "codex-oauth" };
  finishCodexOAuth(deviceData);

  return getRuntimeStatus();
}

function cancelCodexOAuth() {
  codexOAuthCancelled = true;
  if (authProcess && typeof authProcess.kill === "function") {
    authProcess.kill("SIGTERM");
  }
  authProcess = null;
  authState.codexStarting = false;
  authState.codexUserCode = "";
  authState.oauthProvider = "";
  authState.oauthProviderLabel = "";
  appendAuthLog("OpenAI Codex OAuth cancelled.");
  return getRuntimeStatus();
}

function startProviderOAuth(input = {}) {
  initializeRuntime();
  if (!isEngineInstalled()) {
    throw new Error("Hermes engine is not installed in Aimashi runtime.");
  }
  const provider = String(input.provider || "").trim();
  if (!provider) throw new Error("Provider is required.");
  if (provider === "openai-codex") return startCodexOAuth();
  if (authProcess || authState.codexStarting) return getRuntimeStatus();

  const p = runtimePaths();
  const providerLabel = String(input.providerLabel || provider).trim();
  codexOAuthCancelled = false;
  authState = {
    ...authState,
    codexStarting: true,
    oauthProvider: provider,
    oauthProviderLabel: providerLabel,
    codexLastError: "",
    codexUserCode: "",
    codexVerificationUrl: "",
    logs: []
  };
  appendAuthLog(`Starting ${providerLabel} OAuth...`);

  const args = ["-m", "hermes_cli.main", "auth", "add", provider, "--type", "oauth"];
  authProcess = spawn(enginePython(), args, {
    cwd: p.engine,
    env: {
      ...process.env,
      HERMES_HOME: effectiveHermesHome(),
      AIMASHI_HOME: p.home,
      PYTHONPATH: buildPythonPath()
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const onOutput = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) appendAuthLog(line);
  };
  authProcess.stdout.on("data", onOutput);
  authProcess.stderr.on("data", onOutput);
  authProcess.on("exit", async (code, signal) => {
    const completedProvider = provider;
    authState.codexStarting = false;
    authProcess = null;
    if (code === 0) {
      saveProviderConnection({
        provider: completedProvider,
        providerLabel,
        authType: input.authType || "oauth_external",
        apiKeyEnv: "",
        apiKey: "",
        baseUrl: input.baseUrl || "",
        apiMode: input.apiMode || ""
      });
      appendAuthLog(`${providerLabel} OAuth login completed.`);
      authState.oauthProvider = "";
      authState.oauthProviderLabel = "";
      try {
        await restartEngineIfRunning();
      } catch (error) {
        appendAuthLog(`Restart after OAuth failed: ${error.message}`);
      }
    } else if (!codexOAuthCancelled) {
      authState.codexLastError = `${providerLabel} OAuth exited with code ${code ?? "null"} signal ${signal ?? "null"}`;
      appendAuthLog(authState.codexLastError);
    }
  });
  return getRuntimeStatus();
}

function cancelProviderOAuth() {
  if (authState.oauthProvider === "openai-codex" || !authState.oauthProvider) return cancelCodexOAuth();
  codexOAuthCancelled = true;
  if (authProcess && typeof authProcess.kill === "function") authProcess.kill("SIGTERM");
  authProcess = null;
  authState.codexStarting = false;
  authState.codexUserCode = "";
  authState.oauthProvider = "";
  authState.oauthProviderLabel = "";
  appendAuthLog("OAuth cancelled.");
  return getRuntimeStatus();
}

function cleanRunSessionId(value, fellowKey) {
  const raw = String(value || "").trim();
  const fallback = `${fellowKey || "aimashi"}:default`;
  return (raw || fallback)
    .replace(/[^A-Za-z0-9_.:-]+/g, "_")
    .slice(0, 120) || fallback;
}

function normalizeRunMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((message) => message && ["system", "user", "assistant"].includes(message.role))
    .map((message) => ({
      role: message.role,
      content: String(message.content || "").trim(),
      attachments: normalizeAttachments(message.attachments)
    }))
    .filter((message) => message.content || message.attachments.length);
}

function buildRunPayload({ fellow, sessionId, messages }) {
  const normalized = normalizeRunMessages(messages);
  const instructions = normalized
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n")
    .trim();
  const dialogue = normalized.filter((message) => message.role !== "system");
  const lastUserIndex = dialogue.map((message) => message.role).lastIndexOf("user");
  if (lastUserIndex < 0) {
    throw new Error("No user message found.");
  }
  const lastUser = dialogue[lastUserIndex];
  const attachmentText = attachmentContext(lastUser.attachments);
  const input = [lastUser.content, attachmentText ? `附件上下文：\n${attachmentText}` : ""].filter(Boolean).join("\n\n");
  const conversationHistory = dialogue
    .slice(0, lastUserIndex)
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role,
      content: [
        message.content,
        message.role === "user" && message.attachments.length ? attachmentContext(message.attachments) : ""
      ].filter(Boolean).join("\n\n")
    }))
    .filter((message) => message.content);
  const accountId = fellow.account_id || fellow.key;
  const routeProfile = fellow.route_profile || accountId;
  const body = {
    model: "hermes-agent",
    input,
    session_id: cleanRunSessionId(sessionId, fellow.key),
    account_id: accountId,
    metadata: {
      fellow_key: fellow.key,
      persona_key: fellow.key,
      account_id: accountId,
      route_profile: routeProfile,
      display_name: fellow.name
    }
  };
  if (instructions) body.instructions = instructions;
  if (conversationHistory.length) body.conversation_history = conversationHistory;
  return body;
}

function firstTextValue(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(firstTextValue).filter(Boolean).join("");
  }
  if (value && typeof value === "object") {
    for (const key of ["text", "content", "delta", "output", "message", "final_response"]) {
      const nested = firstTextValue(value[key]);
      if (nested) return nested;
    }
  }
  return "";
}

function normalizeHermesError(message) {
  const text = String(message || "").trim();
  if (text.includes("No inference provider configured") || text.includes("no API key was found")) {
    return "Aimashi Hermes 已启动，但模型还不能调用。请在右侧 Model 选择 preset，填 API key，保存后再发送。";
  }
  return text;
}

function eventText(eventName, payload) {
  if (!payload || typeof payload !== "object") return "";
  if (eventName === "message.delta") return firstTextValue(payload.delta);
  for (const key of ["output", "final_response", "text", "content", "message"]) {
    const value = firstTextValue(payload[key]);
    if (value) return value;
  }
  return "";
}

function parseSseFrame(frame) {
  const dataLines = [];
  let eventName = "";
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon >= 0 ? line.slice(0, colon) : line;
    let value = colon >= 0 ? line.slice(colon + 1) : "";
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    if (field === "data") dataLines.push(value);
  }
  if (!dataLines.length) return null;
  const raw = dataLines.join("\n");
  let data = raw;
  try {
    data = JSON.parse(raw);
  } catch {
    // Some SSE producers send plain text data.
  }
  return {
    event: eventName || (data && typeof data === "object" ? data.event : "") || "message",
    data
  };
}

async function readRunEventStream({ runId, signal, emit }) {
  const response = await fetch(`${engineState.baseUrl}/v1/runs/${encodeURIComponent(runId)}/events`, {
    method: "GET",
    headers: {
      Accept: "text/event-stream",
      Authorization: `Bearer ${apiKey()}`
    },
    signal
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `${response.status} ${response.statusText}`);
  }
  if (!response.body?.getReader) {
    throw new Error("Hermes run event stream is not readable in this runtime.");
  }

  const reader = response.body.getReader();
  const cancelReader = () => {
    try {
      reader.cancel();
    } catch {
      // Ignore cancellation failures.
    }
  };
  signal?.addEventListener("abort", cancelReader, { once: true });
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  let content = "";
  let finalContent = "";
  let finishReason = "stop";

  let textBlockId = null;
  let firstDeltaSeen = false;
  const consumeFrame = (frame) => {
    const parsed = parseSseFrame(frame);
    if (!parsed) return false;
    const payload = parsed.data && typeof parsed.data === "object" ? parsed.data : { data: parsed.data };
    const name = parsed.event || payload.event || "message";
    if (events.length < 500) {
      events.push({
        event: name,
        run_id: payload.run_id || runId,
        timestamp: payload.timestamp || null,
        data: payload
      });
    }
    if (name === "message.delta") {
      const chunk = eventText(name, payload);
      content += chunk;
      if (emit && chunk) {
        if (!textBlockId) textBlockId = `text_${crypto.randomUUID()}`;
        firstDeltaSeen = true;
        emit("text_delta", { id: textBlockId, text: chunk });
      }
      return false;
    }
    if (name === "message.complete") {
      const text = eventText(name, payload);
      if (text) finalContent = text;
      return false;
    }
    if (name === "reasoning.available") {
      if (emit) {
        const text = String(payload.text || "");
        emit("reasoning_delta", { id: `reasoning_${runId}`, text });
      }
      return false;
    }
    if (name === "tool.started") {
      if (emit) {
        const toolId = `tool_${payload.tool || "unknown"}_${payload.timestamp || Date.now()}`;
        emit("tool_call_started", {
          id: toolId,
          name: String(payload.tool || ""),
          preview: String(payload.preview || "")
        });
      }
      return false;
    }
    if (name === "tool.completed") {
      if (emit) {
        emit("tool_call_completed", {
          name: String(payload.tool || ""),
          duration: typeof payload.duration === "number" ? payload.duration : null,
          error: Boolean(payload.error),
          matchByName: true
        });
      }
      return false;
    }
    if (name === "run.completed") {
      finalContent = eventText(name, payload) || finalContent || content;
      finishReason = "stop";
      return true;
    }
    if (name === "run.cancelled") {
      finishReason = "cancelled";
      return true;
    }
    if (name === "run.failed") {
      const error = firstTextValue(payload.error) || firstTextValue(payload.message) || "Hermes run failed.";
      throw new Error(normalizeHermesError(error));
    }
    return false;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      let splitIndex = buffer.indexOf("\n\n");
      while (splitIndex >= 0) {
        const frame = buffer.slice(0, splitIndex);
        buffer = buffer.slice(splitIndex + 2);
        if (consumeFrame(frame)) {
          try {
            await reader.cancel();
          } catch {
            // The stream may already be closed by Hermes.
          }
          return { content: finalContent || content, finishReason, events };
        }
        splitIndex = buffer.indexOf("\n\n");
      }
    }
    const tail = buffer.trim();
    if (tail) consumeFrame(tail);
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    try {
      reader.releaseLock();
    } catch {
      // Ignore release failures on already-closed streams.
    }
  }
  return { content: finalContent || content, finishReason, events };
}

function lastUserPrompt(messages) {
  const normalized = normalizeRunMessages(messages);
  const last = [...normalized].reverse().find((message) => message.role === "user");
  if (!last || (!last.content && !last.attachments.length)) throw new Error("No user message found.");
  const attachmentText = attachmentContext(last.attachments);
  return [last.content, attachmentText ? `附件上下文：\n${attachmentText}` : ""].filter(Boolean).join("\n\n");
}

function createActiveStatelessChatEngineAdapters() {
  const claudeAdapter = createActiveClaudeCodeChatAdapter();
  const codexAdapter = createActiveCodexChatAdapter();
  const hermesAdapter = createActiveHermesChatAdapter();
  return createStatelessChatEngineAdapters({
    ensureHermesReady: ensureHermesChatEngineReady,
    sendClaudeCodeStateless: claudeAdapter.sendStateless,
    sendCodexStateless: codexAdapter.sendStateless,
    sendHermesStateless: hermesAdapter.sendStateless
  });
}

async function sendChatStateless({ fellowKey, systemPrompt, userPrompt, signal }) {
  const manifest = loadFellowManifest();
  const { fellow } = requireFellow(manifest, fellowKey, "还没有可用的 fellow，请先在引导里创建一个再发起对话。");
  const chatEngine = resolveChatEngineAdapter(fellow);
  return sendWithStatelessChatEngineAdapter(createActiveStatelessChatEngineAdapters(), {
    chatEngine,
    fellow,
    systemPrompt,
    userPrompt,
    signal
  });
}

async function ensureHermesChatEngineReady() {
  if (!engineState.running || !engineState.baseUrl) {
    await startEngine();
  }
}

function createActiveHermesChatAdapter() {
  return createHermesChatAdapter({
    apiKey,
    baseUrl: () => engineState.baseUrl,
    buildGroupHeader: buildHermesGroupHeader,
    buildRunPayload,
    normalizeError: normalizeHermesError,
    readRunEventStream,
    responseModel: adapterForEngine("hermes").responseModel
  });
}

function createActiveClaudeCodeChatAdapter() {
  return createClaudeCodeChatAdapter({
    appendEngineLog,
    chatCompletionResponse,
    claudeAgentSdk,
    ensureClaudeBridgePlugin,
    expandLeadingSkillCommand: skillsLoader.expandLeadingSkillCommand,
    getAgentSessionEntry,
    getSchedulerMcpSpec,
    injectGroupContextForSdk,
    lastUserPrompt,
    normalizeEffortLevel: settingsStore.normalizeEffortLevel,
    processEnvStrings,
    readFellowPersona,
    setAgentSessionEntry,
    shellCommandPath,
    writeSchedulerMcpContext
  });
}

function createActiveCodexChatAdapter() {
  return createCodexChatAdapter({
    chatCompletionResponse,
    codexSdk,
    ensureCodexHome,
    expandLeadingSkillCommand: skillsLoader.expandLeadingSkillCommand,
    getAgentSessionId,
    injectGroupContextForSdk,
    lastUserPrompt,
    normalizeEffortLevel: settingsStore.normalizeEffortLevel,
    processEnvStrings,
    readFellowPersona,
    setAgentSessionId,
    shellCommandPath,
    writeSchedulerMcpContext
  });
}

function createActiveChatEngineAdapters() {
  const claudeAdapter = createActiveClaudeCodeChatAdapter();
  const codexAdapter = createActiveCodexChatAdapter();
  const hermesAdapter = createActiveHermesChatAdapter();
  return createChatEngineAdapters({
    chatCompletionResponse,
    ensureHermesReady: ensureHermesChatEngineReady,
    hermesSlashCommandResponse: hermesAdapter.slashCommandResponse,
    runExternalSlashCommand,
    runHermesSlashCommand,
    sendClaudeCodeChat: claudeAdapter.sendChat,
    sendCodexChat: codexAdapter.sendChat,
    sendHermesChat: hermesAdapter.sendChat
  });
}

async function sendChat({ fellowKey, personaKey, sessionId, messages, group, webContents, utility = false }) {
  utility = Boolean(utility);
  let abortController;
  if (group || utility) {
    // Group dispatches run in parallel; each gets its own controller.
    // Utility calls also skip the 1v1 "single active chat" semantics.
    abortController = new AbortController();
  } else {
    if (activeChatAbortController) {
      activeChatAbortController.abort();
    }
    abortController = new AbortController();
    activeChatAbortController = abortController;
  }
  const { signal } = abortController;
  const { emit } = !utility
    ? createChatEventEmitter({ webContents, sessionId })
    : { emit: null };
  try {
    const manifest = loadFellowManifest();
    const key = fellowKey || personaKey;
    const { fellow } = requireFellow(manifest, key, "还没有可用的 fellow，请先在引导里创建一个再发起对话。");
    const chatEngine = resolveChatEngineAdapter(fellow);
    const agentEngine = chatEngine.id;
    const shouldNotifyPet = !utility && !String(sessionId || "").startsWith("title:");
    const completeWithPetMessage = (response) => {
      if (shouldNotifyPet) notifyFellowPetMessage(fellow.key, responseMessageContent(response));
      return response;
    };
    if (emit) {
      emit("session_started", { fellowKey: fellow.key, engine: agentEngine });
    }
    const slashText = isSlashCommandText(messages);
    const response = await sendWithChatEngineAdapter(createActiveChatEngineAdapters(), {
      chatEngine,
      fellow,
      sessionId,
      messages,
      group,
      signal,
      abortController,
      emit,
      utility,
      slashText
    });
    return completeWithPetMessage(response);
  } catch (error) {
    if (signal.aborted) {
      if (emit) emit("complete", { finishReason: "cancelled", aborted: true });
      const stopped = new Error("生成已停止");
      stopped.code = "AIMASHI_STOPPED";
      throw stopped;
    }
    if (emit) emit("error", { message: String(error?.message || error) });
    throw error;
  } finally {
    if (activeChatAbortController === abortController) activeChatAbortController = null;
  }
}

function stopChat() {
  if (activeChatAbortController) {
    activeChatAbortController.abort();
    activeChatAbortController = null;
    return { stopped: true };
  }
  return { stopped: false };
}

function loadChatSessions() {
  initializeRuntime();
  const store = loadChatStore();
  return saveChatStore(store);
}

function saveChatSession({ personaKey, session, replaceMessages = false }) {
  initializeRuntime();
  const key = String(personaKey || session?.personaKey || "").trim();
  if (!key) throw new Error("personaKey is required.");
  const store = loadChatStore();
  if (!store.sessions[key]) store.sessions[key] = [];
  const now = new Date().toISOString();
  const next = {
    id: String(session?.id || crypto.randomUUID()),
    personaKey: key,
    title: cleanSessionTitle(session?.title) || "新对话",
    titleGenerated: Boolean(session?.titleGenerated),
    createdAt: session?.createdAt || now,
    updatedAt: session?.updatedAt || now,
    messages: Array.isArray(session?.messages)
      ? session.messages.map((message) => {
        const out = {
          role: ["user", "assistant", "system"].includes(message.role) ? message.role : "assistant",
          content: String(message.content || ""),
          createdAt: message.createdAt || now,
          transient: Boolean(message.transient)
        };
        if (message.pinned) {
          out.pinned = true;
          out.pinnedAt = String(message.pinnedAt || message.pinned_at || now);
        }
        const replyTo = normalizeMessageReply(message.replyTo);
        if (replyTo) out.replyTo = replyTo;
        const translation = normalizeMessageTranslation(message.translation);
        if (translation && translation.status !== "loading") out.translation = translation;
        const attachments = normalizeAttachments(message.attachments);
        if (attachments.length) out.attachments = attachments;
        if (message.reasoning) out.reasoning = String(message.reasoning);
        if (Array.isArray(message.tools) && message.tools.length) {
          out.tools = message.tools.map((tool) => ({
            id: String(tool.id || ""),
            name: String(tool.name || ""),
            preview: String(tool.preview || ""),
            status: ["running", "completed", "error"].includes(tool.status) ? tool.status : "completed",
            duration: typeof tool.duration === "number" ? tool.duration : null,
            error: Boolean(tool.error)
          }));
        }
        return out;
      })
        .filter((message) => !message.transient)
        .map(({ transient, ...message }) => message)
      : []
  };
  const index = store.sessions[key].findIndex((item) => item.id === next.id);
  if (index >= 0) {
    const existing = store.sessions[key][index];
    const mergedMessages = [...(existing.messages || [])];
    const seen = new Map(mergedMessages.map((message, messageIndex) => [chatMessageMergeKey(message), messageIndex]));
    for (const message of next.messages) {
      const messageKey = chatMessageMergeKey(message);
      const existingIndex = seen.get(messageKey);
      if (existingIndex == null) {
        mergedMessages.push(message);
        seen.set(messageKey, mergedMessages.length - 1);
      } else {
        mergedMessages[existingIndex] = mergeChatMessageRecord(mergedMessages[existingIndex], message);
      }
    }
    mergedMessages.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
    store.sessions[key][index] = {
      ...existing,
      ...next,
      title: next.titleGenerated ? next.title : (existing.title || next.title),
      titleGenerated: Boolean(existing.titleGenerated || next.titleGenerated),
      createdAt: existing.createdAt || next.createdAt,
      updatedAt: String(next.updatedAt || "").localeCompare(String(existing.updatedAt || "")) >= 0 ? next.updatedAt : existing.updatedAt,
      messages: replaceMessages ? next.messages : mergedMessages
    };
  }
  else store.sessions[key].push(next);
  return saveChatStore(store);
}

function saveChatReadState({ readAt }) {
  initializeRuntime();
  const store = loadChatStore();
  if (readAt && typeof readAt === "object") {
    store.readAt = Object.fromEntries(
      Object.entries(readAt)
        .filter(([key, value]) => key && typeof value === "string" && value.trim())
        .map(([key, value]) => [String(key), value])
    );
  }
  return saveChatStore(store);
}

function newChatSession({ personaKey }) {
  initializeRuntime();
  const key = String(personaKey || "").trim();
  if (!key) throw new Error("personaKey is required.");
  const store = loadChatStore();
  if (!store.sessions[key]) store.sessions[key] = [];
  store.sessions[key] = store.sessions[key].filter((session) => (session.messages || []).some((message) => String(message.content || "").trim()));
  const session = createChatSession(key);
  store.sessions[key].unshift(session);
  return saveChatStore(store);
}

function renameChatSession({ personaKey, sessionId, title }) {
  initializeRuntime();
  const key = String(personaKey || "").trim();
  const id = String(sessionId || "").trim();
  const nextTitle = cleanSessionTitle(title);
  if (!key || !id || !nextTitle) throw new Error("personaKey, sessionId and title are required.");
  const store = loadChatStore();
  const session = (store.sessions[key] || []).find((item) => item.id === id);
  if (!session) throw new Error("Session not found.");
  session.title = nextTitle;
  session.titleGenerated = true;
  session.updatedAt = new Date().toISOString();
  return saveChatStore(store);
}

async function generateSessionTitle({ personaKey, sessionId, messages }) {
  const clipped = (Array.isArray(messages) ? messages : [])
    .filter((message) => ["user", "assistant"].includes(message.role) && String(message.content || "").trim())
    .slice(0, 4);
  if (!clipped.length) return { title: "新对话" };
  try {
    const response = await sendChat({
      personaKey,
      sessionId: sessionId || `title:${crypto.randomUUID()}`,
      messages: [
        {
          role: "system",
          content: "请给下面这段对话生成一个简短标题。要求：不超过12个中文字；只输出标题；不要解释；不要引号；不要句号。"
        },
        {
          role: "user",
          content: clipped.map((message) => `${message.role}: ${message.content}`).join("\n").slice(0, 1600)
        }
      ]
    });
    const content = response.choices?.[0]?.message?.content || "";
    return { title: cleanSessionTitle(content) || fallbackSessionTitle(clipped) };
  } catch {
    return { title: fallbackSessionTitle(clipped) };
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 420,
    minHeight: 560,
    title: "Aimashi",
    titleBarStyle: "hidden",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  if (process.platform === "darwin" && typeof win.setWindowButtonVisibility === "function") {
    win.setWindowButtonVisibility(false);
  }
  const sendWindowEvent = (channel, payload) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  };
  win.on("focus", () => sendWindowEvent("window:focus-state", true));
  win.on("blur", () => sendWindowEvent("window:focus-state", false));
  win.on("enter-full-screen", () => sendWindowEvent("window:fullscreen", true));
  win.on("leave-full-screen", () => sendWindowEvent("window:fullscreen", false));
  win.webContents.once("did-finish-load", () => startupTimer.mark("renderer:did-finish-load"));
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  startupTimer.mark("window:load-file");
  return win;
}

ipcMain.on("ui:first-paint", () => {
  startupTimer.mark("renderer:first-paint");
  runtimeLifecycle().scheduleBackgroundStartup();
});

ipcMain.handle("window:close", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});
ipcMain.handle("window:minimize", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});
ipcMain.handle("window:green", (event) => {
  const w = BrowserWindow.fromWebContents(event.sender);
  if (!w) return;
  w.setFullScreen(!w.isFullScreen());
});
ipcMain.handle("window:state", (event) => {
  const w = BrowserWindow.fromWebContents(event.sender);
  if (!w) return { focused: true, fullscreen: false };
  return { focused: w.isFocused(), fullscreen: w.isFullScreen() };
});
ipcMain.handle("edit:context-menu", (event, point = {}) => {
  const w = BrowserWindow.fromWebContents(event.sender);
  if (!w) return;
  Menu.buildFromTemplate([
    { label: "剪切", role: "cut" },
    { label: "复制", role: "copy" },
    { label: "粘贴", role: "paste" }
  ]).popup({
    window: w,
    x: Number.isFinite(point.x) ? Math.round(point.x) : undefined,
    y: Number.isFinite(point.y) ? Math.round(point.y) : undefined
  });
});

ipcMain.handle("runtime:initialize", async () => {
  const status = initializeRuntime();
  status.daemon = await getObservedDaemonStatus(350);
  if (!IS_DAEMON_PROCESS) {
    status.relay = { ...status.relay, ...(await fetchDaemonRelayStatus().catch(() => null) || {}) };
  }
  return status;
});
ipcMain.handle("runtime:status", async () => {
  const status = getRuntimeStatus();
  status.daemon = await getObservedDaemonStatus(350);
  if (!IS_DAEMON_PROCESS) {
    status.relay = { ...status.relay, ...(await fetchDaemonRelayStatus().catch(() => null) || {}) };
  }
  return status;
});
ipcMain.handle("daemon:status", async () => {
  return getObservedDaemonStatus(500);
});
ipcMain.handle("daemon:pairing", async () => {
  const settings = settingsStore.daemonSettings();
  const ping = await pingDaemon(settings, 500);
  return { ...getDaemonPairingInfo(), running: controlServerState.running || ping.ok, baseUrl: ping.baseUrl || getDaemonStatus().baseUrl };
});
ipcMain.handle("daemon:start", () => startDaemonService());
ipcMain.handle("daemon:stop", () => stopDaemonService());
ipcMain.handle("daemon:settings-save", (_event, settings) => {
  settingsStore.writeDaemonSettings(settings);
  return getDaemonStatus();
});
ipcMain.handle("util:qr-svg", (_event, text) => {
  const value = String(text || "").trim();
  if (!value) return "";
  return QRCode.toString(value, {
    type: "svg",
    margin: 1,
    width: 184,
    color: {
      dark: "#111111",
      light: "#ffffff"
    }
  });
});
ipcMain.handle("relay:status", async () => {
  if (!IS_DAEMON_PROCESS) {
    const daemonRelay = await fetchDaemonRelayStatus().catch(() => null);
    if (daemonRelay) return { ...relayStatus(true), ...daemonRelay };
  }
  return relayStatus(true);
});
ipcMain.handle("relay:start", async () => {
  settingsStore.writeRelaySettings({ enabled: true });
  if (!IS_DAEMON_PROCESS) {
    const daemonRelay = await notifyDaemonRelay("start");
    if (daemonRelay) return { ...relayStatus(true), ...daemonRelay };
  }
  return startRelayClient();
});
ipcMain.handle("relay:stop", () => {
  settingsStore.writeRelaySettings({ enabled: false });
  if (!IS_DAEMON_PROCESS) {
    notifyDaemonRelay("stop").catch(() => {});
  }
  return stopRelayClient();
});
ipcMain.handle("relay:settings-save", async (_event, settings) => {
  const next = settingsStore.writeRelaySettings(settings);
  if (!IS_DAEMON_PROCESS) {
    const daemonRelay = await notifyDaemonRelay(next.enabled ? "start" : "stop", next);
    if (daemonRelay) return { ...relayStatus(true), ...daemonRelay };
  }
  if (next.enabled) return startRelayClient();
  return stopRelayClient();
});
ipcMain.handle("cloud:status", () => cloudStatus(false));
ipcMain.handle("cloud:login", async (_event, payload) => {
  await loginAimashiCloud(payload || {});
  return getRuntimeStatus();
});
ipcMain.handle("cloud:sync", async () => {
  await syncAimashiCloudWorkspace();
  return getRuntimeStatus();
});
ipcMain.handle("cloud:push-message", async (_event, payload) => {
  await pushDesktopMessageToCloud(payload || {});
  return getRuntimeStatus();
});
ipcMain.handle("cloud:logout", async () => {
  await logoutAimashiCloud();
  return getRuntimeStatus();
});
ipcMain.handle("engine:install", () => installEngine());
ipcMain.handle("engine:start", () => startEngine());
ipcMain.handle("engine:stop", () => stopEngine());
ipcMain.handle("engine:uninstall-standalone", () => uninstallStandaloneEngine());
ipcMain.handle("auth:codex-start", () => startCodexOAuth());
ipcMain.handle("auth:codex-cancel", () => cancelCodexOAuth());
ipcMain.handle("auth:provider-start", (_event, provider) => startProviderOAuth(provider));
ipcMain.handle("auth:provider-cancel", () => cancelProviderOAuth());
ipcMain.handle("chat:send", (event, payload) => sendChat({ ...payload, webContents: event.sender }));
ipcMain.handle("chat:send-stateless", (_event, payload) => sendChatStateless(payload));
ipcMain.handle("chat:stop", () => stopChat());
ipcMain.handle("chat:attachment-save", (_event, payload) => saveChatAttachment(payload));
ipcMain.handle("chat:file-fetch", (_event, payload) => safeFetchFileAttachment(payload));
ipcMain.handle("commands:slash", () => loadHermesSlashCommands());
ipcMain.handle("commands:agent-list", (_event, payload) => loadExternalAgentCommands(payload));
ipcMain.handle("commands:agent-execute", (_event, payload) => executeExternalAgentCommand(payload));
ipcMain.handle("chat:sessions-load", () => loadChatSessions());
ipcMain.handle("chat:session-save", (_event, payload) => saveChatSession(payload));
ipcMain.handle("chat:read-state-save", (_event, payload) => saveChatReadState(payload));
ipcMain.handle("chat:session-create", (_event, payload) => newChatSession(payload));
ipcMain.handle("chat:session-rename", (_event, payload) => renameChatSession(payload));
ipcMain.handle("chat:title-generate", (_event, payload) => generateSessionTitle(payload));
ipcMain.handle("model:catalog", () => loadHermesModelCatalog());
ipcMain.handle("codex:list-models", () => loadCodexModels());
ipcMain.handle("engine:capabilities", () => loadEngineCapabilities());
ipcMain.handle("skills:list", () => skillsLoader.loadLocalSkills());
ipcMain.handle("plugins:install", (_event, extensionId) => skillsLoader.installMarketplacePlugin(extensionId));
ipcMain.handle("skills:read", (_event, skillId) => skillsLoader.readLocalSkill(skillId));
ipcMain.handle("skills:delete", (_event, skillId) => skillsLoader.deleteLocalSkill(skillId));
ipcMain.handle("skills:open-directory", (_event, skillId) => skillsLoader.openLocalSkillDirectory(skillId));
ipcMain.handle("permissions:save", async (_event, settings) => {
  settingsStore.writePermissionSettings(settings);
  return getRuntimeStatus();
});
ipcMain.handle("effort:save", async (_event, settings) => {
  settingsStore.writeEffortSettings(settings);
  return getRuntimeStatus();
});
ipcMain.handle("model:save", (_event, settings) => {
  const current = modelSettings();
  const nextProvider = String(settings.provider || "").trim();
  const hasApiKey = Object.prototype.hasOwnProperty.call(settings || {}, "apiKey");
  const hasApiKeyEnv = Object.prototype.hasOwnProperty.call(settings || {}, "apiKeyEnv");
  const existingConnection = providerConnection(nextProvider);
  const submittedApiKey = hasApiKey ? String(settings.apiKey || "").trim() : "";
  const fallbackApiKey = existingConnection?.apiKey || (nextProvider === current.provider ? current.apiKey : "");
  const nextApiKeyEnv = String(hasApiKeyEnv ? settings.apiKeyEnv : (existingConnection?.apiKeyEnv || current.apiKeyEnv || "OPENAI_API_KEY")).trim();
  const next = {
    provider: nextProvider,
    model: String(settings.model || "").trim(),
    apiKeyEnv: nextApiKeyEnv,
    apiKey: submittedApiKey || String(fallbackApiKey || "").trim(),
    baseUrl: String(settings.baseUrl || "").trim(),
    apiMode: String(settings.apiMode || "").trim()
  };
  if (next.provider && (submittedApiKey || next.apiKey || next.provider === "lmstudio")) {
    saveProviderConnection({
      provider: next.provider,
      providerLabel: String(settings.providerLabel || existingConnection?.providerLabel || next.provider).trim(),
      authType: String(settings.authType || existingConnection?.authType || (next.provider === "openai-codex" ? "oauth_external" : "api_key")).trim(),
      apiKeyEnv: next.apiKeyEnv,
      apiKey: next.apiKey,
      baseUrl: next.baseUrl,
      apiMode: next.apiMode
    });
  }
  writeModelSettings(next);
  if (submittedApiKey) return restartEngineIfRunning();
  return getRuntimeStatus();
});

ipcMain.handle("appearance:save", (_event, settings) => {
  const p = runtimePaths();
  const current = appearanceSettings();
  const theme = String(settings.theme || current.theme || "light").trim();
  const fontPreset = String(settings.fontPreset || current.fontPreset || "system").trim();
  const accentColor = String(settings.accentColor || current.accentColor || "#5e5ce6").trim();
  const userBubbleColor = String(settings.userBubbleColor || current.userBubbleColor || "#dedcff").trim();
  const showHoverBackground = settings.showHoverBackground == null ? current.showHoverBackground !== false : settings.showHoverBackground !== false;
  const showUserAvatar = settings.showUserAvatar == null ? current.showUserAvatar !== false : settings.showUserAvatar !== false;
  const showAssistantAvatar = settings.showAssistantAvatar == null ? current.showAssistantAvatar !== false : settings.showAssistantAvatar !== false;
  const listStyle = String(settings.listStyle || current.listStyle || "card").trim();
  const selectionStyle = String(settings.selectionStyle || current.selectionStyle || "soft").trim();
  const validHex = (value, fallback) => /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : fallback;
  const next = {
    theme: ["light", "dark"].includes(theme) ? theme : "light",
    fontPreset: ["system", "sf-pro", "pingfang", "mono"].includes(fontPreset) ? fontPreset : "system",
    accentColor: validHex(accentColor, "#5e5ce6"),
    userBubbleColor: validHex(userBubbleColor, "#dedcff"),
    showHoverBackground,
    showUserAvatar,
    showAssistantAvatar,
    listStyle: ["card", "flush"].includes(listStyle) ? listStyle : "card",
    selectionStyle: ["soft", "solid"].includes(selectionStyle) ? selectionStyle : "soft"
  };
  fs.writeFileSync(p.appearanceSettings, JSON.stringify(next, null, 2) + "\n");
  return getRuntimeStatus();
});

ipcMain.handle("profile:save", (_event, profile) => {
  const p = runtimePaths();
  const current = { ...settingsStore.defaultUserProfile(), ...readJson(p.userProfile, {}) };
  const next = {
    displayName: String(profile.displayName || current.displayName || "Boss").trim() || "Boss",
    avatarText: String(profile.avatarText || current.avatarText || "B").trim().slice(0, 2).toUpperCase() || "B",
    avatarColor: String(profile.avatarColor || current.avatarColor || "#111827").trim() || "#111827",
    avatarImage: String(profile.avatarImage || current.avatarImage || "").trim(),
    avatarCrop: normalizeAvatarCrop(profile.avatarCrop || current.avatarCrop)
  };
  fs.writeFileSync(p.userProfile, JSON.stringify(next, null, 2) + "\n");
  return getRuntimeStatus();
});

function saveFellow(fellowInput) {
  const p = runtimePaths();
  const name = String(fellowInput.name || "").trim();
  if (!name) throw new Error("Fellow name is required.");
  let key = fellowKeyFromName(fellowInput.key || name);

  const manifest = loadFellowManifest();
  const fellows = Array.isArray(manifest.fellows) ? manifest.fellows : [];
  const existingFellow = fellows.find((item) => item.key === key);
  if (!fellowInput.key) {
    const existingKeys = new Set(fellows.map((item) => item.key));
    const baseKey = key;
    let index = 2;
    while (existingKeys.has(key)) {
      const existing = fellows.find((item) => item.key === key);
      if (existing && existing.name === name) break;
      key = `${baseKey}_${index}`;
      index += 1;
    }
  }
  const next = normalizeFellow({
    ...(existingFellow || {}),
    key,
    name,
    account_id: key,
    route_profile: key,
    agentEngine: fellowInput.agentEngine || fellowInput.agent_engine || existingFellow?.agentEngine || "hermes",
    engineConfig: normalizeFellowEngineConfig(fellowInput.engineConfig || fellowInput.engine_config || existingFellow?.engineConfig),
    platform: "api_server",
    color: fellowInput.color || "#0f766e",
    avatarImage: fellowInput.avatarImage || fellowInput.avatar || "",
    avatarCrop: normalizeAvatarCrop(fellowInput.avatarCrop),
    bio: fellowInput.description || fellowInput.bio || fellows.find((item) => item.key === key)?.bio || "",
    capabilities: normalizeFellowCapabilities(fellowInput.capabilities || existingFellow?.capabilities)
  });
  const index = fellows.findIndex((item) => item.key === key);
  if (index >= 0) fellows[index] = next;
  else fellows.push(next);
  manifest.fellows = fellows;
  saveFellowManifest(manifest);

  const hadExplicitPersona = Object.prototype.hasOwnProperty.call(fellowInput || {}, "personaText");
  const explicitText = hadExplicitPersona ? String(fellowInput.personaText || "").trim() : "";
  const body = hadExplicitPersona
    ? fellowPersonaBody(name, explicitText || next.bio)
    : fs.existsSync(fellowPersonaPath(key))
      ? readFellowPersona(key, name, next.bio)
      : fellowPersonaBody(name, fellowInput.description || fellowInput.bio || "");
  fs.writeFileSync(path.join(p.fellowDir, `${key}.md`), body);
  fs.writeFileSync(path.join(p.fellowDir, `${key}.fellow.json`), JSON.stringify(fellowMetadata(next), null, 2) + "\n");
  return getRuntimeStatus();
}

function saveFellowEngineConfig(input = {}) {
  initializeRuntime();
  const key = String(input.key || input.fellowKey || "").trim();
  if (!key) throw new Error("Fellow key is required.");
  const manifest = loadFellowManifest();
  const fellows = Array.isArray(manifest.fellows) ? manifest.fellows : [];
  const index = fellows.findIndex((item) => item.key === key);
  if (index < 0) throw new Error("Fellow not found.");
  fellows[index] = normalizeFellow({
    ...fellows[index],
    agentEngine: input.agentEngine || fellows[index].agentEngine || "hermes",
    engineConfig: mergeFellowEngineConfig(fellows[index].engineConfig, input.engineConfig || input.engine_config)
  });
  manifest.fellows = fellows;
  saveFellowManifest(manifest);
  fs.writeFileSync(
    path.join(runtimePaths().fellowDir, `${key}.fellow.json`),
    JSON.stringify(fellowMetadata(fellows[index]), null, 2) + "\n"
  );
  return getRuntimeStatus();
}

function setFellowPinned(input = {}) {
  const key = String(input.key || input.fellowKey || "").trim();
  if (!key) throw new Error("Fellow key is required.");
  const manifest = loadFellowManifest();
  const fellows = Array.isArray(manifest.fellows) ? manifest.fellows : [];
  const index = fellows.findIndex((item) => item.key === key);
  if (index < 0) throw new Error("Fellow not found.");
  const pinned = Boolean(input.pinned);
  fellows[index] = normalizeFellow({
    ...fellows[index],
    pinned,
    pinnedAt: pinned ? new Date().toISOString() : ""
  });
  manifest.fellows = fellows;
  saveFellowManifest(manifest);
  fs.writeFileSync(
    path.join(runtimePaths().fellowDir, `${key}.fellow.json`),
    JSON.stringify(fellowMetadata(fellows[index]), null, 2) + "\n"
  );
  return getRuntimeStatus();
}

function deleteFellow(input = {}) {
  initializeRuntime();
  const key = String(input.key || input.fellowKey || "").trim();
  if (!key) throw new Error("Fellow key is required.");
  if (key === "aimashi") throw new Error("内置 Aimashi 伙伴不能删除。");
  const p = runtimePaths();
  const manifest = loadFellowManifest();
  const fellows = Array.isArray(manifest.fellows) ? manifest.fellows : [];
  const fellow = fellows.find((item) => item.key === key);
  if (!fellow) throw new Error("Fellow not found.");
  manifest.fellows = fellows.filter((item) => item.key !== key);
  if (manifest.default_fellow === key) manifest.default_fellow = manifest.fellows[0]?.key || "aimashi";
  saveFellowManifest(manifest);
  for (const filePath of [
    path.join(p.fellowDir, `${key}.md`),
    path.join(p.fellowDir, `${key}.fellow.json`)
  ]) {
    fs.rmSync(filePath, { force: true });
  }
  const chatStore = loadChatStore();
  delete chatStore.sessions[key];
  if (chatStore.readAt) delete chatStore.readAt[key];
  saveChatStore(chatStore);
  const agentSessions = loadAgentSessionMap();
  for (const sessionKey of Object.keys(agentSessions)) {
    if (sessionKey.split(":")[1] === key) delete agentSessions[sessionKey];
  }
  saveAgentSessionMap(agentSessions);
  try {
    initSchedulerSubsystem();
    const orphaned = tasksStore.orphanByFellow(key);
    if (orphaned > 0) {
      tasksEvents.emit("orphaned", { fellowId: key, count: orphaned });
      scheduler.rescan();
    }
  } catch (error) {
    console.warn("[tasks] orphan-by-fellow failed", error);
  }
  recallFellowPet(key);
  return getRuntimeStatus();
}

ipcMain.handle("fellow:details", (_event, key) => getFellowDetails(key));
ipcMain.handle("fellow:save", (_event, fellow) => saveFellow(fellow));
ipcMain.handle("fellow:engine-save", (_event, payload) => saveFellowEngineConfig(payload));
ipcMain.handle("fellow:pin", (_event, payload) => setFellowPinned(payload));
ipcMain.handle("fellow:delete", (_event, payload) => deleteFellow(payload));
ipcMain.handle("group:create", (_event, payload) => ensureGroupStore().create(payload));
ipcMain.handle("group:list", () => ensureGroupStore().list());
ipcMain.handle("group:get", (_event, id) => ensureGroupStore().get(id));
ipcMain.handle("group:update", (_event, payload) => ensureGroupStore().updateGroup(payload.id, payload.patch));
ipcMain.handle("group:delete", (_event, id) => ensureGroupStore().deleteGroup(id));
ipcMain.handle("group:append-message", (_event, payload) => ensureGroupStore().appendMessage(payload.id, payload.message));
ipcMain.handle("group:list-messages", (_event, id) => ensureGroupStore().listMessages(id));
ipcMain.handle("group:save-context-card", (_event, payload) => { ensureGroupStore().saveContextCard(payload.id, payload.card); return true; });
ipcMain.handle("group:load-prompts", () => {
  const dir = path.join(__dirname, "..", "resources", "conductor", "default-prompts");
  return {
    dispatch: fs.readFileSync(path.join(dir, "dispatch.md"), "utf8"),
    summarize: fs.readFileSync(path.join(dir, "summarize.md"), "utf8"),
    nudge: fs.readFileSync(path.join(dir, "nudge.md"), "utf8"),
    relay: fs.readFileSync(path.join(dir, "relay.md"), "utf8"),
  };
});
ipcMain.handle("persona:save", (_event, persona) => saveFellow(persona));
ipcMain.handle("pet:jobs", () => getPetJobs());
ipcMain.handle("pet:generate", (_event, payload) => startFellowPetGeneration(payload));
ipcMain.handle("pet:place", (_event, key) => placeFellowPet(key));
ipcMain.handle("pet:recall", (_event, key) => recallFellowPet(key));

async function callDaemonTasks(pathSegment, opts = {}) {
  const settings = settingsStore.daemonSettings();
  const baseUrl = controlServerState.baseUrl || `http://${settings.host}:${settings.port}`;
  const response = await fetch(`${baseUrl}${pathSegment}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${daemonToken()}`,
      ...(opts.headers || {})
    }
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`daemon ${response.status}: ${body || response.statusText}`);
  }
  return response.json();
}

ipcMain.handle("tasks:list",   async () => (await callDaemonTasks("/api/tasks")).tasks);
ipcMain.handle("tasks:get",    async (_e, id) => (await callDaemonTasks(`/api/tasks/${id}`)).task);
ipcMain.handle("tasks:create", async (_e, input) => (await callDaemonTasks("/api/tasks", { method: "POST", body: JSON.stringify(input) })).task);
ipcMain.handle("tasks:update", async (_e, id, partial) => (await callDaemonTasks(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(partial) })).task);
ipcMain.handle("tasks:delete", async (_e, id) => callDaemonTasks(`/api/tasks/${id}`, { method: "DELETE" }));
ipcMain.handle("tasks:pause",  async (_e, id) => (await callDaemonTasks(`/api/tasks/${id}/pause`,  { method: "POST" })).task);
ipcMain.handle("tasks:resume", async (_e, id) => (await callDaemonTasks(`/api/tasks/${id}/resume`, { method: "POST" })).task);
ipcMain.handle("tasks:run-now", async (_e, id) => callDaemonTasks(`/api/tasks/${id}/run-now`, { method: "POST" }));

function subscribeDaemonTaskEvents() {
  if (IS_DAEMON_PROCESS) return;
  let reconnectDelay = 1000;

  function connect() {
    const settings = settingsStore.daemonSettings();
    const baseUrl = controlServerState.baseUrl || `http://${settings.host}:${settings.port}`;
    const token = daemonToken();
    let pathname = "/api/tasks/events";
    const urlObj = new URL(baseUrl + pathname);
    const httpLib = urlObj.protocol === "https:" ? require("node:https") : require("node:http");
    const req = httpLib.request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" }
    });
    req.on("response", (res) => {
      if (res.statusCode >= 400) {
        // Treat HTTP errors as connection failures — don't reset backoff
        reconnectDelay = Math.min(reconnectDelay * 2, 15000);
        res.resume();  // drain to allow connection close
        res.on("end", () => setTimeout(connect, reconnectDelay));
        return;
      }
      reconnectDelay = 1000;
      let buf = "";
      res.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const events = buf.split("\n\n");
        buf = events.pop() || "";
        for (const evt of events) {
          const lines = evt.split("\n");
          let type = ""; let data = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) type = line.slice(7).trim();
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (!type) continue;
          try {
            const payload = JSON.parse(data || "null");
            for (const w of BrowserWindow.getAllWindows()) {
              try { w.webContents.send("tasks:event", { type, payload }); } catch { /* window closed */ }
            }
          } catch { /* ignore parse errors */ }
        }
      });
      res.on("end", () => setTimeout(connect, reconnectDelay));
      res.on("error", () => setTimeout(connect, reconnectDelay));
    });
    req.on("error", () => {
      reconnectDelay = Math.min(reconnectDelay * 2, 15000);
      setTimeout(connect, reconnectDelay);
    });
    req.end();
  }
  connect();
}

app.whenReady().then(async () => {
  startupTimer.mark("app:ready");
  if (!IS_DAEMON_PROCESS && !shouldRunDesktopInstance) return;
  if (IS_DAEMON_PROCESS) {
    try {
      app.dock?.hide?.();
    } catch {
      // Dock APIs are macOS-only.
    }
    try {
      await startControlServer();
    } catch (error) {
      controlServerState.starting = false;
      controlServerState.lastError = String(error?.message || error);
      appendDaemonLog(`Daemon start failed: ${controlServerState.lastError}`);
      throw error;
    }
    return;
  }
  const win = createWindow();
  startupTimer.mark("window:created");
  subscribeDaemonTaskEvents();
  startCloudEvents();
  startCloudBridge();
  syncAimashiCloudWorkspace().catch((error) => appendCloudLog(`Cloud workspace sync failed: ${error?.message || error}`));
  if (process.env.AIMASHI_DISABLE_BACKGROUND_STARTUP !== "1") {
    win.webContents.once("did-finish-load", () => {
      setTimeout(() => runtimeLifecycle().scheduleBackgroundStartup(), 2500);
    });
  }
});

app.on("window-all-closed", () => {
  cancelCodexOAuth();
  if (IS_DAEMON_PROCESS) return;
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (IS_DAEMON_PROCESS) return;
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
