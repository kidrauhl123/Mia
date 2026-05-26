const { app, BrowserWindow, ipcMain, screen, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const QRCode = require("qrcode");
const WebSocket = require("ws");
const { IpcChannel } = require("./shared/ipc-channels");
const { MemberKind } = require("./shared/conversation-kinds");
const runtimeResources = require("./runtime-resource-paths");
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
const { createAgentCommandProvider } = require("./main/agent-command-provider.js");
const { createClaudeBridgePluginService } = require("./main/claude-bridge-plugin-service.js");
const { requireFellow } = require("./main/fellow-registry.js");
const { createClaudeCodeChatAdapter } = require("./main/claude-code-chat-adapter.js");
const { createCodexChatAdapter } = require("./main/codex-chat-adapter.js");
const { createHermesChatAdapter } = require("./main/hermes-chat-adapter.js");
const { createRuntimeInitializerService } = require("./main/runtime-initializer-service.js");
const { createRuntimeLifecycleService } = require("./main/runtime-lifecycle-service.js");
const { createStartupTimer } = require("./main/startup-timing.js");
const { createChatAttachments } = require("./main/chat-attachments.js");
const { createChatStore } = require("./main/chat-store.js");
const { createFellowManifest } = require("./main/fellow-manifest.js");
const { createFellowService } = require("./main/fellow-service.js");
const { createRuntimePaths } = require("./main/runtime-paths.js");
const { createSettingsStore } = require("./main/settings-store.js");
const { createSkillsLoader } = require("./main/skills-loader.js");
const { createTasksStore } = require("./main/tasks-store.js");
const { createScheduler } = require("./main/scheduler.js");
const { createFireRunner } = require("./main/scheduler-fire.js");
const { createTasksEventBus } = require("./main/tasks-events.js");
const { createTasksRoutes } = require("./main/tasks-routes.js");
const { createSocialApi } = require("./main/social/social-api.js");
const { registerSocialIpc } = require("./main/social/social-ipc.js");
const {
  createLocalFellowResponder,
  shouldHandleLocalCloudRoomAi
} = require("./main/social/local-fellow-responder.js");
const { createMainGroupConductor } = require("./main/social/group-conductor.js");
const { createMainFellowRoomResponder } = require("./main/social/fellow-room-responder.js");
const { createMainFellowRuntimeDispatcher } = require("./main/social/fellow-runtime-dispatcher.js");
const { createCloudEventsClient } = require("./main/cloud/cloud-events-client.js");
const { createCloudBridgeClient } = require("./main/cloud/cloud-bridge-client.js");
const { createCloudDesktopSyncClient } = require("./main/cloud/desktop-sync-client.js");
const { createRelayClient, relayPairingLink } = require("./main/relay/relay-client.js");
const { createRemoteControlRouter } = require("./main/remote/remote-control-router.js");
const { createModelSettingsService } = require("./main/model-settings-service.js");
const { createChatSessionService } = require("./main/chat-session-service.js");
const { createDaemonControlServer } = require("./main/daemon/control-server.js");
const { createDaemonTasksClient } = require("./main/daemon/tasks-client.js");
const { createProviderConnections } = require("./main/provider-connections.js");
const { createAuthService } = require("./main/auth-service.js");
const { createEngineCatalogService } = require("./main/engine-catalog-service.js");
const { createExternalAgentCommandService } = require("./main/external-agent-command-service.js");
const { createFellowPetService } = require("./main/fellow-pet-service.js");
const { createHermesRunService } = require("./main/hermes-run-service.js");
const { createHermesSlashCommandService } = require("./main/hermes-slash-command-service.js");
const { createLaunchdService } = require("./main/launchd-service.js");
const { createEnginePluginsService } = require("./main/engine-plugins-service.js");
const { createLocalAgentEngineService } = require("./main/local-agent-engine-service.js");
const { createAgentSessionStore } = require("./main/agent-session-store.js");
const { createSchedulerMcpBridge } = require("./main/scheduler-mcp-bridge.js");
const { createSystemHermesService } = require("./main/system-hermes-service.js");
const { createEngineRuntimeConfigService } = require("./main/engine-runtime-config-service.js");
const { createEngineHealthService } = require("./main/engine-health-service.js");
const { createEngineInstallService } = require("./main/engine-install-service.js");
const { registerWindowIpc } = require("./main/ipc/window-ipc.js");
const { registerTasksIpc } = require("./main/ipc/tasks-ipc.js");
// (cloud/desktop-sync helpers removed in Phase 4 cutover — fellow chats
//  now sync via rooms+messages, no need for the workspace-shape mappers.)

app.setName("Mia");
const isolatedUserDataDir = String(process.env.MIA_USER_DATA_DIR || "").trim();
if (isolatedUserDataDir) {
  app.setPath("userData", path.resolve(isolatedUserDataDir));
}
const startupTimer = createStartupTimer({ scope: "startup" });

const MIA_GATEWAY_SERVICE_LABEL = "ai.mia.hermes.gateway";
const MIA_DAEMON_SERVICE_LABEL = "ai.mia.daemon";
const MIA_DAEMON_DEFAULT_PORT = Number(process.env.MIA_DAEMON_PORT || 27861);
const MOBILE_ASSET_VERSION = "mobile-slash-commands-1";
const MIA_CLOUD_DEFAULT_URL = process.env.MIA_CLOUD_URL || "https://aiweb.buytb01.com";
const IS_DAEMON_PROCESS = process.argv.includes("--daemon") || process.env.MIA_DAEMON === "1";
const ALLOW_MULTIPLE_INSTANCES = process.env.MIA_ALLOW_MULTIPLE_INSTANCES === "1";

function localDeviceName() {
  const hostname = String(os.hostname() || "").trim();
  return hostname ? `${hostname} Mia Desktop` : "Mia Desktop";
}

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
  MIA_GATEWAY_SERVICE_LABEL,
  MIA_DAEMON_SERVICE_LABEL,
});
const {
  runtimePaths,
  venvPythonPath,
  bundledPython,
  bundledSitePackages,
  buildPythonPath,
  engineMarkerPath,
} = runtimePathsModule;

let settingsStore = null;
const claudeBridgePluginService = createClaudeBridgePluginService({ runtimePaths });
const enginePluginsService = createEnginePluginsService({ runtimePaths });
const engineInstallService = createEngineInstallService({
  runtimePaths,
  venvPythonPath,
  bundledPython,
  bundledSitePackages,
  buildPythonPath,
  engineMarkerPath,
  readJson,
  spawnSync,
  appendLog: appendEngineLog,
  clearLogs: () => { engineState.logs = []; },
  initializeRuntime,
  stopEngine,
  ensureEnginePlugins: () => enginePluginsService.ensureInstalled(),
  getRuntimeStatus
});
const engineRuntimeConfigService = createEngineRuntimeConfigService({
  runtimePaths,
  readJson,
  randomBytes: (size) => crypto.randomBytes(size),
  defaultModelSettings: () => settingsStore?.defaultModelSettings() || {
    provider: "",
    model: "",
    apiKeyEnv: "",
    apiKey: "",
    baseUrl: "",
    apiMode: ""
  },
  permissionSettings: () => settingsStore?.permissionSettings() || { mode: "ask" },
  effortSettings: () => settingsStore?.effortSettings() || { level: "medium" },
  engineSource: engineInstallService.engineSource,
  externalSkillDirs: () => [],
  // Lazy: schedulerMcpBridge is created later in this module; the thunk is
  // only invoked at writeRuntimeConfig time (runtime), by which point it
  // exists. Lets the Hermes config.yaml carry the mia-scheduler MCP.
  getSchedulerMcpSpec: () => schedulerMcpBridge.getSpec()
});
const {
  apiKey,
  effectiveHermesHome,
  modelSettings,
  readConfiguredPort,
  writeRuntimeConfig
} = engineRuntimeConfigService;
const engineHealthService = createEngineHealthService({
  apiKey,
  fetchImpl: fetch,
  getEngineProcess: () => engineProcess,
  getEngineState: () => engineState,
  readConfiguredPort,
  setEngineState: (next) => { engineState = next; },
  timeoutSignal: (timeoutMs) => AbortSignal.timeout(timeoutMs)
});

