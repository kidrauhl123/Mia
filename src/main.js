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
  adapterForEngine,
  normalizeAgentEngine,
  resolveChatEngineAdapter
} = require("./main/chat-engine-registry.js");
const {
  enginePermissionStoreTarget,
  shouldApplyNativePermissionConfig
} = require("./shared/agent-engine-policy.js");
const {
  createChatEngineAdapters,
  createStatelessChatEngineAdapters,
  sendWithChatEngineAdapter,
  sendWithStatelessChatEngineAdapter
} = require("./main/chat-engine-adapters.js");
const { createChatEventEmitter } = require("./main/chat-events.js");
const { createBotExecutionCore } = require("./main/bot-execution-core.js");
const { createBotTurnHelpers } = require("./main/bot-turn-helpers.js");
const { chatCompletionResponse, responseMessageContent } = require("./main/chat-response.js");
const { createAgentCommandProvider } = require("./main/agent-command-provider.js");
const { createClaudeBridgePluginService } = require("./main/claude-bridge-plugin-service.js");
const { requireBot } = require("./main/bot-registry.js");
const {
  closeManagedClaudeProxySessions,
  createClaudeCodeChatAdapter
} = require("./main/claude-code-chat-adapter.js");
const { createClaudeCodeMiaProxy } = require("./main/claude-code-mia-proxy.js");
const { createCodexMiaProxy } = require("./main/codex-mia-proxy.js");
const {
  closeManagedCodexProxySessions,
  createCodexChatAdapter,
  mapCodexPermissionMode
} = require("./main/codex-chat-adapter.js");
const { syncCodexConfigForPermission } = require("./main/codex-config-sync.js");
const { createHermesChatAdapter } = require("./main/hermes-chat-adapter.js");
const {
  closeOpenClawAcpRuntimes,
  createOpenClawChatAdapter
} = require("./main/openclaw-chat-adapter.js");
const { normalizeTurnRuntimeConfig } = require("./main/runtime-config-normalizer.js");
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
const {
  cloudWebSocketUrl: buildCloudWebSocketUrl,
  cloudWebSocketProtocols: buildCloudWebSocketProtocols,
  cloudEventsUrl: buildCloudEventsUrl
} = require("./main/cloud/cloud-events-url.js");
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
const { createModelSettingsService } = require("./main/model-settings-service.js");
const { createConversationTitleService } = require("./main/conversation-title-service.js");
const {
  createMiaCoreControlServer,
  createMiaCoreTasksClient,
  createMiaCoreLocalEventsClient,
  createMiaCoreProcessLauncher,
  coreNeedsReplacement,
  shouldReuseCore
} = require("./main/mia-core/local-process-control.js");
const { createMiaCoreResolver } = require("./main/daemon/executable-resolver.js");
const { windowsTitleBarOverlayForAppearance, applyWindowsTitleBarOverlay } = require("./main/windows-title-bar.js");
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
const { createAgentSessionManager } = require("./main/agent-session/index.js");
const { createAgentPermissionCoordinator } = require("./main/agent-permission-coordinator.js");
const { createAgentPermissionProxy } = require("./main/agent-permission-proxy.js");
const {
  createMiaCoreModelRuntimeResolver,
  isMiaManagedRuntime
} = require("./main/mia-core/model-runtime-resolver.js");
const { createMiaCoreRuntimeService } = require("./main/mia-core/runtime-service.js");
const {
  closeCodexAppServerRuntimes,
  createCodexAppServerConnection,
  runCodexAppServerTurn
} = require("./main/codex-app-server-runner.js");
const { createSchedulerMcpBridge } = require("./main/scheduler-mcp-bridge.js");
const { schedulerSkillIdsForTurn } = require("./main/scheduler-skill-defaults.js");
const { deliverTaskReplyToConversation } = require("./main/task-reply-delivery.js");
const { createSystemHermesService } = require("./main/system-hermes-service.js");
const { createEngineRuntimeConfigService } = require("./main/engine-runtime-config-service.js");
const { createEngineHealthService } = require("./main/engine-health-service.js");
const { createEngineInstallService } = require("./main/engine-install-service.js");
const { registerWindowIpc } = require("./main/ipc/window-ipc.js");
const { registerUtilIpc } = require("./main/ipc/util-ipc.js");
const { registerMcpIpc } = require("./main/ipc/mcp-ipc.js");
const { registerTasksIpc } = require("./main/ipc/tasks-ipc.js");
const { createLocalFileOpenService } = require("./main/local-file-open-service.js");
const { createMcpBridgeServer } = require("./main/mcp/mcp-bridge-server.js");
const { runNativeMcpCliSync } = require("./main/mcp/mcp-engine-sync.js");
const { createMcpSdkClientManager } = require("./main/mcp/mcp-sdk-client.js");
const { createMcpService } = require("./main/mcp/mcp-service.js");
const { createManagedConnectorSupervisor } = require("./core/mcp/managed-connector-supervisor.js");
const { createCoreMcpOAuthService } = require("./core/mcp/oauth-service.js");
const { createCoreMcpOAuthTokenStore } = require("./core/mcp/oauth-token-store.js");
// (cloud/desktop-sync helpers removed in Phase 4 cutover — bot chats
//  now sync via conversations+messages, no need for the workspace-shape mappers.)

const MIA_GATEWAY_SERVICE_LABEL = "ai.mia.hermes.gateway";
const MIA_DAEMON_SERVICE_LABEL = "ai.mia.daemon";
const MIA_DAEMON_DEFAULT_PORT = Number(process.env.MIA_DAEMON_PORT || 27861);
const MIA_CLOUD_DEFAULT_URL = process.env.MIA_CLOUD_URL || "https://mia.gifgif.cn";
const IS_DAEMON_PROCESS = process.argv.includes("--daemon") || process.env.MIA_DAEMON === "1";
const ALLOW_MULTIPLE_INSTANCES = process.env.MIA_ALLOW_MULTIPLE_INSTANCES === "1";

