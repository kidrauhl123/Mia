"use strict";

// Mia Core — standalone Node.js backend process (vertical slice #1).
//
// This is the real Mia Core direction (not the abandoned Electron-helper
// wrapper): a pure-node process with its own executable identity — no window,
// no Dock, no LaunchServices GUI semantics — that owns the runtime home and
// serves the local daemon control API (health/status/control HTTP + SSE).
//
// Slice #1 scope: control server + runtime-paths/settings/daemon-token
// ownership, reusing the SAME pure-node factories the Electron daemon uses
// (no second write path to single-owner data). Cloud sockets, scheduler, and
// bot execution are later vertical slices — see
// docs/superpowers/plans/2026-06-24-mia-core-migration.md. They are wired as
// inert stubs here so the control surface boots and is verifiable today.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const yaml = require("js-yaml");

// PACKAGED-NODE electron shim. Several reused main/ modules do
// `const { shell } = require("electron")` at module load. Under a normal node
// checkout `require("electron")` resolves node_modules/electron/index.js, which
// returns the binary PATH STRING, so destructuring `shell` yields undefined (the
// modules already tolerate this — only openLocalSkillDirectory touches `shell`,
// which Core never calls). In a PACKAGED build the `electron` dev-dependency is
// NOT shipped, so that require would throw MODULE_NOT_FOUND and abort Core boot.
// We register a stub in the module cache ONLY when electron cannot be resolved,
// preserving the exact "shell === undefined" contract. This is a strict no-op in
// dev (electron resolves) and never alters Electron main-process behaviour (this
// file is never required by the Electron app).
(() => {
  try {
    require.resolve("electron");
  } catch {
    require("node:module")._cache.electron = {
      id: "electron",
      filename: "electron",
      loaded: true,
      exports: {}
    };
    const Module = require("node:module");
    const originalResolve = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
      if (request === "electron") return "electron";
      return originalResolve.call(this, request, ...rest);
    };
  }
})();

const { createRuntimePaths } = require("../main/runtime-paths.js");
const { createSettingsStore } = require("../main/settings-store.js");
const { createDaemonControlServer } = require("../main/daemon/control-server.js");
const { createEngineHealthService } = require("../main/engine-health-service.js");

// Bot-execution graph — the SAME pure-node factories the Electron main process
// drives (no fork). Core builds a real adapter graph; only the lowest-level
// Hermes HTTP send is host-injected so the engine baseUrl/apiKey stay external.
const { createBotExecutionCore } = require("../main/bot-execution-core.js");
const { createBotTurnHelpers } = require("../main/bot-turn-helpers.js");
const { createBotManifest } = require("../main/bot-manifest.js");
const { requireBot } = require("../main/bot-registry.js");
const { createChatEventEmitter } = require("../main/chat-events.js");
const { chatCompletionResponse, responseMessageContent } = require("../main/chat-response.js");
const { adapterForEngine, normalizeAgentEngine, resolveChatEngineAdapter } = require("../main/chat-engine-registry.js");
const { enginePermissionStoreTarget } = require("../shared/agent-engine-policy.js");
const { createChatEngineAdapters, sendWithChatEngineAdapter } = require("../main/chat-engine-adapters.js");
const { normalizeTurnRuntimeConfig } = require("../main/runtime-config-normalizer.js");
const { schedulerSkillIdsForTurn } = require("../main/scheduler-skill-defaults.js");
const { createHermesRunService } = require("../main/hermes-run-service.js");
const { createHermesChatAdapter } = require("../main/hermes-chat-adapter.js");

// Memory + skills collaborators — the SAME pure-node factories main.js drives
// (src/main.js ~293 createMiaMemoryService, ~525 createSkillsLoader; no fork).
// Both run node-only: the memory service needs only runtimePaths + fs; the
// skills loader's directive/context builders are pure text over runtimePaths +
// the bundled official-library files. The loader top-level `require("electron")`
// resolves to a path string under plain node, so `shell` is undefined — only
// openLocalSkillDirectory touches it, and Core never calls that.
const { createMiaMemoryService } = require("../main/mia-memory-service.js");
const { createSkillsLoader } = require("../main/skills-loader.js");

// Attachments + MCP context bridges — the SAME pure-node factories main.js drives
// (src/main.js ~453 createChatAttachments, ~631/640 the scheduler/Mia-app MCP
// bridges; no fork). All three are constructed from runtimePaths + fs/path only:
//   - createChatAttachments: the two methods Core needs (normalizeAttachments,
//     attachmentContext) are pure fs/path. The save/read/cloud-fetch methods
//     (which alone touch initializeRuntime/getCloudSettings) are never reached on
//     the hermes-run-service payload path, so node sinks for those deps are safe.
//   - createSchedulerMcpBridge / createMiaAppMcpBridge: writeContext is a pure fs
//     write of {botId, sessionId, originMessageId} to context.json under Core's
//     own runtime home. Core owns that home AND the daemon control server the MCP
//     server scripts call back into (MIA_DAEMON_URL), so the write is correct.
const { createChatAttachments } = require("../main/chat-attachments.js");
const { createSchedulerMcpBridge } = require("../main/scheduler-mcp-bridge.js");
const { createMiaAppMcpBridge } = require("../main/mia-app-mcp-bridge.js");

// Cloud bot-invocation routing — the SAME pure-node social modules the Electron
// main process drives (no fork). Core is the single owner when running, so the
// dispatcher always handles (shouldHandle: () => true) and never falls back.
const { createSocialApi } = require("../main/social/social-api.js");
const { createLocalBotResponder } = require("../main/social/local-bot-responder.js");
const { createMainBotRuntimeDispatcher } = require("../main/social/bot-runtime-dispatcher.js");

// Cloud events WebSocket — the SAME pure-node client main.js drives (no fork):
// connects to /api/events, applies the resume cursor, and routes
// ConversationBotInvocationRequested to botRuntimeDispatcher.handleCloudEvent.
const { createCloudEventsClient } = require("../main/cloud/cloud-events-client.js");
const {
  cloudEventsUrl: buildCloudEventsUrl,
  cloudWebSocketUrl,
  cloudWebSocketProtocols
} = require("../main/cloud/cloud-events-url.js");
const { CloudEvent } = require("../shared/cloud-events.js");

// Cloud BRIDGE WebSocket — the SAME pure-node client main.js drives (no fork):
// it hosts the desktop-agent side of web/mobile "remote run" requests on
// /api/bridge. Reused verbatim; Core supplies a thin bridge chat adapter that
// routes the run into Core's own botExecution.sendChat (Hermes-only).
const { createCloudBridgeClient } = require("../main/cloud/cloud-bridge-client.js");