const launchdService = createLaunchdService({
  gatewayServiceLabel: MIA_GATEWAY_SERVICE_LABEL,
  daemonServiceLabel: MIA_DAEMON_SERVICE_LABEL,
  runtimePaths,
  appPath: () => app.getAppPath(),
  execPath: () => process.execPath,
  defaultApp: () => Boolean(process.defaultApp),
  enginePython: engineInstallService.enginePython,
  effectiveHermesHome,
  buildPythonPath,
  env: process.env,
  platform: process.platform,
  getuid: () => (typeof process.getuid === "function" ? process.getuid() : null),
  spawnSync,
  appendLog: appendEngineLog
});
const localAgentEngineService = createLocalAgentEngineService({
  homeDir: () => os.homedir(),
  env: process.env,
  spawnSync
});
const systemHermesService = createSystemHermesService({
  runtimePaths,
  readJson,
  resetAgentEngineCache: localAgentEngineService.resetCache
});

settingsStore = createSettingsStore({
  runtimePaths,
  readJson,
  writeRuntimeConfig,
  readConfiguredPort,
  getEngineState: () => engineState,
  MIA_DAEMON_DEFAULT_PORT,
  MIA_CLOUD_DEFAULT_URL,
  normalizeAvatarCrop: (crop) => normalizeAvatarCrop(crop)
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
  normalizeAvatarCrop,
  loadFellowManifest,
  saveFellowManifest,
  fellowPersonaBody,
  fellowMetadata,
  fellowPersonaPath,
  readFellowPersona,
} = fellowManifestModule;

const agentSessionStore = createAgentSessionStore({
  runtimePaths,
  readJson,
  normalizeFellowAgentEngine
});

const chatAttachments = createChatAttachments({
  initializeRuntime,
  runtimePaths,
  getCloudSettings: () => settingsStore.cloudSettings(),
  normalizeCloudUrl: settingsStore.normalizeCloudUrl,
  fetchImpl: fetch,
  timeoutSignal: (timeoutMs) => AbortSignal.timeout(timeoutMs),
  randomUUID: () => crypto.randomUUID(),
  now: () => Date.now()
});
const {
  dataUrlToBuffer,
  sanitizeAttachmentName,
  normalizeAttachments,
  attachmentContext,
  saveChatAttachment,
  readLocalFileAttachment,
  safeFetchFileAttachment
} = chatAttachments;

const fellowPetService = createFellowPetService({
  app,
  BrowserWindow,
  screen,
  dirname: __dirname,
  resourcesPath: process.resourcesPath || "",
  runtimePaths,
  readJson,
  loadFellowManifest,
  dataUrlToBuffer,
  initializeRuntime,
  spawnProcess: spawn,
  randomUUID: () => crypto.randomUUID()
});

const hermesRunService = createHermesRunService({
  normalizeAttachments,
  attachmentContext,
  baseUrl: () => engineState.baseUrl,
  apiKey,
  fetchImpl: fetch,
  randomUUID: () => crypto.randomUUID()
});
const hermesSlashCommandService = createHermesSlashCommandService({
  runtimePaths,
  readJson,
  defaultUserProfile: () => settingsStore.defaultUserProfile(),
  cleanRunSessionId: hermesRunService.cleanRunSessionId,
  enginePython: engineInstallService.enginePython,
  effectiveHermesHome,
  buildPythonPath,
  spawnSync,
  env: process.env
});

const chatStoreModule = createChatStore({
  runtimePaths,
  readJson,
  normalizeAttachments,
});
const {
  defaultChatStore,
  fallbackSessionTitle,
  loadChatStore,
  saveChatStore,
  ensurePersonaSession,
} = chatStoreModule;

const runtimeInitializerService = createRuntimeInitializerService({
  runtimePaths,
  randomBytes: (size) => crypto.randomBytes(size),
  ensureEnginePlugins: () => enginePluginsService.ensureInstalled(),
  writeRuntimeConfig,
  readConfiguredPort,
  defaultModelSettings: () => settingsStore.defaultModelSettings(),
  defaultProviderStore: () => defaultProviderStore(),
  defaultPermissionSettings: () => settingsStore.defaultPermissionSettings(),
  defaultEffortSettings: () => settingsStore.defaultEffortSettings(),
  defaultDaemonSettings: () => settingsStore.defaultDaemonSettings(),
  defaultRelaySettings: () => settingsStore.defaultRelaySettings(),
  defaultUserProfile: () => settingsStore.defaultUserProfile(),
  defaultAppearanceSettings: () => settingsStore.defaultAppearanceSettings(),
  defaultChatStore,
  loadFellowManifest,
  saveFellowManifest,
  fellowPersonaBody,
  fellowMetadata,
  ensureClaudeBridgePlugin: () => claudeBridgePluginService.ensureInstalled(),
  appendEngineLog,
  getRuntimeStatus
});

const skillsLoader = createSkillsLoader({
  runtimePaths,
  readJson,
  officialLibraryManifestPath: fellowPetService.officialLibraryManifestPath,
  resolveOfficialLibraryRoot: fellowPetService.resolveOfficialLibraryRoot,
  getEngineState: () => engineState,
  apiKey,
  appendEngineLog,
  isChildPath,
});
const agentCommandProvider = createAgentCommandProvider({
  appendEngineLog,
  claudeAgentSdk,
  cwd: () => process.cwd(),
  homeDir: () => app.getPath("home"),
  normalizeFellowAgentEngine,
  shellCommandPath: localAgentEngineService.shellCommandPath,
});
const externalAgentCommandService = createExternalAgentCommandService({
  agentCommandProvider,
  cwd: () => process.cwd(),
  homeDir: () => app.getPath("home"),
  normalizeFellowAgentEngine,
  normalizeFellowEngineConfig,
  normalizeEffortLevel: settingsStore.normalizeEffortLevel,
  localAgentEngines: localAgentEngineService.localAgentEngines,
  getAgentSessionId: agentSessionStore.getId,
  setAgentSessionId: agentSessionStore.setId,
  setAgentSessionEntry: agentSessionStore.setEntry,
  ensureClaudeBridgePlugin: () => claudeBridgePluginService.ensureInstalled(),
  loadAgentSessionMap: agentSessionStore.loadMap,
  loadChatStore,
  relaySettings: () => settingsStore.relaySettings()
});
let authService = null;
const providerConnections = createProviderConnections({
  runtimePaths,
  readJson,
  modelSettings,
  codexAuthStatus: () => authService?.status() || { codexLoggedIn: false }
});
const defaultProviderStore = providerConnections.defaultStore;
const normalizeProviderConnection = providerConnections.normalize;
const providerConnectionStore = providerConnections.store;
const saveProviderConnection = providerConnections.save;
const providerConnection = providerConnections.get;
const connectedProviderSummaries = providerConnections.connectedSummaries;
authService = createAuthService({
  runtimePaths,
  readJson,
  fetchImpl: fetch,
  spawnProcess: spawn,
  shellOpenExternal: (url) => shell.openExternal(url),
  initializeRuntime,
  isEngineInstalled: engineInstallService.isInstalled,
  getRuntimeStatus,
  enginePython: engineInstallService.enginePython,
  effectiveHermesHome,
  buildPythonPath,
  applyCodexModelSettings,
  saveProviderConnection,
  restartEngineIfRunning
});
const engineCatalogService = createEngineCatalogService({
  isEngineInstalled: engineInstallService.isInstalled,
  initializeRuntime,
  runtimePaths,
  userHome: () => app.getPath("home"),
  effectiveHermesHome,
  buildPythonPath,
  runPythonScript,
  appendEngineLog,
  timeEngineStepAsync
});
let claudeAgentSdkModule = null;
let codexSdkModule = null;
let remoteControlRouter = null;
let daemonControlServer = null;
let daemonTasksClient = null;
let activeChatAbortController = null;
let relayRuntime = null;
let cloudEventSocketRuntime = null;
let cloudBridgeRuntime = null;
let cloudDesktopSyncRuntime = null;
const pendingCloudLogs = [];
const schedulerMcpBridge = createSchedulerMcpBridge({
  runtimePaths,
  daemonStatus: () => daemonControlServer?.status() || {},
  daemonSettings: () => settingsStore.daemonSettings(),
  daemonToken,
  nodePath: () => localAgentEngineService.shellCommandPath("node"),
  serverScriptPath: () => path.join(__dirname, "main", "scheduler-mcp-server.js"),
  homeDir: () => os.homedir()
});

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function daemonToken() {
  const p = runtimePaths();
  if (!fs.existsSync(p.daemonToken)) {
    fs.mkdirSync(path.dirname(p.daemonToken), { recursive: true });
    fs.writeFileSync(p.daemonToken, `${crypto.randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  }
  return fs.readFileSync(p.daemonToken, "utf8").trim();
}

// (mergeCloudWorkspaceIntoChatStore removed in Phase 4 cutover —
//  the cloud workspace snapshot is no longer the conversation source.
//  Fellow chats now sync via rooms+messages; the merge-into-chat-store
//  path is replaced by the cloud-room cache which never overwrites the
//  local chat-store.)

function broadcastRendererEvent(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try { win.webContents.send(channel, payload); } catch { /* ignore */ }
    }
  }
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
  return Object.fromEntries(Object.entries(localAgentEngineService.processEnvWithCliPath()).filter(([, value]) => typeof value === "string"));
}

let runtimeLifecycleService = null;
function runtimeLifecycle() {
  if (!runtimeLifecycleService) {
    runtimeLifecycleService = createRuntimeLifecycleService({
      appendDaemonLog,
      appendEngineLog,
      getRuntimeStatus,
      initializeRuntimeCore: runtimeInitializerService.initializeRuntimeCore,
      isDaemonProcess: IS_DAEMON_PROCESS,
      refreshSystemHermesAsync: systemHermesService.refresh,
      setDaemonLastError: (message) => daemonControlServer?.setLastError(message),
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

function getDaemonStatus() {
  return daemonControlServer.status();
}

function getDaemonPairingInfo() {
  return daemonControlServer.pairingInfo();
}

async function getObservedDaemonStatus(timeoutMs = 500) {
  return daemonControlServer.observedStatus(timeoutMs);
}

function relayStatus(includeSecret = false) {
  if (relayRuntime) return relayRuntime.status(includeSecret);
  const settings = settingsStore.relaySettings();
  return {
    enabled: settings.enabled,
    connected: false,
    connecting: false,
    url: settings.url,
    deviceId: settings.deviceId,
    mobilePeers: 0,
    pairingLink: relayPairingLink(settings, MOBILE_ASSET_VERSION),
    lastError: "",
    logs: [],
    ...(includeSecret ? { secret: settings.secret } : {})
  };
}

function getRuntimeStatus(created = []) {
  const p = runtimePaths();
  const manifest = loadFellowManifest();
  const codexAuth = authService.status();
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
    engineInstalled: engineInstallService.isInstalled(),
    engineSource: engineInstallService.engineSource(),
    managedVenvExists: fs.existsSync(venvPythonPath()),
    engineRunning: engineState.running,
    engineStarting: engineState.starting,
    engineBaseUrl: engineState.baseUrl,
    enginePort: engineState.port,
    engineManagedBy: engineState.managedBy,
    engineServiceLabel: MIA_GATEWAY_SERVICE_LABEL,
    engineLastError: engineState.lastError,
    engineLogs: engineState.logs.slice(-80),
    localDevice: {
      name: localDeviceName(),
      hostname: String(os.hostname() || "").trim(),
      role: "desktop"
    },
    daemon: getDaemonStatus(),
    relay: relayStatus(false),
    cloud: cloudStatus(false),
    auth: codexAuth,
    user: settingsStore.userProfile(),
    appearance: settingsStore.appearanceSettings(),
    agentEngines: localAgentEngineService.localAgentEngines(),
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
    pets: fellowPetService.statusesForFellows(fellows),
    petJobs: fellowPetService.jobs()
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

function isChildPath(parentPath, targetPath) {
  const parent = path.resolve(parentPath);
  const target = path.resolve(targetPath);
  const relative = path.relative(parent, target);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}


function appendEngineLog(line) {
  const redacted = String(line)
    .replace(/(API_SERVER_KEY=)[^\s]+/g, "$1[REDACTED]")
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/(OPENAI_API_KEY|ANTHROPIC_API_KEY|XAI_API_KEY|DEEPSEEK_API_KEY|OPENROUTER_API_KEY)=([^\s]+)/g, "$1=[REDACTED]");
  engineState.logs.push(redacted);
  if (engineState.logs.length > 200) engineState.logs = engineState.logs.slice(-200);
}

function runPythonScript(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(engineInstallService.enginePython(), args, {
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

function appendDaemonLog(line) {
  daemonControlServer.appendLog(line);
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
  const key = String(fellowKey || manifest.default_fellow || fellows[0]?.key || "mia").trim();
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
    webContents: tracedEventSink,
    background: Boolean(body?.background)
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
  // Persist by RELOADING the store after the await and appending only the two new
  // messages to the target session. The pre-await `store` snapshot is stale — any
  // writes that landed during `await sendChat` (foreground chat, another task) are
  // on disk now, and overwriting with the snapshot would drop them. Reload→append→
  // save is fully synchronous, so within this (daemon) process it is atomic; the
  // foreground app routes its writes through the daemon too, so there is a single
  // writer. If the session was created fresh this turn it isn't on disk yet, so
  // recreate it in the reloaded store rather than losing the messages.
  const fresh = loadChatStore();
  if (!fresh.sessions[fellow.key]) fresh.sessions[fellow.key] = [];
  let target = fresh.sessions[fellow.key].find((item) => item.id === session.id);
  if (!target) {
    target = {
      id: session.id,
      personaKey: fellow.key,
      title: session.title || "新对话",
      titleGenerated: Boolean(session.titleGenerated),
      createdAt: session.createdAt || now,
      updatedAt: now,
      messages: []
    };
    fresh.sessions[fellow.key].unshift(target);
  }
  target.messages = [
    ...(Array.isArray(target.messages) ? target.messages : []),
    savedUser,
    savedAssistant
  ];
  target.updatedAt = new Date().toISOString();
  if (!target.titleGenerated) {
    target.title = fallbackSessionTitle(target.messages);
  }
  saveChatStore(fresh);
  notifyChatSessionsChanged();
  return { fellow, session: target, response, userMessageId, assistantMessageId };
}

let tasksStore = null;
let tasksEvents = null;
let scheduler = null;
let tasksRoutes = null;

// Broadcast that the chat store changed (e.g. a task fire appended its reply) so
// the foreground app reloads it. Rides the task-event bus and its SSE stream out
// to the desktop tasks-client and renderer, the same channel task events use.
function notifyChatSessionsChanged(payload = {}) {
  try { if (tasksEvents) tasksEvents.emit("sessions_changed", payload); } catch { /* bus unavailable */ }
}

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

async function startDaemonService() {
  if (!IS_DAEMON_PROCESS && process.env.MIA_DISABLE_BACKGROUND_STARTUP === "1") {
    return { ...getDaemonStatus(), running: false, disabled: true };
  }
  initializeRuntime();
  const settings = settingsStore.daemonSettings();
  if (IS_DAEMON_PROCESS) return daemonControlServer.start(settings);
  const expectedRuntimeHome = runtimePaths().home;
  const existing = await daemonControlServer.ping(settings, 500, { expectedRuntimeHome });
  if (existing.ok) return { ...getDaemonStatus(), running: true, baseUrl: existing.baseUrl };
  if (process.platform === "darwin") {
    launchdService.startDaemon();
    for (let i = 0; i < 20; i += 1) {
      const ping = await daemonControlServer.ping(settings, 500, { expectedRuntimeHome });
      if (ping.ok) return { ...getDaemonStatus(), running: true, baseUrl: ping.baseUrl };
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error("Timed out waiting for Mia daemon LaunchAgent.");
  }
  return daemonControlServer.start(settings);
}

function stopDaemonService() {
  if (process.platform === "darwin" && !IS_DAEMON_PROCESS) {
    launchdService.stopDaemon();
  }
  return daemonControlServer.stop();
}

function appendCloudLog(line) {
  if (cloudBridgeRuntime) {
    cloudBridgeRuntime.appendLog(line);
    return;
  }
  pendingCloudLogs.push(String(line || ""));
  if (pendingCloudLogs.length > 200) pendingCloudLogs.splice(0, pendingCloudLogs.length - 200);
}

function cloudEventsStatus() {
  const settings = settingsStore?.cloudSettings?.() || {};
  const fallback = {
    enabled: Boolean(settings.enabled && settings.token),
    connected: false,
    connecting: false,
    lastError: "",
    lastEventSeq: Number(settings.lastEventSeq) || 0
  };
  return cloudEventSocketRuntime?.status?.() || fallback;
}

function cloudStatus(includeToken = false) {
  if (cloudBridgeRuntime) {
    return {
      ...cloudBridgeRuntime.status(includeToken),
      events: cloudEventsStatus()
    };
  }
  const settings = settingsStore.cloudSettings();
  return {
    enabled: Boolean(settings.enabled && settings.token),
    connected: false,
    connecting: false,
    url: settings.url,
    user: settings.user,
    deviceId: "",
    lastError: "",
    logs: pendingCloudLogs.slice(-80),
    events: cloudEventsStatus(),
    ...(includeToken ? { token: settings.token } : {})
  };
}

function cloudDesktopSync() {
  if (!cloudDesktopSyncRuntime) throw new Error("Cloud desktop sync runtime is not initialized.");
  return cloudDesktopSyncRuntime;
}

function pushFellowToCloud(fellow) {
  return cloudDesktopSync().pushFellow(fellow);
}

function deleteFellowFromCloud(fellowKey) {
  return cloudDesktopSync().deleteFellow(fellowKey);
}

function syncMiaCloudWorkspace() {
  return cloudDesktopSync().syncWorkspace();
}

function loginMiaCloud(payload = {}) {
  return cloudDesktopSync().login(payload);
}

function logoutMiaCloud() {
  return cloudDesktopSync().logout();
}

function cloudSettingsGet() {
  return cloudDesktopSync().getUserSettings();
}

function cloudSettingsPut(settings = {}) {
  return cloudDesktopSync().putUserSettings(settings);
}

function cloudWebSocketUrl(pathname, settings = settingsStore.cloudSettings()) {
  const url = new URL(settings.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = pathname;
  url.search = "";
  return url;
}

function cloudWebSocketProtocols(settings = settingsStore.cloudSettings()) {
  return [`mia-token.${settings.token}`];
}

function cloudEventsUrl(settings = settingsStore.cloudSettings()) {
  const url = cloudWebSocketUrl("/api/events", settings);
  // Tell the server where we left off so it can replay any persisted
  // events we missed while disconnected (Phase 1.C). 0 == replay from
  // the start (login / fresh install).
  url.searchParams.set("since_seq", String(Number(settings.lastEventSeq) || 0));
  return url.toString();
}

function cloudBridgeUrl(settings = settingsStore.cloudSettings()) {
  const url = cloudWebSocketUrl("/api/bridge", settings);
  url.searchParams.set("deviceName", localDeviceName());
  url.searchParams.set("engine", "codex");
  url.searchParams.set("capabilities", JSON.stringify({
    chat: true,
    attachments: true,
    generatedImages: true,
    cancellation: true,
    streaming: true,
    engines: ["codex"],
    app: "Mia Desktop",
    appVersion: app.getVersion(),
    hostname: os.hostname()
  }));
  return url.toString();
}

function startCloudEvents() {
  return cloudEventSocketRuntime ? cloudEventSocketRuntime.start() : cloudStatus(false);
}

function stopCloudEvents() {
  return cloudEventSocketRuntime ? cloudEventSocketRuntime.stop() : cloudStatus(false);
}

function stopCloudBridge() {
  return cloudBridgeRuntime ? cloudBridgeRuntime.stop() : cloudStatus(false);
}

function startCloudBridge() {
  return cloudBridgeRuntime ? cloudBridgeRuntime.start() : cloudStatus(false);
}

function stopRelayClient() {
  return relayRuntime ? relayRuntime.stop() : relayStatus(true);
}

async function startRelayClient() {
  return relayRuntime ? relayRuntime.start() : relayStatus(true);
}

async function startEngine() {
  initializeRuntime();
  const p = runtimePaths();
  if (!engineInstallService.isInstalled()) {
    throw new Error("Hermes engine is not installed in Mia runtime.");
  }
  if (engineProcess && engineState.running) return getRuntimeStatus();
  enginePluginsService.ensureInstalled();
  if (await engineHealthService.adoptRunningEngine()) return getRuntimeStatus();

  const port = await engineHealthService.choosePort();
  if (!port) throw new Error("No available local port for Mia Hermes API.");

  writeRuntimeConfig(port);
  const settings = modelSettings();
  const dotenv = systemHermesService.loadDotenv();
  const env = {
    ...process.env,
    ...dotenv,
    HERMES_HOME: effectiveHermesHome(),
    MIA_HOME: p.home,
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

  const source = engineInstallService.engineSource();
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
    launchdService.startGateway();
    const ok = await engineHealthService.waitForHealth(engineState.baseUrl, 45000, false);
    engineState.starting = false;
    engineState.running = ok;
    if (!ok) {
      engineState.lastError = "Timed out waiting for Mia Hermes launchd service.";
      throw new Error(engineState.lastError);
    }
    appendEngineLog(`Mia Hermes service running at ${engineState.baseUrl}`);
    return getRuntimeStatus();
  }

  engineProcess = spawn(engineInstallService.enginePython(), launchdService.gatewayProgramArguments().slice(1), {
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

  const ok = await engineHealthService.waitForHealth(engineState.baseUrl, 45000, true);
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
  launchdService.stopGateway();
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
  localAgentEngineService.resetCache();
  appendEngineLog("Standalone Hermes copy uninstalled.");
  return getRuntimeStatus();
}

function writeModelSettings(next) {
  const p = runtimePaths();
  fs.writeFileSync(p.modelSettings, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  writeRuntimeConfig(engineState.port || 8642);
  // NOTE: mia never writes back to user's ~/.hermes/config.yaml. The user's
  // hermes setup stays read-only; mia's model choice only affects mia's
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

async function restartEngineIfRunning() {
  const shouldRestart = Boolean(engineProcess || engineState.running || engineState.starting);
  if (!shouldRestart) return getRuntimeStatus();
  stopEngine();
  return startEngine();
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

// Group-context plumbing carried over from the local-group era. Cloud group
// rooms don't currently set group.contextBlock — the dep is wired through
// the adapters as a no-op so existing call sites stay valid until/unless
// cloud-side conductor needs a different injection shape.
function _noopGroupHeader() { return ""; }
function _passthroughGroupContext(userMessage) { return userMessage; }

function createActiveHermesChatAdapter() {
  return createHermesChatAdapter({
    apiKey,
    baseUrl: () => engineState.baseUrl,
    buildGroupHeader: _noopGroupHeader,
    buildRunPayload: hermesRunService.buildRunPayload,
    normalizeError: hermesRunService.normalizeError,
    readRunEventStream: hermesRunService.readRunEventStream,
    responseModel: adapterForEngine("hermes").responseModel,
    writeSchedulerMcpContext: schedulerMcpBridge.writeContext,
    appendEngineLog
  });
}

function createActiveClaudeCodeChatAdapter() {
  return createClaudeCodeChatAdapter({
    appendEngineLog,
    chatCompletionResponse,
    claudeAgentSdk,
    ensureClaudeBridgePlugin: () => claudeBridgePluginService.ensureInstalled(),
    expandLeadingSkillCommand: skillsLoader.expandLeadingSkillCommand,
    getAgentSessionEntry: agentSessionStore.getEntry,
    getSchedulerMcpSpec: schedulerMcpBridge.getSpec,
    injectGroupContextForSdk: _passthroughGroupContext,
    lastUserPrompt: hermesRunService.lastUserPrompt,
    normalizeEffortLevel: settingsStore.normalizeEffortLevel,
    processEnvStrings,
    readFellowPersona,
    setAgentSessionEntry: agentSessionStore.setEntry,
    shellCommandPath: localAgentEngineService.shellCommandPath,
    writeSchedulerMcpContext: schedulerMcpBridge.writeContext
  });
}

function createActiveCodexChatAdapter() {
  return createCodexChatAdapter({
    chatCompletionResponse,
    codexSdk,
    ensureCodexHome: schedulerMcpBridge.ensureCodexHome,
    expandLeadingSkillCommand: skillsLoader.expandLeadingSkillCommand,
    getAgentSessionId: agentSessionStore.getId,
    injectGroupContextForSdk: _passthroughGroupContext,
    lastUserPrompt: hermesRunService.lastUserPrompt,
    normalizeEffortLevel: settingsStore.normalizeEffortLevel,
    processEnvStrings,
    readFellowPersona,
    setAgentSessionId: agentSessionStore.setId,
    shellCommandPath: localAgentEngineService.shellCommandPath,
    writeSchedulerMcpContext: schedulerMcpBridge.writeContext
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
    runExternalSlashCommand: (input) => externalAgentCommandService.runSlashCommand(input),
    runHermesSlashCommand: hermesSlashCommandService.run,
    sendClaudeCodeChat: claudeAdapter.sendChat,
    sendCodexChat: codexAdapter.sendChat,
    sendHermesChat: hermesAdapter.sendChat
  });
}

function normalizeTurnRuntimeConfig(runtimeConfig = null) {
  if (!runtimeConfig || typeof runtimeConfig !== "object") return {};
  const config = {};
  const model = String(runtimeConfig.model || "").trim();
  const effortLevel = String(runtimeConfig.effortLevel || "").trim();
  const permissionMode = String(runtimeConfig.permissionMode || "").trim();
  if (model) config.model = model;
  if (effortLevel) config.effortLevel = effortLevel;
  if (permissionMode) config.permissionMode = permissionMode;
  return config;
}

function fellowWithRuntimeConfig(fellow, runtimeConfig = {}) {
  if (!runtimeConfig || !Object.keys(runtimeConfig).length) return fellow;
  return {
    ...fellow,
    engineConfig: {
      ...(fellow.engineConfig || fellow.engine_config || {}),
      ...runtimeConfig
    }
  };
}

async function sendChat({ fellowKey, personaKey, sessionId, messages, group, webContents, utility = false, background = false, allowSlashCommands = true, runtimeConfig = null }) {
  utility = Boolean(utility);
  let abortController;
  if (group || utility || background) {
    // Group dispatches run in parallel; each gets its own controller.
    // Utility calls also skip the 1v1 "single active chat" semantics.
    // Background runs (scheduled tasks) must not share the interactive
    // single-flight controller — otherwise any foreground/web chat (or an
    // overlapping task) aborts the task mid-generation ("生成已停止").
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
    const turnRuntimeConfig = normalizeTurnRuntimeConfig(runtimeConfig);
    const fellowForTurn = fellowWithRuntimeConfig(fellow, turnRuntimeConfig);
    const chatEngine = resolveChatEngineAdapter(fellowForTurn);
    const agentEngine = chatEngine.id;
    const shouldNotifyPet = !utility && !String(sessionId || "").startsWith("title:");
    const completeWithPetMessage = (response) => {
      if (shouldNotifyPet) fellowPetService.notifyMessage(fellowForTurn.key, responseMessageContent(response));
      return response;
    };
    if (emit) {
      emit("session_started", { fellowKey: fellowForTurn.key, engine: agentEngine });
    }
    const slashText = allowSlashCommands ? hermesRunService.slashCommandText(messages) : "";
    const response = await sendWithChatEngineAdapter(createActiveChatEngineAdapters(), {
      chatEngine,
      fellow: fellowForTurn,
      sessionId,
      messages,
      group,
      signal,
      abortController,
      emit,
      utility,
      slashText,
      runtimeConfig: turnRuntimeConfig
    });
    return completeWithPetMessage(response);
  } catch (error) {
    if (signal.aborted) {
      if (emit) emit("complete", { finishReason: "cancelled", aborted: true });
      const stopped = new Error("生成已停止");
      stopped.code = "MIA_STOPPED";
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

function createWindow() {
  const win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 420,
    minHeight: 560,
    title: "Mia",
    titleBarStyle: "hidden",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  if (process.platform === "darwin" && typeof win.setWindowButtonVisibility === "function") {
    win.setWindowButtonVisibility(false);
  }
  const sendWindowEvent = (channel, payload) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  };
  win.on("focus", () => sendWindowEvent(IpcChannel.WindowFocusState, true));
  win.on("blur", () => sendWindowEvent(IpcChannel.WindowFocusState, false));
  win.on("enter-full-screen", () => sendWindowEvent(IpcChannel.WindowFullscreen, true));
  win.on("leave-full-screen", () => sendWindowEvent(IpcChannel.WindowFullscreen, false));
  win.webContents.once("did-finish-load", () => startupTimer.mark("renderer:did-finish-load"));
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  startupTimer.mark("window:load-file");
  return win;
}

const modelSettingsService = createModelSettingsService({
  modelSettings,
  providerConnection,
  saveProviderConnection,
  writeModelSettings,
  restartEngineIfRunning,
  getRuntimeStatus
});

const chatSessionService = createChatSessionService({
  initializeRuntime,
  chatStore: chatStoreModule,
  randomUUID: () => crypto.randomUUID(),
  sendChat
});

const fellowService = createFellowService({
  initializeRuntime,
  runtimePaths,
  fellowManifest: fellowManifestModule,
  loadChatStore,
  saveChatStore,
  loadAgentSessionMap: agentSessionStore.loadMap,
  saveAgentSessionMap: agentSessionStore.saveMap,
  orphanTasksByFellow: (key) => {
    initSchedulerSubsystem();
    return tasksStore.orphanByFellow(key);
  },
  emitTaskEvent: (event, payload) => tasksEvents.emit(event, payload),
  rescanScheduler: () => scheduler.rescan(),
  recallFellowPet: (key) => fellowPetService.recall(key),
  pushFellowToCloud,
  deleteFellowFromCloud,
  appendCloudLog,
  getRuntimeStatus,
  petStatusForFellow: (key) => fellowPetService.statusForFellow(key)
});

remoteControlRouter = createRemoteControlRouter({
  isDaemonProcess: IS_DAEMON_PROCESS,
  getRuntimeStatus,
  loadFellowManifest,
  loadChatSessions: () => chatSessionService.loadChatSessions(),
  loadHermesModelCatalog: () => engineCatalogService.loadHermesModelCatalog(),
  loadCodexModels: () => engineCatalogService.loadCodexModels(),
  loadEngineCapabilities: () => engineCatalogService.loadEngineCapabilities(),
  loadHermesSlashCommands: () => engineCatalogService.loadHermesSlashCommands(),
  loadExternalAgentCommands: (body) => externalAgentCommandService.loadCommands(body),
  newChatSession: (body) => chatSessionService.newChatSession(body),
  saveChatSession: (body) => chatSessionService.saveChatSession(body),
  saveChatReadState: (body) => chatSessionService.saveChatReadState(body),
  renameChatSession: (body) => chatSessionService.renameChatSession(body),
  saveChatAttachment,
  readLocalFileAttachment,
  executeExternalAgentCommand: (body) => externalAgentCommandService.executeCommand(body),
  saveFellowEngineConfig: (body) => fellowService.saveFellowEngineConfig(body),
  saveModelSelection: (settings) => modelSettingsService.saveModelSelection(settings),
  writeEffortSettings: (body) => settingsStore.writeEffortSettings(body),
  writePermissionSettings: (body) => settingsStore.writePermissionSettings(body),
  stopChat,
  runRemoteChatRequest
});

relayRuntime = createRelayClient({
  WebSocketImpl: WebSocket,
  getSettings: () => settingsStore.relaySettings(),
  mobileAssetVersion: MOBILE_ASSET_VERSION,
  daemonToken,
  initializeRuntime,
  hostname: () => os.hostname() || "Mia Desktop",
  randomUUID: () => crypto.randomUUID(),
  remoteRouter: remoteControlRouter
});

daemonControlServer = createDaemonControlServer({
  isDaemonProcess: IS_DAEMON_PROCESS,
  serviceLabel: MIA_DAEMON_SERVICE_LABEL,
  dirname: __dirname,
  daemonToken,
  initializeRuntime,
  choosePort: engineHealthService.choosePort,
  getDaemonSettings: () => settingsStore.daemonSettings(),
  writeDaemonSettings: (settings) => settingsStore.writeDaemonSettings(settings),
  normalizeDaemonHost: (host) => settingsStore.normalizeDaemonHost(host),
  normalizeDaemonPort: (port) => settingsStore.normalizeDaemonPort(port),
  runtimePaths,
  getRelaySettings: () => settingsStore.relaySettings(),
  writeRelaySettings: (settings) => settingsStore.writeRelaySettings(settings),
  relayStatus,
  startRelayClient,
  stopRelayClient,
  recordRelayError: (error, label) => relayRuntime?.recordError(error, label),
  remoteRouter: () => remoteControlRouter,
  initSchedulerSubsystem,
  tasksRoutes: () => tasksRoutes,
  fetchImpl: fetch,
  timeoutSignal: (timeoutMs) => AbortSignal.timeout(timeoutMs)
});

daemonTasksClient = createDaemonTasksClient({
  isDaemonProcess: IS_DAEMON_PROCESS,
  getDaemonSettings: () => settingsStore.daemonSettings(),
  getDaemonStatus,
  daemonToken,
  fetchImpl: fetch,
  sendTaskEvent: (payload) => {
    for (const window of BrowserWindow.getAllWindows()) {
      try {
        window.webContents.send(IpcChannel.TasksEvent, payload);
      } catch {
        // Window closed during task-event broadcast.
      }
    }
  }
});

registerWindowIpc({ ipcMain, startupTimer, runtimeLifecycle });

ipcMain.handle(IpcChannel.RuntimeInitialize, async () => {
  const status = initializeRuntime();
  status.daemon = await getObservedDaemonStatus(350);
  if (!IS_DAEMON_PROCESS) {
    status.relay = { ...status.relay, ...(await daemonControlServer.fetchRelayStatus().catch(() => null) || {}) };
  }
  return status;
});
ipcMain.handle(IpcChannel.RuntimeStatus, async () => {
  const status = getRuntimeStatus();
  status.daemon = await getObservedDaemonStatus(350);
  if (!IS_DAEMON_PROCESS) {
    status.relay = { ...status.relay, ...(await daemonControlServer.fetchRelayStatus().catch(() => null) || {}) };
  }
  return status;
});
ipcMain.handle(IpcChannel.DaemonStatus, async () => {
  return getObservedDaemonStatus(500);
});
ipcMain.handle(IpcChannel.DaemonPairing, async () => {
  const settings = settingsStore.daemonSettings();
  const ping = await daemonControlServer.ping(settings, 500);
  const current = getDaemonStatus();
  return { ...getDaemonPairingInfo(), running: current.running || ping.ok, baseUrl: ping.baseUrl || current.baseUrl };
});
ipcMain.handle(IpcChannel.DaemonStart, () => startDaemonService());
ipcMain.handle(IpcChannel.DaemonStop, () => stopDaemonService());
ipcMain.handle(IpcChannel.DaemonSettingsSave, (_event, settings) => {
  settingsStore.writeDaemonSettings(settings);
  return getDaemonStatus();
});
ipcMain.handle(IpcChannel.UtilQrSvg, (_event, text) => {
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
ipcMain.handle(IpcChannel.UtilOpenExternal, async (_event, url) => {
  let parsed;
  try {
    parsed = new URL(String(url || "").trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  await shell.openExternal(parsed.href);
  return true;
});
ipcMain.handle(IpcChannel.RelayStatus, async () => {
  if (!IS_DAEMON_PROCESS) {
    const daemonRelay = await daemonControlServer.fetchRelayStatus().catch(() => null);
    if (daemonRelay) return { ...relayStatus(true), ...daemonRelay };
  }
  return relayStatus(true);
});
ipcMain.handle(IpcChannel.RelayStart, async () => {
  settingsStore.writeRelaySettings({ enabled: true });
  if (!IS_DAEMON_PROCESS) {
    const daemonRelay = await daemonControlServer.notifyRelay("start");
    if (daemonRelay) return { ...relayStatus(true), ...daemonRelay };
  }
  return startRelayClient();
});
ipcMain.handle(IpcChannel.RelayStop, () => {
  settingsStore.writeRelaySettings({ enabled: false });
  if (!IS_DAEMON_PROCESS) {
    daemonControlServer.notifyRelay("stop").catch(() => {});
  }
  return stopRelayClient();
});
ipcMain.handle(IpcChannel.RelaySettingsSave, async (_event, settings) => {
  const next = settingsStore.writeRelaySettings(settings);
  if (!IS_DAEMON_PROCESS) {
    const daemonRelay = await daemonControlServer.notifyRelay(next.enabled ? "start" : "stop", next);
    if (daemonRelay) return { ...relayStatus(true), ...daemonRelay };
  }
  if (next.enabled) return startRelayClient();
  return stopRelayClient();
});
ipcMain.handle(IpcChannel.CloudStatus, () => cloudStatus(false));
ipcMain.handle(IpcChannel.CloudLogin, async (_event, payload) => {
  await loginMiaCloud(payload || {});
  return getRuntimeStatus();
});
ipcMain.handle(IpcChannel.CloudSync, async () => {
  await syncMiaCloudWorkspace();
  return getRuntimeStatus();
});
// Phase 3: cross-device settings (pin / read marks / appearance). Renderer
// asks main for current bag; mutations PUT to /api/me/settings whose
// broadcast comes back via the WS event handler and is re-broadcast to
// the renderer.
ipcMain.handle(IpcChannel.CloudSettingsGet, async () => {
  try {
    return await cloudSettingsGet();
  } catch (error) {
    appendCloudLog(`Cloud settings get failed: ${error?.message || error}`);
    return { pins: [], readMarks: {}, appearance: {} };
  }
});
ipcMain.handle(IpcChannel.CloudSettingsPut, async (_event, settings) => {
  try {
    return await cloudSettingsPut(settings || {});
  } catch (error) {
    appendCloudLog(`Cloud settings put failed: ${error?.message || error}`);
    throw error;
  }
});
ipcMain.handle(IpcChannel.CloudLogout, async () => {
  await logoutMiaCloud();
  return getRuntimeStatus();
});
const socialApi = createSocialApi({
  getSettings: () => settingsStore.cloudSettings(),
  normalizeUrl: settingsStore.normalizeCloudUrl
});
cloudDesktopSyncRuntime = createCloudDesktopSyncClient({
  getCloudSettings: () => settingsStore.cloudSettings(),
  writeCloudSettings: (patch) => settingsStore.writeCloudSettings(patch),
  normalizeCloudUrl: settingsStore.normalizeCloudUrl,
  cloudStatus: (includeToken) => cloudStatus(includeToken),
  appendLog: (line) => appendCloudLog(line),
  fetchImpl: fetch,
  timeoutSignal: (timeoutMs) => AbortSignal.timeout(timeoutMs),
  loadFellowManifest,
  fellowPersonaPath,
  fileExists: (filePath) => fs.existsSync(filePath),
  readFellowPersona,
  runtimePaths,
  readJson,
  loadChatStore,
  startCloudEvents,
  startCloudBridge,
  stopCloudEvents,
  stopCloudBridge,
  now: () => Date.now()
});
cloudBridgeRuntime = createCloudBridgeClient({
  WebSocketImpl: WebSocket,
  getSettings: () => settingsStore.cloudSettings(),
  isDaemonProcess: IS_DAEMON_PROCESS,
  isDaemonEnabled: () => settingsStore.daemonSettings().enabled,
  cloudBridgeUrl,
  cloudWebSocketProtocols,
  createActiveCodexChatAdapter,
  randomUUID: () => crypto.randomUUID()
});
for (const line of pendingCloudLogs.splice(0)) cloudBridgeRuntime.appendLog(line);
const localFellowResponder = createLocalFellowResponder({
  sendChat,
  postRoomMessageAsFellow: (roomId, body) => socialApi.postRoomMessageAsFellow(roomId, body),
  log: (line) => appendCloudLog(line)
});
function shouldHandleCloudRoomAi() {
  return shouldHandleLocalCloudRoomAi({
    isDaemon: IS_DAEMON_PROCESS,
    daemonEnabled: settingsStore.daemonSettings().enabled
  });
}
const mainGroupConductor = createMainGroupConductor({
  getCurrentUserId: () => settingsStore.cloudSettings().user?.id || "",
  listFellows: () => loadFellowManifest().fellows || [],
  loadPrompts: loadConductorPrompts,
  getRoomDetails: (roomId) => socialApi.getRoom(roomId),
  listRecentMessages: async (roomId, sinceSeq, limit) => {
    const data = await socialApi.listRoomMessages(roomId, sinceSeq, limit);
    return data?.messages || [];
  },
  sendChatStateless,
  responder: localFellowResponder,
  log: (line) => appendCloudLog(line)
});
const mainFellowRoomResponder = createMainFellowRoomResponder({
  getCurrentUserId: () => settingsStore.cloudSettings().user?.id || "",
  getRoomDetails: (roomId) => socialApi.getRoom(roomId),
  listRecentMessages: async (roomId, sinceSeq, limit) => {
    const data = await socialApi.listRoomMessages(roomId, sinceSeq, limit);
    return data?.messages || [];
  },
  getFellowRuntime: async (fellowId, runtimeKind) => {
    const data = await socialApi.getFellowRuntime(fellowId, runtimeKind);
    return data?.binding || null;
  },
  responder: localFellowResponder,
  log: (line) => appendCloudLog(line)
});
const mainFellowRuntimeDispatcher = createMainFellowRuntimeDispatcher({
  shouldHandle: shouldHandleCloudRoomAi,
  listFellows: () => loadFellowManifest().fellows || [],
  localFellowResponder,
  mainGroupConductor,
  mainFellowRoomResponder,
  log: (line) => appendCloudLog(line)
});
cloudEventSocketRuntime = createCloudEventsClient({
  WebSocketImpl: WebSocket,
  getSettings: () => settingsStore.cloudSettings(),
  writeCloudSettings: (patch) => settingsStore.writeCloudSettings(patch),
  cloudStatus: () => cloudStatus(false),
  cloudEventsUrl,
  cloudWebSocketProtocols,
  broadcastRendererEvent,
  cloudEventChannel: IpcChannel.CloudEvent,
  appendCloudLog,
  fellowRuntimeDispatcher: mainFellowRuntimeDispatcher
});
registerSocialIpc({ ipcMain, socialApi });
ipcMain.handle(IpcChannel.SocialMyUsername, () => {
  // Wrap in the same {ok, data} envelope safeCall uses for the other
  // social IPCs so the renderer's destructure path is consistent and
  // `meRes.ok` actually flips true when a session is present.
  try {
    const settings = settingsStore.cloudSettings();
    const user = settings && settings.user;
    return {
      ok: true,
      data: { username: user?.username || user?.account || "", id: user?.id || "" }
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});
ipcMain.handle(IpcChannel.EngineInstall, () => engineInstallService.install());
ipcMain.handle(IpcChannel.EngineStart, () => startEngine());
ipcMain.handle(IpcChannel.EngineStop, () => stopEngine());
ipcMain.handle(IpcChannel.EngineUninstallStandalone, () => uninstallStandaloneEngine());
ipcMain.handle(IpcChannel.AuthCodexStart, () => authService.startCodexOAuth());
ipcMain.handle(IpcChannel.AuthCodexCancel, () => authService.cancelCodexOAuth());
ipcMain.handle(IpcChannel.AuthProviderStart, (_event, provider) => authService.startProviderOAuth(provider));
ipcMain.handle(IpcChannel.AuthProviderCancel, () => authService.cancelProviderOAuth());
ipcMain.handle(IpcChannel.ChatSend, (event, payload) => sendChat({ ...payload, webContents: event.sender }));
ipcMain.handle(IpcChannel.ChatSendStateless, (_event, payload) => sendChatStateless(payload));
ipcMain.handle(IpcChannel.ChatStop, () => stopChat());
ipcMain.handle(IpcChannel.ChatAttachmentSave, (_event, payload) => saveChatAttachment(payload));
ipcMain.handle(IpcChannel.ChatFileFetch, (_event, payload) => safeFetchFileAttachment(payload));
ipcMain.handle(IpcChannel.CommandsSlash, () => engineCatalogService.loadHermesSlashCommands());
ipcMain.handle(IpcChannel.CommandsAgentList, async (_event, payload) => externalAgentCommandService.loadCommands(payload));
ipcMain.handle(IpcChannel.CommandsAgentExecute, (_event, payload) => externalAgentCommandService.executeCommand(payload));
// The daemon is the single writer of the chat store: whenever it's enabled, the
// foreground app routes its chat-store WRITES through the daemon's control server
// so the daemon's task fires and the user's chats never clobber each other across
// processes. Reads stay local — they hit the same on-disk file the daemon wrote.
// If the daemon is enabled but unreachable, fall back to a local write: an absent
// daemon isn't writing, so there's no competing writer to race.
async function routeChatWrite(localFn, daemonPath, body) {
  if (IS_DAEMON_PROCESS || !settingsStore.daemonSettings().enabled) return localFn();
  try {
    return await daemonTasksClient.call(daemonPath, { method: "POST", body: JSON.stringify(body || {}) });
  } catch (error) {
    // Fall back to a LOCAL write only when the daemon is genuinely down — then it
    // isn't writing, so there's no competing writer. If the daemon is alive and
    // the call merely blipped, a local write would re-introduce the cross-process
    // race, so surface the error instead and let the caller retry on the next save.
    let daemonRunning = true;
    try { daemonRunning = Boolean((await getObservedDaemonStatus(400))?.running); } catch { daemonRunning = false; }
    if (daemonRunning) throw error;
    appendDaemonLog(`Chat write skipped daemon (down) at ${daemonPath}, writing locally: ${error?.message || error}`);
    return localFn();
  }
}
ipcMain.handle(IpcChannel.ChatSessionsLoad, () => chatSessionService.loadChatSessions());
ipcMain.handle(IpcChannel.ChatSessionSave, (_event, payload) =>
  routeChatWrite(() => chatSessionService.saveChatSession(payload), "/api/chat/session/save", payload));
ipcMain.handle(IpcChannel.ChatReadStateSave, (_event, payload) =>
  routeChatWrite(() => chatSessionService.saveChatReadState(payload), "/api/chat/read-state/save", payload));
ipcMain.handle(IpcChannel.ChatSessionCreate, (_event, payload) =>
  routeChatWrite(() => chatSessionService.newChatSession(payload), "/api/chat/session", payload));
ipcMain.handle(IpcChannel.ChatSessionRename, (_event, payload) =>
  routeChatWrite(() => chatSessionService.renameChatSession(payload), "/api/chat/session/rename", payload));
ipcMain.handle(IpcChannel.ChatTitleGenerate, (_event, payload) => chatSessionService.generateSessionTitle(payload));
ipcMain.handle(IpcChannel.ModelCatalog, () => engineCatalogService.loadHermesModelCatalog());
ipcMain.handle(IpcChannel.CodexListModels, () => engineCatalogService.loadCodexModels());
ipcMain.handle(IpcChannel.EngineCapabilities, () => engineCatalogService.loadEngineCapabilities());
ipcMain.handle(IpcChannel.SkillsList, () => skillsLoader.loadLocalSkills());
ipcMain.handle(IpcChannel.PluginsInstall, (_event, extensionId) => skillsLoader.installMarketplacePlugin(extensionId));
ipcMain.handle(IpcChannel.SkillsRead, (_event, skillId) => skillsLoader.readLocalSkill(skillId));
ipcMain.handle(IpcChannel.SkillsDelete, (_event, skillId) => skillsLoader.deleteLocalSkill(skillId));
ipcMain.handle(IpcChannel.SkillsOpenDirectory, (_event, skillId) => skillsLoader.openLocalSkillDirectory(skillId));
ipcMain.handle(IpcChannel.SkillsMarketList, (_event, params) => cloudDesktopSync().listMarketSkills(params || {}));
ipcMain.handle(IpcChannel.SkillsMarketInstall, async (_event, skillId) => {
  const sync = cloudDesktopSync();
  const { skill, download } = await sync.installMarketSkill(skillId);
  if (!skill || !download || !download.url) throw new Error("技能不存在或安装失败。");
  if (!/^[a-f0-9]{64}$/.test(String(download.checksum || ""))) {
    throw new Error("技能包缺少有效校验值，已中止安装。");
  }
  const zipBuffer = await sync.downloadSkillPackage(download.url);
  const checksum = crypto.createHash("sha256").update(zipBuffer).digest("hex");
  if (checksum !== download.checksum) {
    throw new Error("技能包校验失败（checksum 不匹配），已中止安装。");
  }
  const library = await skillsLoader.installMarketplaceSkill({ id: skill.id, zipBuffer, marketVersion: download.version });
  return { skill, library };
});
ipcMain.handle(IpcChannel.SkillsPublish, async (_event, payload) => {
  const pkg = skillsLoader.packageLocalSkill(payload?.skillId);
  return cloudDesktopSync().publishSkill({
    name: pkg.name,
    description: pkg.description,
    category: payload?.category || "uncategorized",
    version: payload?.version || "1.0.0",
    packageBase64: pkg.packageBase64
  });
});
ipcMain.handle(IpcChannel.SkillsReport, (_event, payload) =>
  cloudDesktopSync().reportSkill(payload?.skillId, payload?.reason || ""));
ipcMain.handle(IpcChannel.PermissionsSave, async (_event, settings) => {
  settingsStore.writePermissionSettings(settings);
  return getRuntimeStatus();
});
ipcMain.handle(IpcChannel.EffortSave, async (_event, settings) => {
  settingsStore.writeEffortSettings(settings);
  return getRuntimeStatus();
});
ipcMain.handle(IpcChannel.ModelSave, (_event, settings) => modelSettingsService.saveModelSelection(settings));

ipcMain.handle(IpcChannel.AppearanceSave, (_event, settings) => {
  settingsStore.writeAppearanceSettings(settings);
  return getRuntimeStatus();
});

ipcMain.handle(IpcChannel.ProfileSave, (_event, profile) => {
  settingsStore.writeUserProfile(profile);
  return getRuntimeStatus();
});

function loadConductorPrompts() {
  const dir = path.join(__dirname, "..", "resources", "conductor", "default-prompts");
  return {
    dispatch: fs.readFileSync(path.join(dir, "dispatch.md"), "utf8"),
    summarize: fs.readFileSync(path.join(dir, "summarize.md"), "utf8"),
    nudge: fs.readFileSync(path.join(dir, "nudge.md"), "utf8"),
    relay: fs.readFileSync(path.join(dir, "relay.md"), "utf8"),
  };
}

ipcMain.handle(IpcChannel.FellowDetails, (_event, key) => fellowService.getFellowDetails(key));
ipcMain.handle(IpcChannel.FellowSave, (_event, fellow) => fellowService.saveFellow(fellow));
ipcMain.handle(IpcChannel.FellowEngineSave, (_event, payload) => fellowService.saveFellowEngineConfig(payload));
ipcMain.handle(IpcChannel.FellowPin, (_event, payload) => fellowService.setFellowPinned(payload));
ipcMain.handle(IpcChannel.FellowMute, (_event, payload) => fellowService.setFellowMuted(payload));
ipcMain.handle(IpcChannel.FellowDelete, (_event, payload) => fellowService.deleteFellow(payload));
ipcMain.handle(IpcChannel.ConductorLoadPrompts, () => loadConductorPrompts());
ipcMain.handle(IpcChannel.PersonaSave, (_event, persona) => fellowService.saveFellow(persona));
ipcMain.handle(IpcChannel.PetJobs, () => fellowPetService.jobs());
ipcMain.handle(IpcChannel.PetGenerate, (_event, payload) => fellowPetService.startGeneration(payload));
ipcMain.handle(IpcChannel.PetPlace, (_event, key) => fellowPetService.place(key));
ipcMain.handle(IpcChannel.PetRecall, (_event, key) => fellowPetService.recall(key));

registerTasksIpc({ ipcMain, callDaemonTasks: (...args) => daemonTasksClient.call(...args) });

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
      await daemonControlServer.start();
    } catch (error) {
      const message = String(error?.message || error);
      daemonControlServer.setLastError(message);
      appendDaemonLog(`Daemon start failed: ${message}`);
      throw error;
    }
    // Host the cloud bridge so this device's local AI keeps serving remote
    // (web / mobile) requests while the UI window is closed. The daemon is the
    // sole bridge host whenever it's enabled (the foreground app defers to it),
    // so the cloud always sees exactly one online device. initializeRuntime
    // makes the local engine runnable headlessly. The interval retries so the
    // bridge connects once a cloud token appears (e.g. first login happens in
    // the foreground after the daemon is already up) and after any drop;
    // startCloudBridge no-ops when already connected or when there's no token.
    try {
      initializeRuntime();
    } catch (error) {
      appendDaemonLog(`Daemon runtime init failed: ${error?.message || error}`);
    }
    startCloudBridge();
    setInterval(startCloudBridge, 10000);
    return;
  }
  const win = createWindow();
  startupTimer.mark("window:created");
  daemonTasksClient.startEvents();
  startCloudEvents();
  startCloudBridge(); // self-gates: defers to the daemon when it's enabled
  syncMiaCloudWorkspace().catch((error) => appendCloudLog(`Cloud workspace sync failed: ${error?.message || error}`));
  if (process.env.MIA_DISABLE_BACKGROUND_STARTUP !== "1") {
    win.webContents.once("did-finish-load", () => {
      setTimeout(() => runtimeLifecycle().scheduleBackgroundStartup(), 2500);
    });
  }
});

app.on("window-all-closed", () => {
  authService.cancelCodexOAuth();
  if (IS_DAEMON_PROCESS) return;
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (IS_DAEMON_PROCESS) return;
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
