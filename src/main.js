const { app, BrowserWindow, clipboard, dialog, ipcMain, screen, shell } = require("electron");
const { execFile, spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const AdmZip = require("adm-zip");
const WebSocket = require("ws");
const { IpcChannel } = require("./shared/ipc-channels");
const { memoryChangedEnvelope } = require("./shared/memory-events.js");
const { MemberKind } = require("./shared/conversation-kinds");
const { botConversationId } = require("./shared/bot-identity");
const statusBadgeAssets = require("../packages/shared/status-badge-assets");
const {
  normalizeAgentEngine
} = require("./main/chat-engine-registry.js");
const { createChatSendDelegator } = require("./main/chat-send-delegation.js");
const { createChatAttachmentCoreAdapter } = require("./main/chat-attachment-core-adapter.js");
const { createAgentSessionSkillRuntimeAdapter } = require("./main/agent-session-skill-runtime.js");
const { createNativeTurnHelpers } = require("./main/native-turn-helpers.js");
const { createMiaMemoryProvider } = require("./main/mia-memory-provider.js");
const { createMiaMemoryService } = require("./main/mia-memory-service.js");
const { createRuntimeInitializerService } = require("./main/runtime-initializer-service.js");
const { createRuntimeLifecycleService } = require("./main/runtime-lifecycle-service.js");
const { createStartupBackgroundService } = require("./main/startup-background-service.js");
const { createStartupMcpInitializer } = require("./main/mcp-startup-initializer.js");
const { createStartupTimer } = require("./main/startup-timing.js");
const { onboardingWindowBounds } = require("./main/onboarding-window-bounds.js");
const { setMacNativeControlsVisible } = require("./main/mac-window-controls.js");
const { createChatAttachments } = require("./main/chat-attachments.js");
const { createBotManifest } = require("./main/bot-manifest.js");
const { createRuntimePaths } = require("./main/runtime-paths.js");
const { createExternalUrlOpener } = require("./main/external-url-opener.js");
const {
  localDeviceIdentity: loadLocalDeviceIdentity,
  resetLocalDeviceIdentity: resetPersistedLocalDeviceIdentity,
  localDeviceId: loadLocalDeviceId,
  localDeviceName,
  localDeviceFingerprint: computeLocalDeviceFingerprint
} = require("./main/device-identity.js");
const { createSettingsStore } = require("./main/settings-store.js");
const { createWindowStateManager } = require("./main/window-state.js");
const { installPathPasteShortcut } = require("./main/path-paste-shortcut.js");
const { createAutoUpdateService } = require("./main/updater/auto-update-service.js");
const { createSkillsLoader } = require("./main/skills-loader.js");
const { createMiaAppMcpBridge } = require("./main/mia-app-mcp-bridge.js");
const { createSocialApi } = require("./main/social/social-api.js");
const { registerSocialIpc } = require("./main/social/social-ipc.js");
const { openConversationMessageCache } = require("./main/social/conversation-message-cache.js");
const { createCloudEventsClient } = require("./main/cloud/cloud-events-client.js");
const { finalizeCloudLoginIpcResult } = require("./main/cloud-login-ipc.js");
const { createCloudBridgeClient } = require("./main/cloud/cloud-bridge-client.js");
const { createCloudDesktopSyncClient } = require("./main/cloud/desktop-sync-client.js");
const { createCloudSettingsWriter } = require("./main/cloud/cloud-settings-writer.js");
const {
  DEFAULT_SKILL_MARKET_CACHE_TTL_MS,
  normalizeSkillMarketParams,
  openSkillMarketCache
} = require("./main/skills/skill-market-cache.js");
const { loadLocalSkillMarketPayload, packageLocalCatalogSkill } = require("./main/skills/skill-market-local.js");
const { isSafeEntryName, MAX_UNCOMPRESSED_BYTES } = require("./shared/skill-safety.js");
const { createRemoteControlRouter } = require("./main/remote/remote-control-router.js");
const { createConversationTitleService } = require("./main/conversation-title-service.js");
const {
  createMiaCoreControlServer,
  coreNeedsReplacement,
  shouldReuseCore
} = require("./main/mia-core/control-server.js");
const { createMiaCoreHttpClient } = require("./main/mia-core/http-client.js");
const { createMiaCoreCompatibilityClient } = require("./main/mia-core/compat-client.js");
const { createMiaCoreLocalEventsClient } = require("./main/mia-core/event-client.js");
const { createMiaCoreProcessLauncher } = require("./main/mia-core/process-launcher.js");
const { createMiaCoreResolver } = require("./main/mia-core/process-resolver.js");
const { coreRequestRequiresStreamingEvents } = require("./main/mia-core/request-gates.js");
const { windowsTitleBarOverlayForAppearance, applyWindowsTitleBarOverlay } = require("./main/windows-title-bar.js");
const {
  compactModelFromClientSettings,
  createRuntimeStatusCoreSnapshot,
  resolveCodexModelSelection
} = require("./main/runtime-status-core-snapshot.js");
const { createAuthService } = require("./main/auth-service.js");
const { createEngineCatalogCoreAdapter } = require("./main/engine-catalog-core-adapter.js");
const { createExternalAgentCommandCoreAdapter } = require("./main/external-agent-command-core-adapter.js");
const { createBotPetService } = require("./main/bot-pet-service.js");
const { createHermesSlashCommandService } = require("./main/hermes-slash-command-service.js");
const { createLaunchdService } = require("./main/launchd-service.js");
const { createEnginePluginsService } = require("./main/engine-plugins-service.js");
const { createLocalAgentEngineService } = require("./main/local-agent-engine-service.js");
const {
  createAgentSessionManagerPersistence,
  createAgentSessionStore
} = require("./main/agent-session-store.js");
const { createAgentPermissionProxy } = require("./main/agent-permission-proxy.js");
const { createAgentSessionRuntimePreparer } = require("./main/agent-session-runtime-preparer.js");
const { createSchedulerMcpBridge } = require("./main/scheduler-mcp-bridge.js");
const { createSystemHermesService } = require("./main/system-hermes-service.js");
const { createEngineRuntimeConfigService } = require("./main/engine-runtime-config-service.js");
const { createEngineHealthService } = require("./main/engine-health-service.js");
const { createEngineInstallService } = require("./main/engine-install-service.js");
const { registerWindowIpc } = require("./main/ipc/window-ipc.js");
const { registerUtilIpc } = require("./main/ipc/util-ipc.js");
const { registerMcpIpc } = require("./main/ipc/mcp-ipc.js");
const { createLocalFileOpenService } = require("./main/local-file-open-service.js");
const { createMcpService } = require("./main/mcp/mcp-service.js");
// (cloud/desktop-sync helpers removed in Phase 4 cutover — bot chats
//  now sync via conversations+messages, no need for the workspace-shape mappers.)

const MIA_GATEWAY_SERVICE_LABEL = "ai.mia.hermes.gateway";
// Keep the LaunchAgent label stable so existing installs are overwritten in
// place while the implementation behind it moves to Rust Core.
const MIA_CORE_SERVICE_LABEL = "ai.mia.daemon";
const MIA_CORE_DEFAULT_PORT = Number(process.env.MIA_CORE_PORT || 27861);
const MIA_CLOUD_DEFAULT_URL = process.env.MIA_CLOUD_URL || "https://mia.gifgif.cn";
const IS_CORE_PROCESS = false;
const ALLOW_MULTIPLE_INSTANCES = process.env.MIA_ALLOW_MULTIPLE_INSTANCES === "1";

app.setName("Mia");
// Migration branch: the background Core is not the Electron GUI process; the
// old daemon-profile userData / MIA_HOME special casing was deleted here.
// Electron always runs as the window. A general
// MIA_USER_DATA_DIR override is still honoured (test isolation / multi-instance).
const isolatedUserDataDir = String(process.env.MIA_USER_DATA_DIR || "").trim();
if (isolatedUserDataDir) {
  app.setPath("userData", path.resolve(isolatedUserDataDir));
}
const startupTimer = createStartupTimer({ scope: "startup" });
const localFileOpenService = createLocalFileOpenService({
  shellOpenPath: (target) => shell.openPath(target),
  shellShowItemInFolder: (target) => shell.showItemInFolder(target)
});

function localDeviceIdentity() {
  return loadLocalDeviceIdentity({ runtimePaths, readJson });
}

function resetLocalDeviceIdentity() {
  return resetPersistedLocalDeviceIdentity({ runtimePaths, readJson });
}

function localDeviceId() {
  return loadLocalDeviceId({ runtimePaths, readJson });
}

function localDeviceFingerprint() {
  return computeLocalDeviceFingerprint({ app });
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
if (!IS_CORE_PROCESS && !ALLOW_MULTIPLE_INSTANCES) {
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
  MIA_CORE_SERVICE_LABEL,
  env: process.env,
});
const {
  runtimePaths,
  buildPythonPath,
  engineMarkerPath,
} = runtimePathsModule;

let settingsStore = null;
let agentWorkspaceCoreSnapshot = null;
let memorySettingsCoreSnapshot = null;
let miaCoreStartupState = {
  port: 0,
  failed: false,
  version: null,
  error: null
};

function currentMiaCoreStartupState() {
  return {
    port: Number(miaCoreStartupState.port || 0),
    failed: Boolean(miaCoreStartupState.failed),
    version: miaCoreStartupState.version || null,
    error: miaCoreStartupState.error || null,
    userId: currentMiaUserId()
  };
}

function currentMiaCoreBaseUrl() {
  const port = Number(miaCoreStartupState.port || 0);
  if (port > 0) return `http://127.0.0.1:${port}`;
  const coreSettings = settingsStore?.coreSettings?.() || {};
  const host = coreSettings.host || "127.0.0.1";
  const fallbackPort = Number(coreSettings.port || MIA_CORE_DEFAULT_PORT);
  return `http://${host}:${fallbackPort}`;
}

function currentMiaCoreMcpStatus() {
  const port = Number(miaCoreStartupState.port || 0);
  return port > 0 ? { baseUrl: currentMiaCoreBaseUrl() } : {};
}

async function forwardMiaCoreHttpRequest(payload = {}) {
  const method = String(payload.method || "GET").toUpperCase();
  const route = String(payload.route || payload.path || "").trim();
  if (!route.startsWith("/")) throw new Error(`Invalid Mia Core route: ${route || "(empty)"}`);
  if (coreRequestRequiresStreamingEvents({ method, route })) {
    await requireDaemonRuntimeEventsAvailable();
  }
  const client = createMiaCoreHttpClient({ baseUrl: currentMiaCoreBaseUrl(), fetch });
  return client.request(method, route, payload.body);
}

async function cancelCoreConversationTurn({ conversationId, turnId } = {}) {
  const conversation = String(conversationId || "").trim();
  const turn = String(turnId || "").trim();
  if (!conversation || !turn) {
    return { ok: false, error: "conversationId and turnId are required for Core cancellation." };
  }
  return forwardMiaCoreHttpRequest({
    method: "POST",
    route: `/api/conversations/${encodeURIComponent(conversation)}/turns/${encodeURIComponent(turn)}/cancel`,
    body: {}
  });
}

async function syncCloudSettingsToCore(settings = null) {
  const cloud = settings || settingsStore?.cloudSettings?.() || {};
  let response;
  if (cloud?.enabled && cloud?.token) {
    response = await forwardMiaCoreHttpRequest({
      method: "POST",
      route: "/api/cloud/connect",
      body: {
        url: cloud.url,
        token: cloud.token,
        user: cloud.user || null,
        account: cloud.user || null,
        agentRuntime: cloud.agentRuntime || null,
        lastEventSeq: Number(cloud.lastEventSeq) || 0,
        lastMemorySyncAt: String(cloud.lastMemorySyncAt || "")
      }
    });
    startCloudRuntimeSockets();
    return response;
  }
  response = await forwardMiaCoreHttpRequest({
    method: "POST",
    route: "/api/cloud/disconnect",
    body: {}
  });
  startCloudRuntimeSockets();
  return response;
}

async function coreCloudStatus(includeToken = false) {
  try {
    return await forwardMiaCoreHttpRequest({
      method: "GET",
      route: `/api/cloud/status${includeToken ? "?includeToken=true" : ""}`
    });
  } catch (error) {
    appendCloudLog(`Mia Rust Core cloud status fallback: ${error?.message || error}`);
    return cloudStatus(includeToken);
  }
}

async function coreCloudSettingsGet() {
  try {
    return await cloudSettingsGet();
  } catch (cloudError) {
    appendCloudLog(`Mia Cloud settings get fallback to Core: ${cloudError?.message || cloudError}`);
  }
  try {
    const response = await forwardMiaCoreHttpRequest({
      method: "GET",
      route: "/api/cloud/settings"
    });
    return response?.settings || response;
  } catch (error) {
    appendCloudLog(`Mia Rust Core cloud settings get failed: ${error?.message || error}`);
    return { pins: [], readMarks: {}, appearance: {}, tags: { items: [], assignments: {} } };
  }
}

async function coreCloudSettingsPut(settings = {}) {
  try {
    return await cloudSettingsPut(settings || {});
  } catch (cloudError) {
    appendCloudLog(`Mia Cloud settings put fallback to Core: ${cloudError?.message || cloudError}`);
  }
  const response = await forwardMiaCoreHttpRequest({
    method: "PUT",
    route: "/api/cloud/settings",
    body: { settings: settings || {} }
  });
  return response?.settings || response;
}

function currentMiaUserId() {
  try {
    const cloudUser = settingsStore?.cloudSettings?.()?.user || null;
    return String(cloudUser?.id || cloudUser?.username || "").trim() || "local";
  } catch {
    return "local";
  }
}
const miaMemoryProvider = createMiaMemoryProvider({ env: process.env, fetchImpl: fetch });
const miaMemoryService = createMiaMemoryService({
  runtimePaths,
  currentUserId: currentMiaUserId,
  memoryProvider: miaMemoryProvider
});
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
  permissionSettings: () => settingsStore?.permissionSettings() || { mode: "ask" },
  effortSettings: () => settingsStore?.effortSettings() || { level: "medium" },
  prepareRuntimeConfigRequest: forwardMiaCoreHttpRequest,
  // Lazy: schedulerMcpBridge is created later in this module; these thunks are
  // only invoked when Core prepares Hermes runtime config.
  getMiaAppMcpSpec: () => miaAppMcpBridge.getSpec(),
  getSchedulerMcpSpec: () => schedulerMcpBridge.getSpec(),
  getUserMcpSpecs: () => userMcpService.getEngineSpecs("hermes", { hermesSupportsUrl: true })
});
const {
  apiServerKey,
  effectiveHermesHome,
  prepareRuntimeConfig,
  readConfiguredPort,
} = engineRuntimeConfigService;
const engineHealthService = createEngineHealthService({
  apiServerKey,
  fetchImpl: fetch,
  getEngineProcess: () => engineProcess,
  getEngineState: () => engineState,
  setEngineState: (next) => { engineState = next; },
  timeoutSignal: (timeoutMs) => AbortSignal.timeout(timeoutMs)
});