// Scheduler subsystem — the SAME pure-node factories the Electron daemon drives
// (src/main.js initSchedulerSubsystem, ~line 1194). No fork: Core builds the real
// tasks store (single-owner mia-tasks.json under Core's runtime home), event bus,
// fire runner, scheduler, and /api/tasks routes. The only Core-specific piece is
// the fire path, which drives Core's own botExecution.sendChat instead of the
// Electron-bound runRemoteChatRequest.
const { createTasksStore } = require("../main/tasks-store.js");
const { createTasksEventBus } = require("../main/tasks-events.js");
const { createFireRunner } = require("../main/scheduler-fire.js");
const { createScheduler, sweepMissedCronTasks } = require("../main/scheduler.js");
const { createTasksRoutes } = require("../main/tasks-routes.js");
const { deliverTaskReplyToConversation } = require("../main/task-reply-delivery.js");
const { botConversationId } = require("../shared/bot-identity.js");

const ENGINE_NOT_AVAILABLE = "engine not available in Mia Core yet";

const MIA_GATEWAY_SERVICE_LABEL = "ai.mia.hermes.gateway";
const MIA_DAEMON_SERVICE_LABEL = "ai.mia.daemon";

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// Hermes engine endpoint discovery — Core's own source of truth.
//
// In production the daemon env does NOT set MIA_HERMES_BASE_URL /
// MIA_HERMES_API_KEY (the resolver's daemonEnvOverlay omits them), so Core must
// discover the running Hermes engine from the on-disk runtime home it owns —
// the SAME files the Electron main process reads:
//   - PORT: <hermesHome>/config.yaml  →  platforms.api_server.port  (default 18642)
//           (minimal replica of engine-runtime-config-service.readConfiguredPort)
//   - apiKey: <hermesHome>/mia-api-server.key  (runtimePaths().apiKey), trimmed
//   - baseUrl: http://127.0.0.1:<port>  (local engine host; main.js engineState.baseUrl)
//
// Both reads are pure fs (+ js-yaml, an existing dep). They take NO mutating
// action: unlike engine-runtime-config-service.apiKey(), the key file is NEVER
// created here — Core only reads what the engine wrote ("" if missing). Core
// passes these as FUNCTIONS to createCoreBotExecution so a Hermes restart /
// config change is picked up on the next turn (re-read, not cached at build).
const HERMES_DEFAULT_PORT = 18642;

function coreReadHermesPort(hermesHome) {
  const configPath = path.join(String(hermesHome || ""), "config.yaml");
  if (!fs.existsSync(configPath)) return HERMES_DEFAULT_PORT;
  try {
    const parsed = yaml.load(fs.readFileSync(configPath, "utf8"));
    const port = Number(parsed?.platforms?.api_server?.port);
    if (Number.isInteger(port) && port > 0) return port;
  } catch {
    // fall through to default
  }
  return HERMES_DEFAULT_PORT;
}

function coreHermesBaseUrl(hermesHome) {
  return `http://127.0.0.1:${coreReadHermesPort(hermesHome)}`;
}

function coreReadHermesApiKey(hermesHome) {
  const keyPath = path.join(String(hermesHome || ""), "mia-api-server.key");
  try {
    return String(fs.readFileSync(keyPath, "utf8")).trim();
  } catch {
    return "";
  }
}

