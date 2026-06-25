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

const { spawn: defaultSpawn } = require("node:child_process");

const { createRuntimePaths } = require("../main/runtime-paths.js");
const { createSettingsStore } = require("../main/settings-store.js");
const { createDaemonControlServer } = require("../main/daemon/control-server.js");
const { createEngineHealthService } = require("../main/engine-health-service.js");

// Engine lifecycle collaborators — the SAME pure-node factories the Electron
// main process drives to START Hermes (src/main.js:1856 startEngine). All are
// node-constructible (verified): no app.getAppPath/BrowserWindow; the bundled
// python is NOT used — Hermes is an upstream engine resolved from PATH
// (systemHermesService.pythonPath), exactly like claude/codex. Core reuses these
// verbatim so a GUI-less daemon can own the engine when no GUI window is running.
const { createSystemHermesService } = require("../main/system-hermes-service.js");
const { createEnginePluginsService } = require("../main/engine-plugins-service.js");

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

// PART B — active Codex / Claude Code / OpenClaw engines in Core. The 4 adapter
// MODULES + every dependency service below are pure node (0 electron requires —
// verified): external CLIs (claude/codex/openclaw) are resolved from PATH, never
// packaged (per AGENTS.md). Core constructs the SAME adapters main.js drives
// (src/main.js createActiveCodexChatAdapter / createActiveClaudeCodeChatAdapter /
// createActiveOpenClawChatAdapter — no fork), with node values for the few deps
// main.js sources from electron-coupled collaborators.
const { createClaudeCodeChatAdapter } = require("../main/claude-code-chat-adapter.js");
const { createCodexChatAdapter } = require("../main/codex-chat-adapter.js");
const { createOpenClawChatAdapter } = require("../main/openclaw-chat-adapter.js");
const { runCodexAppServerTurn } = require("../main/codex-app-server-runner.js");
const { createLocalAgentEngineService } = require("../main/local-agent-engine-service.js");
const { createAgentPermissionCoordinator } = require("../main/agent-permission-coordinator.js");
const { createAgentSessionStore } = require("../main/agent-session-store.js");
const { createClaudeBridgePluginService } = require("../main/claude-bridge-plugin-service.js");
const { createClaudeCodeMiaProxy } = require("../main/claude-code-mia-proxy.js");
const { createCodexMiaProxy } = require("../main/codex-mia-proxy.js");
const { createMcpSdkClientManager } = require("../main/mcp/mcp-sdk-client.js");
const { createMcpBridgeServer } = require("../main/mcp/mcp-bridge-server.js");
const { createCoreMcpService } = require("./mcp/service.js");
const { createManagedConnectorSupervisor } = require("./mcp/managed-connector-supervisor.js");
const { createCoreMcpOAuthService } = require("./mcp/oauth-service.js");
const { createCoreMcpOAuthTokenStore } = require("./mcp/oauth-token-store.js");

// Claude Agent SDK — plain-node ESM package (NOT electron). main.js loads it via
// `await import("@anthropic-ai/claude-agent-sdk")`; Core does the same. For a
// PACKAGED Core (plain node), the package must be asarUnpack'd so node can
// import it from outside app.asar — see package.json build.asarUnpack.
let claudeAgentSdkModule = null;
async function coreClaudeAgentSdk() {
  if (!claudeAgentSdkModule) claudeAgentSdkModule = await import("@anthropic-ai/claude-agent-sdk");
  return claudeAgentSdkModule;
}

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
// routes the run into Core's own botExecution.sendChat (all engines: PART B).
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

// process.resourcesPath is set ONLY in a packaged Electron build (…/Contents/
// Resources). Plain node (dev / `node mia-core.js`) leaves it undefined. Core
// resolves the bundled official-library + _builtin skills differently per mode:
//
//   DEV (no resourcesPath): the repo checkout — <repo>/resources/official-library
//   and <repo>/skills (two levels up from src/core/).
//
//   PACKAGED (resourcesPath set): packaging (package.json `build`) puts
//   `resources/official-library/**` under app.asar.unpacked (asarUnpack — a plain
//   node binary CANNOT read inside app.asar, so it MUST be unpacked) and ships
//   `skills` via extraResources to <resources>/skills. So Core resolves:
//     manifest →  <resources>/app.asar.unpacked/resources/official-library/library.json
//     skills/  →  <resources>/skills/...
//
// These mirror botPetService.officialLibraryManifestPath / miaSkillsRoot /
// resolveOfficialLibraryRoot (electron-coupled via app.getAppPath()) but are
// node-only — NOT extracted from bot-pet-service (no fork). The directive/context
// builders tolerate a missing manifest (readMiaOfficialSkillSources returns [] →
// only the private <home>/skills source is active), so this stays correct even
// when neither candidate exists.
function corePackagedResourcesPath() {
  return String(process.resourcesPath || "").trim();
}

function coreOfficialLibraryManifestPath() {
  const res = corePackagedResourcesPath();
  const candidates = [];
  if (res) {
    // Packaged: official-library is asarUnpack'd so plain node can read it.
    candidates.push(path.join(res, "app.asar.unpacked", "resources", "official-library", "library.json"));
    // Defensive: some packagers leave a flat copy under <resources>.
    candidates.push(path.join(res, "official-library", "library.json"));
  }
  candidates.push(path.join(CORE_REPO_ROOT, "resources", "official-library", "library.json"));
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || candidates[candidates.length - 1];
}

// Root that holds the shipped `skills/_builtin` tree (pet-generator etc.).
function coreMiaSkillsRoot() {
  const res = corePackagedResourcesPath();
  const candidates = [];
  if (res) {
    // extraResources ships `skills` to <resources>/skills.
    candidates.push(path.join(res, "skills"));
  }
  candidates.push(path.join(CORE_REPO_ROOT, "skills"));
  return candidates.find((candidate) => candidate && fs.existsSync(path.join(candidate, "_builtin")))
    || candidates[candidates.length - 1];
}

