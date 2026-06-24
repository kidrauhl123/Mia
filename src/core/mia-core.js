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

// Cloud bot-invocation routing — the SAME pure-node social modules the Electron
// main process drives (no fork). Core is the single owner when running, so the
// dispatcher always handles (shouldHandle: () => true) and never falls back.
const { createSocialApi } = require("../main/social/social-api.js");
const { createLocalBotResponder } = require("../main/social/local-bot-responder.js");
const { createMainBotRuntimeDispatcher } = require("../main/social/bot-runtime-dispatcher.js");

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

  // Real Hermes run service (payload/stream/slash helpers). Attachments are not
  // exercised in this slice; the no-op attachment deps match the service's own
  // documented defaults.
  // TODO(mia-core slice): wire real attachment normalization once Core owns the
  // attachment store.
  const hermesRunService = createHermesRunService({
    normalizeAttachments: () => [],
    attachmentContext: () => "",
    baseUrl,
    apiKey: apiKeyFn,
    fetchImpl,
    randomUUID: () => crypto.randomUUID()
  });

  // Real Hermes chat adapter — provides slashCommandResponse and (in production)
  // the real sendChat. The optional MCP/memory/managed-model deps are stubbed for
  // this slice but the adapter itself is the genuine one.
  const hermesAdapter = createHermesChatAdapter({
    apiKey: apiKeyFn,
    baseUrl,
    buildGroupHeader: () => "",
    buildRunPayload: hermesRunService.buildRunPayload,
    normalizeError: hermesRunService.normalizeError,
    readRunEventStream: hermesRunService.readRunEventStream,
    responseModel: adapterForEngine("hermes").responseModel,
    fetch: fetchImpl,
    // TODO(mia-core slice): inject the real memory block once Core owns the
    // memory store.
    memoryBlock: () => "",
    // TODO(mia-core slice): wire the scheduler MCP context write once Core owns
    // the scheduler subsystem.
    writeSchedulerMcpContext: () => {},
    // TODO(mia-core slice): wire the Mia app MCP context write once Core owns the
    // app MCP bridge.
    writeMiaAppMcpContext: () => {},
    // TODO(mia-core slice): wire the managed-model runtime once Core owns model
    // settings; until then Hermes uses the turn's runtimeConfig as-is.
    resolveManagedModelRuntime: () => null,
    writeModelRuntimeConfig: () => {},
    // TODO(mia-core slice): wire full enabled-skills context once Core owns the
    // skills loader.
    buildEnabledSkillsContext: () => "",
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
    // TODO(mia-core slice): wire the real skills loader directive; an empty
    // directive is correct-but-minimal for this slice.
    skillsLoader: { buildActiveSkillsDirective: () => "" },
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
    return {
      kind: "node-core",
      command: path.basename(process.execPath),
      usesGuiAppIdentity: false,
      workingDirectory: process.cwd()
    };
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
    // Inert until later vertical slices migrate these capabilities into Core.
    initializeRuntime: () => {},
    initSchedulerSubsystem: () => {},
    remoteRouter: () => ({ matches: () => false, route: async () => ({ handled: false }) }),
    tasksRoutes: () => ({ handle: async () => false, handleEventsStream: () => {} })
  });

  function start() {
    return controlServer.start(settingsStore.daemonSettings());
  }

  // Bot execution is built lazily and exposed for testing. It is NOT auto-started
  // on cloud yet — wiring it into the cloud events loop is a later vertical slice.
  // The engine HTTP baseUrl + apiKey + lowest-level Hermes send are injectable so
  // tests can fake only the HTTP layer while the real adapter graph stays intact.
  let cachedBotExecution = null;
  function botExecution(overrides = {}) {
    if (cachedBotExecution && !Object.keys(overrides).length) return cachedBotExecution;
    const built = createCoreBotExecution({
      runtimePaths,
      settingsStore,
      hermesBaseUrl: env.MIA_HERMES_BASE_URL || "",
      apiKey: env.MIA_HERMES_API_KEY || "",
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

  return {
    start,
    stop: () => controlServer.stop(),
    status: () => controlServer.status(),
    daemonSettings: () => settingsStore.daemonSettings(),
    writeDaemonSettings: (settings) => settingsStore.writeDaemonSettings(settings),
    runtimePaths,
    daemonToken,
    describeDaemonTarget,
    botExecution,
    cloudRouting
  };
}

module.exports = { createMiaCore, createCoreBotExecution, createCoreCloudRouting };

if (require.main === module) {
  const core = createMiaCore({ version: require("../../package.json").version });
  core.start().then((status) => {
    process.stdout.write(`mia-core listening at ${status.baseUrl} (home ${core.runtimePaths().home})\n`);
  }).catch((error) => {
    process.stderr.write(`mia-core failed to start: ${error && error.message}\n`);
    process.exit(1);
  });
}