// Minimal pure-path helper replicated from src/main.js:910 (byte-identical).
// It is a tiny self-contained predicate already duplicated across several main
// modules (external-agent-command-service, managed-agent-runtime); replicating
// the four lines here is the smallest non-forking choice and leaves main.js
// untouched.
function isChildPath(parentPath, targetPath) {
  const parent = path.resolve(parentPath);
  const target = path.resolve(targetPath);
  const relative = path.relative(parent, target);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

// Repo root that ships the bundled official-library + _builtin skills (the same
// files main.js's botPetService resolves from app.getAppPath()/resourcesPath).
// In a node Core checkout they sit two levels up from src/core/.
const CORE_REPO_ROOT = path.join(__dirname, "..", "..");

// Node-only equivalents of botPetService.officialLibraryManifestPath /
// resolveOfficialLibraryRoot (which are electron-coupled via app.getAppPath()).
// They are NOT extracted from bot-pet-service (no fork); Core points at the same
// bundled resources by repo path. The directive/context builders tolerate a
// missing manifest (readMiaOfficialSkillSources returns [] → only the private
// <home>/skills source is active), so this stays correct even outside a checkout.
function coreOfficialLibraryManifestPath() {
  return path.join(CORE_REPO_ROOT, "resources", "official-library", "library.json");
}

function coreResolveOfficialLibraryRoot(root = "") {
  const value = String(root || "").trim();
  if (!value) return "";
  if (path.isAbsolute(value)) return value;
  // The bundled skillSources use roots like "skills/_builtin"; Core mirrors the
  // shipped layout (<repo>/skills/...) the desktop app resolves via miaSkillsRoot.
  if (value === "skills" || value.startsWith("skills/")) {
    return path.join(CORE_REPO_ROOT, value);
  }
  return path.join(path.dirname(coreOfficialLibraryManifestPath()), value);
}

// Build the REAL bot-execution core for the node Core process. This constructs
// the same adapter graph the Electron main process builds — createChatEngineAdapters
// → sendWithChatEngineAdapter → adapter.send — reusing the real shared helpers
// (bot snapshot/runtime-config/skill/scheduler normalization). It is Hermes-only:
// the non-Hermes send deps throw a clear "not available" error rather than failing
// silently. The Hermes engine (Python) is started by the Electron app today, so
// Core only takes the engine HTTP baseUrl + apiKey + the lowest-level
// `sendHermesChat` (real adapter.sendChat in production; a fake in tests).
function createCoreBotExecution({
  runtimePaths,
  settingsStore,
  hermesBaseUrl,
  apiKey,
  sendHermesChat,
  fetchImpl = fetch
} = {}) {
  const baseUrl = typeof hermesBaseUrl === "function" ? hermesBaseUrl : () => String(hermesBaseUrl || "");
  const apiKeyFn = typeof apiKey === "function" ? apiKey : () => String(apiKey || "");

  // Real bot manifest read-side: local fallback when a turn carries no cloud
  // snapshot. Core owns the same runtime home, so it reads the same manifest.
  const botManifest = createBotManifest({
    runtimePaths,
    readJson,
    normalizeAgentEngine,
    // settingsStore is only reached by manifest WRITE/normalize-effort paths,
    // never by loadBotManifest (the only method bot-execution-core calls).
    settingsStore: settingsStore && typeof settingsStore.normalizeStoredEffortLevel === "function"
      ? settingsStore
      : { normalizeStoredEffortLevel: (value) => String(value || "").trim() }
  });

  const { botWithRuntimeConfig, cloudBotSnapshotForTurn } = createBotTurnHelpers({
    normalizeAgentEngine,
    enginePermissionStoreTarget
  });

  // REAL memory service — pure node (runtimePaths + fs). Yields the same
  // Hermes adapter `memoryBlock` main.js passes (src/main.js:2070), reading the
  // single-owner mia-memory.json under Core's runtime home.
  const miaMemoryService = createMiaMemoryService({ runtimePaths });

  // REAL skills loader — node-only deps. `buildEnabledSkillsContext` /
  // `buildActiveSkillsDirective` are pure text over runtimePaths + the bundled
  // official library. The known light electron coupling (shell.openPath) is only
  // reached by openLocalSkillDirectory, which Core never calls; a no-op opener is
  // never needed because the module-level `require("electron")` already degrades
  // to a path string (shell === undefined) under plain node. getEngineState is
  // inert here (no Hermes /api/skills enable/disable probe in Core); apiKey is the
  // configured engine key; appendEngineLog is a sink.
  const skillsLoader = createSkillsLoader({
    runtimePaths,
    readJson,
    officialLibraryManifestPath: coreOfficialLibraryManifestPath,
    resolveOfficialLibraryRoot: coreResolveOfficialLibraryRoot,
    getEngineState: () => ({}),
    apiKey: apiKeyFn,
    appendEngineLog: () => {},
    isChildPath
  });

  // REAL chat-attachments — pure node (fs/path) for the two methods the run
  // service uses. normalizeAttachments + attachmentContext read local file
  // metadata / text previews exactly like the Electron path (src/main.js:466).
  // The save/read/cloud-fetch methods are never reached on the payload path, so
  // their electron-ish deps are inert node sinks: initializeRuntime is a no-op
  // (Core owns runtimePaths.attachmentsDir already), and the cloud deps reuse
  // Core's own cloud settings if present.
  const chatAttachments = createChatAttachments({
    initializeRuntime: () => {},
    runtimePaths,
    getCloudSettings: () => (settingsStore && typeof settingsStore.cloudSettings === "function"
      ? settingsStore.cloudSettings()
      : { enabled: false }),
    normalizeCloudUrl: settingsStore && typeof settingsStore.normalizeCloudUrl === "function"
      ? settingsStore.normalizeCloudUrl
      : (value) => String(value || "")
  });

  // Real Hermes run service (payload/stream/slash helpers) — now with the REAL
  // attachment deps so a Hermes turn carrying local attachments injects the same
  // "附件上下文" block + text previews the Electron daemon does (src/main.js:487).
  const hermesRunService = createHermesRunService({
    normalizeAttachments: chatAttachments.normalizeAttachments,
    attachmentContext: chatAttachments.attachmentContext,
    baseUrl,
    apiKey: apiKeyFn,
    fetchImpl,
    randomUUID: () => crypto.randomUUID()
  });

  // REAL MCP context bridges — pure node. Only writeContext is wired into the
  // adapter (a fs write of the per-turn {botId, sessionId, originMessageId} to
  // context.json under Core's runtime home). The MCP server scripts read that
  // file + MIA_DAEMON_URL to call back into the daemon — and Core IS that daemon
  // (its control server + /api/tasks routes), so a Hermes turn's schedule_create
  // / app tools resolve to the same conversation the Electron daemon would.
  // getSpec (the config.yaml wiring) is NOT wired here — that is the engine-config
  // path Core does not own; see the managed-model TODO below.
  const schedulerMcpBridge = createSchedulerMcpBridge({
    runtimePaths,
    serverScriptPath: () => path.join(__dirname, "..", "main", "scheduler-mcp-server.js")
  });
  const miaAppMcpBridge = createMiaAppMcpBridge({
    runtimePaths,
    serverScriptPath: () => path.join(__dirname, "..", "main", "mia-app-mcp-server.js")
  });

  // Real Hermes chat adapter — provides slashCommandResponse and (in production)
  // the real sendChat. The MCP context writes are now the genuine bridges; the
  // managed-model deps remain stubbed (see TODO) and the adapter itself is genuine.
  const hermesAdapter = createHermesChatAdapter({
    apiKey: apiKeyFn,
    baseUrl,
    buildGroupHeader: () => "",
    buildRunPayload: hermesRunService.buildRunPayload,
    normalizeError: hermesRunService.normalizeError,
    readRunEventStream: hermesRunService.readRunEventStream,
    responseModel: adapterForEngine("hermes").responseModel,
    fetch: fetchImpl,
    // REAL memory block — Core owns the same single-owner mia-memory.json, so
    // a Hermes turn run via Core injects the same memory the Electron daemon does.
    memoryBlock: miaMemoryService.memoryBlock,
    // REAL scheduler MCP context write — Core owns the scheduler subsystem, so a
    // schedule_create from this turn fires the reminder back into this conversation.
    writeSchedulerMcpContext: schedulerMcpBridge.writeContext,
    // REAL Mia app MCP context write — same per-turn context under Core's home.
    writeMiaAppMcpContext: miaAppMcpBridge.writeContext,
    // TODO(mia-core slice): the managed-model runtime stays stubbed. resolveManagedModelRuntime
    // is node-constructible (cloud settings + token), but the adapter contract requires that a
    // non-null managed model be paired with writeModelRuntimeConfig, which writes Hermes's
    // config.yaml via engineRuntimeConfigService.writeRuntimeConfig — the engine-config path
    // Core does NOT own (the Electron app starts Hermes and owns its config.yaml + the full
    // defaultModelSettings/permission/effort/MCP-spec graph). Wiring resolve-without-write
    // would leave Hermes pointed at a stale model, so both stay stubbed; Hermes uses the
    // turn's runtimeConfig as-is (acceptable-but-degraded for Mia-managed-model bots).
    resolveManagedModelRuntime: () => null,
    writeModelRuntimeConfig: () => {},
    // REAL enabled-skills context — injects the full content of the bot's
    // enabled skills into the user turn, exactly like main.js (src/main.js:2064).
    buildEnabledSkillsContext: skillsLoader.buildEnabledSkillsContext,
    appendEngineLog: () => {}
  });

  // In production `sendHermesChat` is `hermesAdapter.sendChat`. Tests inject a
  // fake so only the lowest-level Hermes HTTP send is replaced — the rest of the
  // graph stays real.
  const hermesChatSend = typeof sendHermesChat === "function"
    ? sendHermesChat
    : hermesAdapter.sendChat;

  // Health check for ensureHermesReady: probe the engine /health if a baseUrl is
  // configured; otherwise no-op (the Electron app owns the engine lifecycle).
  async function ensureHermesReady() {
    const url = baseUrl();
    if (!url) return;
    try {
      await fetchImpl(`${url}/health`, { method: "GET" });
    } catch {
      // Non-fatal: the actual send below surfaces a real connection error.
    }
  }

  const engineUnavailable = () => {
    throw new Error(ENGINE_NOT_AVAILABLE);
  };

  // REAL adapter graph: Hermes is wired to the real adapter; every non-Hermes
  // send throws a clear "not available" error (never silent).
  function createActiveChatEngineAdapters() {
    return createChatEngineAdapters({
      chatCompletionResponse,
      ensureHermesReady,
      hermesSlashCommandResponse: hermesAdapter.slashCommandResponse,
      runHermesSlashCommand: () => "",
      sendHermesChat: hermesChatSend,
      runExternalSlashCommand: engineUnavailable,
      sendClaudeCodeChat: engineUnavailable,
      sendCodexChat: engineUnavailable,
      sendOpenClawChat: engineUnavailable
    });
  }

  return createBotExecutionCore({
    createChatEventEmitter,
    cloudBotSnapshotForTurn,
    loadBotManifest: botManifest.loadBotManifest,
    requireBot,
    normalizeTurnRuntimeConfig,
    botWithRuntimeConfig,
    normalizeAgentEngine,
    resolveChatEngineAdapter,
    // TODO(mia-core slice): wire the real bot pet service once Core owns it; a
    // no-op notifyMessage keeps interactive turns flowing.
    botPetService: { notifyMessage: () => {} },
    responseMessageContent,
    schedulerSkillIdsForTurn,
    // REAL skills loader — buildActiveSkillsDirective names the composer "使用"
    // chips so the agent prioritizes them this turn (src/main.js bot-execution
    // wiring). Same loader instance that backs the Hermes adapter's enabled-skills
    // context above.
    skillsLoader,
    hermesRunService,
    sendWithChatEngineAdapter,
    createActiveChatEngineAdapters,
    // TODO(mia-core slice): wire the real local bot responder once Core owns
    // cloud-conversation handling; the stub keeps stopChat well-defined.
    localBotResponder: () => ({ stopActiveConversationRun: () => ({ stopped: false }) }),
    isDaemonProcess: true,
    daemonTasksClient: () => null,
    settingsStore: () => (settingsStore || { daemonSettings: () => ({ enabled: false }) }),
    appendCloudLog: () => {}
  });
}

// Wire the CLOUD bot-invocation routing into Core, reusing the SAME pure-node
// social modules main.js drives (src/main.js ~2622-2708):
//   dispatcher.handleCloudEvent(ConversationBotInvocationRequested)
//     → localBotResponder.respond(...)
//     → botExecution.sendChat (the real Hermes adapter graph)
//     → socialApi.postConversationMessageAsBot(...) posts the reply.
//
// This is the routing ONLY — it is NOT auto-connected to the real cloud
// WebSocket (that is a later slice + a dual-owner risk). Feeding the returned
// dispatcher a cloud event drives the full node-only path, which is exactly how
// the proof test exercises it.
//
// Injection points (for tests): `socialApi` (a mock recording posts) and
// `botExecution` (a createCoreBotExecution graph with a faked Hermes send).
function createCoreCloudRouting({
  runtimePaths,
  settingsStore,
  botExecution,
  socialApi,
  emitLocalEvent = () => {},
  deviceId = "mia-core",
  log = () => {}
} = {}) {
  if (!botExecution || typeof botExecution.sendChat !== "function") {
    throw new Error("createCoreCloudRouting requires a botExecution with sendChat");
  }

  // Real pure-node socialApi built from Core's cloud settings. Injectable for
  // tests; in production it reuses settingsStore.cloudSettings() (same shape and
  // url normalization the Electron path uses).
  const api = socialApi || createSocialApi({
    getSettings: () => (settingsStore ? settingsStore.cloudSettings() : { enabled: false }),
    normalizeUrl: settingsStore ? settingsStore.normalizeCloudUrl : (value) => String(value || "")
  });

  const localBotResponder = createLocalBotResponder({
    sendChat: botExecution.sendChat,
    postConversationMessageAsBot: (conversationId, body) => api.postConversationMessageAsBot(conversationId, body),
    listConversationMessages: (conversationId, sinceSeq, limit) => api.listConversationMessages(conversationId, sinceSeq, limit),
    // Run streams (typing, token deltas, tool traces) + posted-message echoes go
    // to the Core control server's local event channel. The caller injects the
    // sink; a no-op/collector is fine until the local-events fan-out lands.
    emitCloudEvent: (message) => emitLocalEvent({ type: message.type, payload: message }),
    log
  });

  const dispatcher = createMainBotRuntimeDispatcher({
    // Core is the single owner when running, so it always handles the turn.
    shouldHandle: () => true,
    currentDeviceId: () => String(deviceId || ""),
    currentDeviceIds: () => [String(deviceId || "")],
    // TODO(mia-core slice): wire the real owned-bots list once Core owns the bot
    // directory read-side; an empty list is correct-but-minimal — buildBotInvocation
    // falls back to the member roster / a botId snapshot, so Hermes turns still run.
    listBots: () => [],
    localBotResponder,
    log
  });

  return { dispatcher, localBotResponder, socialApi: api };
}

// Mirror main.js's cloud event channel name so local-event consumers (windows
// listening on the daemon's local feed) see the same envelope type the Electron
// daemon emits. main.js passes IpcChannel.CloudEvent ("cloud:event").
const CORE_CLOUD_EVENT_CHANNEL = "cloud:event";

// Wire the REAL cloud-events WebSocket client into Core, reusing the SAME
// pure-node module main.js drives (src/main.js ~2720, no fork). It connects to
// /api/events, applies the resume cursor, and routes
// ConversationBotInvocationRequested → cloudRouting.dispatcher.handleCloudEvent
// (the full Core routing graph: responder → botExecution.sendChat → socialApi).
//
// SINGLE-OWNER: Core is the /api/events host only when it actually runs as the
// daemon. The client's own isDaemonProcess/isDaemonEnabled gate is set so it
// connects only while cloud is enabled+tokened; callers must additionally NOT
// call start() at import — only createMiaCore.start() connects.
//
// ELECTRON-COUPLED deps in the client are replaced with node sinks here:
//   broadcastRendererEvent → emitLocalEvent (Core control-server local channel),
//                            NOT electron's BrowserWindow broadcast.
//   messageCache → null (TODO: wire once Core owns the local message cache).
//
// Injection points (for tests): `WebSocketImpl` (a mock socket) and `cloudRouting`
// (whose dispatcher routes into a faked Hermes send + mock socialApi).
function createCoreCloudEvents({
  settingsStore,
  cloudRouting,
  WebSocketImpl,
  emitLocalEvent = () => {},
  cloudEventsUrl = buildCloudEventsUrl,
  log = () => {}
} = {}) {
  if (!cloudRouting || !cloudRouting.dispatcher) {
    throw new Error("createCoreCloudEvents requires a cloudRouting with a dispatcher");
  }
  if (!WebSocketImpl) {
    throw new Error("createCoreCloudEvents requires a WebSocketImpl");
  }

  const getSettings = () => (settingsStore ? settingsStore.cloudSettings() : { enabled: false });
  const cloudEnabled = () => {
    const s = getSettings();
    return Boolean(s.enabled && s.token);
  };

  return createCloudEventsClient({
    WebSocketImpl,
    getSettings,
    // Core is the single owner of the cursor when it runs as the daemon, so it
    // persists lastEventSeq through the same settings-store the Electron daemon
    // uses (single write path). Falls back to a no-op if absent.
    writeCloudSettings: (patch) => (settingsStore && typeof settingsStore.writeCloudSettings === "function"
      ? settingsStore.writeCloudSettings(patch)
      : undefined),
    cloudStatus: () => ({ enabled: cloudEnabled() }),
    cloudEventsUrl,
    cloudWebSocketProtocols,
    // NOT electron: every renderer-bound cloud event is pushed to Core's
    // control-server local channel (ADR P0/P2), where a window replays it.
    broadcastRendererEvent: (channel, envelope) => emitLocalEvent(envelope),
    cloudEventChannel: CORE_CLOUD_EVENT_CHANNEL,
    appendCloudLog: (line) => log(line),
    botRuntimeDispatcher: cloudRouting.dispatcher,
    // TODO(mia-core slice): wire the local message cache once Core owns it.
    messageCache: null,
    // Core is the daemon owner of /api/events when it runs, so it persists the
    // resume cursor (single writer).
    persistCursor: () => true,
    isDaemonProcess: true,
    isDaemonEnabled: cloudEnabled
  });
}

// Build the /api/bridge WebSocket URL from Core's cloud settings. main.js's
// cloudBridgeUrl is electron-coupled (app.getVersion(), localDeviceId(),
// localDeviceFingerprint(), localBridgeEngineIds() reading the Electron
// localAgentEngineService) and CANNOT be reused as-is — so it is NOT extracted.
// Core supplies its own minimal builder over the SHARED pure-node
// cloudWebSocketUrl("/api/bridge", ...): same address + token-protocol derivation,
// Core's own deviceId, and a Hermes-only capabilities advertisement (Core only
// runs Hermes — every non-Hermes bridge run throws ENGINE_NOT_AVAILABLE below).
function coreCloudBridgeUrl(settings = {}, { deviceId = "mia-core", version = "" } = {}) {
  const url = cloudWebSocketUrl("/api/bridge", settings);
  url.searchParams.set("deviceId", String(deviceId || "mia-core"));
  url.searchParams.set("deviceName", `Mia Core (${os.hostname()})`);
  url.searchParams.set("engine", "hermes");
  url.searchParams.set("capabilities", JSON.stringify({
    chat: true,
    attachments: false,
    generatedImages: false,
    cancellation: true,
    streaming: true,
    engines: ["hermes"],
    app: "Mia Core",
    appVersion: String(version || ""),
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch()
  }));
  return url.toString();
}

// Wire the REAL cloud BRIDGE WebSocket client into Core, reusing the SAME
// pure-node module main.js drives (src/main.js ~2654, no fork). The bridge hosts
// the desktop-agent side of web/mobile "remote run" requests: a `run` frame on
// /api/bridge calls runCloudBridgeRequest → the bridge chat adapter's sendChat →
// (here) Core's own botExecution.sendChat → run_event/run_result frames back over
// the socket.
//
// BRIDGE RUN CONTRACT (from cloud-bridge-client.js runCloudBridgeRequest): the
// client calls `createActiveBridgeChatAdapter(agentEngine).sendChat({ bot, sessionId,
// messages, signal, emit, utility:false, runtimeConfig })` and reads the result's
// `choices[0].message` (content + attachments). Core's bridge adapter maps that
// onto botExecution.sendChat by passing the bridge `bot` object as `botSnapshot`
// (+ botKey/botId) and forwarding sessionId/messages/signal/emit/utility/runtimeConfig.
// The engine is selected by runtimeConfig.agentEngine inside sendChat
// (botWithRuntimeConfig), so Hermes runs the real adapter graph and every
// non-Hermes engine hits the engineUnavailable throw (ENGINE_NOT_AVAILABLE) — the
// SAME "engine not available in Mia Core yet" surfaced everywhere else in Core.
//
// SINGLE-OWNER: like the events client, the bridge client's own
// isDaemonProcess/isDaemonEnabled gate connects only while cloud is enabled+tokened;
// callers must NOT call start() at import — only createMiaCore.start() connects.
//
// ELECTRON-COUPLED deps replaced with node values here:
//   cloudBridgeUrl              → coreCloudBridgeUrl (Hermes-only capabilities),
//   createActiveCodexChatAdapter→ null (Codex not available in Core),
//   resetLocalDeviceIdentity    → null (Core regenerates identity on reconnect),
//   resolveBotCapabilities      → caller-injected (default {}),
//   broadcast/run streams        → emitLocalEvent via the bridge adapter's emit.
//
// Injection points (for tests): `WebSocketImpl` (a mock socket) and `botExecution`
// (a createCoreBotExecution graph with a faked Hermes send).
function createCoreCloudBridge({
  settingsStore,
  botExecution,
  WebSocketImpl,
  emitLocalEvent = () => {},
  cloudBridgeUrl = null,
  deviceId = "mia-core",
  version = "",
  resolveBotCapabilities = () => ({}),
  log = () => {}
} = {}) {
  if (!botExecution || typeof botExecution.sendChat !== "function") {
    throw new Error("createCoreCloudBridge requires a botExecution with sendChat");
  }
  if (!WebSocketImpl) {
    throw new Error("createCoreCloudBridge requires a WebSocketImpl");
  }

  const getSettings = () => (settingsStore ? settingsStore.cloudSettings() : { enabled: false });
  const cloudEnabled = () => {
    const s = getSettings();
    return Boolean(s.enabled && s.token);
  };

  // Thin bridge chat adapter: routes a bridge run into Core's real botExecution
  // graph. The bridge passes a full `bot` object (key/id/name/agentEngine/
  // capabilities/engineConfig); Core forwards it as `botSnapshot` so no manifest
  // read is needed for cloud-supplied bots. Engine selection + the Hermes-only
  // guard live inside botExecution.sendChat (non-Hermes → ENGINE_NOT_AVAILABLE).
  const createActiveBridgeChatAdapter = () => ({
    sendChat: ({ bot, sessionId, messages, signal, emit, utility = false, runtimeConfig }) => botExecution.sendChat({
      botKey: bot?.key || bot?.id || "",
      botId: bot?.id || bot?.key || "",
      botSnapshot: bot || null,
      sessionId,
      messages,
      signal,
      emit,
      utility,
      runtimeConfig
    })
  });

  const buildBridgeUrl = typeof cloudBridgeUrl === "function"
    ? cloudBridgeUrl
    : (s) => coreCloudBridgeUrl(s, { deviceId, version });

  return createCloudBridgeClient({
    WebSocketImpl,
    getSettings,
    isDaemonProcess: true,
    isDaemonEnabled: cloudEnabled,
    cloudBridgeUrl: buildBridgeUrl,
    cloudWebSocketProtocols,
    createActiveBridgeChatAdapter,
    // Codex (and every other non-Hermes engine) is not available in Core; routing
    // a Codex bridge run through createActiveBridgeChatAdapter still reaches
    // botExecution.sendChat, which throws ENGINE_NOT_AVAILABLE.
    createActiveCodexChatAdapter: null,
    resolveBotCapabilities,
    // Core regenerates its device identity on the next reconnect rather than
    // persisting an electron-side identity file.
    // TODO(mia-core slice): wire a persisted Core device identity reset.
    resetLocalDeviceIdentity: null,
    randomUUID: () => crypto.randomUUID()
  });
}

// Wire the REAL scheduler subsystem into Core, reusing the SAME pure-node
// factories the Electron daemon drives (src/main.js initSchedulerSubsystem):
//   createTasksStore  → single-owner mia-tasks.json under Core's runtime home
//   createTasksEventBus → SSE fan-out for /api/tasks/events
//   createFireRunner  → runs a fired task; the non-direct path drives Core's own
//                       botExecution.sendChat({ background:true, scheduledFire:true })
//                       and posts the reply via socialApi.postConversationMessageAsBot
//                       (deliverTaskReplyToConversation — the real task-reply path).
//   createScheduler   → cron/oneshot timers (constructed WITHOUT timers; only
//                       initSchedulerSubsystem() → scheduler.start() arms them).
//   createTasksRoutes → the real /api/tasks REST + events stream.
//
// SINGLE-OWNER SAFETY: constructing this subsystem starts NO timers. The
// scheduler arms its setTimeout only inside initSchedulerSubsystem(), which the
// control server calls on start(). Tests construct the subsystem and fire a task
// directly via the returned fireRunner WITHOUT calling initSchedulerSubsystem(),
// so no live wall-clock timer is ever created in tests. core.stop() stops the
// control server; this function also returns stopScheduler() so timers (if armed)
// are cleared on teardown.
//
// Injection points (for tests): `botExecution` (a createCoreBotExecution graph
// with a faked Hermes send), `socialApi` (a mock recording posts), and
// `runtimePaths` (a temp home so the tasks file is isolated).
function createCoreScheduler({
  runtimePaths,
  settingsStore,
  botExecution,
  socialApi,
  emitLocalEvent = () => {},
  deviceId = "mia-core",
  log = () => {}
} = {}) {
  if (!botExecution || typeof botExecution.sendChat !== "function") {
    throw new Error("createCoreScheduler requires a botExecution with sendChat");
  }

  const api = socialApi || createSocialApi({
    getSettings: () => (settingsStore ? settingsStore.cloudSettings() : { enabled: false }),
    normalizeUrl: settingsStore ? settingsStore.normalizeCloudUrl : (value) => String(value || "")
  });

  // Core-side equivalent of main.js's runRemoteChatRequest for the fire path: run
  // a background, scheduled-fire chat turn through Core's own botExecution graph,
  // then deliver the assistant reply to the bot's cloud conversation the same way
  // the Electron path does (deliverTaskReplyToConversation → socialApi as-bot post).
  // It returns a session-shaped result so the real fireRunner records the reply
  // (it reads result.session.messages for the last assistant message).
  async function runRemoteChatRequest(body) {
    const conversationId = String(body?.conversationId || body?.sessionId || "").trim();
    const agentSessionId = String(body?.agentSessionId || conversationId || `remote:${crypto.randomUUID()}`);
    const botKey = String(body?.botKey || body?.botId || "").trim();
    const runtimeConfig = body?.runtimeConfig || null;

    const response = await botExecution.sendChat({
      botKey,
      botId: botKey,
      sessionId: agentSessionId,
      messages: [{ role: "user", content: String(body?.text || ""), attachments: [] }],
      background: Boolean(body?.background),
      // A fired scheduled task carries meta.taskId. Switch the agent into
      // execution mode so the replayed task prompt is run, not re-interpreted as
      // a fresh "create a task" request (matches main.js sendChat semantics).
      scheduledFire: Boolean(body?.meta?.taskId),
      persistAgentSession: true,
      runtimeConfig
    });

    const assistantText = responseMessageContent(response);
    const assistantMessageId = "msg-" + crypto.randomBytes(6).toString("hex");
    const savedAssistant = {
      id: assistantMessageId,
      role: "assistant",
      content: assistantText,
      createdAt: new Date().toISOString()
    };
    if (body?.meta) savedAssistant.meta = body.meta;

    let deliveredAssistantMessageId = assistantMessageId;
    // Only background (task) runs deliver to the cloud conversation; the bot we
    // post as is keyed off the task's botId (deliverTaskReplyToConversation only
    // reads bot.key || bot.id).
    if (body?.background && assistantText.trim()) {
      const cloud = settingsStore?.cloudSettings?.() || {};
      const fallbackConversationId = cloud?.user?.id ? botConversationId(`${cloud.user.id}_${botKey}`) : "";
      const delivery = await deliverTaskReplyToConversation({
        socialApi: api,
        settingsStore,
        bot: { key: botKey },
        conversationId,
        fallbackConversationId,
        assistantText,
        assistantTracePayload: {},
        taskRunId: body?.meta?.taskRunId || agentSessionId,
        fallbackMessageId: assistantMessageId
      });
      deliveredAssistantMessageId = delivery.messageId || assistantMessageId;
      savedAssistant.id = deliveredAssistantMessageId;
    }

    return {
      session: {
        id: agentSessionId,
        conversationId,
        botId: botKey,
        messages: [savedAssistant],
        updatedAt: savedAssistant.createdAt
      },
      response,
      assistantMessageId: deliveredAssistantMessageId
    };
  }

  const tasksStore = createTasksStore(runtimePaths().tasks);
  const tasksEvents = createTasksEventBus();

  const fireRunner = createFireRunner({
    store: tasksStore,
    runRemoteChatRequest,
    // Direct-delivery tasks (canned text, no chat turn) post the reply straight
    // to the conversation — the same path main.js wires.
    deliverTaskMessage: async ({ task, runId, conversationId, text }) => {
      const cloud = settingsStore?.cloudSettings?.() || {};
      const fallbackConversationId = cloud?.user?.id ? botConversationId(`${cloud.user.id}_${task.botId}`) : "";
      return deliverTaskReplyToConversation({
        socialApi: api,
        settingsStore,
        bot: { key: task.botId },
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

  const scheduler = createScheduler({
    store: tasksStore,
    onFire: (task) => fireRunner.fire(task)
  });

  const tasksRoutesImpl = createTasksRoutes({
    store: tasksStore,
    events: tasksEvents,
    runNow: async (id) => {
      const task = tasksStore.get(id);
      if (!task) throw new Error("task not found");
      const run = await fireRunner.fire(task);
      return { runId: run?.id };
    },
    onChange: () => scheduler.rescan()
  });

  let started = false;
  // The control server calls this on start(). It arms the cron/oneshot timers —
  // the ONLY place timers are created. Idempotent + single-owner-gated upstream
  // (Core's control server is only started standalone/in tests today).
  function initSchedulerSubsystem() {
    if (started) return;
    started = true;
    sweepMissedCronTasks(tasksStore, Date.now(), (type, payload) => tasksEvents.emit(type, payload));
    scheduler.start();
  }

  function stopScheduler() {
    started = false;
    scheduler.stop();
  }

  return {
    scheduler,
    tasksRoutes: tasksRoutesImpl,
    tasksStore,
    tasksEvents,
    fireRunner,
    initSchedulerSubsystem,
    stopScheduler,
    socialApi: api
  };
}

function createMiaCore(options = {}) {
  const env = options.env || process.env;
  const version = String(options.version || "");
  const defaultPort = Number(env.MIA_DAEMON_PORT || 27861);
  const cloudUrl = env.MIA_CLOUD_URL || "https://mia.gifgif.cn";

  // runtime-paths only needs app.getPath("userData"|"home"); MIA_HOME bypasses
  // userData entirely. A node process supplies these from the OS + env, with no
  // Electron dependency.
  const appShim = {
    getPath(key) {
      if (key === "userData") {
        return env.MIA_USER_DATA_DIR ? path.resolve(env.MIA_USER_DATA_DIR) : path.join(os.homedir(), ".mia");
      }
      return os.homedir();
    }
  };

  const { runtimePaths } = createRuntimePaths({
    app: appShim,
    MIA_GATEWAY_SERVICE_LABEL,
    MIA_DAEMON_SERVICE_LABEL,
    env
  });

  // Daemon settings/host/port persistence reuses the real settings-store. The
  // engine/effort write deps it also accepts are never reached by the daemon
  // settings methods (verified: settings-store.js:312,356 are engine paths),
  // so inert values here keep single-owner persistence correct.
  const settingsStore = createSettingsStore({
    runtimePaths,
    readJson,
    writeRuntimeConfig: () => {},
    readConfiguredPort: () => defaultPort,
    getEngineState: () => ({}),
    MIA_DAEMON_DEFAULT_PORT: defaultPort,
    MIA_CLOUD_DEFAULT_URL: cloudUrl,
    env
  });

  // Real port selection (probes for a free port from the configured one),
  // reusing the pure-node health service the Electron path uses.
  const choosePort = createEngineHealthService({}).choosePort;

  let cachedToken = "";
  function daemonToken() {
    if (cachedToken) return cachedToken;
    const tokenPath = runtimePaths().daemonToken;
    const existing = readJsonToken(tokenPath);
    if (existing) {
      cachedToken = existing;
      return cachedToken;
    }
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    cachedToken = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(tokenPath, cachedToken + "\n", { mode: 0o600 });
    return cachedToken;
  }

  function readJsonToken(tokenPath) {
    try {
      return String(fs.readFileSync(tokenPath, "utf8")).trim();
    } catch {
      return "";
    }
  }

  function describeDaemonTarget() {
    // Prefer the target kind/identity the launcher stamped into env
    // (MIA_DAEMON_TARGET_KIND) so this process reports the SAME target the
    // resolver chose, without re-resolving anything. Falls back to the
    // node-core literal when launched directly (`node mia-core.js`).
    const kind = String(env.MIA_DAEMON_TARGET_KIND || "").trim() || "node-core";
    const usesGuiAppIdentity = String(env.MIA_DAEMON_USES_GUI_IDENTITY || "") === "1";
    return {
      kind,
      command: path.basename(process.execPath),
      usesGuiAppIdentity,
      workingDirectory: process.cwd()
    };
  }

  // REAL scheduler subsystem — built lazily so constructing createMiaCore arms NO
  // timers (single-owner safety). The subsystem itself also starts no timers on
  // construction; only its initSchedulerSubsystem() (called by the control server
  // on start()) arms them. Reuses Core's botExecution (real Hermes adapter graph)
  // and the same pure-node tasks/scheduler modules the Electron daemon drives.
  let cachedScheduler = null;
  function schedulerSubsystem() {
    if (cachedScheduler) return cachedScheduler;
    cachedScheduler = createCoreScheduler({
      runtimePaths,
      settingsStore,
      botExecution: botExecution(),
      // Reuse the same cloud socialApi the cloud routing builds, so task replies
      // and interactive replies post through one client.
      socialApi: cloudRouting().socialApi,
      emitLocalEvent: (envelope) => controlServer.publishLocalEvent?.(envelope),
      log: () => {}
    });
    return cachedScheduler;
  }

  const controlServer = createDaemonControlServer({
    isDaemonProcess: true,
    serviceLabel: MIA_DAEMON_SERVICE_LABEL,
    daemonToken,
    appVersion: () => version,
    describeDaemonTarget,
    runtimePaths,
    getDaemonSettings: () => settingsStore.daemonSettings(),
    writeDaemonSettings: (settings) => settingsStore.writeDaemonSettings(settings),
    normalizeDaemonHost: settingsStore.normalizeDaemonHost,
    normalizeDaemonPort: settingsStore.normalizeDaemonPort,
    choosePort,
    // Inert until later vertical slices migrate this capability into Core.
    initializeRuntime: () => {},
    remoteRouter: () => ({ matches: () => false, route: async () => ({ handled: false }) }),
    // REAL scheduler: the control server calls initSchedulerSubsystem() on start()
    // (arming timers) and tasksRoutes() per request to serve /api/tasks.
    initSchedulerSubsystem: () => schedulerSubsystem().initSchedulerSubsystem(),
    tasksRoutes: () => schedulerSubsystem().tasksRoutes
  });

  function start() {
    return controlServer.start(settingsStore.daemonSettings());
  }

  // Bot execution is built lazily and exposed for testing. It is NOT auto-started
  // on cloud yet — wiring it into the cloud events loop is a later vertical slice.
  // The engine HTTP baseUrl + apiKey + lowest-level Hermes send are injectable so
  // tests can fake only the HTTP layer while the real adapter graph stays intact.
  // Resolve the live Hermes endpoint as FUNCTIONS so a Hermes restart / config
  // change is re-read on the next turn. Env vars are an OVERRIDE only — in
  // production the daemon env does NOT set them, so Core falls back to the
  // on-disk runtime home it owns (config.yaml port + mia-api-server.key).
  const envHermesBaseUrl = String(env.MIA_HERMES_BASE_URL || "").trim();
  const envHermesApiKey = String(env.MIA_HERMES_API_KEY || "").trim();
  const resolveHermesBaseUrl = () => (envHermesBaseUrl
    ? envHermesBaseUrl
    : coreHermesBaseUrl(runtimePaths().hermesHome));
  const resolveHermesApiKey = () => (envHermesApiKey
    ? envHermesApiKey
    : coreReadHermesApiKey(runtimePaths().hermesHome));

  let cachedBotExecution = null;
  function botExecution(overrides = {}) {
    if (cachedBotExecution && !Object.keys(overrides).length) return cachedBotExecution;
    const built = createCoreBotExecution({
      runtimePaths,
      settingsStore,
      hermesBaseUrl: resolveHermesBaseUrl,
      apiKey: resolveHermesApiKey,
      ...overrides
    });
    if (!Object.keys(overrides).length) cachedBotExecution = built;
    return built;
  }

  // Cloud bot-invocation routing is built lazily and exposed for testing. It is
  // NOT auto-started and NOT auto-connected to the real cloud WebSocket — that is
  // a later vertical slice (dual-owner risk). The control server boot is unchanged.
  // It reuses the SAME botExecution graph (real Hermes adapter) and the same
  // pure-node social modules the Electron path drives.
  let cachedCloudRouting = null;
  function cloudRouting(overrides = {}) {
    if (cachedCloudRouting && !Object.keys(overrides).length) return cachedCloudRouting;
    const built = createCoreCloudRouting({
      runtimePaths,
      settingsStore,
      botExecution: overrides.botExecution || botExecution(),
      // The control server's local event channel: push run streams to any
      // window listening on the daemon's local event feed (ADR P0).
      emitLocalEvent: (envelope) => controlServer.publishLocalEvent?.(envelope),
      log: () => {},
      ...overrides
    });
    if (!Object.keys(overrides).length) cachedCloudRouting = built;
    return built;
  }

  // Cloud-events WebSocket client — built lazily and exposed for testing. It is
  // NOT connected on construction/import; only createMiaCore.start() connects it
  // (gated on cloud enabled+token), and stop() disconnects it. This is the
  // single-owner cut-over point: Core only hosts /api/events when it actually
  // runs as the daemon. Reuses the SAME pure-node client main.js drives.
  let cachedCloudEvents = null;
  function cloudEvents(overrides = {}) {
    if (cachedCloudEvents && !Object.keys(overrides).length) return cachedCloudEvents;
    const built = createCoreCloudEvents({
      settingsStore,
      cloudRouting: overrides.cloudRouting || cloudRouting(),
      // Production transport is the same `ws` package main.js uses (no fork);
      // tests inject a mock socket class.
      WebSocketImpl: overrides.WebSocketImpl || require("ws"),
      emitLocalEvent: (envelope) => controlServer.publishLocalEvent?.(envelope),
      log: () => {},
      ...overrides
    });
    if (!Object.keys(overrides).length) cachedCloudEvents = built;
    return built;
  }

  // Cloud-BRIDGE WebSocket client — built lazily and exposed for testing. Like
  // the events client it is NOT connected on construction/import; only
  // createMiaCore.start() connects it (gated on cloud enabled+token), and stop()
  // disconnects it. Reuses the SAME pure-node client main.js drives. Bridge runs
  // execute through Core's own botExecution graph (Hermes-only).
  let cachedCloudBridge = null;
  function cloudBridge(overrides = {}) {
    if (cachedCloudBridge && !Object.keys(overrides).length) return cachedCloudBridge;
    const built = createCoreCloudBridge({
      settingsStore,
      botExecution: overrides.botExecution || botExecution(),
      // Production transport is the same `ws` package main.js uses (no fork);
      // tests inject a mock socket class.
      WebSocketImpl: overrides.WebSocketImpl || require("ws"),
      emitLocalEvent: (envelope) => controlServer.publishLocalEvent?.(envelope),
      deviceId: "mia-core",
      version,
      log: () => {},
      ...overrides
    });
    if (!Object.keys(overrides).length) cachedCloudBridge = built;
    return built;
  }

  async function startWithCloud() {
    const status = await start();
    // SINGLE-OWNER CUT-OVER: connect to the cloud sockets only AFTER the control
    // server is up AND cloud is enabled with a token. Never connect at
    // import/construction — only here, when Core runs as the daemon.
    const cloud = settingsStore.cloudSettings();
    if (cloud.enabled && cloud.token) {
      cloudEvents().start();
      cloudBridge().start();
    }
    return status;
  }

  return {
    start: startWithCloud,
    stop: () => {
      // Disconnect the cloud sockets first so their reconnect timers + active
      // sockets are torn down before the control server stops (clean shutdown,
      // node --test exits). No-op if they were never built/connected.
      if (cachedCloudEvents) cachedCloudEvents.stop();
      if (cachedCloudBridge) cachedCloudBridge.stop();
      // Clear any armed scheduler timer so node --test (and a clean shutdown)
      // exits; if the subsystem was never built this is a no-op.
      if (cachedScheduler) cachedScheduler.stopScheduler();
      return controlServer.stop();
    },
    status: () => controlServer.status(),
    daemonSettings: () => settingsStore.daemonSettings(),
    writeDaemonSettings: (settings) => settingsStore.writeDaemonSettings(settings),
    runtimePaths,
    daemonToken,
    describeDaemonTarget,
    botExecution,
    cloudRouting,
    cloudEvents,
    cloudBridge,
    schedulerSubsystem
  };
}

module.exports = {
  createMiaCore,
  createCoreBotExecution,
  createCoreCloudRouting,
  createCoreCloudEvents,
  createCoreCloudBridge,
  createCoreScheduler,
  // Exported for the engine-endpoint proof test: Core's on-disk Hermes endpoint
  // discovery (the production source of truth when MIA_HERMES_* env is unset).
  coreHermesBaseUrl,
  coreReadHermesApiKey,
  coreReadHermesPort
};

if (require.main === module) {
  const core = createMiaCore({ version: require("../../package.json").version });
  core.start().then((status) => {
    process.stdout.write(`mia-core listening at ${status.baseUrl} (home ${core.runtimePaths().home})\n`);
  }).catch((error) => {
    process.stderr.write(`mia-core failed to start: ${error && error.message}\n`);
    process.exit(1);
  });
}