app.setName("Mia");
// Migration slice 5c: the daemon is the standalone node Core, not Electron, so
// the old `if (IS_DAEMON_PROCESS)` daemon-profile userData / MIA_HOME special
// casing was deleted here — Electron always runs as the window. A general
// MIA_USER_DATA_DIR override is still honoured (test isolation / multi-instance).
const isolatedUserDataDir = String(process.env.MIA_USER_DATA_DIR || "").trim();
if (isolatedUserDataDir) {
  app.setPath("userData", path.resolve(isolatedUserDataDir));
}
const startupTimer = createStartupTimer({ scope: "startup" });
const localFileOpenService = createLocalFileOpenService({
  shellOpenPath: (target) => shell.openPath(target)
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
const claudeBridgePluginService = createClaudeBridgePluginService({ runtimePaths });
const claudeCodeMiaProxy = createClaudeCodeMiaProxy({ appendLog: appendEngineLog, fetch });
const codexMiaProxy = createCodexMiaProxy({ appendLog: appendEngineLog, fetch });
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
  getSchedulerMcpSpec: () => schedulerMcpBridge.getSpec(),
  getUserMcpSpecs: () => userMcpService.getEngineSpecs("hermes", { hermesSupportsUrl: true }),
  resolveModelRuntime: (settings, context) => resolveModelRuntime(settings, context)
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
  // Launch the standalone node Core as the daemon (slice 5c: this is now the SOLE
  // daemon target — the legacy-gui/electron-dev GUI-identity daemons are deleted).
  // process.execPath is the Electron GUI executable (NOT node), so we resolve an
  // absolute node via the shared shell-path lookup. When none is found on a
  // packaged build the resolver returns `unresolved` and assertLaunchable() fails
  // closed rather than launching the GUI app as the daemon.
  // DEV: process.defaultApp is true → use the system `node` (shell-path lookup)
  // + the on-disk Core entry (unchanged behaviour). PACKAGED: process.defaultApp
  // is false → the resolver derives the bundled node (<resources>/mia-node) and
  // the unpacked Core entry (app.asar.unpacked/src/core/mia-core.js) from
  // resourcesPath, because a plain node binary cannot require out of app.asar.
  nodePath: () => {
    if (!process.defaultApp) return "";
    try {
      return String(localAgentEngineService?.shellCommandPath?.("node") || "").trim();
    } catch {
      return "";
    }
  },
  coreEntry: () => (process.defaultApp ? path.resolve(__dirname, "core", "mia-core.js") : "")
});
const launchdService = createLaunchdService({
  gatewayServiceLabel: MIA_GATEWAY_SERVICE_LABEL,
  daemonServiceLabel: MIA_DAEMON_SERVICE_LABEL,
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

function miaMemoryEnabled() {
  try {
    return settingsStore.memorySettings().enabled !== false;
  } catch {
    return true;
  }
}

function syncNativeMemoryFilesForAgent(input = {}) {
  if (miaMemoryEnabled()) return miaMemoryService.syncNativeMemoryFiles(input);
  return miaMemoryService.syncNativeMemoryFiles({ ...input, entries: [] });
}

function miaContextSnapshot({ botId = "", sessionId = "", originMessageId = "" } = {}) {
  const key = String(botId || "mia").trim() || "mia";
  const localSessionId = String(sessionId || "default").trim() || "default";
  let bot = null;
  try {
    bot = (loadBotManifest().bots || []).find((item) => String(item?.key || item?.id || "") === key) || null;
  } catch {
    bot = null;
  }
  const name = bot?.name || key;
  const bio = bot?.bio || "";
  return {
    userId: miaMemoryService.currentUserId(),
    botId: key,
    sessionId: localSessionId,
    originMessageId: String(originMessageId || ""),
    generatedAt: Date.now(),
    persona: readBotPersona(key, name, bio),
    memory: "",
    memoryTools: {
      enabled: miaMemoryEnabled(),
      search: "memory_search",
      remember: "memory_remember",
      update: "memory_update",
      forget: "memory_forget"
    },
    skillTools: {
      listCurrent: "skill_list_current",
      readCurrent: "skill_read_current"
    }
  };
}

function botForMiaContext(botId = "") {
  const key = String(botId || "mia").trim() || "mia";
  try {
    const bot = (loadBotManifest().bots || []).find((item) => String(item?.key || item?.id || "") === key) || null;
    return bot || { key, id: key, name: key, capabilities: { enabledSkills: [] } };
  } catch {
    return { key, id: key, name: key, capabilities: { enabledSkills: [] } };
  }
}

function miaCurrentSkills({ botId = "", skillId = "" } = {}) {
  const bot = botForMiaContext(botId);
  const key = String(bot?.key || bot?.id || botId || "mia").trim() || "mia";
  if (skillId) {
    return {
      botId: key,
      skill: skillsLoader.readCurrentBotSkill(bot, skillId)
    };
  }
  return {
    botId: key,
    skills: skillsLoader.listCurrentBotSkills(bot)
  };
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

function publishRendererMemoryEvent(reason = "memory", result = {}, scope = {}) {
  const envelope = memoryChangedEnvelope(reason, result, { eventSource: "ui", ...scope });
  broadcastRendererEvent(IpcChannel.CloudEvent, envelope);
}

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
  enginePermissionMode: settingsStore.enginePermissionMode,
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
const miaCoreModelRuntimeResolver = createMiaCoreModelRuntimeResolver({
  cloudStatus,
  normalizeCloudUrl: settingsStore.normalizeCloudUrl,
  providerConnection: (provider) => providerConnections.get(provider),
  modelSettings
});
const miaCoreRuntime = createMiaCoreRuntimeService({
  normalizeAgentEngine,
  enginePermissionStoreTarget
});
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
  timeEngineStepAsync,
  shellCommandPath: (command) => localAgentEngineService.shellCommandPath(command),
  processEnvStrings,
  ensureCodexHome: (options) => schedulerMcpBridge.ensureCodexHome(options),
  createCodexAppServerConnection,
  claudeAgentSdk,
  cwd: () => process.cwd()
});
let claudeAgentSdkModule = null;
let remoteControlRouter = null;
let miaCoreControlServer = null;
let miaCoreTasksClient = null;
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
  daemonStatus: () => miaCoreControlServer?.status() || {},
  daemonSettings: () => settingsStore.daemonSettings(),
  daemonToken,
  nodePath: () => localAgentEngineService.shellCommandPath("node"),
  serverScriptPath: () => path.join(__dirname, "main", "scheduler-mcp-server.js"),
  homeDir: () => os.homedir()
});
const miaAppMcpBridge = createMiaAppMcpBridge({
  runtimePaths,
  daemonStatus: () => miaCoreControlServer?.status() || {},
  daemonSettings: () => settingsStore.daemonSettings(),
  daemonToken,
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

function processEnvStrings() {
  return Object.fromEntries(Object.entries(localAgentEngineService.processEnvWithCliPath()).filter(([, value]) => typeof value === "string"));
}

const userMcpOAuthTokenStore = createCoreMcpOAuthTokenStore({ runtimePaths, fs });
const userMcpOAuthService = createCoreMcpOAuthService({
  tokenStore: userMcpOAuthTokenStore,
  fetch,
  openExternal: (url) => shell.openExternal(url)
});
const userMcpManager = createMcpSdkClientManager({
  processEnvStrings,
  appendLog: appendEngineLog,
  oauthService: userMcpOAuthService,
  authorizeToolCall: async ({ args, options = {} }) => {
    const toolLabel = String(options.toolLabel || "").trim() || "mcp.tool";
    let preview = "";
    try {
      preview = args ? JSON.stringify(args, null, 2).slice(0, 4000) : "";
    } catch {
      preview = "";
    }
    const decision = await agentPermissionCoordinator.requestPermission({
      engine: String(options.engine || "mcp"),
      botId: String(options.botId || ""),
      sessionId: String(options.sessionId || ""),
      signal: options.signal,
      emit: options.emit,
      toolName: toolLabel,
      title: String(options.title || `MCP 请求使用 ${toolLabel}`),
      description: String(options.description || ""),
      preview,
      input: args && typeof args === "object" ? args : {}
    });
    return {
      allowed: String(decision?.decision || "").startsWith("allow"),
      reason: decision?.message || "MCP 工具调用已被拒绝。"
    };
  }
});
const userMcpBridge = createMcpBridgeServer({
  manager: userMcpManager,
  secret: crypto.randomUUID(),
  appendLog: appendEngineLog
});
const userMcpService = createMcpService({
  runtimePaths,
  manager: userMcpManager,
  bridge: userMcpBridge,
  nativeSync: (payload) => runNativeMcpCliSync({
    ...payload,
    cliPaths: { codex: "codex", claude: "claude" },
    runCommand: execFileAsPromise,
    appendLog: appendEngineLog
  }),
  nodePath: () => localAgentEngineService.shellCommandPath("node"),
  stdioProxyScriptPath: () => path.join(__dirname, "main", "mcp", "mcp-stdio-proxy-server.js"),
  oauthTokenStore: userMcpOAuthTokenStore,
  oauthService: userMcpOAuthService,
  managedSupervisor: createManagedConnectorSupervisor({
    runtimePaths,
    fs,
    fetch,
    testTools: (record) => userMcpManager.testServer(record)
  })
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
      isDaemonProcess: IS_DAEMON_PROCESS,
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
  isDaemonEnabled: () => settingsStore.daemonSettings().enabled,
  refreshSystemHermesAsync: systemHermesService.refresh,
  setDaemonLastError: (message) => miaCoreControlServer?.setLastError(message),
  setEngineLastError: (message) => { engineState.lastError = message; },
  shouldStartEngine: () => IS_DAEMON_PROCESS,
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
    memory: settingsStore.memorySettings(),
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
      stdio: ["ignore", "pipe", "pipe"],
      ...(process.platform === "win32" ? { windowsHide: true } : {})
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
  miaCoreControlServer.appendLog(line);
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
  const snapshotBot = miaCoreRuntime.cloudBotSnapshotForTurn(botSnapshot, botKey, runtimeConfig);
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
    messages: body?.suppressUserMessage ? [savedAssistant] : [savedUser, savedAssistant],
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
    deliverTaskMessage: async ({ task, runId, conversationId, text }) => {
      const { bot } = resolveRemoteChatBot({ botKey: task.botId });
      if (!bot) throw new Error("Bot not found.");
      const cloud = settingsStore.cloudSettings();
      const fallbackConversationId = cloud?.user?.id ? botConversationId(`${cloud.user.id}_${bot.key}`) : "";
      return deliverTaskReplyToConversation({
        socialApi,
        settingsStore,
        bot,
        conversationId,
        fallbackConversationId,
        assistantText: text,
        assistantTracePayload: {},
        taskRunId: runId,
        fallbackMessageId: `task_${task.id}_${runId}`
      });
    },
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
  if (IS_DAEMON_PROCESS) return miaCoreControlServer.start(settings);
  const expectedRuntimeHome = runtimePaths().home;
  const expectedDaemonTarget = miaCoreResolver.describe();
  const existing = await miaCoreControlServer.ping(settings, 500, { expectedRuntimeHome });
  if (existing.ok && existing.mode === "daemon") {
    // A KeepAlive launchd daemon survives app updates, so the freshly-updated
    // window can find an old-version daemon still owning cloud events + bot
    // execution. Reuse it only when versions match AND it is NOT running under
    // the GUI app identity (an old `Electron --daemon` is migrated to node-core,
    // not kept). Otherwise fall through to launchdService.startDaemon() below,
    // which rewrites the plist and bootout+bootstraps a daemon running this
    // app's code as the node Core.
    if (shouldReuseCore(existing, app.getVersion(), { expectedDaemonTarget })) {
      return { ...getDaemonStatus(), running: true, baseUrl: existing.baseUrl };
    }
    if (coreNeedsReplacement(existing, app.getVersion())) {
      appendDaemonLog(`Daemon version ${existing.version || "(none)"} != app ${app.getVersion()}; replacing.`);
    } else if (existing.daemonTarget?.usesGuiAppIdentity === true || !existing.daemonTarget) {
      appendDaemonLog(`Daemon target ${existing.daemonTarget?.kind || "(unknown)"} uses GUI app identity or is unreported; migrating to node-core.`);
    } else {
      appendDaemonLog(`Daemon target ${existing.daemonTarget?.workingDirectory || existing.daemonTarget?.command || "(unknown)"} != expected ${expectedDaemonTarget.workingDirectory || expectedDaemonTarget.command || "(unknown)"}; replacing.`);
    }
  } else if (existing.ok) {
    appendDaemonLog(`Ignoring ${existing.mode || "unknown"} process on daemon port; a real daemon process is required.`);
  }
  // Fail closed: node-core is the sole daemon target. On a degenerate packaged
  // build that cannot resolve the bundled node Core the resolver returns
  // `unresolved` and this throws, rather than launching the GUI app as the daemon
  // (the deleted legacy-gui path). node-core / bundled-cli (non-darwin) pass.
  miaCoreResolver.assertLaunchable();
  if (process.platform === "darwin") {
    await launchdService.startDaemon();
    for (let i = 0; i < 20; i += 1) {
      const ping = await miaCoreControlServer.ping(settings, 500, { expectedRuntimeHome });
      // Only accept once the *replacement* node-core daemon answers: during
      // bootout/kickstart the old daemon can still briefly hold the port, so
      // require shouldReuseCore (version match + non-GUI target) or the stale
      // GUI-identity one would be accepted and replaced again next launch.
      if (shouldReuseCore(ping, app.getVersion(), { expectedDaemonTarget })) {
        return { ...getDaemonStatus(), running: true, baseUrl: ping.baseUrl };
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error("Timed out waiting for Mia daemon LaunchAgent.");
  }
  miaCoreControlServer.stop();
  await miaCoreProcessLauncher.start();
  for (let i = 0; i < 20; i += 1) {
    const ping = await miaCoreControlServer.ping(settings, 500, { expectedRuntimeHome });
    if (shouldReuseCore(ping, app.getVersion(), { expectedDaemonTarget })) {
      return { ...getDaemonStatus(), running: true, baseUrl: ping.baseUrl };
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("Timed out waiting for Mia daemon process.");
}

async function stopDaemonService() {
  if (process.platform === "darwin" && !IS_DAEMON_PROCESS) {
    await launchdService.stopDaemon();
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

function daemonUnavailableError() {
  const error = new Error("Mia Core 未运行，Mia 暂不可用。");
  error.status = 503;
  return error;
}

function requireDaemonRuntimeAvailable() {
  if (IS_DAEMON_PROCESS) return;
  if (daemonLocalEventsConnected()) return;
  throw daemonUnavailableError();
}

function daemonReportedEventsStatus() {
  return daemonCloudRuntimeStatus?.events || daemonCloudEventsStatus || null;
}

function daemonReportedBridgeStatus() {
  return daemonCloudRuntimeStatus?.bridge || null;
}

function daemonOwnsCloudEvents() {
  if (IS_DAEMON_PROCESS) return Boolean(settingsStore?.daemonSettings?.().enabled);
  if (!settingsStore?.daemonSettings?.().enabled) return false;
  if (!daemonLocalEventsConnected()) return false;
  const upstream = daemonReportedEventsStatus();
  return upstream?.connected !== false;
}

function daemonOwnsCloudBridge() {
  if (IS_DAEMON_PROCESS) return Boolean(settingsStore?.daemonSettings?.().enabled);
  if (!settingsStore?.daemonSettings?.().enabled) return false;
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
  if (!IS_DAEMON_PROCESS) {
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
  if (!IS_DAEMON_PROCESS) {
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

let cloudMemorySyncTimer = null;
function scheduleCloudMemorySync(reason = "memory") {
  if (cloudMemorySyncTimer) clearTimeout(cloudMemorySyncTimer);
  cloudMemorySyncTimer = setTimeout(() => {
    cloudMemorySyncTimer = null;
    try {
      cloudDesktopSync().syncMemories().catch((error) => {
        appendCloudLog(`Cloud memory sync failed (${reason}): ${error?.message || error}`);
      });
    } catch (error) {
      appendCloudLog(`Cloud memory sync unavailable (${reason}): ${error?.message || error}`);
    }
  }, 1000);
  if (cloudMemorySyncTimer && typeof cloudMemorySyncTimer.unref === "function") cloudMemorySyncTimer.unref();
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

function cloudWebSocketUrl(pathname, settings = settingsStore.cloudSettings()) {
  return buildCloudWebSocketUrl(pathname, settings);
}

function cloudWebSocketProtocols(settings = settingsStore.cloudSettings()) {
  return buildCloudWebSocketProtocols(settings);
}

function cloudEventsUrl(settings = settingsStore.cloudSettings()) {
  return buildCloudEventsUrl(settings);
}

function bridgeEngineIdsFromView(engines = {}) {
  const ids = [];
  if (engines.hermes?.available || engines.hermes?.installed) ids.push("hermes");
  if (engines.claudeCode?.available) ids.push("claude-code");
  if (engines.codex?.available) ids.push("codex");
  if (engines.openClaw?.available || engines.openClaw?.installed) ids.push("openclaw");
  return ids;
}

function localBridgeEngineIds() {
  let engines = localAgentEngineService?.cachedLocalAgentEngines?.() || {};
  let ids = bridgeEngineIdsFromView(engines);
  if (IS_DAEMON_PROCESS && !ids.length && typeof localAgentEngineService?.localAgentEngines === "function") {
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

function cloudBridgeUrl(settings = settingsStore.cloudSettings()) {
  const url = cloudWebSocketUrl("/api/bridge", settings);
  const bridgeEngineIds = localBridgeEngineIds();
  const deviceIdentity = localDeviceIdentity();
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
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    deviceFingerprint: localDeviceFingerprint(),
    deviceCreatedAt: deviceIdentity.createdAt || ""
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

  writeRuntimeConfig(port);
  const settings = modelSettings();
  const dotenv = systemHermesService.loadDotenv();
  const modelRuntimeEnv = typeof engineRuntimeConfigService.modelRuntimeEnv === "function"
    ? engineRuntimeConfigService.modelRuntimeEnv()
    : {};
  const env = {
    ...process.env,
    ...dotenv,
    ...modelRuntimeEnv,
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

function writeModelSettings(next) {
  const p = runtimePaths();
  fs.writeFileSync(p.modelSettings, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  writeRuntimeConfig(engineState.port || 8642);
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
  return miaCoreModelRuntimeResolver.resolveMiaManagedModelSettings(settings);
}

function resolveModelRuntime(config = {}, context = {}) {
  return miaCoreModelRuntimeResolver.resolveModelRuntime(config, context);
}

function resolveManagedModelRuntime(config = {}, context = {}) {
  const runtime = resolveModelRuntime(config, context);
  return isMiaManagedRuntime(runtime) ? runtime : null;
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
    recoverHermesAfterFailure: recoverHermesChatEngineAfterFailure,
    sendClaudeCodeStateless: claudeAdapter.sendStateless,
    sendCodexStateless: codexAdapter.sendStateless,
    sendHermesStateless: hermesAdapter.sendStateless,
    sendOpenClawStateless: openClawAdapter.sendStateless
  });
}

async function sendChatStateless({ botKey, botSnapshot = null, runtimeConfig = null, systemPrompt, userPrompt, signal }) {
  const snapshotBot = miaCoreRuntime.cloudBotSnapshotForTurn(botSnapshot, botKey, runtimeConfig);
  let bot = snapshotBot;
  if (!bot) {
    const manifest = loadBotManifest();
    ({ bot } = requireBot(manifest, botKey, "还没有可用的 bot，请先在引导里创建一个再发起对话。"));
  }
  const runtimeAgentEngine = String(runtimeConfig?.agentEngine || runtimeConfig?.agent_engine || "").trim();
  const chatEngine = resolveChatEngineAdapter(bot);
  return sendWithStatelessChatEngineAdapter(createActiveStatelessChatEngineAdapters(), {
    chatEngine,
    bot: miaCoreRuntime.botWithRuntimeConfig(bot, normalizeTurnRuntimeConfig(runtimeConfig), { agentEngine: runtimeAgentEngine }),
    systemPrompt,
    userPrompt,
    signal
  });
}

async function ensureHermesChatEngineReady() {
  const wasMarkedRunning = Boolean(engineState.running && engineState.baseUrl);
  const stillHealthy = await engineHealthService.refreshRunningEngineHealth();
  if (wasMarkedRunning && !stillHealthy && engineProcess) {
    try { engineProcess.kill("SIGTERM"); } catch { /* stale process may already be gone */ }
    engineProcess = null;
    appendEngineLog("Hermes API became unreachable; restarting through Mia Core.");
  }
  if (!engineState.running || !engineState.baseUrl) {
    await startEngine();
  }
}

async function recoverHermesChatEngineAfterFailure(error) {
  appendEngineLog(`Hermes API request failed during chat; restarting through Mia Core before retry. ${error?.message || error}`);
  await stopEngine();
  return startEngine();
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
    buildGroupHeader: _noopGroupHeader,
    buildRunPayload: hermesRunService.buildRunPayload,
    normalizeError: hermesRunService.normalizeError,
    readRunEventStream: hermesRunService.readRunEventStream,
    responseModel: adapterForEngine("hermes").responseModel,
    writeSchedulerMcpContext: schedulerMcpBridge.writeContext,
    writeMiaAppMcpContext: miaAppMcpBridge.writeContext,
    getMiaAppMcpSpec: miaAppMcpBridge.getSpec,
    resolveModelRuntime,
    writeModelRuntimeConfig: (settings) => writeRuntimeConfig(engineState.port || readConfiguredPort(), {
      modelSettings: settings
    }),
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
    ensureUserMcpReady: () => ensureUserMcpReady("Claude Code chat"),
    expandLeadingSkillCommand: skillsLoader.expandLeadingSkillCommand,
    clearAgentSessionEntry: agentSessionStore.deleteEntry,
    enginePermissionMode: settingsStore.enginePermissionMode,
    ensureMiaClaudeProxy: (managedModel) => claudeCodeMiaProxy.createSession(managedModel),
    getAgentSessionEntry: agentSessionStore.getEntry,
    getMcpFingerprint: userMcpService.fingerprint,
    getMiaAppMcpSpec: miaAppMcpBridge.getSpec,
    getSchedulerMcpSpec: schedulerMcpBridge.getSpec,
    getUserMcpSpecs: () => userMcpService.getEngineSpecs("claude-code"),
    injectGroupContextForSdk: _passthroughGroupContext,
    lastUserPrompt: hermesRunService.lastUserPrompt,
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
    chatCompletionResponse,
    cwd: agentWorkspaceDir,
    appendEngineLog,
    enginePermissionMode: settingsStore.enginePermissionMode,
    ensureCodexHome: schedulerMcpBridge.ensureCodexHome,
    ensureMiaCodexProxy: (managedModel) => codexMiaProxy.createSession(managedModel),
    ensureUserMcpReady: () => ensureUserMcpReady("Codex chat"),
    expandLeadingSkillCommand: skillsLoader.expandLeadingSkillCommand,
    getAgentSessionEntry: agentSessionStore.getEntry,
    getAgentSessionId: agentSessionStore.getId,
    getMcpFingerprint: userMcpService.fingerprint,
    getMiaAppMcpSpec: miaAppMcpBridge.getSpec,
    getSchedulerMcpSpec: schedulerMcpBridge.getSpec,
    getUserMcpSpecs: () => userMcpService.getEngineSpecs("codex"),
    injectGroupContextForSdk: _passthroughGroupContext,
    lastUserPrompt: hermesRunService.lastUserPrompt,
    normalizeEffortLevel: settingsStore.normalizeEffortLevel,
    permissionCoordinator: agentPermissionCoordinator,
    processEnvStrings,
    readBotPersona,
    resolveModelRuntime,
    runCodexAppServerTurn,
    setAgentSessionEntry: agentSessionStore.setEntry,
    setAgentSessionId: agentSessionStore.setId,
    agentRuntimeEnv: localAgentEngineService.agentRuntimeEnv,
    resolveAgentRuntime: localAgentEngineService.resolveAgentRuntime,
    shellCommandPath: localAgentEngineService.shellCommandPath,
    writeSchedulerMcpContext: schedulerMcpBridge.writeContext
  });
}

function createActiveOpenClawChatAdapter() {
  return createOpenClawChatAdapter({
    chatCompletionResponse,
    cwd: agentWorkspaceDir,
    appendEngineLog,
    enginePermissionMode: settingsStore.enginePermissionMode,
    ensureUserMcpReady: () => ensureUserMcpReady("OpenClaw chat"),
    expandLeadingSkillCommand: skillsLoader.expandLeadingSkillCommand,
    getAgentSessionId: agentSessionStore.getId,
    getMiaAppMcpSpec: miaAppMcpBridge.getSpec,
    getMcpFingerprint: userMcpService.fingerprint,
    getUserMcpServers: (options) => userMcpService.getEngineSpecs("openclaw", options),
    injectGroupContextForSdk: _passthroughGroupContext,
    lastUserPrompt: hermesRunService.lastUserPrompt,
    normalizeEffortLevel: settingsStore.normalizeEffortLevel,
    permissionCoordinator: agentPermissionCoordinator,
    processEnvStrings,
    readBotPersona,
    resolveModelRuntime,
    runtimePaths,
    setAgentSessionId: agentSessionStore.setId,
    shellCommandPath: localAgentEngineService.shellCommandPath,
    syncNativeMemoryFiles: syncNativeMemoryFilesForAgent
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
    recoverHermesAfterFailure: recoverHermesChatEngineAfterFailure,
    hermesSlashCommandResponse: hermesAdapter.slashCommandResponse,
    runExternalSlashCommand: (input) => externalAgentCommandService.runSlashCommand(input),
    runHermesSlashCommand: hermesSlashCommandService.run,
    sendClaudeCodeChat: claudeAdapter.sendChat,
    sendCodexChat: codexAdapter.sendChat,
    sendHermesChat: hermesAdapter.sendChat,
    sendOpenClawChat: openClawAdapter.sendChat
  });
}

async function createAppScheduledTask(input) {
  const result = await miaCoreTasksClient.call("/api/tasks", {
    method: "POST",
    body: JSON.stringify(input)
  });
  return result.task;
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

// `cloudBotSnapshotForTurn` and `botWithRuntimeConfig` now live in
// src/main/bot-turn-helpers.js so the standalone Mia Core node process builds
// the same turn-normalization pipeline — no fork. Behaviour is byte-identical;
// the only deps are the two shared engine-policy functions already imported.
const { botWithRuntimeConfig, cloudBotSnapshotForTurn } = createBotTurnHelpers({
  normalizeAgentEngine,
  enginePermissionStoreTarget
});
const agentSessionManager = createAgentSessionManager();

// Single shared bot-execution core: `sendChat`/`stopChat` (and the single-flight
// abort state) live in src/main/bot-execution-core.js so the standalone Mia Core
// node process drives the exact same implementation — no fork. Late-bound deps
// (localBotResponder, miaCoreTasksClient, settingsStore) are injected as accessors
// because they are constructed after this point / reassigned at runtime.
const botExecutionCore = createBotExecutionCore({
  createChatEventEmitter,
  cloudBotSnapshotForTurn,
  loadBotManifest,
  requireBot,
  normalizeTurnRuntimeConfig,
  botWithRuntimeConfig,
  normalizeAgentEngine,
  resolveChatEngineAdapter,
  botPetService,
  responseMessageContent,
  schedulerSkillIdsForTurn,
  skillsLoader,
  hermesRunService,
  sendWithChatEngineAdapter,
  createActiveChatEngineAdapters,
  agentSessionManager,
  localBotResponder: () => localBotResponder,
  isDaemonProcess: IS_DAEMON_PROCESS,
  daemonTasksClient: () => miaCoreTasksClient,
  settingsStore: () => settingsStore,
  appendCloudLog,
  miaMemoryService,
  isMemoryEnabled: miaMemoryEnabled,
  onMemoryExtracted: (result, scope) => publishRendererMemoryEvent("remember", result, scope)
});

function sendChat(payload) {
  return botExecutionCore.sendChat(payload);
}

function stopChat(payload = {}) {
  return botExecutionCore.stopChat(payload);
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
  setMacNativeControlsVisible(win, false);
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

function applyNativePermissionConfig(settings = {}) {
  const engine = normalizeAgentEngine(settings.engine || settings.agentEngine || settings.agent_engine || "");
  if (!shouldApplyNativePermissionConfig(engine)) return;
  try {
    syncCodexConfigForPermission(
      mapCodexPermissionMode(settingsStore.enginePermissionMode("codex")),
      { appendLog: appendEngineLog }
    );
  } catch (error) {
    appendEngineLog(`Codex permission config sync failed: ${error?.message || error}`);
  }
}

function writePermissionSettingsAndApply(settings = {}) {
  const next = settingsStore.writePermissionSettings(settings);
  applyNativePermissionConfig(settings);
  return next;
}

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
  writePermissionSettings: writePermissionSettingsAndApply,
  stopChat,
  runRemoteChatRequest
});

miaCoreControlServer = createMiaCoreControlServer({
  isDaemonProcess: IS_DAEMON_PROCESS,
  serviceLabel: MIA_DAEMON_SERVICE_LABEL,
  daemonToken,
  appVersion: () => app.getVersion(),
  describeDaemonTarget: () => {
    // When this process IS the launched daemon, prefer the target identity the
    // launcher stamped into env (MIA_DAEMON_TARGET_KIND) so /health reports the
    // SAME target the resolver chose, without re-resolving process.resourcesPath.
    const kind = String(process.env.MIA_DAEMON_TARGET_KIND || "").trim();
    if (IS_DAEMON_PROCESS && kind) {
      return {
        kind,
        command: path.basename(process.execPath),
        usesGuiAppIdentity: String(process.env.MIA_DAEMON_USES_GUI_IDENTITY || "") === "1",
        workingDirectory: process.cwd()
      };
    }
    return miaCoreResolver.describe();
  },
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
  agentPermissionCoordinator,
  miaMemoryService,
  isMemoryEnabled: miaMemoryEnabled,
  onMemoryChanged: scheduleCloudMemorySync,
  initSchedulerSubsystem,
  tasksRoutes: () => tasksRoutes,
  getMiaContextSnapshot: miaContextSnapshot,
  getMiaCurrentSkills: miaCurrentSkills,
  getCloudSettings: () => settingsStore.cloudSettings(),
  normalizeCloudUrl: settingsStore.normalizeCloudUrl,
  fetchImpl: fetch,
  timeoutSignal: (timeoutMs) => AbortSignal.timeout(timeoutMs)
});

miaCoreTasksClient = createMiaCoreTasksClient({
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

agentPermissionProxy = createAgentPermissionProxy({
  isDaemonProcess: IS_DAEMON_PROCESS,
  coordinator: agentPermissionCoordinator,
  daemonClient: {
    call: (...args) => miaCoreTasksClient.call(...args)
  }
});

registerWindowIpc({ ipcMain, startupTimer, runtimeLifecycle });
registerUtilIpc({ ipcMain, openLocalFile: localFileOpenService.openLocalFile });
registerMcpIpc({ ipcMain, mcpService: userMcpService });

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
  settingsStore.writeDaemonSettings(settings);
  startCloudRuntimeSockets();
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
ipcMain.handle(IpcChannel.CloudModelBalance, () => fetchCloudModelBalance());
ipcMain.handle(IpcChannel.CloudLogin, async (_event, payload) => {
  requireDaemonRuntimeAvailable();
  const result = await loginMiaCloud(payload || {});
  if (result?.kind === "wechat-login-start" || result?.kind === "wechat-login-pending") return result;
  return getRuntimeStatus();
});
// Phase 3: cross-device settings (pin / read marks / appearance). Renderer
// asks main for current bag; mutations PUT to /api/me/settings whose
// broadcast comes back via the WS event handler and is re-broadcast to
// the renderer.
ipcMain.handle(IpcChannel.CloudSettingsGet, async () => {
  try {
    requireDaemonRuntimeAvailable();
    return await cloudSettingsGet();
  } catch (error) {
    if (error?.status === 503) throw error;
    appendCloudLog(`Cloud settings get failed: ${error?.message || error}`);
    return { pins: [], readMarks: {}, appearance: {} };
  }
});
ipcMain.handle(IpcChannel.CloudSettingsPut, async (_event, settings) => {
  try {
    requireDaemonRuntimeAvailable();
    return await cloudSettingsPut(settings || {});
  } catch (error) {
    appendCloudLog(`Cloud settings put failed: ${error?.message || error}`);
    throw error;
  }
});
ipcMain.handle(IpcChannel.CloudLogout, async (event) => {
  requireDaemonRuntimeAvailable();
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
// ADR P3: daemon-process credential writes are the only local file writes.
// Foreground credential writes route through the daemon and fail if it is down.
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
  memoryService: miaMemoryService,
  skillMarketCache
});
cloudBridgeRuntime = createCloudBridgeClient({
  WebSocketImpl: WebSocket,
  getSettings: () => settingsStore.cloudSettings(),
  isDaemonProcess: IS_DAEMON_PROCESS,
  isDaemonEnabled: () => daemonOwnsCloudBridge(),
  cloudBridgeUrl,
  cloudWebSocketProtocols,
  createActiveBridgeChatAdapter,
  createActiveCodexChatAdapter,
  resetLocalDeviceIdentity,
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
  listConversationMessages: (conversationId, sinceSeq, limit) => socialApi.listConversationMessages(conversationId, sinceSeq, limit),
  fetchFileAttachment: safeFetchFileAttachment,
  emitCloudEvent: (message) => {
    const envelope = {
      type: message.type,
      payload: message
    };
    broadcastRendererEvent(IpcChannel.CloudEvent, envelope);
    // The daemon has no windows: push run streams (typing, token deltas,
    // tool traces) to the window over the local channel (ADR P0).
    if (IS_DAEMON_PROCESS) miaCoreControlServer?.publishLocalEvent?.(envelope);
  },
  log: (line) => appendCloudLog(line),
  artifactWorkspaceDir: agentWorkspaceDir,
  agentSessionManager
});
async function shouldHandleCloudConversationAi() {
  const daemonSettings = settingsStore.daemonSettings();
  return shouldHandleLocalCloudConversationAi({
    isDaemon: IS_DAEMON_PROCESS,
    daemonEnabled: daemonSettings.enabled
  });
}
const mainBotRuntimeDispatcher = createMainBotRuntimeDispatcher({
  shouldHandle: shouldHandleCloudConversationAi,
  currentDeviceId: () => localDeviceId(),
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
    if (IS_DAEMON_PROCESS) miaCoreControlServer?.publishLocalEvent?.(envelope);
  },
  cloudEventChannel: IpcChannel.CloudEvent,
  appendCloudLog,
  botRuntimeDispatcher: mainBotRuntimeDispatcher,
  memorySync: () => cloudDesktopSync().syncMemories(),
  messageCache: conversationMessageCache,
  persistCursor: () => IS_DAEMON_PROCESS,
  isDaemonProcess: IS_DAEMON_PROCESS,
  isDaemonEnabled: () => daemonOwnsCloudEvents()
});
// ADR P0/P2: the window listens to the daemon's local event stream and replays
// the envelopes to its renderers — bot run streams (typing / token deltas /
// tool traces) and, with the daemon enabled, the entire cloud event feed.
if (!IS_DAEMON_PROCESS) {
  localEventsRuntime = createMiaCoreLocalEventsClient({
    baseUrl: () => {
      const daemonSettings = settingsStore.daemonSettings();
      return `http://${daemonSettings.host}:${daemonSettings.port}`;
    },
    daemonToken,
    enabled: () => settingsStore.daemonSettings().enabled,
    onEnvelope: (envelope) => {
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
    onStateChange: () => {
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
ipcMain.handle(IpcChannel.EngineUninstallStandalone, () => uninstallStandaloneEngine());
ipcMain.handle(IpcChannel.AuthCodexStart, () => authService.startCodexOAuth());
ipcMain.handle(IpcChannel.AuthCodexCancel, () => authService.cancelCodexOAuth());
ipcMain.handle(IpcChannel.AuthProviderStart, (_event, provider) => authService.startProviderOAuth(provider));
ipcMain.handle(IpcChannel.AuthProviderCancel, () => authService.cancelProviderOAuth());
ipcMain.handle(IpcChannel.ChatSend, (event, payload) => sendChat({ ...payload, webContents: event.sender }));
ipcMain.handle(IpcChannel.ChatSendStateless, (_event, payload) => sendChatStateless(payload));
ipcMain.handle(IpcChannel.ChatStop, (_event, payload) => stopChat(payload || {}));
ipcMain.handle(IpcChannel.ChatPermissionRespond, (_event, payload) => agentPermissionProxy.respond(payload || {}));
ipcMain.handle(IpcChannel.ChatPermissionList, (_event, payload) => agentPermissionProxy.list(payload || {}));
ipcMain.handle(IpcChannel.ChatAttachmentSave, (_event, payload) => saveChatAttachment(payload));
ipcMain.handle(IpcChannel.ChatFileFetch, (_event, payload) => safeFetchFileAttachment(payload));
ipcMain.handle(IpcChannel.CommandsSlash, () => engineCatalogService.loadHermesSlashCommands());
ipcMain.handle(IpcChannel.CommandsAgentList, async (_event, payload) => externalAgentCommandService.loadCommands(payload));
ipcMain.handle(IpcChannel.CommandsAgentExecute, (_event, payload) => externalAgentCommandService.executeCommand(payload));
ipcMain.handle(IpcChannel.MemoryList, (_event, payload) => miaMemoryService.listMemories(rendererMemoryListInput(payload)));
ipcMain.handle(IpcChannel.MemoryListAll, (_event, payload) => miaMemoryService.listAllMemories(rendererMemoryManagementInput(payload)));
ipcMain.handle(IpcChannel.MemoryRemember, (_event, payload) => {
  const input = rendererRememberMemoryInput(payload);
  const result = miaMemoryService.rememberMemory(input);
  scheduleCloudMemorySync("remember");
  publishRendererMemoryEvent("remember", result, input);
  return result;
});
ipcMain.handle(IpcChannel.MemoryUpdate, (_event, payload) => {
  const input = rendererUpdateMemoryInput(payload);
  const result = miaMemoryService.updateMemory(input);
  scheduleCloudMemorySync("update");
  publishRendererMemoryEvent("update", result, input);
  return result;
});
ipcMain.handle(IpcChannel.MemoryForget, (_event, payload) => {
  const input = rendererForgetMemoryInput(payload);
  const result = miaMemoryService.forgetMemory(input);
  scheduleCloudMemorySync("forget");
  publishRendererMemoryEvent("forget", result, input);
  return result;
});
ipcMain.handle(IpcChannel.MemoryDelete, (_event, payload) => {
  const input = rendererMemoryIdInput(payload);
  const result = miaMemoryService.deleteMemory(input);
  scheduleCloudMemorySync("delete");
  publishRendererMemoryEvent("delete", result, input);
  return result;
});
ipcMain.handle(IpcChannel.MemorySettingsSave, (_event, settings) => {
  settingsStore.writeMemorySettings(settings || {});
  return getRuntimeStatus();
});
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
ipcMain.handle(IpcChannel.PermissionsSave, async (_event, settings) => {
  writePermissionSettingsAndApply(settings);
  return getRuntimeStatus();
});
ipcMain.handle(IpcChannel.EffortSave, async (_event, settings) => {
  settingsStore.writeEffortSettings(settings);
  return getRuntimeStatus();
});
ipcMain.handle(IpcChannel.ModelSave, (_event, settings) => modelSettingsService.saveModelSelection(resolveMiaManagedModelSettings(settings)));

ipcMain.handle(IpcChannel.AppearanceSave, async (_event, settings) => {
  await cloudDesktopSync().saveAppearanceSettings(settings || {});
  for (const win of BrowserWindow.getAllWindows()) {
    applyWindowsTitleBarOverlay(win, settingsStore.appearanceSettings());
  }
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

registerTasksIpc({ ipcMain, callDaemonTasks: (...args) => miaCoreTasksClient.call(...args) });

const autoUpdateService = createAutoUpdateService({
  // Lazy: constructs the electron-updater singleton only when the foreground
  // window calls start(), so it's never materialized in the daemon process.
  getAutoUpdater: () => require("electron-updater").autoUpdater,
  isPackaged: app.isPackaged,
  getMainWindow: () => BrowserWindow.getAllWindows()[0] || null,
  getMainWindows: () => BrowserWindow.getAllWindows(),
  sendUpdateEvent: (payload) => broadcastRendererEvent(IpcChannel.UpdateEvent, payload),
  prepareForUpdateInstall: async () => {
    await stopDaemonService();
  },
  quitApp: () => app.quit(),
});

ipcMain.handle(IpcChannel.UpdateCheck, () => autoUpdateService.checkForUpdates());

app.on("before-quit", () => {
  closeCodexAppServerRuntimes();
  closeOpenClawAcpRuntimes();
  closeManagedClaudeProxySessions();
  closeManagedCodexProxySessions();
  agentSessionManager.closeAllSessions().catch((error) => appendEngineLog(`AgentSession cleanup failed: ${error?.message || error}`));
  claudeCodeMiaProxy.stop().catch((error) => appendEngineLog(`Claude Code Mia proxy stop failed: ${error?.message || error}`));
  codexMiaProxy.stop().catch((error) => appendEngineLog(`Codex Mia proxy stop failed: ${error?.message || error}`));
});

app.whenReady().then(async () => {
  startupTimer.mark("app:ready");
  // Migration slice 5c: the daemon is ALWAYS the standalone node Core
  // (src/core/mia-core.js), never the Electron GUI app. The obsolete
  // `if (IS_DAEMON_PROCESS)` Electron daemon-boot branch (dock.hide + control
  // server + cloud sockets + retry interval) was deleted here — node Core owns
  // that boot in createMiaCore.startWithCloud(). Electron only ever runs as the
  // window; IS_DAEMON_PROCESS is false-by-construction in this process now, and
  // its remaining `!IS_DAEMON_PROCESS` arms are the window-side path. The window
  // still constructs miaCoreControlServer and pings/forwards to the node-Core
  // daemon over 127.0.0.1; startDaemonService launches node Core.
  if (!shouldRunDesktopInstance) return;
  startupMcpInitializer.start();
  const win = createWindow();
  startupTimer.mark("window:created");
  autoUpdateService.start();
  miaCoreTasksClient.startEvents();
  startCloudRuntimeSockets(); // foreground clients self-gate; daemon owns runtime sockets
  cloudDesktopSync().syncWorkspace().catch((error) => appendCloudLog(`云同步刷新失败：${error?.message || error}`));
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