function coreResolveOfficialLibraryRoot(root = "") {
  const value = String(root || "").trim();
  if (!value) return "";
  if (path.isAbsolute(value)) return value;
  // The bundled skillSources use roots like "skills/_builtin"; resolve them
  // against the shipped skills root (extraResources in packaged mode, <repo>/
  // skills in dev) — the same layout botPetService resolves via miaSkillsRoot.
  if (value === "skills" || value.startsWith("skills/")) {
    const rel = value.slice("skills".length).replace(/^[\\/]/, "");
    return path.join(coreMiaSkillsRoot(), rel);
  }
  return path.join(path.dirname(coreOfficialLibraryManifestPath()), value);
}

// Build the REAL bot-execution core for the node Core process. This constructs
// the same adapter graph the Electron main process builds — createChatEngineAdapters
// → sendWithChatEngineAdapter → adapter.send — reusing the real shared helpers
// (bot snapshot/runtime-config/skill/scheduler normalization). All FOUR engines
// are wired to their REAL adapters: Hermes (HTTP), and — PART B — Codex / Claude
// Code / OpenClaw (external CLIs resolved from PATH). The Hermes lowest-level
// `sendHermesChat` is host-injectable (real adapter.sendChat in production; a fake
// in tests) so only the engine HTTP layer is replaced while the graph stays real.
function createCoreBotExecution({
  runtimePaths,
  settingsStore,
  hermesBaseUrl,
  apiKey,
  sendHermesChat,
  fetchImpl = fetch,
  // BLOCKER #2: ensure the Hermes engine is running before a turn. In production
  // Core injects its engine supervisor's ensureRunning (adopt-or-spawn); when
  // absent (older callers / pure-adapter tests) Core falls back to a plain
  // /health probe, preserving the prior behaviour.
  ensureEngine = null,
  // PART A: managed-model runtime. `hermesHome` locates config.yaml for the
  // model/provider write; `engineOwnedByCore` reports whether Core SPAWNED the
  // engine (vs adopted the GUI's). Core writes the model block ONLY when it owns
  // the engine — see resolveManagedModelRuntime / writeModelRuntimeConfig below.
  hermesHome = null,
  engineOwnedByCore = null,
  // PART B: the daemon-control facts the scheduler/Mia-app MCP specs embed so a
  // Codex/Claude/OpenClaw turn's MCP servers can call back into Core's daemon
  // (MIA_DAEMON_URL/TOKEN). All optional: absent (tests / Hermes-only callers) →
  // getSpec degrades to null (no MCP) and the engines still run their turn.
  daemonStatus = null,
  daemonSettings = null,
  daemonToken = null,
  // PART B test seam: override the PATH-resolving CLI service so a proof test can
  // deterministically force "CLI absent" (the engine adapter then hits its own
  // distinctive guard) WITHOUT spawning a real external agent. Production passes
  // nothing → the real createLocalAgentEngineService is used.
  localAgentEngineService: injectedLocalAgentEngineService = null,
  // PART B test seam: override the Claude Agent SDK loader so a proof test can
  // assert the real Claude adapter reached the SDK without loading the npm package.
  claudeAgentSdk: injectedClaudeAgentSdk = null,
  // Test seam: override the Claude/Codex managed-model proxies so a shutdown test
  // can assert closeAgentEngines() stops their loopback servers.
  claudeCodeMiaProxy: injectedClaudeProxy = null,
  codexMiaProxy: injectedCodexProxy = null
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

  // PART B — local agent engine service (pure node). Provides the PATH-resolved
  // CLI lookup (shellCommandPath: claude/codex/openclaw/node), the codex runtime
  // env/profile helpers, and processEnvWithCliPath — the SAME service main.js
  // drives (src/main.js:425). Constructed from node values only (homeDir/env/
  // resourcesPath/spawnSync + node predicates); external CLIs come from PATH.
  const localAgentEngineService = injectedLocalAgentEngineService || createLocalAgentEngineService({
    homeDir: () => os.homedir(),
    env: process.env,
    resourcesPath: process.resourcesPath || ""
  });
  const coreNodePath = () => String(localAgentEngineService.shellCommandPath("node") || "").trim() || process.execPath;

  // REAL MCP context bridges — pure node. writeContext writes the per-turn
  // {botId, sessionId, originMessageId} to context.json under Core's runtime home;
  // the MCP server scripts read that file + MIA_DAEMON_URL to call back into the
  // daemon — and Core IS that daemon (its control server + /api/tasks routes).
  //
  // PART B also needs getSpec (the stdio MCP spec Codex/Claude embed in their own
  // config). getSpec requires the daemon base-url + token + node path; Core passes
  // them when available (daemonStatus/daemonSettings/daemonToken injected by
  // createMiaCore). Absent (tests / Hermes-only) getSpec returns null and the turn
  // simply runs without the Mia MCP servers. Hermes still gets its MCP via the
  // engine's own config.yaml (the GUI-owned richer path) — Core does not write it.
  const schedulerMcpBridge = createSchedulerMcpBridge({
    runtimePaths,
    serverScriptPath: () => path.join(__dirname, "..", "main", "scheduler-mcp-server.js"),
    daemonStatus: typeof daemonStatus === "function" ? daemonStatus : undefined,
    daemonSettings: typeof daemonSettings === "function" ? daemonSettings : undefined,
    daemonToken: typeof daemonToken === "function" ? daemonToken : undefined,
    nodePath: coreNodePath,
    homeDir: () => os.homedir()
  });
  const miaAppMcpBridge = createMiaAppMcpBridge({
    runtimePaths,
    serverScriptPath: () => path.join(__dirname, "..", "main", "mia-app-mcp-server.js"),
    daemonStatus: typeof daemonStatus === "function" ? daemonStatus : undefined,
    daemonSettings: typeof daemonSettings === "function" ? daemonSettings : undefined,
    daemonToken: typeof daemonToken === "function" ? daemonToken : undefined,
    nodePath: coreNodePath
  });

  // PART A — managed-model runtime (node-only reconstruction of main.js
  // resolveManagedModelRuntime, src/main.js:2014). A Mia-managed-model bot
  // (provider "mia" / authType "mia_account" / modelProfileId "mia:*") resolves
  // to the Mia cloud model-proxy provider. Cloud settings (url/token) come from
  // the SAME single-owner settings-store the Electron path reads — node, no
  // electron coupling (main.js's cloudStatus(true) returns the identical
  // {enabled, url, token} fields cloudSettings() exposes directly).
  const coreCloudSettings = () => (settingsStore && typeof settingsStore.cloudSettings === "function"
    ? settingsStore.cloudSettings()
    : { enabled: false, url: "", token: "" });
  const normalizeCloudUrl = settingsStore && typeof settingsStore.normalizeCloudUrl === "function"
    ? settingsStore.normalizeCloudUrl
    : (value) => String(value || "");

  function resolveManagedModelRuntime(config = {}) {
    const provider = String(config.provider || config.modelProvider || config.model_provider || "").trim();
    const authType = String(config.authType || config.auth_type || "").trim();
    const profileId = String(config.modelProfileId || config.model_profile_id || "").trim();
    const model = String(config.model || "").trim();
    if (provider !== "mia" && authType !== "mia_account" && !profileId.startsWith("mia:")) return null;
    const cloud = coreCloudSettings();
    if (!cloud?.enabled || !cloud.token || !cloud.url) {
      throw new Error("这个 Bot 使用 Mia 托管模型，请先登录 Mia Cloud。");
    }
    const cloudBaseUrl = normalizeCloudUrl(cloud.url);
    return {
      provider: "mia",
      providerLabel: "Mia",
      model: model || "mia-default",
      authType: "mia_account",
      apiKeyEnv: "MIA_CLOUD_MODEL_TOKEN",
      baseUrl: `${cloudBaseUrl}/api/me/model-proxy/v1`,
      anthropicBaseUrl: `${cloudBaseUrl}/api/me/model-proxy`,
      apiKey: cloud.token,
      apiMode: "chat_completions"
    };
  }

  // PART A — writeModelRuntimeConfig. Minimal read-modify-write of the Hermes
  // config.yaml model/provider block, mirroring ONLY the model-related key paths
  // of engineRuntimeConfigService.writeRuntimeConfig (config.model.{provider,
  // default,base_url,api_mode} + config.providers[provider].{name,base_url,
  // key_env,api_key,default_model,api_mode}). Every other key (api_server,
  // approvals, agent, skills, mcp_servers, mia, ...) is preserved untouched.
  //
  // SINGLE-OWNER (AION): the backend that OWNS the engine owns this config write.
  // Core writes ONLY when it SPAWNED the engine (engineOwnedByCore() === true).
  // If Core ADOPTED the GUI's engine, the GUI owns config.yaml and already wrote
  // the model — Core must not fight it (no-op). When no ownership predicate is
  // injected (pure-adapter tests), Core writes so the proof can assert the keys.
  const resolveHermesHome = typeof hermesHome === "function"
    ? hermesHome
    : () => String(hermesHome || (runtimePaths && runtimePaths().hermesHome) || "");

  function writeModelRuntimeConfig(settings = {}) {
    if (typeof engineOwnedByCore === "function" && !engineOwnedByCore()) return;
    const home = resolveHermesHome();
    if (!home) return;
    const configPath = path.join(home, "config.yaml");
    let config = {};
    try {
      if (fs.existsSync(configPath)) config = yaml.load(fs.readFileSync(configPath, "utf8")) || {};
    } catch {
      config = {};
    }
    if (!config || typeof config !== "object") config = {};

    const provider = String(settings.provider || "").trim();
    const model = String(settings.model || "").trim();
    const apiKeyEnv = String(settings.apiKeyEnv || "").trim();
    const baseUrl = String(settings.baseUrl || "").trim();
    const apiMode = String(settings.apiMode || "").trim();

    const modelConfig = config.model && typeof config.model === "object" ? { ...config.model } : {};
    if (provider) modelConfig.provider = provider;
    if (model) modelConfig.default = model;
    if (baseUrl) modelConfig.base_url = baseUrl;
    if (apiMode) modelConfig.api_mode = apiMode;
    if (Object.keys(modelConfig).length) config.model = modelConfig;

    if (provider && baseUrl) {
      const providers = config.providers && typeof config.providers === "object" ? { ...config.providers } : {};
      const providerConfig = providers[provider] && typeof providers[provider] === "object" ? { ...providers[provider] } : {};
      providerConfig.name = settings.providerLabel || provider;
      providerConfig.base_url = baseUrl;
      if (apiKeyEnv) providerConfig.key_env = apiKeyEnv;
      if (settings.apiKey) providerConfig.api_key = settings.apiKey;
      if (model) providerConfig.default_model = model;
      if (apiMode) providerConfig.api_mode = apiMode;
      providers[provider] = providerConfig;
      config.providers = providers;
    }

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const tmpPath = `${configPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, yaml.dump(config, { lineWidth: 100, noRefs: true }), { mode: 0o600 });
    fs.renameSync(tmpPath, configPath);
  }

  // Real Hermes chat adapter — provides slashCommandResponse and (in production)
  // the real sendChat. The MCP context writes are the genuine bridges; PART A
  // wires the REAL managed-model resolve + config write (above); the adapter
  // itself is genuine.
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
    // PART A — REAL managed-model runtime. resolveManagedModelRuntime returns the
    // Mia cloud model-proxy provider for a Mia-managed-model bot; writeModelRuntimeConfig
    // writes ONLY the model/provider block into config.yaml (single-owner gated:
    // Core writes only when it SPAWNED the engine, see above).
    resolveManagedModelRuntime,
    writeModelRuntimeConfig,
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

  // ensureHermesReady: when Core owns the engine lifecycle (an ensureEngine is
  // injected), ADOPT-OR-SPAWN the Hermes engine so a GUI-less daemon turn always
  // has a running engine (BLOCKER #2). Otherwise fall back to a plain /health
  // probe (legacy behaviour: the Electron app owns the engine).
  async function ensureHermesReady() {
    if (typeof ensureEngine === "function") {
      try {
        await ensureEngine();
      } catch {
        // Non-fatal here: the actual send below surfaces a real connection error.
      }
      return;
    }
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

  // ====================================================================
  // PART B — active Codex / Claude Code / OpenClaw engines (all pure node).
  // Core constructs the SAME adapters main.js drives (createActiveCodexChatAdapter
  // / createActiveClaudeCodeChatAdapter / createActiveOpenClawChatAdapter — no
  // fork), substituting node values for the few deps main.js sources from
  // electron-coupled collaborators. The external CLIs (claude/codex/openclaw) are
  // resolved from PATH via localAgentEngineService.shellCommandPath (per AGENTS.md:
  // engines are never packaged). Every dependency below is node-constructible
  // (audited: 0 electron requires in any adapter module or its dep services).
  // ====================================================================

  // Per-engine permission policy + cross-turn agent-session map: pure JSON I/O
  // under Core's single-owner runtime home — the SAME stores main.js drives.
  const agentPermissionCoordinator = createAgentPermissionCoordinator({ runtimePaths, readJson });
  const agentSessionStore = createAgentSessionStore({
    runtimePaths,
    readJson,
    normalizeBotAgentEngine: normalizeAgentEngine
  });

  // Claude bridge plugin + Mia model proxies (Claude/Codex managed model over the
  // Mia cloud model-proxy) — pure node (fs/fetch). The proxies start a local
  // loopback HTTP server lazily ONLY when a managed-model turn calls createSession
  // — never at construction, so importing Core has no side effect.
  const claudeBridgePluginService = createClaudeBridgePluginService({ runtimePaths });
  const claudeCodeMiaProxy = injectedClaudeProxy || createClaudeCodeMiaProxy({ appendLog: () => {}, fetch: fetchImpl });
  const codexMiaProxy = injectedCodexProxy || createCodexMiaProxy({ appendLog: () => {}, fetch: fetchImpl });

  // User-defined MCP servers (the same registry main.js drives). All node: the
  // manager/bridge/service are pure JS; the bridge binds a loopback port lazily on
  // initialize(), not at construction. processEnvStrings reuses the PATH-augmented
  // env from localAgentEngineService.
  const processEnvStrings = () => Object.fromEntries(
    Object.entries(localAgentEngineService.processEnvWithCliPath()).filter(([, value]) => typeof value === "string")
  );
  const userMcpOAuthTokenStore = createCoreMcpOAuthTokenStore({ runtimePaths, fs });
  const userMcpOAuthService = createCoreMcpOAuthService({
    tokenStore: userMcpOAuthTokenStore,
    fetch: fetchImpl
  });
  const userMcpManager = createMcpSdkClientManager({
    processEnvStrings,
    appendLog: () => {},
    oauthService: userMcpOAuthService,
    authorizeToolCall: async ({ args, options = {} }) => {
      const toolLabel = String(options.toolLabel || "").trim() || "mcp.tool";
      let preview = "";
      try { preview = args ? JSON.stringify(args, null, 2).slice(0, 4000) : ""; } catch { preview = ""; }
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
    appendLog: () => {}
  });
  const userMcpService = createCoreMcpService({
    runtimePaths,
    manager: userMcpManager,
    bridge: userMcpBridge,
    nodePath: coreNodePath,
    stdioProxyScriptPath: () => path.join(__dirname, "..", "main", "mcp", "mcp-stdio-proxy-server.js"),
    oauthTokenStore: userMcpOAuthTokenStore,
    oauthService: userMcpOAuthService,
    fetch: fetchImpl,
    processEnvStrings,
    openExternal: async () => {},
    managedSupervisor: createManagedConnectorSupervisor({
      runtimePaths,
      fs,
      fetch: fetchImpl,
      testTools: (record) => userMcpManager.testServer(record)
    })
  });
  async function ensureUserMcpReady() {
    try { await userMcpService.awaitInitialization(); } catch { /* MCP optional; turn proceeds */ }
  }

  // Mia-owned agent workspace (never `/` or the user's home). Core owns
  // runtimePaths().workspace — the SAME default main.js uses (src/main.js:561).
  function agentWorkspaceDir() {
    const dir = runtimePaths().workspace;
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
    return dir;
  }

  const readBotPersona = botManifest.readBotPersona;
  const enginePermissionMode = settingsStore && typeof settingsStore.enginePermissionMode === "function"
    ? settingsStore.enginePermissionMode
    : () => "default";
  const normalizeEffortLevel = settingsStore && typeof settingsStore.normalizeEffortLevel === "function"
    ? settingsStore.normalizeEffortLevel
    : (value) => String(value || "medium").trim() || "medium";

  // The three active adapters — constructed exactly like main.js (deps mapped to
  // Core's node services). Lazily built so a failure in one engine doesn't break
  // the others, and so building Core has no side effect.
  let cachedClaudeCodeAdapter = null;
  function activeClaudeCodeAdapter() {
    if (!cachedClaudeCodeAdapter) {
      cachedClaudeCodeAdapter = createClaudeCodeChatAdapter({
        appendEngineLog: () => {},
        cwd: agentWorkspaceDir,
        chatCompletionResponse,
        claudeAgentSdk: typeof injectedClaudeAgentSdk === "function" ? injectedClaudeAgentSdk : coreClaudeAgentSdk,
        ensureClaudeBridgePlugin: () => claudeBridgePluginService.ensureInstalled(),
        ensureUserMcpReady,
        expandLeadingSkillCommand: skillsLoader.expandLeadingSkillCommand,
        buildEnabledSkillsContext: skillsLoader.buildEnabledSkillsContext,
        clearAgentSessionEntry: agentSessionStore.deleteEntry,
        enginePermissionMode,
        ensureMiaClaudeProxy: (managedModel) => claudeCodeMiaProxy.createSession(managedModel),
        getAgentSessionEntry: agentSessionStore.getEntry,
        getMcpFingerprint: userMcpService.fingerprint,
        getMiaAppMcpSpec: miaAppMcpBridge.getSpec,
        getSchedulerMcpSpec: schedulerMcpBridge.getSpec,
        getUserMcpSpecs: () => userMcpService.getEngineSpecs("claude-code"),
        injectGroupContextForSdk: (userMessage) => userMessage,
        lastUserPrompt: hermesRunService.lastUserPrompt,
        memoryBlock: miaMemoryService.memoryBlock,
        normalizeEffortLevel,
        permissionCoordinator: agentPermissionCoordinator,
        processEnvStrings,
        readBotPersona,
        resolveManagedModelRuntime,
        setAgentSessionEntry: agentSessionStore.setEntry,
        shellCommandPath: localAgentEngineService.shellCommandPath,
        writeSchedulerMcpContext: schedulerMcpBridge.writeContext
      });
    }
    return cachedClaudeCodeAdapter;
  }

  let cachedCodexAdapter = null;
  function activeCodexAdapter() {
    if (!cachedCodexAdapter) {
      cachedCodexAdapter = createCodexChatAdapter({
        buildEnabledSkillsContext: skillsLoader.buildEnabledSkillsContext,
        chatCompletionResponse,
        cwd: agentWorkspaceDir,
        appendEngineLog: () => {},
        enginePermissionMode,
        ensureCodexHome: schedulerMcpBridge.ensureCodexHome,
        ensureMiaCodexProxy: (managedModel) => codexMiaProxy.createSession(managedModel),
        ensureUserMcpReady,
        expandLeadingSkillCommand: skillsLoader.expandLeadingSkillCommand,
        getAgentSessionEntry: agentSessionStore.getEntry,
        getAgentSessionId: agentSessionStore.getId,
        getMcpFingerprint: userMcpService.fingerprint,
        getMiaAppMcpSpec: miaAppMcpBridge.getSpec,
        getSchedulerMcpSpec: schedulerMcpBridge.getSpec,
        getUserMcpSpecs: () => userMcpService.getEngineSpecs("codex"),
        injectGroupContextForSdk: (userMessage) => userMessage,
        lastUserPrompt: hermesRunService.lastUserPrompt,
        memoryBlock: miaMemoryService.memoryBlock,
        normalizeEffortLevel,
        permissionCoordinator: agentPermissionCoordinator,
        processEnvStrings,
        readBotPersona,
        resolveManagedModelRuntime,
        runCodexAppServerTurn,
        setAgentSessionEntry: agentSessionStore.setEntry,
        setAgentSessionId: agentSessionStore.setId,
        agentRuntimeEnv: localAgentEngineService.agentRuntimeEnv,
        resolveAgentRuntime: localAgentEngineService.resolveAgentRuntime,
        shellCommandPath: localAgentEngineService.shellCommandPath,
        writeSchedulerMcpContext: schedulerMcpBridge.writeContext
      });
    }
    return cachedCodexAdapter;
  }

  let cachedOpenClawAdapter = null;
  function activeOpenClawAdapter() {
    if (!cachedOpenClawAdapter) {
      cachedOpenClawAdapter = createOpenClawChatAdapter({
        buildEnabledSkillsContext: skillsLoader.buildEnabledSkillsContext,
        chatCompletionResponse,
        cwd: agentWorkspaceDir,
        appendEngineLog: () => {},
        enginePermissionMode,
        ensureUserMcpReady,
        expandLeadingSkillCommand: skillsLoader.expandLeadingSkillCommand,
        getAgentSessionId: agentSessionStore.getId,
        getMcpFingerprint: userMcpService.fingerprint,
        getUserMcpServers: (options) => userMcpService.getEngineSpecs("openclaw", options),
        injectGroupContextForSdk: (userMessage) => userMessage,
        lastUserPrompt: hermesRunService.lastUserPrompt,
        memoryBlock: miaMemoryService.memoryBlock,
        normalizeEffortLevel,
        permissionCoordinator: agentPermissionCoordinator,
        processEnvStrings,
        readBotPersona,
        resolveManagedModelRuntime,
        setAgentSessionId: agentSessionStore.setId,
        shellCommandPath: localAgentEngineService.shellCommandPath
      });
    }
    return cachedOpenClawAdapter;
  }

  // REAL adapter graph: Hermes + Codex + Claude Code + OpenClaw all wired to real
  // adapters. The legacy "engine not available" throw is GONE; every engine routes
  // through its real adapter (the external CLI is resolved from PATH at turn time).
  function createActiveChatEngineAdapters() {
    return createChatEngineAdapters({
      chatCompletionResponse,
      ensureHermesReady,
      hermesSlashCommandResponse: hermesAdapter.slashCommandResponse,
      runHermesSlashCommand: () => "",
      sendHermesChat: hermesChatSend,
      // External agent slash commands aren't wired in Core yet (no
      // externalAgentCommandService); a slash command on a non-Hermes engine is
      // rare and surfaces the same "not available" — the CHAT path below is real.
      runExternalSlashCommand: engineUnavailable,
      sendClaudeCodeChat: activeClaudeCodeAdapter().sendChat,
      sendCodexChat: activeCodexAdapter().sendChat,
      sendOpenClawChat: activeOpenClawAdapter().sendChat
    });
  }

  const botExecutionCore = createBotExecutionCore({
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

  // PART B teardown: the user-MCP bridge (createMcpBridgeServer) opens a loopback
  // HTTP server when a Codex/Claude/OpenClaw turn first calls ensureUserMcpReady.
  // createMiaCore.stop() (and tests) call closeAgentEngines() to close it + any
  // managed Mia model-proxy sessions, so the process exits cleanly. No-op before
  // the bridge has started.
  async function closeAgentEngines() {
    try { if (userMcpBridge && typeof userMcpBridge.stop === "function") await userMcpBridge.stop(); } catch { /* already closed */ }
    try { if (userMcpManager && typeof userMcpManager.stopAll === "function") await userMcpManager.stopAll(); } catch { /* best effort */ }
    // Close the Claude/Codex managed-model proxy loopback HTTP servers a turn may
    // have opened (createSession). Mirrors main.js quit (src/main.js:3027-3028).
    try { if (claudeCodeMiaProxy && typeof claudeCodeMiaProxy.stop === "function") await claudeCodeMiaProxy.stop(); } catch { /* best effort */ }
    try { if (codexMiaProxy && typeof codexMiaProxy.stop === "function") await codexMiaProxy.stop(); } catch { /* best effort */ }
  }

  return Object.assign(botExecutionCore, { closeAgentEngines });
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
// Core's own deviceId, and a capabilities advertisement spanning all engines Core
// now runs — hermes (HTTP) + codex / claude-code / openclaw (PART B, external CLIs
// resolved from PATH). The actual CLI availability is probed at turn time; the
// adapter surfaces its own "CLI not found" error if one is missing.
const CORE_BRIDGE_ENGINE_IDS = ["hermes", "codex", "claude-code", "openclaw"];

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
    engines: CORE_BRIDGE_ENGINE_IDS,
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
// (botWithRuntimeConfig), so each of hermes / codex / claude-code / openclaw runs
// its REAL adapter graph (PART B). A missing external CLI surfaces that adapter's
// own "CLI not found" error — not a Core-level "engine not available" throw.
//
// SINGLE-OWNER: like the events client, the bridge client's own
// isDaemonProcess/isDaemonEnabled gate connects only while cloud is enabled+tokened;
// callers must NOT call start() at import — only createMiaCore.start() connects.
//
// ELECTRON-COUPLED deps replaced with node values here:
//   cloudBridgeUrl              → coreCloudBridgeUrl (all-engines capabilities),
//   createActiveCodexChatAdapter→ null (the bridge's codex slash-command path is
//                                 unused; codex CHAT routes via botExecution.sendChat),
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
  // read is needed for cloud-supplied bots. Engine selection lives inside
  // botExecution.sendChat (botWithRuntimeConfig), so each of hermes / codex /
  // claude-code / openclaw runs its REAL adapter (PART B).
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
    // The bridge client's createActiveCodexChatAdapter dep is only used by its
    // codex SLASH-command path (not chat). Codex CHAT routes through
    // createActiveBridgeChatAdapter → botExecution.sendChat → the real codex
    // adapter (PART B), so the slash-command hook stays null here.
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

// BLOCKER #2 — engine lifecycle ownership. The Electron app's startEngine
// (src/main.js:1856) spawns Hermes as a CHILD of whatever process calls it (the
// GUI window). startGateway() (the independent launchd gateway) has NO call
// sites. So when the GUI is closed and only the Core daemon runs, NO engine is
// running → all cloud bot work fails. Core must therefore be able to ENSURE the
// engine is running itself — adopting an already-running one (the GUI's) and
// only spawning when none is reachable (single-owner).
//
// This reconstructs the node-only slice of startEngine (verified node-
// constructible): resolve the system Hermes python (PATH, like claude/codex),
// write the mia_plugins overlay, choose a free port, write the minimal
// platforms.api_server block Core already reads, then spawn the SAME gateway
// command (`python -m mia_plugins gateway run --replace --accept-hooks`) with the
// SAME env (API_SERVER_*, HERMES_HOME, MIA_HOME, PYTHONPATH) main.js spawns, and
// supervise stdout/stderr/exit. Core kills ONLY an engine it spawned (never an
// adopted one) on stop().
//
// What Core does NOT do (the engine-config-ownership boundary main.js owns): the
// full writeRuntimeConfig graph's permission/effort/MCP specs. Core writes the
// api_server block here (so the port/key it chose are on disk) and — when it
// SPAWNED the engine — the model/provider block for Mia-managed-model bots (PART
// A, createCoreBotExecution.writeModelRuntimeConfig). The remaining
// approvals/agent/skills/mcp_servers sections come from whatever the GUI already
// wrote; a fresh install with no GUI run yet relies on Hermes defaults for those.
//
// spawnImpl/fetchImpl/systemHermesPython are injectable so a test can assert the
// EXACT spawned command + env (and adoption) without running the real Python.
function createCoreEngineSupervisor({
  runtimePaths,
  buildPythonPath,
  hermesHome,
  spawnImpl = defaultSpawn,
  fetchImpl = fetch,
  // PATH-resolved Hermes python (system-hermes-service in production). A "" here
  // falls back to "python3" — the SAME fallback engine-install-service.enginePython
  // uses (src/main/engine-install-service.js:173).
  systemHermesPython = null,
  env = process.env,
  log = () => {},
  // Health timeout knobs (kept short-overridable for tests).
  waitForHealthMs = 45000
} = {}) {
  const hermesHomePath = typeof hermesHome === "function" ? hermesHome : () => String(hermesHome || "");

  const apiKeyFn = () => coreReadHermesApiKey(hermesHomePath());

  // Ensure an api-server key exists on disk before spawn (mirrors
  // engineRuntimeConfigService.apiKey, which creates it if missing). The engine
  // authenticates incoming requests against this key; Core reads the same file.
  function ensureApiKey() {
    const keyPath = path.join(hermesHomePath(), "mia-api-server.key");
    if (!fs.existsSync(keyPath)) {
      fs.mkdirSync(path.dirname(keyPath), { recursive: true });
      fs.writeFileSync(keyPath, `${crypto.randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
    }
    return String(fs.readFileSync(keyPath, "utf8")).trim();
  }

  // Minimal config.yaml write: ensure platforms.api_server.{enabled,host,port,key}
  // matches the chosen port/key WITHOUT clobbering any richer config the GUI wrote
  // (read-modify-write). This is the only config Core owns; everything else is the
  // GUI's (see the boundary note above).
  function writeMinimalConfig(port, key) {
    const configPath = path.join(hermesHomePath(), "config.yaml");
    let parsed = {};
    try {
      if (fs.existsSync(configPath)) parsed = yaml.load(fs.readFileSync(configPath, "utf8")) || {};
    } catch {
      parsed = {};
    }
    if (!parsed || typeof parsed !== "object") parsed = {};
    parsed.platforms = parsed.platforms && typeof parsed.platforms === "object" ? parsed.platforms : {};
    parsed.platforms.api_server = {
      ...(parsed.platforms.api_server && typeof parsed.platforms.api_server === "object" ? parsed.platforms.api_server : {}),
      enabled: true,
      host: "127.0.0.1",
      port,
      key
    };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const tmpPath = `${configPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, yaml.dump(parsed), { mode: 0o600 });
    fs.renameSync(tmpPath, configPath);
  }

  const systemHermes = createSystemHermesService({ runtimePaths, env });
  const enginePlugins = createEnginePluginsService({ runtimePaths });

  const resolvePython = typeof systemHermesPython === "function"
    ? systemHermesPython
    : () => systemHermes.pythonPath();

  let engineProcess = null;
  let spawnedByCore = false;

  const healthService = createEngineHealthService({
    fetchImpl,
    apiKey: apiKeyFn,
    readConfiguredPort: () => coreReadHermesPort(hermesHomePath()),
    getEngineState: () => ({ port: coreReadHermesPort(hermesHomePath()) }),
    // waitForHealth(requireChildProcess=true) checks the spawned child is still
    // alive (exitCode null) before declaring health — mirrors main.js startEngine.
    getEngineProcess: () => engineProcess
  });

  function isManaged() {
    return Boolean(engineProcess) && spawnedByCore;
  }

  // Adopt an already-running engine (the GUI's, or any reachable one) so Core
  // never double-starts. Returns true if one was adopted.
  async function adopt() {
    return healthService.adoptRunningEngine();
  }

  // Ensure an engine is reachable: adopt if one is already healthy, else spawn.
  // Idempotent: a Core-spawned, still-alive engine short-circuits.
  async function ensureRunning() {
    if (isManaged() && engineProcess.exitCode === null) {
      const baseUrl = coreHermesBaseUrl(hermesHomePath());
      if (await healthService.isEngineHealthy(baseUrl)) return { adopted: false, spawned: false, baseUrl };
    }
    if (await adopt()) {
      return { adopted: true, spawned: false, baseUrl: coreHermesBaseUrl(hermesHomePath()) };
    }

    const python = String(resolvePython() || "").trim() || "python3";
    enginePlugins.ensureInstalled();

    const port = await healthService.choosePort();
    if (!port) throw new Error("No available local port for Mia Hermes API.");

    const key = ensureApiKey();
    writeMinimalConfig(port, key);

    const baseUrl = `http://127.0.0.1:${port}`;
    const spawnEnv = {
      ...env,
      HERMES_HOME: hermesHomePath(),
      MIA_HOME: runtimePaths().home,
      HERMES_ACCEPT_HOOKS: "1",
      API_SERVER_ENABLED: "true",
      API_SERVER_HOST: "127.0.0.1",
      API_SERVER_PORT: String(port),
      API_SERVER_KEY: key,
      PYTHONPATH: typeof buildPythonPath === "function" ? buildPythonPath() : String(buildPythonPath || "")
    };
    // The SAME gateway command main.js spawns (launchdService.gatewayProgramArguments
    // minus the leading python): `-m mia_plugins gateway run --replace --accept-hooks`.
    const args = ["-m", "mia_plugins", "gateway", "run", "--replace", "--accept-hooks"];

    const child = spawnImpl(python, args, {
      cwd: runtimePaths().engine,
      env: spawnEnv,
      stdio: ["ignore", "pipe", "pipe"]
    });
    engineProcess = child;
    spawnedByCore = true;

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) log(`[HermesEngine] ${line}`);
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) log(`[HermesEngine] ${line}`);
      });
    }
    child.on("exit", (code, signal) => {
      if (engineProcess === child) {
        engineProcess = null;
        spawnedByCore = false;
      }
      if (code !== 0 && signal !== "SIGTERM") {
        log(`[HermesEngine] exited code ${code ?? "null"} signal ${signal ?? "null"}`);
      }
    });

    const ok = await healthService.waitForHealth(baseUrl, waitForHealthMs, true);
    if (!ok) {
      stop();
      throw new Error("Timed out waiting for Hermes API health.");
    }
    return { adopted: false, spawned: true, baseUrl, port, command: python, args, env: spawnEnv };
  }

  // Kill ONLY an engine Core spawned. An adopted engine (the GUI's) is left
  // running — Core is not its owner.
  function stop() {
    if (engineProcess && spawnedByCore) {
      try { engineProcess.kill("SIGTERM"); } catch { /* already gone */ }
    }
    engineProcess = null;
    spawnedByCore = false;
  }

  return { ensureRunning, adopt, stop, isManaged, apiKey: apiKeyFn };
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

  const { runtimePaths, buildPythonPath } = createRuntimePaths({
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
    // ADR P3: the window delegates cloud credential writes to the daemon so it
    // stays the only mia-cloud.json writer while enabled. Without this the Core
    // control server returns 501 on /api/cloud-settings and login/logout/
    // profile-refresh FAIL against Core. Reuse the SAME single-owner settings
    // store the Electron daemon writes (no second write path). Like main.js
    // (src/main.js:2518), react to auth changes: a new token connects the cloud
    // sockets, a logout drops them — so a login against Core actually brings the
    // bot online. NOT getCloudSettings: that would enable the cloud-tasks PROXY
    // and route /api/tasks upstream, bypassing Core's own single-owner scheduler.
    writeCloudSettings: (patch) => {
      const next = settingsStore.writeCloudSettings(patch);
      if (patch && (patch.token !== undefined || patch.enabled !== undefined)) {
        try {
          if (next.enabled && next.token) {
            cloudEvents().start();
            cloudBridge().start();
          } else {
            if (cachedCloudEvents) cachedCloudEvents.stop();
            if (cachedCloudBridge) cachedCloudBridge.stop();
          }
        } catch { /* sockets re-evaluate on their own retry tick */ }
      }
      return next;
    },
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

  // BLOCKER #2: Core's engine supervisor — built lazily, exposed for testing. It
  // owns the Hermes engine lifecycle when Core runs GUI-less: adopt an already-
  // running engine (the GUI's) or spawn one when none is reachable, and kill ONLY
  // a Core-spawned engine on stop(). When MIA_HERMES_BASE_URL is set (an external
  // engine is injected via env), Core does NOT manage the lifecycle — ensureEngine
  // stays null and ensureHermesReady falls back to a plain /health probe.
  let cachedEngineSupervisor = null;
  function engineSupervisor(overrides = {}) {
    if (cachedEngineSupervisor && !Object.keys(overrides).length) return cachedEngineSupervisor;
    const built = createCoreEngineSupervisor({
      runtimePaths,
      buildPythonPath,
      hermesHome: () => runtimePaths().hermesHome,
      env,
      log: () => {},
      ...overrides
    });
    if (!Object.keys(overrides).length) cachedEngineSupervisor = built;
    return built;
  }

  let cachedBotExecution = null;
  function botExecution(overrides = {}) {
    if (cachedBotExecution && !Object.keys(overrides).length) return cachedBotExecution;
    const built = createCoreBotExecution({
      runtimePaths,
      settingsStore,
      hermesBaseUrl: resolveHermesBaseUrl,
      apiKey: resolveHermesApiKey,
      // Own the engine lifecycle only when no external engine endpoint is
      // injected via env. With MIA_HERMES_BASE_URL set, the engine is external
      // and Core must not adopt/spawn — ensureEngine stays absent.
      ensureEngine: envHermesBaseUrl ? null : () => engineSupervisor().ensureRunning(),
      // PART A: managed-model config write targets the Hermes home Core owns,
      // and is gated on Core actually SPAWNING the engine (isManaged()). When an
      // external engine is injected via env, Core never owns config — so the
      // ownership predicate is false and the model write is skipped (the external
      // engine's owner wrote the model).
      hermesHome: () => runtimePaths().hermesHome,
      engineOwnedByCore: envHermesBaseUrl ? () => false : () => engineSupervisor().isManaged(),
      // PART B: the daemon-control facts the Codex/Claude/OpenClaw MCP specs embed
      // so their MCP servers can call back into Core's own control server. Core IS
      // the daemon, so it reports its own status/settings/token (single owner).
      daemonStatus: () => controlServer.status?.() || {},
      daemonSettings: () => settingsStore.daemonSettings(),
      daemonToken,
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
  // execute through Core's own botExecution graph (all engines: PART B).
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
    stop: async () => {
      // Disconnect the cloud sockets first so their reconnect timers + active
      // sockets are torn down before the control server stops (clean shutdown,
      // node --test exits). No-op if they were never built/connected.
      if (cachedCloudEvents) cachedCloudEvents.stop();
      if (cachedCloudBridge) cachedCloudBridge.stop();
      // Clear any armed scheduler timer so node --test (and a clean shutdown)
      // exits; if the subsystem was never built this is a no-op.
      if (cachedScheduler) cachedScheduler.stopScheduler();
      // BLOCKER #2: kill ONLY an engine Core spawned (an adopted GUI engine is
      // left running — Core is not its owner). No-op if never built/spawned.
      if (cachedEngineSupervisor) cachedEngineSupervisor.stop();
      // PART B: close the user-MCP bridge (loopback HTTP) + managed proxy sessions
      // a Codex/Claude/OpenClaw turn may have opened, so the daemon exits cleanly.
      // MUST await — closeAgentEngines closes loopback HTTP servers; not awaiting
      // leaves their handles alive and blocks a clean process exit.
      if (cachedBotExecution && typeof cachedBotExecution.closeAgentEngines === "function") {
        try { await cachedBotExecution.closeAgentEngines(); } catch { /* best effort */ }
      }
      return controlServer.stop();
    },
    status: () => controlServer.status(),
    daemonSettings: () => settingsStore.daemonSettings(),
    writeDaemonSettings: (settings) => settingsStore.writeDaemonSettings(settings),
    runtimePaths,
    daemonToken,
    describeDaemonTarget,
    botExecution,
    engineSupervisor,
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
  // Exported for the engine-lifecycle proof test (BLOCKER #2): adopt-or-spawn
  // the Hermes engine, asserting the exact spawned command/args/env + adoption.
  createCoreEngineSupervisor,
  // Exported for the engine-endpoint proof test: Core's on-disk Hermes endpoint
  // discovery (the production source of truth when MIA_HERMES_* env is unset).
  coreHermesBaseUrl,
  coreReadHermesApiKey,
  coreReadHermesPort,
  // Exported for the packaged-skills resolution test (BLOCKER #3): the bundled
  // official-library manifest + skills/_builtin path resolution, dev vs packaged.
  coreOfficialLibraryManifestPath,
  coreMiaSkillsRoot,
  coreResolveOfficialLibraryRoot
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