const miaCoreResolver = createMiaCoreResolver({
  runtimePaths,
  effectiveHermesHome,
  appPath: () => app.getAppPath(),
  execPath: () => process.execPath,
  defaultApp: () => Boolean(process.defaultApp),
  platform: process.platform,
  env: process.env,
  resourcesPath: () => process.resourcesPath || "",
  repoRoot: () => path.resolve(__dirname, ".."),
  coreSettings: () => settingsStore.coreSettings(),
  appVersion: () => app.getVersion(),
  cargoPath: () => process.env.MIA_CARGO_BIN || "cargo",
  parentPid: () => process.pid
});
const launchdService = createLaunchdService({
  gatewayServiceLabel: MIA_GATEWAY_SERVICE_LABEL,
  coreServiceLabel: MIA_CORE_SERVICE_LABEL,
  runtimePaths,
  resolver: miaCoreResolver,
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
const miaCoreProcessLauncher = createMiaCoreProcessLauncher({
  runtimePaths,
  effectiveHermesHome,
  resolver: miaCoreResolver,
  appPath: () => app.getAppPath(),
  execPath: () => process.execPath,
  defaultApp: () => Boolean(process.defaultApp),
  env: process.env,
  spawn,
  appendLog: appendDaemonLog
});
localAgentEngineService = createLocalAgentEngineService({
  homeDir: () => os.homedir(),
  env: process.env,
  resourcesPath: process.resourcesPath || "",
  spawnSync,
  isHermesInstalled: () => engineInstallService.isInstalled(),
  isHermesApiRuntimeReady: () => engineInstallService.isApiRuntimeReady(),
  hermesSource: () => engineInstallService.engineSource()
});

settingsStore = createSettingsStore({
  runtimePaths,
  readJson,
  MIA_CORE_DEFAULT_PORT,
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
} = botManifestModule;

function miaMemoryEnabled() {
  return memorySettingsSnapshot().enabled !== false;
}

function syncNativeMemoryFilesForAgent(input = {}) {
  if (miaMemoryEnabled()) return miaMemoryService.syncNativeMemoryFiles(input);
  return miaMemoryService.syncNativeMemoryFiles({ ...input, entries: [] });
}

function rendererMemoryBase(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const botId = String(source.botId || source.botKey || "mia").trim() || "mia";
  const sessionId = String(source.sessionId || "default").trim() || "default";
  return { botId, sessionId };
}

function rendererMemoryListInput(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const scopes = Array.isArray(source.scopes)
    ? source.scopes
    : (source.scope ? [source.scope] : []);
  return {
    ...rendererMemoryBase(source),
    query: String(source.query || "").trim(),
    scopes,
    limit: Math.max(1, Math.min(100, Math.floor(Number(source.limit) || 80)))
  };
}

function rendererMemoryManagementInput(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const scopes = Array.isArray(source.scopes)
    ? source.scopes
    : (source.scope ? [source.scope] : []);
  return {
    query: String(source.query || "").trim(),
    scopes,
    botId: String(source.botId || source.botKey || "").trim(),
    sessionId: String(source.sessionId || "").trim(),
    limit: Math.max(1, Math.min(5000, Math.floor(Number(source.limit) || 250)))
  };
}

function rendererRememberMemoryInput(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  return {
    ...rendererMemoryBase(source),
    scope: String(source.scope || "bot").trim() || "bot",
    text: String(source.text || source.content || "").trim(),
    confidence: 1,
    source: "manual",
    trusted: true,
    metadata: { source: "mia-ui" }
  };
}

function rendererUpdateMemoryInput(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  return {
    ...rendererMemoryBase(source),
    memoryId: String(source.memoryId || source.id || "").trim(),
    oldText: String(source.oldText || "").trim(),
    text: String(source.text || source.content || source.newText || "").trim(),
    confidence: 1,
    source: "manual",
    trusted: true,
    metadata: { source: "mia-ui" }
  };
}

function rendererForgetMemoryInput(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  return {
    ...rendererMemoryBase(source),
    memoryId: String(source.memoryId || source.id || "").trim(),
    oldText: String(source.oldText || source.query || "").trim(),
    scope: String(source.scope || "").trim()
  };
}

function rendererMemoryIdInput(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  return {
    memoryId: String(source.memoryId || source.id || "").trim(),
    actor: "user"
  };
}

function coreMemoryContext(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const context = { userId: currentMiaUserId() };
  const botId = String(source.botId || source.botKey || "").trim();
  const sessionId = String(source.sessionId || "").trim();
  if (botId) context.botId = botId;
  if (sessionId) context.sessionId = sessionId;
  return context;
}

function coreMemorySearchBody(input = {}) {
  const source = rendererMemoryListInput(input);
  return {
    context: coreMemoryContext(source),
    query: source.query,
    scopes: source.scopes,
    limit: source.limit
  };
}

function coreMemoryManagementListBody(input = {}) {
  const source = rendererMemoryManagementInput(input);
  return {
    context: coreMemoryContext(source),
    query: source.query,
    scopes: source.scopes,
    limit: source.limit
  };
}

function coreMemoryRememberBody(input = {}) {
  const source = rendererRememberMemoryInput(input);
  return {
    context: coreMemoryContext(source),
    text: source.text,
    scope: source.scope,
    confidence: source.confidence,
    metadata: source.metadata
  };
}

function coreMemoryUpdateBody(input = {}) {
  const source = rendererUpdateMemoryInput(input);
  return {
    context: coreMemoryContext(source),
    memoryId: source.memoryId,
    oldText: source.oldText,
    text: source.text,
    confidence: source.confidence,
    metadata: source.metadata
  };
}

function coreMemoryForgetBody(input = {}) {
  const source = rendererForgetMemoryInput(input);
  return {
    context: coreMemoryContext(source),
    memoryId: source.memoryId,
    oldText: source.oldText,
    scope: source.scope
  };
}

function coreMemoryDeleteBody(input = {}) {
  const source = rendererMemoryIdInput(input);
  return {
    context: { userId: currentMiaUserId() },
    memoryId: source.memoryId
  };
}

async function listCoreMemory(input = {}) {
  const response = await forwardMiaCoreHttpRequest({
    method: "POST",
    route: "/api/mia/memory/list",
    body: coreMemorySearchBody(input)
  });
  return Array.isArray(response?.memories) ? response.memories : [];
}

async function listAllCoreMemory(input = {}) {
  const response = await forwardMiaCoreHttpRequest({
    method: "POST",
    route: "/api/mia/memory/list",
    body: coreMemoryManagementListBody(input)
  });
  return Array.isArray(response?.memories) ? response.memories : [];
}

async function rememberCoreMemory(input = {}) {
  return forwardMiaCoreHttpRequest({
    method: "POST",
    route: "/api/mia/memory/remember",
    body: coreMemoryRememberBody(input)
  });
}

async function updateCoreMemory(input = {}) {
  return forwardMiaCoreHttpRequest({
    method: "POST",
    route: "/api/mia/memory/update",
    body: coreMemoryUpdateBody(input)
  });
}

async function forgetCoreMemory(input = {}) {
  return forwardMiaCoreHttpRequest({
    method: "POST",
    route: "/api/mia/memory/forget",
    body: coreMemoryForgetBody(input)
  });
}

async function deleteCoreMemory(input = {}) {
  return forwardMiaCoreHttpRequest({
    method: "POST",
    route: "/api/mia/memory/delete",
    body: coreMemoryDeleteBody(input)
  });
}

function publishRendererMemoryEvent(reason = "memory", result = {}, scope = {}) {
  const envelope = memoryChangedEnvelope(reason, result, { eventSource: "ui", ...scope });
  broadcastRendererEvent(IpcChannel.CloudEvent, envelope);
}

const agentSessionStore = createAgentSessionStore({
  runtimePaths,
  readJson,
  normalizeBotAgentEngine: normalizeBotAgentEngine
});
const agentSessionPersistence = createAgentSessionManagerPersistence(agentSessionStore);
void agentSessionPersistence;
const agentSessionManager = null;

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
  attachmentContext
} = chatAttachments;
const chatAttachmentCoreAdapter = createChatAttachmentCoreAdapter({
  coreRequest: forwardMiaCoreHttpRequest,
  cloudAttachments: chatAttachments
});
const engineCatalogCoreAdapter = createEngineCatalogCoreAdapter({
  coreRequest: forwardMiaCoreHttpRequest
});

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

const nativeTurnHelpers = createNativeTurnHelpers({
  normalizeAttachments,
  attachmentContext
});
const hermesSlashCommandService = createHermesSlashCommandService({
  runtimePaths,
  readJson,
  defaultUserProfile: () => settingsStore.defaultUserProfile(),
  cleanRunSessionId: nativeTurnHelpers.cleanSessionId,
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
  defaultPermissionSettings: () => settingsStore.defaultPermissionSettings(),
  defaultEffortSettings: () => settingsStore.defaultEffortSettings(),
  defaultCoreSettings: () => settingsStore.defaultCoreSettings(),
  defaultUserProfile: () => settingsStore.defaultUserProfile(),
  defaultAppearanceSettings: () => settingsStore.defaultAppearanceSettings(),
  appendEngineLog,
  getRuntimeStatus
});

const skillsLoader = createSkillsLoader({
  runtimePaths,
  readJson,
  officialLibraryManifestPath: botPetService.officialLibraryManifestPath,
  resolveOfficialLibraryRoot: botPetService.resolveOfficialLibraryRoot,
  getEngineState: () => engineState,
  apiServerKey,
  appendEngineLog,
  isChildPath,
  materializeSkillsWithCore: async (request) => {
    const client = createMiaCoreHttpClient({ baseUrl: currentMiaCoreBaseUrl(), fetch });
    return client.post("/api/conversations/skill-materialization", request);
  },
});
// Local agents default to a Mia-owned workspace, never `/` (Finder-launched app)
// or the user's home — so launching/using them never trips macOS privacy prompts
// for Desktop/Documents/Downloads/Photos. Real user folders are opted into
// explicitly (folder picker), not by accident.
function agentWorkspaceDir() {
  // Core owns the persisted user-picked workspace. Main keeps only a runtime
  // cache so synchronous agent launch paths can pick the resolved directory.
  const custom = String(agentWorkspaceCoreSnapshot?.custom || "").trim();
  const dir = custom && fs.existsSync(custom) ? custom : runtimePaths().workspace;
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
  return dir;
}

function resolveAgentSessionPermissionMode({ engineId = "", requestedEngine = "" } = {}) {
  const engine = String(requestedEngine || engineId || "").trim();
  return settingsStore.enginePermissionMode(engine);
}

function agentWorkspaceSnapshot() {
  if (agentWorkspaceCoreSnapshot && typeof agentWorkspaceCoreSnapshot === "object") {
    return {
      path: String(agentWorkspaceCoreSnapshot.path || agentWorkspaceDir()),
      custom: String(agentWorkspaceCoreSnapshot.custom || ""),
      default: String(agentWorkspaceCoreSnapshot.default || runtimePaths().workspace)
    };
  }
  return {
    path: agentWorkspaceDir(),
    custom: "",
    default: runtimePaths().workspace
  };
}

function rememberAgentWorkspaceSnapshot(snapshot = {}) {
  const next = {
    path: String(snapshot.path || runtimePaths().workspace),
    custom: String(snapshot.custom || ""),
    default: String(snapshot.default || runtimePaths().workspace)
  };
  agentWorkspaceCoreSnapshot = next;
  return agentWorkspaceSnapshot();
}

function memorySettingsSnapshot() {
  return {
    enabled: memorySettingsCoreSnapshot?.enabled !== false
  };
}

function rememberMemorySettingsSnapshot(snapshot = {}) {
  memorySettingsCoreSnapshot = {
    enabled: snapshot?.enabled !== false
  };
  return memorySettingsSnapshot();
}

const externalAgentCommandCoreAdapter = createExternalAgentCommandCoreAdapter({
  coreRequest: forwardMiaCoreHttpRequest,
  projectPath: agentWorkspaceDir,
  sourceDeviceId: () => cloudBridgeRuntime?.status()?.deviceId || localDeviceId()
});
let authService = null;
const runtimeStatusCoreSnapshot = createRuntimeStatusCoreSnapshot({
  coreRequest: forwardMiaCoreHttpRequest,
  authStatus: () => authService?.status() || { codexLoggedIn: false }
});
const openExternalUrl = createExternalUrlOpener({
  shellOpenExternal: (url) => shell.openExternal(url),
  spawnProcess: spawn
});
authService = createAuthService({
  runtimePaths,
  readJson,
  fetchImpl: fetch,
  spawnProcess: spawn,
  shellOpenExternal: openExternalUrl,
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
let remoteControlRouter = null;
let miaCoreControlServer = null;
let miaCoreCompatibilityClient = null;
let agentPermissionProxy = null;
let cloudEventSocketRuntime = null;
let cloudBridgeRuntime = null;
let localEventsRuntime = null;
// Last cloud-events health the daemon pushed over the local channel; lets the
// window report the real upstream state instead of just "local channel up".
let daemonCloudEventsStatus = null;
let daemonCloudRuntimeStatus = null;
let cloudDesktopSyncRuntime = null;
const pendingCloudLogs = [];
const schedulerMcpBridge = createSchedulerMcpBridge({
  runtimePaths,
  coreStatus: currentMiaCoreMcpStatus,
  coreSettings: () => ({}),
  coreToken,
  nodePath: () => localAgentEngineService.shellCommandPath("node"),
  serverScriptPath: () => path.join(__dirname, "main", "scheduler-mcp-server.js"),
  homeDir: () => os.homedir()
});
const miaAppMcpBridge = createMiaAppMcpBridge({
  runtimePaths,
  coreStatus: currentMiaCoreMcpStatus,
  coreSettings: () => ({}),
  coreToken,
  nodePath: () => localAgentEngineService.shellCommandPath("node"),
  ddgsPythonPath: () => systemHermesService.pythonPath() || engineInstallService.enginePython(),
  serverScriptPath: () => path.join(__dirname, "main", "mia-app-mcp-server.js")
});

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function execFileAsPromise(file, args, _meta = {}) {
  return new Promise((resolve) => {
    const resultFrom = (error, stdout, stderr) => {
      const numericCode = Number.isInteger(error?.code) ? error.code : 1;
      const spawnCode = error && !Number.isInteger(error?.code) && error?.code != null ? String(error.code) : "";
      const signal = error?.signal ? String(error.signal) : "";
      const stderrBase = String(stderr || error?.message || "");
      const detailSuffix = [spawnCode ? `spawnCode=${spawnCode}` : "", signal ? `signal=${signal}` : ""]
        .filter(Boolean)
        .join(" ");
      return {
        ok: !error,
        code: error ? numericCode : 0,
        spawnCode,
        signal,
        stdout: String(stdout || ""),
        stderr: detailSuffix && !stderrBase.includes(detailSuffix)
          ? `${stderrBase}${stderrBase ? " " : ""}${detailSuffix}`
          : stderrBase
      };
    };
    try {
      execFile(
        file,
        Array.isArray(args) ? args.map((arg) => String(arg)) : [],
        {
          encoding: "utf8",
          env: processEnvStrings(),
          ...(process.platform === "win32" ? { windowsHide: true } : {})
        },
        (error, stdout, stderr) => {
          resolve(resultFrom(error, stdout, stderr));
        }
      );
    } catch (error) {
      resolve(resultFrom(error, "", ""));
    }
  });
}

function coreToken() {
  const p = runtimePaths();
  if (!fs.existsSync(p.coreToken)) {
    fs.mkdirSync(path.dirname(p.coreToken), { recursive: true });
    fs.writeFileSync(p.coreToken, `${crypto.randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  }
  return fs.readFileSync(p.coreToken, "utf8").trim();
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

function processEnvStrings() {
  return Object.fromEntries(Object.entries(localAgentEngineService.processEnvWithCliPath()).filter(([, value]) => typeof value === "string"));
}

const userMcpService = createMcpService({
  coreRequest: forwardMiaCoreHttpRequest,
  appendLog: appendEngineLog,
  openExternal: openExternalUrl
});
const startupMcpInitializer = createStartupMcpInitializer({
  initializeMcp: () => userMcpService.initialize(),
  appendEngineLog
});

async function ensureUserMcpReady(reason) {
  try {
    await userMcpService.awaitInitialization();
  } catch (error) {
    appendEngineLog(`MCP bridge initialization incomplete before ${reason}: ${error?.message || error}`);
  }
}

let runtimeLifecycleService = null;
function runtimeLifecycle() {
  if (!runtimeLifecycleService) {
    runtimeLifecycleService = createRuntimeLifecycleService({
      appendDaemonLog,
      getRuntimeStatus,
      initializeRuntimeCore: runtimeInitializerService.initializeRuntimeCore,
      isDaemonProcess: IS_CORE_PROCESS,
      prepareEngineRuntimeConfigAsync: () => prepareRuntimeConfig(readConfiguredPort()),
      refreshAgentWorkspaceAsync: readAgentWorkspaceFromCore,
      refreshMemorySettingsAsync: readMemorySettingsFromCore,
      refreshSystemHermesAsync: systemHermesService.refresh,
      setDaemonLastError: (message) => miaCoreControlServer?.setLastError(message),
      startDaemonService,
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
  isDaemonEnabled: () => settingsStore.coreSettings().enabled,
  refreshAgentWorkspaceAsync: readAgentWorkspaceFromCore,
  refreshMemorySettingsAsync: readMemorySettingsFromCore,
  refreshSystemHermesAsync: systemHermesService.refresh,
  setDaemonLastError: (message) => miaCoreControlServer?.setLastError(message),
  setEngineLastError: (message) => { engineState.lastError = message; },
  shouldStartEngine: () => IS_CORE_PROCESS,
  startDaemonService,
  startEngine
});

function getDaemonStatus() {
  return miaCoreControlServer.status();
}

async function getObservedDaemonStatus(timeoutMs = 500) {
  return miaCoreControlServer.observedStatus(timeoutMs);
}

function getRuntimeStatus(created = [], options = {}) {
  const p = runtimePaths();
  const codexAuth = authService?.status?.() || { codexLoggedIn: false };
  const settings = {};
  const connectedProviders = codexAuth.codexLoggedIn
    ? [{
      provider: "openai-codex",
      providerConnectionId: "openai-codex",
      providerLabel: "OpenAI Codex",
      authType: "oauth_external",
      hasApiKey: true,
      models: []
    }]
    : [];
  // Skip the synchronous local-agent scan while signed out: the login screen
  // never needs the agent inventory, and the scan's shell probes for missing
  // agents (hermes) would block the main process and beachball the
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
    memory: memorySettingsSnapshot(),
    agentInventory,
    agentEngines,
    permissions: settingsStore.permissionStatus(),
    effort: settingsStore.effortStatus(),
    model: {
      provider: settings.provider || "",
      providerConnectionId: settings.providerConnectionId || settings.provider || "",
      providerLabel: settings.providerLabel || settings.provider || "",
      authType: settings.authType || (settings.provider === "openai-codex" ? "oauth_external" : "api_key"),
      model: settings.model || "",
      modelProfileId: settings.modelProfileId || (settings.provider && settings.model ? `${settings.provider}:${settings.model}` : settings.provider || ""),
      hasApiKey: connectedProviders.some((entry) => entry.provider === settings.provider && entry.hasApiKey)
    },
    connectedProviders,
    bots: [],
    pets: {},
    petJobs: botPetService.jobs()
  };
}

async function runtimeStatusWithCoreModelProviders(status = getRuntimeStatus()) {
  return runtimeStatusCoreSnapshot.apply(status);
}

async function saveProviderConnection(connection = {}) {
  const provider = String(connection.provider || connection.kind || "").trim();
  if (!provider) return { ok: false };
  const providerLabel = String(connection.providerLabel || connection.provider_label || connection.label || provider).trim() || provider;
  const authType = String(connection.authType || connection.auth_type || "oauth_external").trim() || "oauth_external";
  return forwardMiaCoreHttpRequest({
    method: "POST",
    route: "/api/settings/model-selection",
    body: {
      selection: {
        provider,
        providerConnectionId: String(connection.providerConnectionId || connection.provider_connection_id || provider).trim() || provider,
        providerLabel,
        authType,
        model: String(connection.model || "").trim(),
        modelProfileId: String(connection.modelProfileId || connection.model_profile_id || provider).trim() || provider
      }
    }
  });
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

function appendDaemonLog(line) {
  miaCoreControlServer.appendLog(line);
  if (coreStartMode() === "process") {
    console.info(`[Mia:core] ${line}`);
  }
}

function coreStartMode() {
  return String(process.env.MIA_CORE_START_MODE || "").trim().toLowerCase();
}

function shouldUseLaunchdForCore() {
  return process.platform === "darwin" && !process.defaultApp && coreStartMode() !== "process";
}

async function startDaemonService() {
  if (!IS_CORE_PROCESS && process.env.MIA_DISABLE_BACKGROUND_STARTUP === "1") {
    return { ...getDaemonStatus(), running: false, disabled: true };
  }
  initializeRuntime();
  const settings = settingsStore.coreSettings();
  if (IS_CORE_PROCESS) return miaCoreControlServer.start(settings);
  await launchdService.cleanupLegacyNodeCore();
  const expectedRuntimeHome = runtimePaths().home;
  const expectedCoreTarget = miaCoreResolver.describe();
  const existing = await miaCoreControlServer.ping(settings, 500, { expectedRuntimeHome });
  let existingReusable = false;
  if (existing.ok && existing.mode === "daemon") {
    // A KeepAlive launchd daemon survives app updates, so the freshly-updated
    // window can find an old-version daemon still owning cloud events + bot
    // execution. Reuse it only when versions match AND it is NOT running under
    // the GUI app identity. Otherwise fall through to launchdService.startCore()
    // below, which rewrites the plist and bootout+bootstraps Mia Rust Core.
    existingReusable = shouldReuseCore(existing, app.getVersion(), { expectedCoreTarget });
    if (existingReusable) {
      appendDaemonLog(`Reusing Mia Rust Core at ${existing.baseUrl}.`);
      return { ...getDaemonStatus(), running: true, baseUrl: existing.baseUrl };
    }
    if (coreNeedsReplacement(existing, app.getVersion())) {
      appendDaemonLog(`Daemon version ${existing.version || "(none)"} != app ${app.getVersion()}; replacing.`);
    } else if (existing.daemonTarget?.usesGuiAppIdentity === true || !existing.daemonTarget) {
      appendDaemonLog(`Core target ${existing.daemonTarget?.kind || "(unknown)"} uses GUI app identity or is unreported; migrating to rust-core.`);
    } else {
      appendDaemonLog(`Daemon target ${existing.daemonTarget?.workingDirectory || existing.daemonTarget?.command || "(unknown)"} != expected ${expectedCoreTarget.workingDirectory || expectedCoreTarget.command || "(unknown)"}; replacing.`);
    }
  } else if (existing.ok) {
    appendDaemonLog(`Ignoring ${existing.mode || "unknown"} process on daemon port; a real daemon process is required.`);
  }
  // Fail closed: rust-core is the sole background Core target. On a degenerate
  // packaged build that cannot resolve the bundled Rust Core the resolver returns
  // `unresolved` and this throws, rather than launching the GUI app as Core.
  miaCoreResolver.assertLaunchable();
  if (!existingReusable && existing.ok && existing.mode === "daemon" && !shouldUseLaunchdForCore()) {
    await miaCoreProcessLauncher.stopObservedProcess(existing.pid);
  }
  if (shouldUseLaunchdForCore()) {
    await launchdService.startCore();
    for (let i = 0; i < 20; i += 1) {
      const ping = await miaCoreControlServer.ping(settings, 500, { expectedRuntimeHome });
      // Only accept once the *replacement* rust-core process answers: during
      // bootout/kickstart the old daemon can still briefly hold the port, so
      // require shouldReuseCore (version match + non-GUI target) or the stale
      // GUI-identity one would be accepted and replaced again next launch.
      if (shouldReuseCore(ping, app.getVersion(), { expectedCoreTarget })) {
        appendDaemonLog(`Mia Rust Core reachable at ${ping.baseUrl}.`);
        return { ...getDaemonStatus(), running: true, baseUrl: ping.baseUrl };
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error("Timed out waiting for Mia daemon LaunchAgent.");
  }
  if (process.platform === "darwin") {
    appendDaemonLog("MIA_CORE_START_MODE=process: starting Mia Rust Core as a child process for development verification.");
  }
  miaCoreControlServer.stop();
  await miaCoreProcessLauncher.start();
  for (let i = 0; i < 20; i += 1) {
    const ping = await miaCoreControlServer.ping(settings, 500, { expectedRuntimeHome });
    if (shouldReuseCore(ping, app.getVersion(), { expectedCoreTarget })) {
      appendDaemonLog(`Mia Rust Core reachable at ${ping.baseUrl}.`);
      return { ...getDaemonStatus(), running: true, baseUrl: ping.baseUrl };
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("Timed out waiting for Mia daemon process.");
}

async function stopDaemonService() {
  await launchdService.cleanupLegacyNodeCore();
  if (shouldUseLaunchdForCore() && !IS_CORE_PROCESS) {
    await launchdService.stopCore();
  }
  return miaCoreControlServer.stop();
}

function appendCloudLog(line) {
  if (cloudBridgeRuntime) {
    cloudBridgeRuntime.appendLog(line);
    return;
  }
  pendingCloudLogs.push(String(line || ""));
  if (pendingCloudLogs.length > 200) pendingCloudLogs.splice(0, pendingCloudLogs.length - 200);
}

function daemonLocalEventsConnected() {
  return Boolean(localEventsRuntime?.status?.().connected);
}

function daemonUnavailableError(message = "Mia Core 未运行，Mia 暂不可用。") {
  const error = new Error(message);
  error.status = 503;
  return error;
}

function requireDaemonRuntimeAvailable() {
  if (IS_CORE_PROCESS) return;
  if (daemonLocalEventsConnected()) return;
  throw daemonUnavailableError();
}

async function requireDaemonRuntimeEventsAvailable(timeoutMs = 2500) {
  if (IS_CORE_PROCESS) return;
  if (daemonLocalEventsConnected()) return;
  try {
    localEventsRuntime?.start?.();
  } catch {
    // The wait below will report the unavailable event bridge.
  }
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (daemonLocalEventsConnected()) return;
  }
  if (daemonLocalEventsConnected()) return;
  throw daemonUnavailableError("Mia Core 事件流未连接，暂不能开始需要流式输出的对话。");
}

function daemonReportedEventsStatus() {
  return daemonCloudRuntimeStatus?.events || daemonCloudEventsStatus || null;
}

function daemonReportedBridgeStatus() {
  return daemonCloudRuntimeStatus?.bridge || null;
}

function daemonOwnsCloudBridge() {
  if (IS_CORE_PROCESS) return Boolean(settingsStore?.coreSettings?.().enabled);
  if (!settingsStore?.coreSettings?.().enabled) return false;
  if (!daemonLocalEventsConnected()) return false;
  const bridge = daemonReportedBridgeStatus();
  return bridge?.connected === true;
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
  // ADR P2: the daemon hosts /api/events. The window's event health is its
  // local-channel subscription combined with the upstream state the daemon last
  // reported — a live local channel with a dead cloud socket is not "OK".
  if (!IS_CORE_PROCESS) {
    const localConnected = daemonLocalEventsConnected();
    const upstream = daemonReportedEventsStatus();
    const upstreamDown = upstream?.connected === false;
    return {
      ...fallback,
      connected: localConnected && !upstreamDown,
      lastError: !localConnected
        ? "Mia Core 未运行，Mia 暂不可用。"
        : (upstreamDown ? (upstream?.lastError || "Mia Core 未连接云端") : "")
    };
  }
  return cloudEventSocketRuntime?.status?.() || fallback;
}

function cloudStatus(includeToken = false) {
  if (!IS_CORE_PROCESS) {
    const settings = settingsStore.cloudSettings();
    const localConnected = daemonLocalEventsConnected();
    const bridge = daemonReportedBridgeStatus();
    const bridgeKnown = bridge && typeof bridge === "object";
    const logs = Array.isArray(bridge?.logs) ? bridge.logs : pendingCloudLogs.slice(-80);
    return {
      enabled: Boolean(settings.enabled && settings.token),
      connected: Boolean(localConnected && bridge?.connected),
      connecting: Boolean(localConnected && bridge?.connecting),
      url: settings.url,
      user: settings.user,
      agentRuntime: settings.agentRuntime || null,
      deviceId: localConnected ? String(bridge?.deviceId || "") : "",
      lastError: !localConnected
        ? "Mia Core 未运行，Mia 暂不可用。"
        : (bridgeKnown ? String(bridge.lastError || "") : "云同步暂未连接。"),
      logs,
      events: cloudEventsStatus(),
      ...(includeToken ? { token: settings.token } : {})
    };
  }
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
    agentRuntime: settings.agentRuntime || null,
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

async function fetchCloudModelBalance() {
  const settings = settingsStore.cloudSettings();
  if (!settings.enabled || !settings.token || !settings.url) {
    throw new Error("请先登录 Mia Cloud。");
  }
  const baseUrl = String(settings.url || "").replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/api/me/model-balance`, {
    headers: { Authorization: `Bearer ${settings.token}` },
    signal: AbortSignal.timeout(10000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || `Mia Cloud ${response.status}`);
  }
  return payload;
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
  const snapshotSkills = Array.isArray(snapshots.skills) ? snapshots.skills : [];
  const snapshotById = new Map(snapshotSkills.map((skill) => [String(skill.id || ""), skill]));
  const skillsById = new Map(snapshotSkills.map((skill) => [String(skill.id || ""), skill]));
  for (const skill of Array.isArray(page.skills) ? page.skills : []) {
    const id = String(skill?.id || "").trim();
    if (!id) continue;
    const snapshot = snapshotById.get(id) || null;
    if (isHiddenRemoteMarketSkill(skill)) {
      if (snapshot) skillsById.set(id, snapshot);
      continue;
    }
    skillsById.set(id, mergeMarketSkillWithSnapshot(skill, snapshot));
  }
  const skills = [...skillsById.values()]
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

function readSkillMarkdownFromPackage(zipBuffer, entryPath = "SKILL.md") {
  const zip = new AdmZip(Buffer.from(zipBuffer));
  const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
  const preferred = String(entryPath || "").trim();
  const entry = entries.find((item) => preferred && item.entryName === preferred)
    || entries.find((item) => item.entryName === "SKILL.md")
    || entries.find((item) => String(item.entryName || "").endsWith("/SKILL.md"));
  if (!entry) throw new Error("技能安装包缺少 SKILL.md。");
  if (!isSafeEntryName(entry.entryName)) throw new Error("技能安装包路径不安全。");
  if (Number(entry.header?.size || 0) > MAX_UNCOMPRESSED_BYTES) throw new Error("技能正文过大。");
  return entry.getData().toString("utf8");
}

function marketSkillDownloadFromVersion(skill = {}) {
  const version = skill?.version && typeof skill.version === "object" ? skill.version : null;
  if (!skill?.id || !version?.version) return null;
  return {
    version: version.version,
    url: `/api/skills/${encodeURIComponent(String(skill.id))}/versions/${encodeURIComponent(String(version.version))}/package`,
    checksum: version.checksum || "",
    entryPath: version.entryPath || "SKILL.md"
  };
}

async function readDesktopMarketSkill(skillId) {
  const id = String(skillId || "").trim();
  if (!id) throw new Error("技能不存在。");
  if (isHiddenRemoteMarketSkill({ id })) throw new Error("这个技能来源暂未开放。");

  const snapshot = (skillMarketSnapshotAll().skills || []).find((skill) => skill.id === id) || null;
  const cloud = settingsStore.cloudSettings();
  const online = Boolean(cloud.enabled && cloud.token);
  if (!online) {
    if (snapshot?.body) return { skill: snapshot, body: snapshot.body };
    throw new Error("请登录云端后查看这个技能正文。");
  }

  try {
    const detail = await cloudDesktopSync().getMarketSkill(id);
    const cloudSkill = detail?.skill || null;
    const mergedSkill = mergeMarketSkillWithSnapshot(cloudSkill || snapshot || { id }, snapshot);
    const download = detail?.download || marketSkillDownloadFromVersion(cloudSkill);
    const cloudVersion = String(download?.version || cloudSkill?.latestVersion || cloudSkill?.version?.version || "");
    const snapshotVersion = String(snapshot?.latestVersion || snapshot?.version || "");
    if (snapshot?.body && (!cloudVersion || cloudVersion === snapshotVersion)) {
      return { skill: mergedSkill, body: snapshot.body };
    }
    if (!download?.url) throw new Error("技能正文下载信息缺失。");
    const zipBuffer = await cloudDesktopSync().downloadSkillPackage(download.url);
    verifySkillPackageChecksum(zipBuffer, download.checksum);
    return { skill: mergedSkill, body: readSkillMarkdownFromPackage(zipBuffer, download.entryPath) };
  } catch (error) {
    appendCloudLog(`Mia Cloud skill preview failed for ${id}: ${error?.message || error}`);
    if (snapshot?.body) return { skill: snapshot, body: snapshot.body };
    throw error;
  }
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

function bridgeEngineIdsFromView(engines = {}) {
  const ids = [];
  if (engines.hermes?.available || engines.hermes?.installed) ids.push("hermes");
  if (engines.claudeCode?.available) ids.push("claude-code");
  if (engines.codex?.available) ids.push("codex");
  return ids;
}

function localBridgeEngineIds() {
  let engines = localAgentEngineService?.cachedLocalAgentEngines?.() || {};
  let ids = bridgeEngineIdsFromView(engines);
  if (IS_CORE_PROCESS && !ids.length && typeof localAgentEngineService?.localAgentEngines === "function") {
    try {
      engines = localAgentEngineService.localAgentEngines();
      ids = bridgeEngineIdsFromView(engines);
    } catch (error) {
      appendCloudLog(`Local Agent scan for bridge capabilities failed: ${error?.message || error}`);
    }
  }
  if (!ids.includes("hermes") && (engineState.running || engineInstallService.isInstalled())) ids.push("hermes");
  if (!ids.length) ids.push("hermes");
  return ids;
}

function cloudBridgeStartPayload() {
  const bridgeEngineIds = localBridgeEngineIds();
  const deviceIdentity = localDeviceIdentity();
  return {
    deviceId: localDeviceId(),
    deviceName: localDeviceName(),
    engine: bridgeEngineIds[0] || "mia-desktop",
    capabilities: {
      chat: true,
      attachments: true,
      generatedImages: true,
      cancellation: true,
      streaming: true,
      engines: bridgeEngineIds,
      app: "Mia Desktop",
      appVersion: app.getVersion(),
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      deviceFingerprint: localDeviceFingerprint(),
      deviceCreatedAt: deviceIdentity.createdAt || ""
    }
  };
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
  await ensureUserMcpReady("Hermes startup");
  const p = runtimePaths();
  if (!engineInstallService.isInstalled()) {
    throw new Error("Hermes engine is not installed in Mia runtime.");
  }
  const apiRuntime = engineInstallService.hermesApiRuntimeCheck();
  if (!apiRuntime.ok) {
    const detail = apiRuntime.error ? ` ${apiRuntime.error}` : "";
    throw new Error(`Hermes API runtime is incomplete. Please run Repair Hermes in Mia settings.${detail}`);
  }
  if (engineProcess && engineState.running) return getRuntimeStatus();
  enginePluginsService.ensureInstalled();

  const port = await engineHealthService.choosePort();
  if (!port) throw new Error("No available local port for Mia Hermes API.");

  const runtimeConfig = await prepareRuntimeConfig(port);
  const dotenv = systemHermesService.loadDotenv();
  const hermesApiServerKey = String(runtimeConfig?.apiServerKey || apiServerKey() || "").trim();
  const env = {
    ...process.env,
    ...dotenv,
    HERMES_HOME: effectiveHermesHome(),
    MIA_HOME: p.home,
    HERMES_ACCEPT_HOOKS: "1",
    API_SERVER_ENABLED: "true",
    API_SERVER_HOST: "127.0.0.1",
    API_SERVER_PORT: String(port),
    API_SERVER_KEY: hermesApiServerKey,
    PYTHONPATH: buildPythonPath()
  };
  engineState = {
    ...engineState,
    running: false,
    starting: true,
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    managedBy: "process",
    lastError: "",
    logs: []
  };

  engineProcess = spawn(engineInstallService.enginePython(), launchdService.gatewayProgramArguments().slice(1), {
    cwd: p.engine,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    ...(process.platform === "win32" ? { windowsHide: true } : {})
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

async function applyCodexModelSettings() {
  let current = {};
  let codexModels = {};
  try {
    current = compactModelFromClientSettings(await forwardMiaCoreHttpRequest({
      method: "GET",
      route: "/api/settings/client"
    }));
  } catch {
    current = {};
  }
  try {
    codexModels = await forwardMiaCoreHttpRequest({
      method: "GET",
      route: "/api/engines/codex/models"
    });
  } catch {
    codexModels = {};
  }
  const selection = resolveCodexModelSelection(current, codexModels);
  await forwardMiaCoreHttpRequest({
    method: "POST",
    route: "/api/settings/model-selection",
    body: {
      selection
    }
  });
}

function runConversationUtilityTurn(payload = {}) {
  return forwardMiaCoreHttpRequest({
    method: "POST",
    route: "/api/conversations/utility-turns",
    body: payload && typeof payload === "object" ? payload : {}
  });
}

const skillRuntimeAdapter = createAgentSessionSkillRuntimeAdapter({
  listSkillRecordsForBot: (bot) => skillsLoader.skillRecordsForBot(bot),
  resolveSkillRecord: (skillId) => skillsLoader.resolveLocalSkillRecord(skillId),
  resolveSkillRuntimeWithCore: async (request) => {
    const client = createMiaCoreHttpClient({ baseUrl: currentMiaCoreBaseUrl(), fetch });
    return client.post("/api/conversations/agent-session-skill-runtime", request);
  }
});
const agentSessionRuntimePreparer = createAgentSessionRuntimePreparer({
  skillRuntimeAdapter,
  getMiaAppMcpSpec: miaAppMcpBridge.getSpec,
  getSchedulerMcpSpec: schedulerMcpBridge.getSpec,
  getUserMcpServers: (engineId, options) => userMcpService.getEngineSpecs(engineId, options),
  getMcpFingerprint: userMcpService.fingerprint,
  writeMiaAppMcpContext: miaAppMcpBridge.writeContext,
  writeSchedulerMcpContext: schedulerMcpBridge.writeContext
});
const prepareAgentSessionRuntime = (input) => agentSessionRuntimePreparer.prepare(input);

async function restartEngineIfRunning() {
  const shouldRestart = Boolean(engineProcess || engineState.running || engineState.starting);
  if (!shouldRestart) return getRuntimeStatus();
  await stopEngine();
  return startEngine();
}

async function readAgentWorkspaceFromCore() {
  try {
    const snapshot = await forwardMiaCoreHttpRequest({
      method: "GET",
      route: "/api/agent-workspace"
    });
    return rememberAgentWorkspaceSnapshot(snapshot);
  } catch (error) {
    appendEngineLog(`Mia Rust Core agent workspace read fallback: ${error?.message || error}`);
    return agentWorkspaceSnapshot();
  }
}

async function writeAgentWorkspaceToCore(workspacePath) {
  const snapshot = await forwardMiaCoreHttpRequest({
    method: "POST",
    route: "/api/agent-workspace",
    body: { path: workspacePath }
  });
  rememberAgentWorkspaceSnapshot(snapshot);
  localAgentEngineService?.resetCache?.();
  return agentWorkspaceSnapshot();
}

async function readMemorySettingsFromCore() {
  try {
    const snapshot = await forwardMiaCoreHttpRequest({
      method: "GET",
      route: "/api/memory/settings"
    });
    return rememberMemorySettingsSnapshot(snapshot);
  } catch (error) {
    appendEngineLog(`Mia Rust Core memory settings read fallback: ${error?.message || error}`);
    return memorySettingsSnapshot();
  }
}

async function writeMemorySettingsToCore(settings = {}) {
  const snapshot = await forwardMiaCoreHttpRequest({
    method: "POST",
    route: "/api/memory/settings",
    body: { enabled: settings.enabled !== false }
  });
  rememberMemorySettingsSnapshot(snapshot);
  return getRuntimeStatus();
}

const sendChat = createChatSendDelegator({
  isDaemonProcess: IS_CORE_PROCESS,
  requireDaemonRuntimeAvailable,
  coreClient: {
    call: (...args) => miaCoreCompatibilityClient.call(...args)
  }
});

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
  const forceMainWindow = process.env.MIA_FORCE_MAIN_WINDOW === "1";
  const onboarding = !forceMainWindow && !Boolean(cloudStatus(false) && cloudStatus(false).enabled);
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
  const minWindowWidth = onboarding ? onboardingWindowBounds.minWidth : 360;
  const minWindowHeight = onboarding ? onboardingWindowBounds.minHeight : 560;
  const initialAppearance = onboarding
    ? { theme: "light" }
    : settingsStore.appearanceSettings();
  const initialWindowsTitleBarOverlay = windowsTitleBarOverlayForAppearance(initialAppearance);
  const windowChromeOptions = process.platform === "darwin"
    ? { titleBarStyle: "hidden" }
    : process.platform === "win32"
      ? {
          frame: false,
          thickFrame: true
        }
      : { frame: true };
  const win = new BrowserWindow({
    ...initialWindow.bounds,
    minWidth: minWindowWidth,
    minHeight: minWindowHeight,
    title: "Mia",
    ...windowChromeOptions,
    autoHideMenuBar: process.platform !== "darwin",
    transparent: process.platform === "darwin",
    show: false,
    backgroundColor: onboarding
      ? "#ffffff"
      : (process.platform === "darwin" ? "#00000000" : initialWindowsTitleBarOverlay.color),
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
  setMacNativeControlsVisible(win, process.platform === "darwin");
  if (initialWindow.maximized) win.maximize();
  if (!onboarding) windowStateManager.attachWindowStatePersistence(win);
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url).catch((error) => {
      appendEngineLog(`Open external link failed: ${error?.message || error}`);
    });
    return { action: "deny" };
  });
  const sendWindowEvent = (channel, payload) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  };
  installPathPasteShortcut(win, {
    clipboard,
    channel: IpcChannel.ComposerPathPaste,
    platform: process.platform
  });
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
  applyWindowsTitleBarOverlay(target, { theme: "light" });
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
  setMacNativeControlsVisible(win, true);
  applyWindowsTitleBarOverlay(win, settingsStore.appearanceSettings());
  win.setMinimumSize(360, 560);
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

const conversationTitleService = createConversationTitleService({
  randomUUID: () => crypto.randomUUID(),
  runUtilityTurn: runConversationUtilityTurn
});

remoteControlRouter = createRemoteControlRouter({
  cancelConversationTurn: cancelCoreConversationTurn
});

miaCoreControlServer = createMiaCoreControlServer({
  isCoreProcess: IS_CORE_PROCESS,
  serviceLabel: MIA_CORE_SERVICE_LABEL,
  coreToken,
  appVersion: () => app.getVersion(),
  describeCoreTarget: () => miaCoreResolver.describe(),
  initializeRuntime,
  choosePort: engineHealthService.choosePort,
  getCoreSettings: () => settingsStore.coreSettings(),
  writeCoreSettings: (settings) => settingsStore.writeCoreSettings(settings),
  normalizeCoreHost: (host) => settingsStore.normalizeCoreHost(host),
  normalizeCorePort: (port) => settingsStore.normalizeCorePort(port),
  runtimePaths,
  remoteRouter: () => remoteControlRouter,
  fetchImpl: fetch,
  timeoutSignal: (timeoutMs) => AbortSignal.timeout(timeoutMs)
});

miaCoreCompatibilityClient = createMiaCoreCompatibilityClient({
  getCoreSettings: () => settingsStore.coreSettings(),
  getCoreStatus: getDaemonStatus,
  fetchImpl: fetch
});

agentPermissionProxy = createAgentPermissionProxy({
  coreControlClient: {
    call: (...args) => miaCoreCompatibilityClient.call(...args)
  }
});

registerWindowIpc({ ipcMain, startupTimer, runtimeLifecycle });
registerUtilIpc({
  ipcMain,
  openLocalFile: localFileOpenService.openLocalFile,
  revealLocalFile: localFileOpenService.revealLocalFile
});
registerMcpIpc({ ipcMain, mcpService: userMcpService });

ipcMain.on(IpcChannel.MiaCoreStartupState, (event) => {
  event.returnValue = currentMiaCoreStartupState();
});
ipcMain.handle(IpcChannel.MiaCoreHttpRequest, (_event, payload) => forwardMiaCoreHttpRequest(payload || {}));

ipcMain.handle(IpcChannel.RuntimeInitialize, async () => {
  const status = initializeRuntime();
  status.daemon = await getObservedDaemonStatus(350);
  return runtimeStatusWithCoreModelProviders(status);
});
ipcMain.handle(IpcChannel.RuntimeStatus, async () => {
  const status = getRuntimeStatus();
  status.daemon = await getObservedDaemonStatus(350);
  return runtimeStatusWithCoreModelProviders(status);
});
ipcMain.handle(IpcChannel.StartupBackgroundServices, () => startupBackgroundService.run());
ipcMain.handle(IpcChannel.DaemonStatus, async () => {
  return getObservedDaemonStatus(500);
});
ipcMain.handle(IpcChannel.DaemonStart, async () => {
  const result = await startDaemonService();
  // The daemon is the only runtime owner. This call only nudges status/socket
  // clients to re-evaluate; foreground clients self-gate and never take over.
  startCloudRuntimeSockets();
  return result;
});
ipcMain.handle(IpcChannel.DaemonStop, async () => {
  const result = await stopDaemonService();
  // Stopping the daemon makes the foreground unavailable instead of promoting
  // it to runtime owner.
  startCloudRuntimeSockets();
  return result;
});
ipcMain.handle(IpcChannel.DaemonSettingsSave, (_event, settings) => {
  settingsStore.writeCoreSettings(settings);
  startCloudRuntimeSockets();
  return getDaemonStatus();
});
ipcMain.handle(IpcChannel.UtilOpenExternal, async (_event, url) => {
  return openExternalUrl(url);
});
ipcMain.handle(IpcChannel.StatusBadgeAssetLoad, (_event, assetId) => loadStatusBadgeAsset(assetId));
ipcMain.handle(IpcChannel.CloudStatus, () => coreCloudStatus(false));
ipcMain.handle(IpcChannel.CloudModelBalance, () => fetchCloudModelBalance());
ipcMain.handle(IpcChannel.CloudLogin, async (_event, payload) => {
  requireDaemonRuntimeAvailable();
  const result = await loginMiaCloud(payload || {});
  syncCloudSettingsToCore().catch((error) => {
    appendCloudLog(`Mia Rust Core cloud login sync failed: ${error?.message || error}`);
  });
  return finalizeCloudLoginIpcResult({
    payload: payload || {},
    result,
    runtimeStatus: await runtimeStatusWithCoreModelProviders(getRuntimeStatus())
  });
});
// Phase 3: cross-device settings (pin / read marks / appearance). Renderer
// asks main for current bag; mutations PUT to /api/me/settings whose
// broadcast comes back via the WS event handler and is re-broadcast to
// the renderer.
ipcMain.handle(IpcChannel.CloudSettingsGet, async () => {
  return coreCloudSettingsGet();
});
ipcMain.handle(IpcChannel.CloudSettingsPut, async (_event, settings) => {
  try {
    return await coreCloudSettingsPut(settings || {});
  } catch (error) {
    appendCloudLog(`Cloud settings put failed: ${error?.message || error}`);
    throw error;
  }
});
ipcMain.handle(IpcChannel.CloudLogout, async (event) => {
  requireDaemonRuntimeAvailable();
  await logoutMiaCloud();
  syncCloudSettingsToCore({ enabled: false, token: "", user: null, agentRuntime: null }).catch((error) => {
    appendCloudLog(`Mia Rust Core cloud logout sync failed: ${error?.message || error}`);
  });
  const runtime = await runtimeStatusWithCoreModelProviders(getRuntimeStatus());
  const win = BrowserWindow.fromWebContents(event.sender);
  setTimeout(() => showSignedOutOnboardingWindow(win), 0);
  return runtime;
});
const socialApi = createSocialApi({
  getSettings: () => settingsStore.cloudSettings(),
  normalizeUrl: settingsStore.normalizeCloudUrl
});
const skillMarketCache = openSkillMarketCache(path.join(runtimePaths().home, "skill-market-cache.db"));
const cloudSettingsWriter = createCloudSettingsWriter({
  writeLocal: (patch) => {
    const next = settingsStore.writeCloudSettings(patch);
    if (patch && (patch.token !== undefined || patch.enabled !== undefined)) {
      try {
        if (next.enabled && next.token) {
          startCloudRuntimeSockets();
        } else {
          stopCloudEvents();
          stopCloudBridge();
        }
      } catch {
        // Sockets re-evaluate on their own retry tick.
      }
    }
    return next;
  },
  syncCore: (settings) => syncCloudSettingsToCore(settings),
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
  syncCloudMemory: (options = {}) => forwardMiaCoreHttpRequest({
    method: "POST",
    route: "/api/cloud/memory/sync",
    body: options || {}
  }),
  skillMarketCache
});
cloudBridgeRuntime = createCloudBridgeClient({
  getSettings: () => settingsStore.cloudSettings(),
  isDaemonProcess: true,
  isDaemonEnabled: () => Boolean(settingsStore?.coreSettings?.().enabled),
  cloudBridgeStartPayload,
  startCloudBridgeRequest: (payload = {}) => forwardMiaCoreHttpRequest({
    method: "POST",
    route: "/api/cloud/bridge/start",
    body: payload || {}
  }),
  stopCloudBridgeRequest: () => forwardMiaCoreHttpRequest({
    method: "POST",
    route: "/api/cloud/bridge/stop",
    body: {}
  })
});
for (const line of pendingCloudLogs.splice(0)) cloudBridgeRuntime.appendLog(line);
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
  getSettings: () => settingsStore.cloudSettings(),
  appendCloudLog,
  startCloudEventsRequest: () => forwardMiaCoreHttpRequest({
    method: "POST",
    route: "/api/cloud/events/start",
    body: {}
  }),
  stopCloudEventsRequest: () => forwardMiaCoreHttpRequest({
    method: "POST",
    route: "/api/cloud/events/stop",
    body: {}
  })
});
// The window listens to Rust Core's websocket and replays Core-owned local
// envelopes to its renderers. The legacy event name is kept for UI state.
if (!IS_CORE_PROCESS) {
  localEventsRuntime = createMiaCoreLocalEventsClient({
    baseUrl: () => getDaemonStatus().baseUrl,
    WebSocketImpl: WebSocket,
    enabled: () => settingsStore.coreSettings().enabled,
    includeTaskEvents: true,
    onEnvelope: (envelope) => {
      const coreEventType = String(envelope?.coreEnvelope?.name || envelope?.coreEnvelope?.type || "").trim();
      if (coreEventType.startsWith("task.")) {
        broadcastRendererEvent(IpcChannel.TasksEvent, envelope);
        return;
      }
      if (envelope?.type === "daemon.cloud_events_status") {
        daemonCloudEventsStatus = envelope.payload || null;
        startCloudRuntimeSockets();
        return;
      }
      if (envelope?.type === "daemon.cloud_runtime_status") {
        daemonCloudRuntimeStatus = envelope.payload || null;
        daemonCloudEventsStatus = daemonCloudRuntimeStatus?.events || daemonCloudEventsStatus;
        startCloudRuntimeSockets();
        return;
      }
      broadcastRendererEvent(IpcChannel.CloudEvent, envelope);
    },
    onStateChange: (connected) => {
      const envelope = {
        type: "daemon.local_events_status",
        payload: { connected: Boolean(connected) }
      };
      broadcastRendererEvent(IpcChannel.CloudEvent, envelope);
      startCloudRuntimeSockets();
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
  ensureRuntimeAvailable: requireDaemonRuntimeAvailable,
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
ipcMain.handle(IpcChannel.OnboardingComplete, async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!cloudStatus(false).enabled) {
    showSignedOutOnboardingWindow(win);
    return runtimeStatusWithCoreModelProviders(getRuntimeStatus());
  }
  promoteOnboardingWindowToMain(win);
  return runtimeStatusWithCoreModelProviders(getRuntimeStatus());
});
ipcMain.handle(IpcChannel.WindowSignedOutOnboarding, async (event) => {
  showSignedOutOnboardingWindow(BrowserWindow.fromWebContents(event.sender));
  return runtimeStatusWithCoreModelProviders(getRuntimeStatus());
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
ipcMain.handle(IpcChannel.EngineWorkspaceGet, () => readAgentWorkspaceFromCore());
ipcMain.handle(IpcChannel.EngineWorkspacePick, async (event) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(target, {
    properties: ["openDirectory", "createDirectory"],
    message: "选择 Mia Agent 的工作目录",
  });
  const picked = result.canceled ? "" : (result.filePaths?.[0] || "");
  if (picked) {
    const workspace = await writeAgentWorkspaceToCore(picked);
    return {
      ...workspace,
      changed: true
    };
  }
  const workspace = await readAgentWorkspaceFromCore();
  return {
    ...workspace,
    changed: false
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
ipcMain.handle(IpcChannel.EngineUninstallStandalone, async () => runtimeStatusWithCoreModelProviders(await uninstallStandaloneEngine()));
ipcMain.handle(IpcChannel.AuthCodexStart, async () => runtimeStatusWithCoreModelProviders(await authService.startCodexOAuth()));
ipcMain.handle(IpcChannel.AuthCodexCancel, async () => runtimeStatusWithCoreModelProviders(authService.cancelCodexOAuth()));
ipcMain.handle(IpcChannel.AuthProviderStart, async (_event, provider) => runtimeStatusWithCoreModelProviders(await authService.startProviderOAuth(provider)));
ipcMain.handle(IpcChannel.AuthProviderCancel, async () => runtimeStatusWithCoreModelProviders(authService.cancelProviderOAuth()));
ipcMain.handle(IpcChannel.ChatSend, (event, payload) => sendChat({ ...payload, webContents: event.sender }));
ipcMain.handle(IpcChannel.ChatPermissionRespond, (_event, payload) => agentPermissionProxy.respond(payload || {}));
ipcMain.handle(IpcChannel.ChatPermissionList, (_event, payload) => agentPermissionProxy.list(payload || {}));
ipcMain.handle(IpcChannel.ChatAttachmentSave, (_event, payload) => chatAttachmentCoreAdapter.saveAttachment(payload));
ipcMain.handle(IpcChannel.ChatFileFetch, (_event, payload) => chatAttachmentCoreAdapter.fetchFileAttachment(payload));
ipcMain.handle(IpcChannel.CommandsSlash, () => engineCatalogCoreAdapter.loadHermesSlashCommands());
ipcMain.handle(IpcChannel.CommandsAgentList, async (_event, payload) => externalAgentCommandCoreAdapter.loadCommands(payload));
ipcMain.handle(IpcChannel.CommandsAgentExecute, (_event, payload) => externalAgentCommandCoreAdapter.executeCommand(payload));
ipcMain.handle(IpcChannel.MemoryList, (_event, payload) => listCoreMemory(payload));
ipcMain.handle(IpcChannel.MemoryListAll, (_event, payload) => listAllCoreMemory(payload));
ipcMain.handle(IpcChannel.MemoryRemember, async (_event, payload) => {
  const input = coreMemoryRememberBody(payload);
  const result = await rememberCoreMemory(payload);
  publishRendererMemoryEvent("remember", result, input);
  return result;
});
ipcMain.handle(IpcChannel.MemoryUpdate, async (_event, payload) => {
  const input = coreMemoryUpdateBody(payload);
  const result = await updateCoreMemory(payload);
  publishRendererMemoryEvent("update", result, input);
  return result;
});
ipcMain.handle(IpcChannel.MemoryForget, async (_event, payload) => {
  const input = coreMemoryForgetBody(payload);
  const result = await forgetCoreMemory(payload);
  publishRendererMemoryEvent("forget", result, input);
  return result;
});
ipcMain.handle(IpcChannel.MemoryDelete, async (_event, payload) => {
  const input = coreMemoryDeleteBody(payload);
  const result = await deleteCoreMemory(payload);
  publishRendererMemoryEvent("delete", result, input);
  return result;
});
ipcMain.handle(IpcChannel.MemorySettingsSave, (_event, settings) => writeMemorySettingsToCore(settings || {}));
ipcMain.handle(IpcChannel.ConversationTitleGenerate, (_event, payload) => conversationTitleService.generateTitle(payload));
ipcMain.handle(IpcChannel.ModelCatalog, () => engineCatalogCoreAdapter.loadHermesModelCatalog());
ipcMain.handle(IpcChannel.CodexListModels, () => engineCatalogCoreAdapter.loadCodexModels());
ipcMain.handle(IpcChannel.EngineCapabilities, () => engineCatalogCoreAdapter.loadEngineCapabilities());
ipcMain.handle(IpcChannel.SkillsList, () => skillsLoader.loadLocalSkills());
ipcMain.handle(IpcChannel.PluginsInstall, (_event, extensionId) => skillsLoader.installMarketplacePlugin(extensionId));
ipcMain.handle(IpcChannel.SkillsRead, (_event, skillId) => skillsLoader.readLocalSkill(skillId));
ipcMain.handle(IpcChannel.SkillsDelete, (_event, skillId) => skillsLoader.deleteLocalSkill(skillId));
ipcMain.handle(IpcChannel.SkillsOpenDirectory, (_event, skillId) => skillsLoader.openLocalSkillDirectory(skillId));
ipcMain.handle(IpcChannel.SkillsMarketList, (_event, params) => listDesktopMarketSkills(params || {}));
ipcMain.handle(IpcChannel.SkillsMarketRead, (_event, skillId) => readDesktopMarketSkill(skillId));
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
ipcMain.handle(IpcChannel.AppearanceSave, async (_event, settings) => {
  await cloudDesktopSync().saveAppearanceSettings(settings || {});
  for (const win of BrowserWindow.getAllWindows()) {
    applyWindowsTitleBarOverlay(win, settingsStore.appearanceSettings());
  }
  return runtimeStatusWithCoreModelProviders(getRuntimeStatus());
});

ipcMain.handle(IpcChannel.ProfileSave, async (_event, profile) => {
  await cloudDesktopSync().saveUserProfile(profile || {});
  return runtimeStatusWithCoreModelProviders(getRuntimeStatus());
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

const autoUpdateService = createAutoUpdateService({
  // Lazy: constructs the electron-updater singleton only when the foreground
  // window calls start(), so it's never materialized in the daemon process.
  getAutoUpdater: () => require("electron-updater").autoUpdater,
  isPackaged: app.isPackaged,
  getMainWindow: () => BrowserWindow.getAllWindows()[0] || null,
  getMainWindows: () => BrowserWindow.getAllWindows(),
  sendUpdateEvent: (payload) => broadcastRendererEvent(IpcChannel.UpdateEvent, payload),
  prepareForUpdateInstall: async () => {
    await launchdService.cleanupLegacyNodeCore();
    await stopDaemonService();
  },
  quitApp: () => app.quit(),
});

ipcMain.handle(IpcChannel.UpdateCheck, () => autoUpdateService.checkForUpdates());

app.on("before-quit", () => {
  if (agentSessionManager && typeof agentSessionManager.closeAllSessions === "function") {
    agentSessionManager.closeAllSessions().catch((error) => appendEngineLog(`AgentSession cleanup failed: ${error?.message || error}`));
  }
});

app.whenReady().then(async () => {
  startupTimer.mark("app:ready");
  // Migration branch: the background Core is always a separate Core process,
  // never the Electron GUI app. The obsolete
  // `if (IS_CORE_PROCESS)` Electron daemon-boot branch (dock.hide + control
  // server + cloud sockets + retry interval) was deleted here — Core owns
  // that boot in createMiaCore.startWithCloud(). Electron only ever runs as the
  // window; IS_CORE_PROCESS is false-by-construction in this process now, and
  // its remaining `!IS_CORE_PROCESS` arms are the window-side path. The window
  // still constructs miaCoreControlServer and pings/forwards to the node-Core
  // daemon over 127.0.0.1; startDaemonService launches Mia Rust Core.
  if (!shouldRunDesktopInstance) return;
  startupMcpInitializer.start();
  const win = createWindow();
  startupTimer.mark("window:created");
  autoUpdateService.start();
  startCloudRuntimeSockets(); // foreground clients self-gate; daemon owns runtime sockets
  syncCloudSettingsToCore().catch((error) => appendCloudLog(`Mia Rust Core cloud bootstrap sync failed: ${error?.message || error}`));
  cloudDesktopSync().syncWorkspace()
    .then(() => syncCloudSettingsToCore().catch((error) => appendCloudLog(`Mia Rust Core cloud refresh sync failed: ${error?.message || error}`)))
    .catch((error) => appendCloudLog(`云同步刷新失败：${error?.message || error}`));
  if (!win.miaSkipAutomaticBackgroundStartup && process.env.MIA_DISABLE_BACKGROUND_STARTUP !== "1") {
    win.webContents.once("did-finish-load", () => {
      setTimeout(() => runtimeLifecycle().scheduleBackgroundStartup(), 2500);
    });
  }
});

app.on("window-all-closed", () => {
  authService.cancelCodexOAuth();
  if (IS_CORE_PROCESS) return;
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (IS_CORE_PROCESS) return;
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else if (!cloudStatus(false).enabled) showSignedOutOnboardingWindow(BrowserWindow.getAllWindows()[0]);
});
