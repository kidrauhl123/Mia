const { app, BrowserWindow, dialog, ipcMain, screen, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const WebSocket = require("ws");
const { IpcChannel } = require("./shared/ipc-channels");
const { MemberKind } = require("./shared/conversation-kinds");
const { botConversationId } = require("./shared/bot-identity");
const statusBadgeAssets = require("../packages/shared/status-badge-assets");
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
const { requireBot } = require("./main/bot-registry.js");
const { createClaudeCodeChatAdapter } = require("./main/claude-code-chat-adapter.js");
const { createCodexChatAdapter } = require("./main/codex-chat-adapter.js");
const { createHermesChatAdapter } = require("./main/hermes-chat-adapter.js");
const { createOpenClawChatAdapter } = require("./main/openclaw-chat-adapter.js");
const { createMiaMemoryService } = require("./main/mia-memory-service.js");
const { createRuntimeInitializerService } = require("./main/runtime-initializer-service.js");
const { createRuntimeLifecycleService } = require("./main/runtime-lifecycle-service.js");
const { createStartupBackgroundService } = require("./main/startup-background-service.js");
const { createStartupTimer } = require("./main/startup-timing.js");
const { onboardingWindowBounds } = require("./main/onboarding-window-bounds.js");
const { setMacNativeControlsVisible } = require("./main/mac-window-controls.js");
const { createChatAttachments } = require("./main/chat-attachments.js");
const { createBotManifest } = require("./main/bot-manifest.js");
const { createRuntimePaths } = require("./main/runtime-paths.js");
const { createSettingsStore } = require("./main/settings-store.js");
const { createWindowStateManager } = require("./main/window-state.js");
const { createAutoUpdateService } = require("./main/updater/auto-update-service.js");
const { createSkillsLoader } = require("./main/skills-loader.js");
const { createTasksStore } = require("./main/tasks-store.js");
const { createScheduler, sweepMissedCronTasks } = require("./main/scheduler.js");
const { createFireRunner } = require("./main/scheduler-fire.js");
const { createTasksEventBus } = require("./main/tasks-events.js");
const { createTasksRoutes } = require("./main/tasks-routes.js");
const { createMiaAppMcpBridge } = require("./main/mia-app-mcp-bridge.js");
const { createSocialApi } = require("./main/social/social-api.js");
const { registerSocialIpc } = require("./main/social/social-ipc.js");
const { openConversationMessageCache } = require("./main/social/conversation-message-cache.js");
const {
  createLocalBotResponder,
  shouldHandleLocalCloudConversationAi
} = require("./main/social/local-bot-responder.js");
const { createMainBotRuntimeDispatcher } = require("./main/social/bot-runtime-dispatcher.js");
const { createCloudEventsClient } = require("./main/cloud/cloud-events-client.js");
const { createCloudBridgeClient } = require("./main/cloud/cloud-bridge-client.js");
const { createCloudDesktopSyncClient } = require("./main/cloud/desktop-sync-client.js");
const { createCloudSettingsWriter } = require("./main/cloud/cloud-settings-writer.js");
const {
  DEFAULT_SKILL_MARKET_CACHE_TTL_MS,
  normalizeSkillMarketParams,
  openSkillMarketCache
} = require("./main/skills/skill-market-cache.js");
const { loadLocalSkillMarketPayload, packageLocalCatalogSkill } = require("./main/skills/skill-market-local.js");
const { createRemoteControlRouter } = require("./main/remote/remote-control-router.js");
const { createModelSettingsService } = require("./main/model-settings-service.js");
const { createConversationTitleService } = require("./main/conversation-title-service.js");
const { createDaemonControlServer } = require("./main/daemon/control-server.js");
const { createDaemonTasksClient } = require("./main/daemon/tasks-client.js");
const { createLocalEventsClient } = require("./main/daemon/local-events-client.js");
const { createProviderConnections } = require("./main/provider-connections.js");
const { createAuthService } = require("./main/auth-service.js");
const { createEngineCatalogService } = require("./main/engine-catalog-service.js");
const { createExternalAgentCommandService } = require("./main/external-agent-command-service.js");
const { createBotPetService } = require("./main/bot-pet-service.js");
const { createHermesRunService } = require("./main/hermes-run-service.js");
const { createHermesSlashCommandService } = require("./main/hermes-slash-command-service.js");
const { createLaunchdService } = require("./main/launchd-service.js");
const { createEnginePluginsService } = require("./main/engine-plugins-service.js");
const { createLocalAgentEngineService } = require("./main/local-agent-engine-service.js");
const { createAgentSessionStore } = require("./main/agent-session-store.js");
const { createAgentPermissionCoordinator } = require("./main/agent-permission-coordinator.js");
const { runCodexAppServerTurn } = require("./main/codex-app-server-runner.js");
const { createSchedulerMcpBridge } = require("./main/scheduler-mcp-bridge.js");
const { schedulerSkillIdsForTurn } = require("./main/scheduler-skill-detector.js");
const { deliverTaskReplyToConversation } = require("./main/task-reply-delivery.js");
const { createSystemHermesService } = require("./main/system-hermes-service.js");
const { createEngineRuntimeConfigService } = require("./main/engine-runtime-config-service.js");
const { createEngineHealthService } = require("./main/engine-health-service.js");
const { createEngineInstallService } = require("./main/engine-install-service.js");
const { registerWindowIpc } = require("./main/ipc/window-ipc.js");
const { registerTasksIpc } = require("./main/ipc/tasks-ipc.js");
// (cloud/desktop-sync helpers removed in Phase 4 cutover — bot chats
//  now sync via conversations+messages, no need for the workspace-shape mappers.)

const MIA_GATEWAY_SERVICE_LABEL = "ai.mia.hermes.gateway";
const MIA_DAEMON_SERVICE_LABEL = "ai.mia.daemon";
const MIA_DAEMON_DEFAULT_PORT = Number(process.env.MIA_DAEMON_PORT || 27861);
const MIA_CLOUD_DEFAULT_URL = process.env.MIA_CLOUD_URL || "https://mia.gifgif.cn";
const IS_DAEMON_PROCESS = process.argv.includes("--daemon") || process.env.MIA_DAEMON === "1";
const ALLOW_MULTIPLE_INSTANCES = process.env.MIA_ALLOW_MULTIPLE_INSTANCES === "1";

app.setName("Mia");
const defaultUserDataDir = app.getPath("userData");
const isolatedUserDataDir = String(process.env.MIA_USER_DATA_DIR || "").trim();
if (IS_DAEMON_PROCESS && !String(process.env.MIA_HOME || "").trim()) {
  process.env.MIA_HOME = path.join(defaultUserDataDir, "runtime", "engine-home");
}
if (isolatedUserDataDir) {
  app.setPath("userData", path.resolve(isolatedUserDataDir));
} else if (IS_DAEMON_PROCESS) {
  app.setPath("userData", path.join(defaultUserDataDir, "daemon-profile"));
}
const startupTimer = createStartupTimer({ scope: "startup" });

function localDeviceName() {
  const hostname = String(os.hostname() || "").trim().replace(/\.local$/i, "");
  return hostname || "本机";
}

function localDeviceId() {
  const p = runtimePaths();
  const saved = readJson(p.deviceIdentity, {});
  const existing = String(saved.id || saved.deviceId || "").trim();
  if (/^device_[A-Za-z0-9_-]{8,}$/.test(existing)) return existing;
  const next = {
    id: `device_${crypto.randomUUID().replace(/-/g, "")}`,
    createdAt: new Date().toISOString()
  };
  fs.mkdirSync(path.dirname(p.deviceIdentity), { recursive: true });
  fs.writeFileSync(p.deviceIdentity, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return next.id;
}

const statusBadgeAssetDefinitions = Object.fromEntries(
  statusBadgeAssets.statusBadgeAssetDefinitions().map((definition) => [
    definition.id,
    {
      ...definition,
      relativePath: path.join("renderer", definition.relativePath)
    }
  ])
);

function loadStatusBadgeAsset(assetId) {
  const id = String(assetId || "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return { ok: false, error: "bad_asset_id" };
  const definition = statusBadgeAssetDefinitions[id];
  if (!definition) return { ok: false, error: "unknown_asset" };
  const filePath = path.resolve(__dirname, definition.relativePath);
  const rendererRoot = path.resolve(__dirname, "renderer");
  if (!filePath.startsWith(`${rendererRoot}${path.sep}`)) return { ok: false, error: "bad_asset_path" };
  try {
    const raw = fs.readFileSync(filePath);
    const text = definition.format === "tgs"
      ? zlib.gunzipSync(raw).toString("utf8")
      : raw.toString("utf8");
    return {
      ok: true,
      assetId: id,
      format: definition.format,
      animationData: JSON.parse(text)
    };
  } catch (error) {
    return { ok: false, error: error?.message || "load_failed" };
  }
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
  MIA_GATEWAY_SERVICE_LABEL,
  MIA_DAEMON_SERVICE_LABEL,
  env: process.env,
});
const {
  runtimePaths,
  buildPythonPath,
  engineMarkerPath,
} = runtimePathsModule;

let settingsStore = null;
const miaMemoryService = createMiaMemoryService({ runtimePaths });
const claudeBridgePluginService = createClaudeBridgePluginService({ runtimePaths });
const enginePluginsService = createEnginePluginsService({ runtimePaths });
let localAgentEngineService = null;
const systemHermesService = createSystemHermesService({
  runtimePaths,
  readJson,
  env: process.env,
  homeDir: () => os.homedir(),
  spawnSync,
  resetAgentEngineCache: () => localAgentEngineService?.resetCache?.()
});
const engineInstallService = createEngineInstallService({
  buildPythonPath,
  systemHermesPython: () => systemHermesService.pythonPath(),
  refreshSystemHermes: () => systemHermesService.refresh(),
  shellCommandPath: (command) => localAgentEngineService?.shellCommandPath?.(command),
  spawnSync,
  appendLog: appendEngineLog,
  clearLogs: () => { engineState.logs = []; },
  initializeRuntime,
  stopEngine,
  ensureEnginePlugins: () => enginePluginsService.ensureInstalled(),
  resetAgentEngineCache: () => localAgentEngineService.resetCache(),
  getRuntimeStatus: (created) => getRuntimeStatus(created, { scanAgents: false })
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
  // Surface the user's skills to the Hermes runtime so it auto-uses them by
  // description (no slash command). Installed/authored skills live under
  // <home>/skills; bundled official skills (skill-creator etc.) under _builtin.
  // Lazy thunk: invoked at writeRuntimeConfig time, after botPetService init.
  externalSkillDirs: () => {
    const dirs = [path.join(runtimePaths().home, "skills")];
    try { dirs.push(path.join(botPetService.miaSkillsRoot(), "_builtin")); } catch { /* bundled root not found */ }
    return dirs;
  },
  // Lazy: schedulerMcpBridge is created later in this module; the thunk is
  // only invoked at writeRuntimeConfig time (runtime), by which point it
  // exists. Lets the Hermes config.yaml carry the mia-scheduler MCP.
  getMiaAppMcpSpec: () => miaAppMcpBridge.getSpec(),
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
localAgentEngineService = createLocalAgentEngineService({
  homeDir: () => os.homedir(),
  env: process.env,
  spawnSync,
  isHermesInstalled: () => engineInstallService.isInstalled(),
  hermesSource: () => engineInstallService.engineSource()
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
const windowStateManager = createWindowStateManager({ settingsStore, screen });

const botManifestModule = createBotManifest({
  runtimePaths,
  readJson,
  normalizeAgentEngine,
  settingsStore,
});
const {
  normalizeBotAgentEngine,
  normalizeBotEngineConfig,
  normalizeAvatarCrop,
  loadBotManifest,
  readBotPersona,
} = botManifestModule;

const agentSessionStore = createAgentSessionStore({
  runtimePaths,
  readJson,
  normalizeBotAgentEngine: normalizeBotAgentEngine
});
const agentPermissionCoordinator = createAgentPermissionCoordinator({
  runtimePaths,
  readJson
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

const botPetService = createBotPetService({
  app,
  BrowserWindow,
  screen,
  dirname: __dirname,
  resourcesPath: process.resourcesPath || "",
  runtimePaths,
  readJson,
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
  defaultUserProfile: () => settingsStore.defaultUserProfile(),
  defaultAppearanceSettings: () => settingsStore.defaultAppearanceSettings(),
  ensureClaudeBridgePlugin: () => claudeBridgePluginService.ensureInstalled(),
  appendEngineLog,
  getRuntimeStatus
});

const skillsLoader = createSkillsLoader({
  runtimePaths,
  readJson,
  officialLibraryManifestPath: botPetService.officialLibraryManifestPath,
  resolveOfficialLibraryRoot: botPetService.resolveOfficialLibraryRoot,
  getEngineState: () => engineState,
  apiKey,
  appendEngineLog,
  isChildPath,
});
// Local agents default to a Mia-owned workspace, never `/` (Finder-launched app)
// or the user's home — so launching/using them never trips macOS privacy prompts
// for Desktop/Documents/Downloads/Photos. Real user folders are opted into
// explicitly (folder picker), not by accident.
function agentWorkspaceDir() {
  // A user-picked workspace (Settings) wins when it still exists; otherwise the
  // Mia-owned default. Either way it's an explicit, non-protected location.
  const custom = String(settingsStore?.agentWorkspace?.()?.path || "").trim();
  const dir = custom && fs.existsSync(custom) ? custom : runtimePaths().workspace;
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
  return dir;
}
const agentCommandProvider = createAgentCommandProvider({
  appendEngineLog,
  claudeAgentSdk,
  cwd: agentWorkspaceDir,
  homeDir: () => app.getPath("home"),
  normalizeBotAgentEngine: normalizeBotAgentEngine,
  shellCommandPath: localAgentEngineService.shellCommandPath,
});
const externalAgentCommandService = createExternalAgentCommandService({
  agentCommandProvider,
  cwd: agentWorkspaceDir,
  homeDir: () => app.getPath("home"),
  normalizeBotAgentEngine,
  normalizeBotEngineConfig,
  normalizeEffortLevel: settingsStore.normalizeEffortLevel,
  localAgentEngines: localAgentEngineService.localAgentEngines,
  getAgentSessionId: agentSessionStore.getId,
  setAgentSessionId: agentSessionStore.setId,
  setAgentSessionEntry: agentSessionStore.setEntry,
  ensureClaudeBridgePlugin: () => claudeBridgePluginService.ensureInstalled(),
  loadAgentSessionMap: agentSessionStore.loadMap,
  sourceDeviceId: () => cloudBridgeRuntime?.status()?.deviceId || ""
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
let cloudEventSocketRuntime = null;
let cloudBridgeRuntime = null;
let localEventsRuntime = null;
// Last cloud-events health the daemon pushed over the local channel; lets the
// window report the real upstream state instead of just "local channel up".
let daemonCloudEventsStatus = null;
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
const miaAppMcpBridge = createMiaAppMcpBridge({
  runtimePaths,
  daemonStatus: () => daemonControlServer?.status() || {},
  daemonSettings: () => settingsStore.daemonSettings(),
  daemonToken,
  nodePath: () => localAgentEngineService.shellCommandPath("node"),
  serverScriptPath: () => path.join(__dirname, "main", "mia-app-mcp-server.js")
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

// Cloud conversations are authoritative; local storage is limited to caches
// and agent runtime metadata, never a second conversation source.

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

const startupBackgroundService = createStartupBackgroundService({
  appendDaemonLog,
  appendEngineLog,
  getRuntimeStatus,
  isDaemonEnabled: () => settingsStore.daemonSettings().enabled,
  refreshSystemHermesAsync: systemHermesService.refresh,
  setDaemonLastError: (message) => daemonControlServer?.setLastError(message),
  setEngineLastError: (message) => { engineState.lastError = message; },
  startDaemonService,
  startEngine
});

function getDaemonStatus() {
  return daemonControlServer.status();
}

async function getObservedDaemonStatus(timeoutMs = 500) {
  return daemonControlServer.observedStatus(timeoutMs);
}

function getRuntimeStatus(created = [], options = {}) {
  const p = runtimePaths();
  const codexAuth = authService.status();
  const settings = settingsWithoutSecret();
  const connectedProviders = connectedProviderSummaries(codexAuth);
  // Skip the synchronous local-agent scan while signed out: the login screen
  // never needs the agent inventory, and the scan's shell probes for missing
  // agents (hermes/openclaw) would block the main process and beachball the
  // window on open. Once signed in, the scan runs for the prepare/app views.
  const cloudState = cloudStatus(false);
  // Never block the main process on the local-agent scan: while signed out the
  // login screen needs no inventory; while signed in we warm the cache async
  // and serve whatever is cached (or the scanning placeholder) immediately.
  const wantAgents = options.scanAgents !== false && Boolean(cloudState?.enabled);
  if (wantAgents) localAgentEngineService.scanAgentsAsync().catch(() => {});
  const agentInventory = wantAgents
    ? localAgentEngineService.cachedAgentInventory()
    : localAgentEngineService.pendingAgentInventory();
  const agentEngines = wantAgents
    ? localAgentEngineService.cachedLocalAgentEngines()
    : localAgentEngineService.pendingLocalAgentEngines();
  return {
    appData: p.root,
    runtimeRoot: p.runtime,
    engineRoot: p.engine,
    hermesHome: p.home,
    manifestPath: p.botManifest,
    configPath: p.config,
    created,
    engineInstalled: engineInstallService.isInstalled(),
    engineSource: engineInstallService.engineSource(),
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
      id: localDeviceId(),
      hostname: String(os.hostname() || "").trim(),
      role: "desktop"
    },
    daemon: getDaemonStatus(),
    cloud: cloudState,
    auth: codexAuth,
    user: settingsStore.userProfile(),
    appearance: settingsStore.appearanceSettings(),
    agentInventory,
    agentEngines,
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
    bots: [],
    pets: {},
    petJobs: botPetService.jobs()
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

function resolveRemoteChatBot({ botKey, botSnapshot = null, runtimeConfig = null }) {
  initializeRuntime();
  const snapshotBot = cloudBotSnapshotForTurn(botSnapshot, botKey, runtimeConfig);
  if (snapshotBot) return { bot: snapshotBot };
  const manifest = loadBotManifest();
  const bots = Array.isArray(manifest.bots) ? manifest.bots : [];
  const key = String(botKey || manifest.default_bot || bots[0]?.key || "").trim();
  const bot = bots.find((item) => item.key === key) || bots[0] || null;
  return { bot };
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

  const runtimeConfig = body?.runtimeConfig || body?.runtime_config || null;
  const { bot } = resolveRemoteChatBot({
    botKey: body?.botKey || body?.botId,
    botSnapshot: body?.botSnapshot || body?.bot || null,
    runtimeConfig
  });
  if (!bot) throw new Error("Bot not found.");
  const conversationId = String(body?.conversationId || body?.sessionId || "").trim();
  const agentSessionId = String(body?.agentSessionId || conversationId || `remote:${crypto.randomUUID()}`);
  const now = new Date().toISOString();
  const runMessages = explicitMessages.length
    ? explicitMessages
    : [userMessage].map((message) => ({
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
    botKey: bot.key,
    botSnapshot: bot,
    sessionId: agentSessionId,
    messages: runMessages,
    webContents: tracedEventSink,
    background: Boolean(body?.background),
    // A fired scheduled task carries meta.taskId. Switch the agent into
    // execution mode for this turn so the replayed task prompt is run, not
    // re-interpreted as a fresh "create a task" request.
    scheduledFire: Boolean(body?.meta?.taskId),
    persistAgentSession: true,
    runtimeConfig
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
  const assistantTracePayload = {
    ...(savedAssistant.reasoning ? { reasoning: savedAssistant.reasoning } : {}),
    ...(Array.isArray(savedAssistant.tools) && savedAssistant.tools.length ? { tools: savedAssistant.tools } : {})
  };
  const responseConversation = {
    id: agentSessionId,
    conversationId,
    botId: bot.key,
    messages: [savedUser, savedAssistant],
    updatedAt: savedAssistant.createdAt
  };
  // When signed into Mia Cloud, the conversation the user sees is a per-bot
  // cloud conversation. A scheduled task runs locally, so post its reply as the bot
  // through the existing conversation message delivery path so it shows up and notifies in
  // the message list (and syncs to web / other devices). Only for background
  // (task) runs; foreground and web chats already reach the conversation themselves.
  let deliveredAssistantMessageId = assistantMessageId;
  if (body?.background && assistantText.trim()) {
    const cloud = settingsStore.cloudSettings();
    const fallbackConversationId = cloud?.user?.id ? botConversationId(`${cloud.user.id}_${bot.key}`) : "";
    const delivery = await deliverTaskReplyToConversation({
      socialApi,
      settingsStore,
      bot,
      conversationId,
      fallbackConversationId,
      assistantText,
      assistantTracePayload,
      taskRunId: body?.meta?.taskRunId || agentSessionId,
      fallbackMessageId: assistantMessageId
    });
    deliveredAssistantMessageId = delivery.messageId || assistantMessageId;
    savedAssistant.id = deliveredAssistantMessageId;
  }
  return { bot, session: responseConversation, response, userMessageId, assistantMessageId: deliveredAssistantMessageId };
}

let tasksStore = null;
let tasksEvents = null;
let scheduler = null;
let tasksRoutes = null;

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
    sweepMissedCronTasks(tasksStore, Date.now(), (type, payload) => tasksEvents.emit(type, payload));
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
    await launchdService.startDaemon();
    for (let i = 0; i < 20; i += 1) {
      const ping = await daemonControlServer.ping(settings, 500, { expectedRuntimeHome });
      if (ping.ok) return { ...getDaemonStatus(), running: true, baseUrl: ping.baseUrl };
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error("Timed out waiting for Mia daemon LaunchAgent.");
  }
  return daemonControlServer.start(settings);
}

async function stopDaemonService() {
  if (process.platform === "darwin" && !IS_DAEMON_PROCESS) {
    await launchdService.stopDaemon();
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
  // ADR P2: while the daemon hosts /api/events, the window's event health is
  // its local-channel subscription combined with the upstream state the daemon
  // last reported — a live local channel with a dead cloud socket is not "OK".
  if (!IS_DAEMON_PROCESS && settingsStore?.daemonSettings?.().enabled) {
    const localConnected = Boolean(localEventsRuntime?.status?.().connected);
    const upstreamDown = daemonCloudEventsStatus?.connected === false;
    return {
      ...fallback,
      connected: localConnected && !upstreamDown,
      lastError: !localConnected
        ? "等待后台守护进程的本地事件通道"
        : (upstreamDown ? (daemonCloudEventsStatus?.lastError || "后台守护进程未连接云端") : "")
    };
  }
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

function hasCjkText(value) {
  return /[\u3400-\u9fff]/.test(String(value || ""));
}

function skillMarketSnapshot(params = {}) {
  return loadLocalSkillMarketPayload({ params: normalizeSkillMarketParams(params) });
}

function skillMarketSnapshotAll() {
  return loadLocalSkillMarketPayload({ params: { limit: 10000 } });
}

function skillMarketCacheUserId() {
  const cloud = settingsStore.cloudSettings();
  return String(cloud?.user?.id || cloud?.user?.username || "").trim();
}

function cloudMarketParamsForDesktop(params = {}) {
  const normalized = normalizeSkillMarketParams(params);
  // The cloud catalog stores first-party categories/descriptions in the
  // underlying SKILL.md language. Chinese UI filters are applied after we
  // overlay the bundled zh snapshot, so broad-fetch those refreshes.
  return {
    category: hasCjkText(normalized.category) ? "" : normalized.category,
    q: hasCjkText(normalized.q) ? "" : normalized.q,
    limit: normalized.limit
  };
}

function marketSkillDisplayCategory(skill = {}) {
  return String(skill.category_zh || skill.category || "").trim();
}

function marketSkillMatchesParams(skill = {}, params = {}) {
  const normalized = normalizeSkillMarketParams(params);
  if (normalized.category) {
    const category = String(normalized.category || "").trim();
    if (marketSkillDisplayCategory(skill) !== category && String(skill.rawCategory || "") !== category) return false;
  }
  const q = String(normalized.q || "").trim().toLowerCase();
  if (!q) return true;
  return [
    skill.id,
    skill.name,
    skill.name_zh,
    skill.description,
    skill.summary_zh,
    skill.category,
    skill.category_zh,
    skill.sourceLabel,
    skill.ownerLabel,
    skill.upstreamId
  ].join(" ").toLowerCase().includes(q);
}

function isHiddenRemoteMarketSkill(skill = {}) {
  const id = String(skill?.id || "").trim().toLowerCase();
  const source = String(skill?.source || "").trim().toLowerCase();
  const sourceLabel = String(skill?.sourceLabel || skill?.ownerLabel || "").trim().toLowerCase();
  if (id.startsWith("hermes.")) return true;
  if (source === "hermes-hub") return true;
  return skill?.remote === true && sourceLabel === "hermes";
}

function categoryCountsFromMarketSkills(skills = []) {
  const counts = new Map();
  for (const skill of Array.isArray(skills) ? skills : []) {
    const category = marketSkillDisplayCategory(skill);
    if (!category) continue;
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  return [...counts.entries()].map(([category, count]) => ({ category, count }));
}

function mergeMarketSkillWithSnapshot(skill = {}, snapshot = null) {
  if (!snapshot) return skill;
  return {
    ...skill,
    rawCategory: skill.category || snapshot.rawCategory || "",
    name_zh: skill.name_zh || snapshot.name_zh || "",
    summary_zh: skill.summary_zh || snapshot.summary_zh || "",
    category_zh: skill.category_zh || snapshot.category_zh || snapshot.category || "",
    category: snapshot.category || skill.category || "",
    description: snapshot.description || skill.description || "",
    sourceLabel: skill.sourceLabel || snapshot.sourceLabel || "",
    ownerLabel: skill.ownerLabel || snapshot.ownerLabel || snapshot.sourceLabel || "",
    latestVersion: skill.latestVersion || snapshot.latestVersion || snapshot.version || "",
    version: skill.version || snapshot.version || "",
    checksum: skill.checksum || snapshot.checksum || ""
  };
}

function normalizeDesktopMarketPayload(page = {}, params = {}) {
  const snapshots = skillMarketSnapshotAll();
  const snapshotById = new Map((snapshots.skills || []).map((skill) => [String(skill.id || ""), skill]));
  const skills = (Array.isArray(page.skills) ? page.skills : [])
    .filter((skill) => !isHiddenRemoteMarketSkill(skill))
    .map((skill) => mergeMarketSkillWithSnapshot(skill, snapshotById.get(String(skill?.id || ""))))
    .filter((skill) => marketSkillMatchesParams(skill, params));
  return {
    skills,
    categories: categoryCountsFromMarketSkills(skills),
    cached: Boolean(page.cached),
    stale: Boolean(page.stale),
    updatedAt: page.updatedAt || ""
  };
}

function cachedDesktopMarketPayload(params = {}) {
  const userId = skillMarketCacheUserId();
  if (!userId) return null;
  const cached = skillMarketCache.getMarketPage(userId, cloudMarketParamsForDesktop(params), {
    nowMs: Date.now(),
    ttlMs: DEFAULT_SKILL_MARKET_CACHE_TTL_MS
  });
  return cached ? normalizeDesktopMarketPayload({ ...cached, cached: true }, params) : null;
}

async function listDesktopMarketSkills(params = {}) {
  const normalized = normalizeSkillMarketParams(params);
  const cloud = settingsStore.cloudSettings();
  const online = Boolean(cloud.enabled && cloud.token);
  const snapshot = {
    ...skillMarketSnapshot(normalized),
    cached: true,
    stale: online && !params.forceRefresh,
    updatedAt: ""
  };
  if (!online) return { ...snapshot, stale: false };

  if (!params.forceRefresh) {
    const cached = cachedDesktopMarketPayload(normalized);
    return cached || snapshot;
  }

  try {
    const page = await cloudDesktopSync().listMarketSkills({
      ...cloudMarketParamsForDesktop(normalized),
      forceRefresh: true
    });
    return normalizeDesktopMarketPayload(page, normalized);
  } catch (error) {
    appendCloudLog(`Mia Cloud skill market refresh failed: ${error?.message || error}`);
    return { ...snapshot, stale: false, error: error?.message || String(error) };
  }
}

function marketMetaFromSkill(skill = {}, extra = {}) {
  return {
    sourceLabel: skill.sourceLabel || skill.ownerLabel || "",
    upstreamSource: skill.upstreamSource || "",
    upstreamId: skill.upstreamId || "",
    upstreamRepo: skill.upstreamRepo || "",
    upstreamPath: skill.upstreamPath || "",
    trustLevel: skill.trustLevel || "",
    checksum: extra.checksum || skill.checksum || "",
    nameZh: skill.name_zh || "",
    summaryZh: skill.summary_zh || "",
    categoryZh: skill.category_zh || (hasCjkText(skill.category) ? skill.category : "")
  };
}

function verifySkillPackageChecksum(buf, checksum = "") {
  const expected = String(checksum || "").trim().toLowerCase();
  if (!expected) return;
  const actual = crypto.createHash("sha256").update(Buffer.from(buf)).digest("hex");
  if (actual !== expected) throw new Error("技能安装包校验失败。");
}

async function installDesktopMarketSkill(skillId) {
  const id = String(skillId || "").trim();
  if (!id) throw new Error("技能不存在或安装失败。");
  if (isHiddenRemoteMarketSkill({ id })) throw new Error("这个技能来源暂未开放。");
  const snapshot = (skillMarketSnapshotAll().skills || []).find((skill) => skill.id === id) || null;
  const cloud = settingsStore.cloudSettings();
  const online = Boolean(cloud.enabled && cloud.token);
  let cloudSkill = null;
  let download = null;

  if (online) {
    try {
      const result = await cloudDesktopSync().installMarketSkill(id);
      cloudSkill = result?.skill || null;
      download = result?.download || null;
    } catch (error) {
      appendCloudLog(`Mia Cloud skill install failed for ${id}: ${error?.message || error}`);
      if (!snapshot) throw error;
    }
  }

  const mergedSkill = mergeMarketSkillWithSnapshot(cloudSkill || snapshot || { id }, snapshot);
  const cloudVersion = String(download?.version || cloudSkill?.latestVersion || cloudSkill?.version?.version || "");
  const snapshotVersion = String(snapshot?.latestVersion || snapshot?.version || "");
  if (snapshot && (!cloudVersion || cloudVersion === snapshotVersion)) {
    const zipBuffer = packageLocalCatalogSkill(snapshot.id);
    const library = await skillsLoader.installMarketplaceSkill({
      id: snapshot.id,
      zipBuffer,
      marketVersion: snapshotVersion,
      marketMeta: marketMetaFromSkill(mergedSkill, { checksum: snapshot.checksum })
    });
    return { skill: mergedSkill, library };
  }

  if (!download?.url) {
    throw new Error(online ? "技能安装包缺失。" : "请登录云端后添加这个技能。");
  }
  const zipBuffer = await cloudDesktopSync().downloadSkillPackage(download.url);
  verifySkillPackageChecksum(zipBuffer, download.checksum);
  const library = await skillsLoader.installMarketplaceSkill({
    id,
    zipBuffer,
    marketVersion: download.version || cloudVersion,
    marketMeta: marketMetaFromSkill(mergedSkill, { checksum: download.checksum })
  });
  return { skill: mergedSkill, library };
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

function localBridgeEngineIds() {
  const engines = localAgentEngineService?.cachedLocalAgentEngines?.() || {};
  const ids = [];
  if (engines.hermes?.available || engines.hermes?.installed) ids.push("hermes");
  if (engines.claudeCode?.available) ids.push("claude-code");
  if (engines.codex?.available) ids.push("codex");
  if (engines.openClaw?.available || engines.openClaw?.installed) ids.push("openclaw");
  return ids;
}

function cloudBridgeUrl(settings = settingsStore.cloudSettings()) {
  const url = cloudWebSocketUrl("/api/bridge", settings);
  const bridgeEngineIds = localBridgeEngineIds();
  url.searchParams.set("deviceId", localDeviceId());
  url.searchParams.set("deviceName", localDeviceName());
  url.searchParams.set("engine", bridgeEngineIds[0] || "mia-desktop");
  url.searchParams.set("capabilities", JSON.stringify({
    chat: true,
    attachments: true,
    generatedImages: true,
    cancellation: true,
    streaming: true,
    engines: bridgeEngineIds,
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

function startCloudRuntimeSockets() {
  startCloudEvents();
  startCloudBridge();
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
    await launchdService.startGateway();
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
    await stopEngine();
    throw new Error(engineState.lastError);
  }
  return getRuntimeStatus();
}

async function stopEngine() {
  if (engineProcess) {
    engineProcess.kill("SIGTERM");
    engineProcess = null;
  }
  await launchdService.stopGateway();
  engineState.running = false;
  engineState.starting = false;
  engineState.managedBy = "";
  return getRuntimeStatus();
}

async function uninstallStandaloneEngine() {
  await stopEngine();
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

function resolveMiaManagedModelSettings(settings = {}) {
  const provider = String(settings?.provider || "").trim();
  const authType = String(settings?.authType || settings?.auth_type || "").trim();
  if (provider !== "mia" && authType !== "mia_account") return settings;
  const cloud = cloudStatus(true);
  if (!cloud?.enabled || !cloud.token || !cloud.url) {
    throw new Error("请先登录 Mia Cloud，再使用 Mia 托管模型。");
  }
  const baseUrl = `${settingsStore.normalizeCloudUrl(cloud.url)}/api/me/model-proxy/v1`;
  return {
    ...settings,
    provider: "mia",
    providerLabel: settings.providerLabel || "Mia",
    authType: "mia_account",
    model: String(settings.model || "mia-default").trim() || "mia-default",
    apiKeyEnv: "MIA_CLOUD_MODEL_TOKEN",
    apiKey: cloud.token,
    baseUrl,
    apiMode: settings.apiMode || "chat_completions"
  };
}

function resolveManagedModelRuntime(config = {}) {
  const provider = String(config.provider || config.modelProvider || config.model_provider || "").trim();
  const authType = String(config.authType || config.auth_type || "").trim();
  const profileId = String(config.modelProfileId || config.model_profile_id || "").trim();
  const model = String(config.model || "").trim();
  if (provider !== "mia" && authType !== "mia_account" && !profileId.startsWith("mia:")) return null;
  const cloud = cloudStatus(true);
  if (!cloud?.enabled || !cloud.token || !cloud.url) {
    throw new Error("这个 Bot 使用 Mia 托管模型，请先登录 Mia Cloud。");
  }
  const cloudBaseUrl = settingsStore.normalizeCloudUrl(cloud.url);
  return {
    provider: "mia",
    model: model || "mia-default",
    baseUrl: `${cloudBaseUrl}/api/me/model-proxy/v1`,
    anthropicBaseUrl: `${cloudBaseUrl}/api/me/model-proxy`,
    apiKey: cloud.token
  };
}

async function restartEngineIfRunning() {
  const shouldRestart = Boolean(engineProcess || engineState.running || engineState.starting);
  if (!shouldRestart) return getRuntimeStatus();
  await stopEngine();
  return startEngine();
}

function createActiveStatelessChatEngineAdapters() {
  const claudeAdapter = createActiveClaudeCodeChatAdapter();
  const codexAdapter = createActiveCodexChatAdapter();
  const hermesAdapter = createActiveHermesChatAdapter();
  const openClawAdapter = createActiveOpenClawChatAdapter();
  return createStatelessChatEngineAdapters({
    ensureHermesReady: ensureHermesChatEngineReady,
    sendClaudeCodeStateless: claudeAdapter.sendStateless,
    sendCodexStateless: codexAdapter.sendStateless,
    sendHermesStateless: hermesAdapter.sendStateless,
    sendOpenClawStateless: openClawAdapter.sendStateless
  });
}

async function sendChatStateless({ botKey, botSnapshot = null, runtimeConfig = null, systemPrompt, userPrompt, signal }) {
  const snapshotBot = cloudBotSnapshotForTurn(botSnapshot, botKey, runtimeConfig);
  let bot = snapshotBot;
  if (!bot) {
    const manifest = loadBotManifest();
    ({ bot } = requireBot(manifest, botKey, "还没有可用的 bot，请先在引导里创建一个再发起对话。"));
  }
  const chatEngine = resolveChatEngineAdapter(bot);
  return sendWithStatelessChatEngineAdapter(createActiveStatelessChatEngineAdapters(), {
    chatEngine,
    bot: botWithRuntimeConfig(bot, normalizeTurnRuntimeConfig(runtimeConfig)),
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
// conversations don't currently set group.contextBlock — the dep is wired through
// the adapters as a no-op so existing call sites stay valid until/unless
// cloud-side conductor needs a different injection shape.
function _noopGroupHeader() { return ""; }
function _passthroughGroupContext(userMessage) { return userMessage; }

function createActiveHermesChatAdapter() {
  return createHermesChatAdapter({
    apiKey,
    baseUrl: () => engineState.baseUrl,
    buildEnabledSkillsContext: skillsLoader.buildEnabledSkillsContext,
    buildGroupHeader: _noopGroupHeader,
    buildRunPayload: hermesRunService.buildRunPayload,
    normalizeError: hermesRunService.normalizeError,
    readRunEventStream: hermesRunService.readRunEventStream,
    responseModel: adapterForEngine("hermes").responseModel,
    memoryBlock: miaMemoryService.memoryBlock,
    writeSchedulerMcpContext: schedulerMcpBridge.writeContext,
    writeMiaAppMcpContext: miaAppMcpBridge.writeContext,
    appendEngineLog
  });
}

function createActiveClaudeCodeChatAdapter() {
  return createClaudeCodeChatAdapter({
    appendEngineLog,
    cwd: agentWorkspaceDir,
    chatCompletionResponse,
    claudeAgentSdk,
    ensureClaudeBridgePlugin: () => claudeBridgePluginService.ensureInstalled(),
    expandLeadingSkillCommand: skillsLoader.expandLeadingSkillCommand,
    buildEnabledSkillsContext: skillsLoader.buildEnabledSkillsContext,
    clearAgentSessionEntry: agentSessionStore.deleteEntry,
    getAgentSessionEntry: agentSessionStore.getEntry,
    getMiaAppMcpSpec: miaAppMcpBridge.getSpec,
    getSchedulerMcpSpec: schedulerMcpBridge.getSpec,
    injectGroupContextForSdk: _passthroughGroupContext,
    lastUserPrompt: hermesRunService.lastUserPrompt,
    memoryBlock: miaMemoryService.memoryBlock,
    normalizeEffortLevel: settingsStore.normalizeEffortLevel,
    permissionCoordinator: agentPermissionCoordinator,
    processEnvStrings,
    readBotPersona,
    resolveManagedModelRuntime,
    setAgentSessionEntry: agentSessionStore.setEntry,
    shellCommandPath: localAgentEngineService.shellCommandPath,
    writeSchedulerMcpContext: schedulerMcpBridge.writeContext
  });
}

function createActiveCodexChatAdapter() {
  return createCodexChatAdapter({
    buildEnabledSkillsContext: skillsLoader.buildEnabledSkillsContext,
    chatCompletionResponse,
    codexSdk,
    cwd: agentWorkspaceDir,
    appendEngineLog,
    ensureCodexHome: schedulerMcpBridge.ensureCodexHome,
    expandLeadingSkillCommand: skillsLoader.expandLeadingSkillCommand,
    getAgentSessionId: agentSessionStore.getId,
    getMiaAppMcpSpec: miaAppMcpBridge.getSpec,
    getSchedulerMcpSpec: schedulerMcpBridge.getSpec,
    injectGroupContextForSdk: _passthroughGroupContext,
    lastUserPrompt: hermesRunService.lastUserPrompt,
    memoryBlock: miaMemoryService.memoryBlock,
    normalizeEffortLevel: settingsStore.normalizeEffortLevel,
    permissionCoordinator: agentPermissionCoordinator,
    processEnvStrings,
    readBotPersona,
    resolveManagedModelRuntime,
    runCodexAppServerTurn,
    setAgentSessionId: agentSessionStore.setId,
    shellCommandPath: localAgentEngineService.shellCommandPath,
    writeSchedulerMcpContext: schedulerMcpBridge.writeContext
  });
}

function createActiveOpenClawChatAdapter() {
  return createOpenClawChatAdapter({
    buildEnabledSkillsContext: skillsLoader.buildEnabledSkillsContext,
    chatCompletionResponse,
    cwd: agentWorkspaceDir,
    expandLeadingSkillCommand: skillsLoader.expandLeadingSkillCommand,
    getAgentSessionId: agentSessionStore.getId,
    injectGroupContextForSdk: _passthroughGroupContext,
    lastUserPrompt: hermesRunService.lastUserPrompt,
    memoryBlock: miaMemoryService.memoryBlock,
    normalizeEffortLevel: settingsStore.normalizeEffortLevel,
    permissionCoordinator: agentPermissionCoordinator,
    processEnvStrings,
    readBotPersona,
    resolveManagedModelRuntime,
    setAgentSessionId: agentSessionStore.setId,
    shellCommandPath: localAgentEngineService.shellCommandPath
  });
}

function createActiveChatEngineAdapters() {
  const claudeAdapter = createActiveClaudeCodeChatAdapter();
  const codexAdapter = createActiveCodexChatAdapter();
  const hermesAdapter = createActiveHermesChatAdapter();
  const openClawAdapter = createActiveOpenClawChatAdapter();
  return createChatEngineAdapters({
    chatCompletionResponse,
    ensureHermesReady: ensureHermesChatEngineReady,
    hermesSlashCommandResponse: hermesAdapter.slashCommandResponse,
    runExternalSlashCommand: (input) => externalAgentCommandService.runSlashCommand(input),
    runHermesSlashCommand: hermesSlashCommandService.run,
    sendClaudeCodeChat: claudeAdapter.sendChat,
    sendCodexChat: codexAdapter.sendChat,
    sendHermesChat: hermesAdapter.sendChat,
    sendOpenClawChat: openClawAdapter.sendChat
  });
}

function createActiveBridgeChatAdapter(agentEngine = "codex") {
  const chatEngine = resolveChatEngineAdapter({ agentEngine: normalizeAgentEngine(agentEngine, "codex") });
  const adapters = createActiveChatEngineAdapters();
  return {
    sendChat(context = {}) {
      return sendWithChatEngineAdapter(adapters, {
        ...context,
        chatEngine
      });
    }
  };
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

function botWithRuntimeConfig(bot, runtimeConfig = {}) {
  if (!runtimeConfig || !Object.keys(runtimeConfig).length) return bot;
  return {
    ...bot,
    engineConfig: {
      ...(bot.engineConfig || bot.engine_config || {}),
      ...runtimeConfig
    }
  };
}

function cloudBotSnapshotForTurn(snapshot = null, key = "", runtimeConfig = null) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const botKey = String(snapshot.key || snapshot.id || key || "").trim();
  if (!botKey) return null;
  const requested = String(key || "").trim();
  if (requested && botKey !== requested) return null;
  const agentEngine = normalizeAgentEngine(
    snapshot.agentEngine || snapshot.agent_engine || snapshot.engine || runtimeConfig?.agentEngine || runtimeConfig?.agent_engine,
    "hermes"
  );
  return {
    ...snapshot,
    key: botKey,
    id: String(snapshot.id || botKey),
    name: String(snapshot.name || snapshot.displayName || snapshot.display_name || botKey),
    agentEngine,
    capabilities: snapshot.capabilities && typeof snapshot.capabilities === "object" ? snapshot.capabilities : {}
  };
}

async function sendChat({ botKey, botId, botSnapshot = null, sessionId, messages, group, webContents, emit: externalEmit = null, utility = false, persistAgentSession = undefined, background = false, scheduledFire = false, allowSlashCommands = true, runtimeConfig = null, activeSkillIds = [] }) {
  utility = Boolean(utility);
  const shouldPersistAgentSession = persistAgentSession == null
    ? !utility
    : Boolean(persistAgentSession);
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
  // chat:event drives background/remote trace capture (see runRemoteChatRequest's
  // tracedEventSink). Interactive cloud-conversation chats publish their own
  // cloud:event stream via local-bot-responder — those
  // callers either pass externalEmit or set utility/group/background to skip
  // this emitter.
  const { emit } = typeof externalEmit === "function"
    ? { emit: externalEmit }
    : !utility
    ? createChatEventEmitter({ webContents, sessionId })
    : { emit: null };
  try {
    const key = botKey || botId;
    const snapshotBot = cloudBotSnapshotForTurn(botSnapshot, key, runtimeConfig);
    let bot = snapshotBot;
    if (!bot) {
      const manifest = loadBotManifest();
      ({ bot } = requireBot(manifest, key, "还没有可用的 bot，请先在引导里创建一个再发起对话。"));
    }
    const turnRuntimeConfig = normalizeTurnRuntimeConfig(runtimeConfig);
    let botForTurn = botWithRuntimeConfig(bot, turnRuntimeConfig);
    const runtimeAgentEngine = String(runtimeConfig?.agentEngine || runtimeConfig?.agent_engine || "").trim();
    if (runtimeAgentEngine) {
      botForTurn = {
        ...botForTurn,
        agentEngine: normalizeAgentEngine(runtimeAgentEngine, botForTurn.agentEngine || botForTurn.agent_engine || "hermes")
      };
    }
    // Composer "使用" chips: enable these skills for this turn (so their content
    // is injected) AND prepend a directive to the user's message so the agent
    // actually USES them this turn — merely enabling is a no-op when the skill
    // is already in the bot's enabled set (the "AI picks" case).
    const turnActiveSkillIds = schedulerSkillIdsForTurn({ messages, activeSkillIds, utility, group, background });
    if (turnActiveSkillIds.length) {
      const caps = botForTurn.capabilities || {};
      botForTurn = {
        ...botForTurn,
        capabilities: {
          ...caps,
          enabledSkills: [...new Set([...(caps.enabledSkills || []), ...turnActiveSkillIds.map((id) => String(id))])]
        }
      };
      const directive = skillsLoader.buildActiveSkillsDirective(turnActiveSkillIds);
      if (directive && Array.isArray(messages)) {
        const next = messages.slice();
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i] && next[i].role === "user") {
            next[i] = { ...next[i], content: `${directive}\n\n${next[i].content || ""}` };
            break;
          }
        }
        messages = next;
      }
    }
    const chatEngine = resolveChatEngineAdapter(botForTurn);
    const agentEngine = chatEngine.id;
    const shouldNotifyPet = !utility && !String(sessionId || "").startsWith("title:");
    const completeWithPetMessage = (response) => {
      if (shouldNotifyPet) botPetService.notifyMessage(botForTurn.key, responseMessageContent(response));
      return response;
    };
    if (emit) {
      emit("session_started", { botKey: botForTurn.key, engine: agentEngine });
    }
    const slashText = allowSlashCommands ? hermesRunService.slashCommandText(messages) : "";
    const response = await sendWithChatEngineAdapter(createActiveChatEngineAdapters(), {
      chatEngine,
      bot: botForTurn,
      sessionId,
      messages,
      group,
      signal,
      abortController,
      emit,
      utility,
      scheduledFire,
      persistAgentSession: shouldPersistAgentSession,
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

function shouldOpenAgentSetupWindow() {
  if (process.env.MIA_FORCE_AGENT_SETUP_WINDOW === "1") return true;
  if (process.env.MIA_FORCE_AGENT_SETUP_WINDOW === "0") return false;
  try {
    return !fs.existsSync(runtimePaths().runtime);
  } catch {
    return false;
  }
}

function createWindow() {
  const initialWindow = windowStateManager.initialWindowState();
  // Signed-out users (first run OR returning) get a dedicated lightweight
  // onboarding window: a separate HTML that loads none of the main app, so it
  // opens instantly (no startup beachball) and is a clean native window.
  const onboarding = !Boolean(cloudStatus(false) && cloudStatus(false).enabled);
  if (onboarding) {
    const workArea = screen.getPrimaryDisplay().workArea;
    initialWindow.bounds = {
      ...initialWindow.bounds,
      x: Math.round(workArea.x + (workArea.width - onboardingWindowBounds.width) / 2),
      y: Math.round(workArea.y + (workArea.height - onboardingWindowBounds.height) / 2),
      width: onboardingWindowBounds.width,
      height: onboardingWindowBounds.height
    };
    initialWindow.maximized = false;
  }
  const minWindowWidth = onboarding ? onboardingWindowBounds.minWidth : 500;
  const minWindowHeight = onboarding ? onboardingWindowBounds.minHeight : 560;
  const windowChromeOptions = process.platform === "darwin"
    ? { titleBarStyle: "hidden" }
    : process.platform === "win32"
      ? {
          titleBarStyle: "hidden",
          titleBarOverlay: {
            color: "rgba(0, 0, 0, 0)",
            symbolColor: "#24262d",
            height: 36
          }
        }
      : { frame: true };
  const win = new BrowserWindow({
    ...initialWindow.bounds,
    minWidth: minWindowWidth,
    minHeight: minWindowHeight,
    title: "Mia",
    ...windowChromeOptions,
    autoHideMenuBar: process.platform !== "darwin",
    show: false,
    backgroundColor: onboarding ? "#ffffff" : "#f0f0f3",
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  if (process.platform !== "darwin" && typeof win.setMenuBarVisibility === "function") {
    win.setMenuBarVisibility(false);
  }
  win.miaSkipAutomaticBackgroundStartup = onboarding;
  win.miaSignedOutOnboarding = onboarding;
  setMacNativeControlsVisible(win, onboarding);
  if (initialWindow.maximized) win.maximize();
  if (!onboarding) windowStateManager.attachWindowStatePersistence(win);
  const sendWindowEvent = (channel, payload) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  };
  win.on("focus", () => sendWindowEvent(IpcChannel.WindowFocusState, true));
  win.on("blur", () => sendWindowEvent(IpcChannel.WindowFocusState, false));
  win.on("enter-full-screen", () => sendWindowEvent(IpcChannel.WindowFullscreen, true));
  win.on("leave-full-screen", () => sendWindowEvent(IpcChannel.WindowFullscreen, false));
  win.on("maximize", () => sendWindowEvent(IpcChannel.WindowMaximized, true));
  win.on("unmaximize", () => sendWindowEvent(IpcChannel.WindowMaximized, false));
  let windowShown = false;
  const showWhenReady = () => {
    if (windowShown || win.isDestroyed()) return;
    windowShown = true;
    win.show();
    startupTimer.mark("window:shown");
  };
  win.miaShowWhenReady = showWhenReady;
  win.once("ready-to-show", showWhenReady);
  win.webContents.once("did-finish-load", () => {
    startupTimer.mark("renderer:did-finish-load");
    showWhenReady();
  });
  win.loadFile(onboarding
    ? path.join(__dirname, "renderer", "onboarding", "onboarding.html")
    : path.join(__dirname, "renderer", "index.html"));
  startupTimer.mark("window:load-file");
  return win;
}

function showSignedOutOnboardingWindow(win) {
  const target = win && !win.isDestroyed() ? win : BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!target) {
    createWindow();
    return;
  }
  if (target.miaSignedOutOnboarding) {
    if (!target.isVisible()) target.show();
    if (typeof target.focus === "function") target.focus();
    return;
  }
  if (typeof target.isFullScreen === "function" && target.isFullScreen()) {
    target.setFullScreen(false);
  }
  if (typeof target.isMaximized === "function" && target.isMaximized()) {
    target.unmaximize();
  }
  if (typeof target.setBackgroundColor === "function") target.setBackgroundColor("#ffffff");
  setMacNativeControlsVisible(target, true);
  target.setMinimumSize(onboardingWindowBounds.minWidth, onboardingWindowBounds.minHeight);
  target.setSize(onboardingWindowBounds.width, onboardingWindowBounds.height);
  target.center();
  target.miaSkipAutomaticBackgroundStartup = true;
  target.miaSignedOutOnboarding = true;
  target.loadFile(path.join(__dirname, "renderer", "onboarding", "onboarding.html"));
  if (!target.isVisible()) target.show();
}

// Onboarding finished (signed in): turn the lightweight onboarding window into
// the real main app window — load the full app, restore main chrome/size, and
// kick the deferred background startup. Reuses the one window (no flash).
function promoteOnboardingWindowToMain(win) {
  if (!win || win.isDestroyed()) return;
  if (typeof win.setBackgroundColor === "function") win.setBackgroundColor("#f0f0f3");
  setMacNativeControlsVisible(win, false);
  win.setMinimumSize(500, 560);
  win.setSize(1040, 700);
  win.center();
  windowStateManager.attachWindowStatePersistence(win);
  win.miaSkipAutomaticBackgroundStartup = false;
  win.miaSignedOutOnboarding = false;
  if (process.env.MIA_DISABLE_BACKGROUND_STARTUP !== "1") {
    win.webContents.once("did-finish-load", () => {
      setTimeout(() => runtimeLifecycle().scheduleBackgroundStartup(), 2500);
    });
  }
  win.loadFile(path.join(__dirname, "renderer", "index.html"), { query: { onboarding: "complete" } });
}

const modelSettingsService = createModelSettingsService({
  modelSettings,
  providerConnection,
  saveProviderConnection,
  writeModelSettings,
  restartEngineIfRunning,
  getRuntimeStatus
});

const conversationTitleService = createConversationTitleService({
  randomUUID: () => crypto.randomUUID(),
  sendChat
});

remoteControlRouter = createRemoteControlRouter({
  isDaemonProcess: IS_DAEMON_PROCESS,
  getRuntimeStatus,
  loadHermesModelCatalog: () => engineCatalogService.loadHermesModelCatalog(),
  loadCodexModels: () => engineCatalogService.loadCodexModels(),
  loadEngineCapabilities: () => engineCatalogService.loadEngineCapabilities(),
  loadHermesSlashCommands: () => engineCatalogService.loadHermesSlashCommands(),
  loadExternalAgentCommands: (body) => externalAgentCommandService.loadCommands(body),
  saveChatAttachment,
  readLocalFileAttachment,
  executeExternalAgentCommand: (body) => externalAgentCommandService.executeCommand(body),
  saveModelSelection: (settings) => modelSettingsService.saveModelSelection(settings),
  writeEffortSettings: (body) => settingsStore.writeEffortSettings(body),
  writePermissionSettings: (body) => settingsStore.writePermissionSettings(body),
  stopChat,
  runRemoteChatRequest
});

daemonControlServer = createDaemonControlServer({
  isDaemonProcess: IS_DAEMON_PROCESS,
  serviceLabel: MIA_DAEMON_SERVICE_LABEL,
  daemonToken,
  initializeRuntime,
  choosePort: engineHealthService.choosePort,
  getDaemonSettings: () => settingsStore.daemonSettings(),
  writeDaemonSettings: (settings) => settingsStore.writeDaemonSettings(settings),
  // ADR P3: the daemon applies the window's delegated credential writes and
  // reacts immediately when auth changes (new token → connect, logout → drop).
  writeCloudSettings: (patch) => {
    const next = settingsStore.writeCloudSettings(patch);
    if (patch && (patch.token !== undefined || patch.enabled !== undefined)) {
      try {
        if (next.enabled && next.token) {
          startCloudRuntimeSockets();
        } else {
          stopCloudEvents();
          stopCloudBridge();
        }
      } catch { /* sockets re-evaluate on their own retry tick */ }
    }
    return next;
  },
  normalizeDaemonHost: (host) => settingsStore.normalizeDaemonHost(host),
  normalizeDaemonPort: (port) => settingsStore.normalizeDaemonPort(port),
  runtimePaths,
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
  return status;
});
ipcMain.handle(IpcChannel.RuntimeStatus, async () => {
  const status = getRuntimeStatus();
  status.daemon = await getObservedDaemonStatus(350);
  return status;
});
ipcMain.handle(IpcChannel.StartupBackgroundServices, () => startupBackgroundService.run());
ipcMain.handle(IpcChannel.DaemonStatus, async () => {
  return getObservedDaemonStatus(500);
});
ipcMain.handle(IpcChannel.DaemonStart, async () => {
  const result = await startDaemonService();
  // ADR P2: events socket ownership follows the daemon toggle — re-evaluate
  // ours (start() self-gates and releases when the daemon hosts the feed).
  startCloudEvents();
  return result;
});
ipcMain.handle(IpcChannel.DaemonStop, async () => {
  const result = await stopDaemonService();
  startCloudEvents();
  return result;
});
ipcMain.handle(IpcChannel.DaemonSettingsSave, (_event, settings) => {
  settingsStore.writeDaemonSettings(settings);
  // Re-evaluate immediately only when the daemon just became enabled (the
  // window must release its socket). The disable path waits for DaemonStop:
  // grabbing /api/events while the daemon is still draining would briefly
  // double-host the feed.
  if (settingsStore.daemonSettings().enabled) startCloudEvents();
  return getDaemonStatus();
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
ipcMain.handle(IpcChannel.StatusBadgeAssetLoad, (_event, assetId) => loadStatusBadgeAsset(assetId));
ipcMain.handle(IpcChannel.CloudStatus, () => cloudStatus(false));
ipcMain.handle(IpcChannel.CloudLogin, async (_event, payload) => {
  const result = await loginMiaCloud(payload || {});
  if (result?.kind === "wechat-login-start" || result?.kind === "wechat-login-pending") return result;
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
ipcMain.handle(IpcChannel.CloudLogout, async (event) => {
  await logoutMiaCloud();
  const runtime = getRuntimeStatus();
  const win = BrowserWindow.fromWebContents(event.sender);
  setTimeout(() => showSignedOutOnboardingWindow(win), 0);
  return runtime;
});
const socialApi = createSocialApi({
  getSettings: () => settingsStore.cloudSettings(),
  normalizeUrl: settingsStore.normalizeCloudUrl
});
const skillMarketCache = openSkillMarketCache(path.join(runtimePaths().home, "skill-market-cache.db"));
// ADR P3: window-process credential writes route through the daemon (single
// writer); the daemon itself — or the window when the daemon is off/dead —
// writes the file directly.
const cloudSettingsWriter = createCloudSettingsWriter({
  isDaemonProcess: IS_DAEMON_PROCESS,
  isDaemonEnabled: () => settingsStore.daemonSettings().enabled,
  writeLocal: (patch) => settingsStore.writeCloudSettings(patch),
  daemonBaseUrl: () => {
    const daemonSettings = settingsStore.daemonSettings();
    return `http://${daemonSettings.host}:${daemonSettings.port}`;
  },
  daemonToken,
  log: (line) => appendCloudLog(line)
});
cloudDesktopSyncRuntime = createCloudDesktopSyncClient({
  getCloudSettings: () => settingsStore.cloudSettings(),
  writeCloudSettings: (patch) => cloudSettingsWriter.write(patch),
  normalizeCloudUrl: settingsStore.normalizeCloudUrl,
  cloudStatus: (includeToken) => cloudStatus(includeToken),
  appendLog: (line) => appendCloudLog(line),
  fetchImpl: fetch,
  timeoutSignal: (timeoutMs) => AbortSignal.timeout(timeoutMs),
  writeUserProfile: (profile) => settingsStore.writeUserProfile(profile),
  writeAppearanceSettings: (settings) => settingsStore.writeAppearanceSettings(settings),
  runtimePaths,
  readJson,
  startCloudEvents,
  startCloudBridge,
  stopCloudEvents,
  stopCloudBridge,
  skillMarketCache
});
cloudBridgeRuntime = createCloudBridgeClient({
  WebSocketImpl: WebSocket,
  getSettings: () => settingsStore.cloudSettings(),
  isDaemonProcess: IS_DAEMON_PROCESS,
  isDaemonEnabled: () => settingsStore.daemonSettings().enabled,
  cloudBridgeUrl,
  cloudWebSocketProtocols,
  createActiveBridgeChatAdapter,
  createActiveCodexChatAdapter,
  resolveBotCapabilities: ({ botKey, botName }) => {
    const bot = { key: botKey, id: botKey, name: botName };
    return skillsLoader.botCapabilitiesWithPresetDefaults(bot);
  },
  randomUUID: () => crypto.randomUUID()
});
for (const line of pendingCloudLogs.splice(0)) cloudBridgeRuntime.appendLog(line);
const localBotResponder = createLocalBotResponder({
  sendChat,
  postConversationMessageAsBot: (conversationId, body) => socialApi.postConversationMessageAsBot(conversationId, body),
  emitCloudEvent: (message) => {
    const envelope = {
      type: message.type,
      payload: message
    };
    broadcastRendererEvent(IpcChannel.CloudEvent, envelope);
    // The daemon has no windows: push run streams (typing, token deltas,
    // tool traces) to the window over the local channel (ADR P0).
    if (IS_DAEMON_PROCESS) daemonControlServer?.publishLocalEvent?.(envelope);
  },
  log: (line) => appendCloudLog(line)
});
async function shouldHandleCloudConversationAi() {
  const daemonSettings = settingsStore.daemonSettings();
  let daemonReachable = false;
  if (!IS_DAEMON_PROCESS && daemonSettings.enabled) {
    // Window falls back to executing only when the enabled daemon is actually
    // dead (ADR 2026-06-12). A zombie daemon socket is covered by replay: the
    // cursor is daemon-owned, so a missed invocation is re-delivered on its
    // reconnect instead of being consumed here.
    try {
      const expectedRuntimeHome = runtimePaths().home;
      const ping = await daemonControlServer.ping(daemonSettings, 500, { expectedRuntimeHome });
      daemonReachable = Boolean(ping.ok);
    } catch {
      daemonReachable = false;
    }
  }
  return shouldHandleLocalCloudConversationAi({
    isDaemon: IS_DAEMON_PROCESS,
    daemonEnabled: daemonSettings.enabled,
    daemonReachable
  });
}
const mainBotRuntimeDispatcher = createMainBotRuntimeDispatcher({
  shouldHandle: shouldHandleCloudConversationAi,
  currentDeviceId: () => localDeviceId(),
  currentDeviceIds: () => [
    localDeviceId(),
    cloudBridgeRuntime?.status?.()?.deviceId
  ],
  listBots: () => [],
  localBotResponder,
  log: (line) => appendCloudLog(line)
});
// Desktop-local message cache (TG-style local-first render + delta sync). If
// node:sqlite is unavailable for any reason, degrade to no cache — the IPC layer
// treats a null cache as "always fetch from cloud" (previous behavior).
const conversationMessageCache = (() => {
  try {
    return openConversationMessageCache(path.join(runtimePaths().home, "conversation-cache.db"));
  } catch (error) {
    appendCloudLog(`[social] conversation message cache unavailable: ${error?.message || error}`);
    return null;
  }
})();
cloudEventSocketRuntime = createCloudEventsClient({
  WebSocketImpl: WebSocket,
  getSettings: () => settingsStore.cloudSettings(),
  writeCloudSettings: (patch) => settingsStore.writeCloudSettings(patch),
  cloudStatus: () => cloudStatus(false),
  cloudEventsUrl,
  cloudWebSocketProtocols,
  // ADR P2: in the daemon every renderer-bound cloud event is also pushed to
  // the local channel, because the daemon is the only /api/events host and
  // the window renders from the forwarded feed.
  broadcastRendererEvent: (channel, envelope) => {
    broadcastRendererEvent(channel, envelope);
    if (IS_DAEMON_PROCESS) daemonControlServer?.publishLocalEvent?.(envelope);
  },
  cloudEventChannel: IpcChannel.CloudEvent,
  appendCloudLog,
  botRuntimeDispatcher: mainBotRuntimeDispatcher,
  messageCache: conversationMessageCache,
  persistCursor: () => IS_DAEMON_PROCESS || !settingsStore.daemonSettings().enabled,
  isDaemonProcess: IS_DAEMON_PROCESS,
  isDaemonEnabled: () => settingsStore.daemonSettings().enabled
});
// ADR P0/P2: the window listens to the daemon's local event stream and replays
// the envelopes to its renderers — bot run streams (typing / token deltas /
// tool traces) and, with the daemon enabled, the entire cloud event feed.
if (!IS_DAEMON_PROCESS) {
  localEventsRuntime = createLocalEventsClient({
    baseUrl: () => {
      const daemonSettings = settingsStore.daemonSettings();
      return `http://${daemonSettings.host}:${daemonSettings.port}`;
    },
    daemonToken,
    enabled: () => settingsStore.daemonSettings().enabled,
    onEnvelope: (envelope) => {
      if (envelope?.type === "daemon.cloud_events_status") {
        daemonCloudEventsStatus = envelope.payload || null;
        return;
      }
      broadcastRendererEvent(IpcChannel.CloudEvent, envelope);
    }
  });
  localEventsRuntime.start();
  app.on("before-quit", () => localEventsRuntime.stop());
}
registerSocialIpc({
  ipcMain,
  socialApi,
  messageCache: conversationMessageCache,
  getCloudUserId: () => settingsStore.cloudSettings().user?.id || "",
  log: (line) => appendCloudLog(line)
});
ipcMain.handle(IpcChannel.SocialMyIdentity, () => {
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
function sendEngineInstallProgress(event, engineId, payload = {}) {
  if (!event?.sender || event.sender.isDestroyed()) return;
  event.sender.send(IpcChannel.EngineInstallProgress, {
    engineId: String(engineId || payload.engineId || "hermes"),
    ...payload
  });
}

ipcMain.handle(IpcChannel.EngineInstall, async (event, engineId) => {
  const id = String(engineId || "hermes");
  try {
    return await engineInstallService.installEngineAsync(id, {
      onProgress: (payload) => sendEngineInstallProgress(event, id, payload)
    });
  } catch (error) {
    sendEngineInstallProgress(event, id, {
      status: "error",
      stage: "error",
      message: error?.message || String(error)
    });
    throw error;
  }
});
ipcMain.handle(IpcChannel.OnboardingComplete, (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!cloudStatus(false).enabled) {
    showSignedOutOnboardingWindow(win);
    return getRuntimeStatus();
  }
  promoteOnboardingWindowToMain(win);
  return getRuntimeStatus();
});
ipcMain.handle(IpcChannel.WindowSignedOutOnboarding, (event) => {
  showSignedOutOnboardingWindow(BrowserWindow.fromWebContents(event.sender));
  return getRuntimeStatus();
});
ipcMain.handle(IpcChannel.EngineScan, async (event) => {
  // User-initiated async detection (onboarding prepare step). Streams each agent
  // back as it resolves so the renderer can show a real progress bar, then
  // returns the full inventory + engine view.
  const total = 4;
  let done = 0;
  const inventory = await localAgentEngineService.scanAgentsAsync((agent) => {
    done += 1;
    if (!event.sender.isDestroyed()) {
      event.sender.send(IpcChannel.EngineScanProgress, { agent, done, total });
    }
  });
  return { inventory, agentEngines: localAgentEngineService.cachedLocalAgentEngines() };
});
ipcMain.handle(IpcChannel.EngineWorkspaceGet, () => ({
  path: agentWorkspaceDir(),
  custom: String(settingsStore.agentWorkspace().path || ""),
  default: runtimePaths().workspace,
}));
ipcMain.handle(IpcChannel.EngineWorkspacePick, async (event) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(target, {
    properties: ["openDirectory", "createDirectory"],
    message: "选择 Mia Agent 的工作目录",
  });
  const picked = result.canceled ? "" : (result.filePaths?.[0] || "");
  if (picked) {
    settingsStore.writeAgentWorkspace(picked);
    localAgentEngineService?.resetCache?.();
  }
  return {
    path: agentWorkspaceDir(),
    custom: String(settingsStore.agentWorkspace().path || ""),
    default: runtimePaths().workspace,
    changed: Boolean(picked),
  };
});
ipcMain.handle(IpcChannel.EngineRepair, async (event) => {
  try {
    return await engineInstallService.repairAsync({
      onProgress: (payload) => sendEngineInstallProgress(event, "hermes", payload)
    });
  } catch (error) {
    sendEngineInstallProgress(event, "hermes", {
      status: "error",
      stage: "error",
      message: error?.message || String(error)
    });
    throw error;
  }
});
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
ipcMain.handle(IpcChannel.ChatPermissionRespond, (_event, payload) => agentPermissionCoordinator.resolvePermission(payload || {}));
ipcMain.handle(IpcChannel.ChatPermissionList, (_event, payload) => agentPermissionCoordinator.listPending(payload || {}));
ipcMain.handle(IpcChannel.ChatAttachmentSave, (_event, payload) => saveChatAttachment(payload));
ipcMain.handle(IpcChannel.ChatFileFetch, (_event, payload) => safeFetchFileAttachment(payload));
ipcMain.handle(IpcChannel.CommandsSlash, () => engineCatalogService.loadHermesSlashCommands());
ipcMain.handle(IpcChannel.CommandsAgentList, async (_event, payload) => externalAgentCommandService.loadCommands(payload));
ipcMain.handle(IpcChannel.CommandsAgentExecute, (_event, payload) => externalAgentCommandService.executeCommand(payload));
ipcMain.handle(IpcChannel.ConversationTitleGenerate, (_event, payload) => conversationTitleService.generateTitle(payload));
ipcMain.handle(IpcChannel.ModelCatalog, () => engineCatalogService.loadHermesModelCatalog());
ipcMain.handle(IpcChannel.CodexListModels, () => engineCatalogService.loadCodexModels());
ipcMain.handle(IpcChannel.EngineCapabilities, () => engineCatalogService.loadEngineCapabilities());
ipcMain.handle(IpcChannel.SkillsList, () => skillsLoader.loadLocalSkills());
ipcMain.handle(IpcChannel.PluginsInstall, (_event, extensionId) => skillsLoader.installMarketplacePlugin(extensionId));
ipcMain.handle(IpcChannel.SkillsRead, (_event, skillId) => skillsLoader.readLocalSkill(skillId));
ipcMain.handle(IpcChannel.SkillsDelete, (_event, skillId) => skillsLoader.deleteLocalSkill(skillId));
ipcMain.handle(IpcChannel.SkillsOpenDirectory, (_event, skillId) => skillsLoader.openLocalSkillDirectory(skillId));
ipcMain.handle(IpcChannel.SkillsMarketList, (_event, params) => listDesktopMarketSkills(params || {}));
ipcMain.handle(IpcChannel.SkillsMarketInstall, (_event, skillId) => installDesktopMarketSkill(skillId));
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
ipcMain.handle(IpcChannel.ModelSave, (_event, settings) => modelSettingsService.saveModelSelection(resolveMiaManagedModelSettings(settings)));

ipcMain.handle(IpcChannel.AppearanceSave, async (_event, settings) => {
  await cloudDesktopSync().saveAppearanceSettings(settings || {});
  return getRuntimeStatus();
});

ipcMain.handle(IpcChannel.ProfileSave, async (_event, profile) => {
  await cloudDesktopSync().saveUserProfile(profile || {});
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

ipcMain.handle(IpcChannel.ConductorLoadPrompts, () => loadConductorPrompts());
ipcMain.handle(IpcChannel.PetJobs, () => botPetService.jobs());
ipcMain.handle(IpcChannel.PetGenerate, (_event, payload) => botPetService.startGeneration(payload));
ipcMain.handle(IpcChannel.PetPlace, (_event, key) => botPetService.place(key));
ipcMain.handle(IpcChannel.PetRecall, (_event, key) => botPetService.recall(key));

registerTasksIpc({ ipcMain, callDaemonTasks: (...args) => daemonTasksClient.call(...args) });

const autoUpdateService = createAutoUpdateService({
  // Lazy: constructs the electron-updater singleton only when the foreground
  // window calls start(), so it's never materialized in the daemon process.
  getAutoUpdater: () => require("electron-updater").autoUpdater,
  isPackaged: app.isPackaged,
  getMainWindow: () => BrowserWindow.getAllWindows()[0] || null,
  getMainWindows: () => BrowserWindow.getAllWindows(),
  sendUpdateEvent: (payload) => broadcastRendererEvent(IpcChannel.UpdateEvent, payload),
});

ipcMain.handle(IpcChannel.UpdateCheck, () => autoUpdateService.checkForUpdates());

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
    // Host cloud realtime sockets so this device's local AI keeps serving
    // requests while the UI window is closed. Bridge exposes the device to
    // Cloud; events deliver desktop-local bot invocations into this process.
    // The interval retries once a cloud token appears (e.g. first login happens
    // in the foreground after the daemon is already up) and after any drop.
    try {
      initializeRuntime();
    } catch (error) {
      appendDaemonLog(`Daemon runtime init failed: ${error?.message || error}`);
    }
    startCloudRuntimeSockets();
    setInterval(() => {
      startCloudRuntimeSockets();
      // ADR P2: keep the window honest about upstream health — local channel
      // up + cloud socket down must not render as "connected".
      daemonControlServer?.publishLocalEvent?.({
        type: "daemon.cloud_events_status",
        payload: cloudEventsStatus()
      });
    }, 10000);
    return;
  }
  const win = createWindow();
  startupTimer.mark("window:created");
  autoUpdateService.start();
  daemonTasksClient.startEvents();
  startCloudRuntimeSockets(); // bridge self-gates: defers to the daemon when it's enabled
  syncMiaCloudWorkspace().catch((error) => appendCloudLog(`Cloud workspace sync failed: ${error?.message || error}`));
  if (!win.miaSkipAutomaticBackgroundStartup && process.env.MIA_DISABLE_BACKGROUND_STARTUP !== "1") {
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
  else if (!cloudStatus(false).enabled) showSignedOutOnboardingWindow(BrowserWindow.getAllWindows()[0]);
});
