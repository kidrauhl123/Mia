const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");

test("project structure check covers cloud release helpers and rejects root source duplicates", () => {
  const source = fs.readFileSync(path.join(root, "src/check.js"), "utf8");
  assert.match(source, /scripts\/diagnose-deploy-ssh\.js/);
  assert.match(source, /scripts\/print-cloud-blockers\.js/);
  assert.match(source, /forbiddenRootDuplicates/);
  assert.match(source, /main\.js/);
  assert.match(source, /desktop-bridge-permission\.js/);
  assert.match(source, /Unexpected root-level duplicate source file/);
});

test("cloud bridge remote run is account-authenticated and does not add a separate local approval gate", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const bridgeSource = fs.readFileSync(path.join(root, "src/main/cloud/cloud-bridge-client.js"), "utf8");
  const body = bridgeSource.match(/async function runCloudBridgeRequest\(ws, message = \{\}\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.ok(body, "runCloudBridgeRequest should exist");
  assert.doesNotMatch(body, /confirmCloudBridgeRun\(/);
  assert.doesNotMatch(body, /等待本机权限确认/);
  assert.match(body, /permissionMode: "default"/);
  assert.match(mainSource, /createCloudBridgeClient/, "main must instantiate the cloud bridge Module");
  assert.doesNotMatch(mainSource, /async function runCloudBridgeRequest/, "main must not own bridge run implementation");
  assert.doesNotMatch(mainSource, /function handleCloudBridgeMessage/, "main must not own bridge message routing");
  assert.doesNotMatch(mainSource, /cloudBridgeAbortControllers/, "main must not own bridge run abort controllers");
  assert.doesNotMatch(mainSource, /cloudBridgeReconnectTimer/, "main must not own bridge reconnect timer");
});

test("cloud desktop sync lives behind a main/cloud Module instead of main.js", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const syncSource = fs.readFileSync(path.join(root, "src/main/cloud/desktop-sync-client.js"), "utf8");
  assert.match(syncSource, /function createCloudDesktopSyncClient/, "cloud desktop sync Module should exist");
  assert.match(mainSource, /createCloudDesktopSyncClient/, "main should instantiate the cloud desktop sync Module");
  assert.doesNotMatch(mainSource, /async function cloudApi/, "main must not own low-level cloud HTTP requests");
  assert.doesNotMatch(mainSource, /async function syncMiaCloudWorkspace/, "main must not own workspace sync orchestration");
  assert.doesNotMatch(mainSource, /async function pushAllFellowSessionsToCloudRooms/, "main must not own fellow room backfill");
  assert.doesNotMatch(mainSource, /async function mirrorFellowSessionToCloudRoom/, "main must not own fellow-room message mirroring");
});

test("relay client socket state and RPC routing live behind a main/relay Module", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const relaySource = fs.readFileSync(path.join(root, "src/main/relay/relay-client.js"), "utf8");
  assert.match(relaySource, /function createRelayClient/, "relay client Module should exist");
  assert.match(mainSource, /createRelayClient/, "main should instantiate the relay client Module");
  assert.doesNotMatch(mainSource, /let relayClient/, "main must not own relay websocket");
  assert.doesNotMatch(mainSource, /relayReconnectTimer/, "main must not own relay reconnect timer");
  assert.doesNotMatch(mainSource, /let relayState/, "main must not own relay mutable state");
  assert.doesNotMatch(mainSource, /async function handleRelayRpc/, "main must not own relay RPC routing");
  assert.doesNotMatch(mainSource, /function handleRelayMessage/, "main must not own relay socket message routing");
});

test("remote control API routes are shared by daemon HTTP and relay adapters", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const relaySource = fs.readFileSync(path.join(root, "src/main/relay/relay-client.js"), "utf8");
  const routerSource = fs.readFileSync(path.join(root, "src/main/remote/remote-control-router.js"), "utf8");
  const modelSource = fs.readFileSync(path.join(root, "src/main/model-settings-service.js"), "utf8");
  assert.match(routerSource, /function createRemoteControlRouter/, "remote control router Module should exist");
  assert.match(mainSource, /createRemoteControlRouter/, "main should instantiate the shared remote router");
  assert.match(relaySource, /remoteRouter\.route/, "relay should use the shared remote router");
  assert.match(modelSource, /function createModelSettingsService/, "model settings service should own model save normalization");
  assert.match(mainSource, /createModelSettingsService/, "main should instantiate the shared model settings service");
  assert.doesNotMatch(routerSource, /modelSettings\(\)/, "remote router must not duplicate model settings normalization");
  assert.doesNotMatch(routerSource, /providerConnection\(/, "remote router must not duplicate provider lookup");
  assert.doesNotMatch(routerSource, /writeModelSettings\(next\)/, "remote router must not write model settings directly");
  assert.doesNotMatch(mainSource, /url\.pathname === "\/api\/chat\/send"/, "main must not duplicate remote chat route matching");
  assert.doesNotMatch(mainSource, /url\.pathname === "\/api\/model\/save"/, "main must not duplicate remote model route matching");
  assert.doesNotMatch(relaySource, /requestPath === "\/api\/chat\/send"/, "relay must not duplicate remote chat route matching");
  assert.doesNotMatch(relaySource, /requestPath === "\/api\/model\/save"/, "relay must not duplicate remote model route matching");
});

test("chat session mutations live behind a main chat-session service", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const sessionSource = fs.readFileSync(path.join(root, "src/main/chat-session-service.js"), "utf8");
  assert.match(sessionSource, /function createChatSessionService/, "chat session service should exist");
  assert.match(mainSource, /createChatSessionService/, "main should instantiate the chat session service");
  assert.doesNotMatch(mainSource, /function saveChatSession/, "main must not own chat session save logic");
  assert.doesNotMatch(mainSource, /function saveChatReadState/, "main must not own read-state persistence");
  assert.doesNotMatch(mainSource, /function newChatSession/, "main must not own new-session pruning");
  assert.doesNotMatch(mainSource, /function renameChatSession/, "main must not own rename persistence");
  assert.doesNotMatch(mainSource, /async function generateSessionTitle/, "main must not own title-generation orchestration");
});

test("chat attachment normalization and transfer live behind a main chat-attachments module", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const attachmentSource = fs.readFileSync(path.join(root, "src/main/chat-attachments.js"), "utf8");
  assert.match(attachmentSource, /function createChatAttachments/, "chat attachments module should exist");
  assert.match(mainSource, /createChatAttachments/, "main should instantiate chat attachments");
  assert.doesNotMatch(mainSource, /function normalizeAttachment\(/, "main must not own attachment normalization");
  assert.doesNotMatch(mainSource, /function saveChatAttachment/, "main must not own attachment writes");
  assert.doesNotMatch(mainSource, /function readLocalFileAttachment/, "main must not own local attachment reads");
  assert.doesNotMatch(mainSource, /async function fetchCloudFileAttachment/, "main must not own cloud attachment fetch");
  assert.doesNotMatch(mainSource, /function attachmentContext/, "main must not own attachment prompt context");
});

test("fellow write-side management lives behind a main fellow service", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const manifestSource = fs.readFileSync(path.join(root, "src/main/fellow-manifest.js"), "utf8");
  const fellowSource = fs.readFileSync(path.join(root, "src/main/fellow-service.js"), "utf8");
  assert.match(fellowSource, /function createFellowService/, "fellow service should exist");
  assert.match(mainSource, /createFellowService/, "main should instantiate the fellow service");
  assert.doesNotMatch(mainSource, /function getFellowDetails/, "main must not own fellow detail composition");
  assert.doesNotMatch(mainSource, /function saveFellow\(/, "main must not own fellow save logic");
  assert.doesNotMatch(mainSource, /function saveFellowEngineConfig/, "main must not own fellow engine config persistence");
  assert.doesNotMatch(mainSource, /function setFellowPinned/, "main must not own fellow pin persistence");
  assert.doesNotMatch(mainSource, /function setFellowMuted/, "main must not own fellow mute persistence");
  assert.doesNotMatch(mainSource, /function deleteFellow\(/, "main must not own fellow deletion cleanup");
  assert.doesNotMatch(manifestSource, /write-side CRUD .* stays in main\.js/, "fellow manifest docs must not claim writes stay in main");
});

test("provider connection persistence lives behind a main provider connections Module", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const providerSource = fs.readFileSync(path.join(root, "src/main/provider-connections.js"), "utf8");

  assert.match(providerSource, /function createProviderConnections/, "provider connections Module should exist");
  assert.match(mainSource, /createProviderConnections/, "main should instantiate provider connections");
  assert.doesNotMatch(mainSource, /function defaultProviderStore/, "main must not own provider connection defaults");
  assert.doesNotMatch(mainSource, /function normalizeProviderConnection/, "main must not own provider connection normalization");
  assert.doesNotMatch(mainSource, /function providerConnectionStore/, "main must not own provider connection persistence");
  assert.doesNotMatch(mainSource, /function connectedProviderSummaries/, "main must not own provider summary shaping");
});

test("profile and appearance preferences live behind the main settings store", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const settingsSource = fs.readFileSync(path.join(root, "src/main/settings-store.js"), "utf8");

  assert.match(settingsSource, /function appearanceSettings/, "settings store should own appearance reads");
  assert.match(settingsSource, /function writeAppearanceSettings/, "settings store should own appearance writes");
  assert.match(settingsSource, /function userProfile/, "settings store should own profile reads");
  assert.match(settingsSource, /function writeUserProfile/, "settings store should own profile writes");
  assert.doesNotMatch(mainSource, /function appearanceSettings/, "main must not own appearance reads");
  assert.doesNotMatch(mainSource, /validHex/, "main must not own appearance validation");
  assert.doesNotMatch(mainSource, /fs\.writeFileSync\(p\.appearanceSettings/, "main must not write appearance settings directly");
  assert.doesNotMatch(mainSource, /fs\.writeFileSync\(p\.userProfile/, "main must not write user profile directly");
  assert.doesNotMatch(mainSource, /avatarText: String\(profile\.avatarText/, "main must not own profile normalization");
});

test("auth and provider OAuth lifecycle live behind a main auth service", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const authSource = fs.readFileSync(path.join(root, "src/main/auth-service.js"), "utf8");

  assert.match(authSource, /function createAuthService/, "auth service Module should exist");
  assert.match(mainSource, /createAuthService/, "main should instantiate the auth service");
  assert.doesNotMatch(mainSource, /let authProcess/, "main must not own OAuth child-process state");
  assert.doesNotMatch(mainSource, /let codexOAuthCancelled/, "main must not own Codex OAuth cancellation state");
  assert.doesNotMatch(mainSource, /let authState/, "main must not own auth mutable state");
  assert.doesNotMatch(mainSource, /function appendAuthLog/, "main must not own auth log parsing");
  assert.doesNotMatch(mainSource, /async function requestCodexDeviceCode/, "main must not own Codex device auth HTTP calls");
  assert.doesNotMatch(mainSource, /async function pollCodexAuthorization/, "main must not own Codex device auth polling");
  assert.doesNotMatch(mainSource, /function startProviderOAuth/, "main must not own provider OAuth lifecycle");
});

test("engine catalog, capabilities, and slash command discovery live behind a main engine catalog Module", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const catalogSource = fs.readFileSync(path.join(root, "src/main/engine-catalog-service.js"), "utf8");

  assert.match(catalogSource, /function createEngineCatalogService/, "engine catalog Module should exist");
  assert.match(mainSource, /createEngineCatalogService/, "main should instantiate engine catalog discovery");
  assert.doesNotMatch(mainSource, /function fallbackModelCatalog/, "main must not own model catalog fallbacks");
  assert.doesNotMatch(mainSource, /async function loadHermesModelCatalogInner/, "main must not own Hermes model discovery scripts");
  assert.doesNotMatch(mainSource, /function loadCodexModels/, "main must not own Codex model cache parsing");
  assert.doesNotMatch(mainSource, /async function loadEngineCapabilities/, "main must not own engine capability discovery");
  assert.doesNotMatch(mainSource, /function fallbackSlashCommands/, "main must not own slash command fallbacks");
  assert.doesNotMatch(mainSource, /async function loadHermesSlashCommandsInner/, "main must not own Hermes slash command discovery scripts");
});

test("external Agent command execution and session binding live behind a main external-agent-command Module", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const commandSource = fs.readFileSync(path.join(root, "src/main/external-agent-command-service.js"), "utf8");

  assert.match(commandSource, /function createExternalAgentCommandService/, "external Agent command Module should exist");
  assert.match(mainSource, /createExternalAgentCommandService/, "main should instantiate external Agent command execution");
  assert.doesNotMatch(mainSource, /const externalAgentBuiltInCommands/, "main must not own external Agent built-in command definitions");
  assert.doesNotMatch(mainSource, /function splitCommandInvocation/, "main must not keep unused Agent command parsing helpers");
  assert.doesNotMatch(mainSource, /function executeExternalAgentCommand/, "main must not own external Agent command execution");
  assert.doesNotMatch(mainSource, /function externalAgentStatus/, "main must not own external Agent status rendering");
  assert.doesNotMatch(mainSource, /function listBoundExternalAgentSessions/, "main must not own external session binding list shaping");
  assert.doesNotMatch(mainSource, /function usefulExternalSessionRow/, "main must not own external session history filtering");
  assert.doesNotMatch(mainSource, /function runExternalSlashCommand/, "main must not own external slash command execution");
  assert.doesNotMatch(mainSource, /function skillRoots/, "main must not keep dead skill root helpers");
});

test("Claude bridge plugin generation lives behind a main claude-bridge-plugin service", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const bridgeSource = fs.readFileSync(path.join(root, "src/main/claude-bridge-plugin-service.js"), "utf8");

  assert.match(bridgeSource, /function createClaudeBridgePluginService/, "Claude bridge plugin service should exist");
  assert.match(mainSource, /createClaudeBridgePluginService/, "main should instantiate Claude bridge plugin setup");
  assert.doesNotMatch(mainSource, /function ensureClaudeBridgePlugin/, "main must not own Claude bridge plugin generation");
  assert.doesNotMatch(mainSource, /\.claude-plugin/, "main must not own Claude plugin manifest paths");
  assert.doesNotMatch(mainSource, /mia-skills/, "main must not own Claude plugin manifest content");
  assert.doesNotMatch(mainSource, /fs\.symlinkSync\(skillPath/, "main must not own bridge skill symlink creation");
});

test("fellow pet assets, generation jobs, and pet windows live behind a main fellow-pet service", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const petSource = fs.readFileSync(path.join(root, "src/main/fellow-pet-service.js"), "utf8");

  assert.match(petSource, /function createFellowPetService/, "fellow pet service should exist");
  assert.match(mainSource, /createFellowPetService/, "main should instantiate the fellow pet service");
  assert.doesNotMatch(mainSource, /const petWindows = new Map/, "main must not own pet window state");
  assert.doesNotMatch(mainSource, /const petJobs = new Map/, "main must not own pet generation job state");
  assert.doesNotMatch(mainSource, /function fellowPetId/, "main must not own pet id normalization");
  assert.doesNotMatch(mainSource, /function findFellowPetPackage/, "main must not own pet asset discovery");
  assert.doesNotMatch(mainSource, /function petStatusForFellow/, "main must not own pet status shaping");
  assert.doesNotMatch(mainSource, /function startFellowPetGeneration/, "main must not own pet generation orchestration");
  assert.doesNotMatch(mainSource, /function notifyFellowPetMessage/, "main must not own pet window notifications");
  assert.doesNotMatch(mainSource, /function placeFellowPet/, "main must not own pet window placement");
  assert.doesNotMatch(mainSource, /function recallFellowPet/, "main must not own pet window teardown");
  assert.doesNotMatch(mainSource, /function officialLibraryManifestPath/, "main must not own packaged library resource lookup");
  assert.doesNotMatch(mainSource, /function resolveOfficialLibraryRoot/, "main must not own packaged library root resolution");
});

test("Hermes run payload and event stream parsing live behind a main hermes-run service", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const runSource = fs.readFileSync(path.join(root, "src/main/hermes-run-service.js"), "utf8");

  assert.match(runSource, /function createHermesRunService/, "Hermes run service should exist");
  assert.match(mainSource, /createHermesRunService/, "main should instantiate the Hermes run service");
  assert.doesNotMatch(mainSource, /function normalizeRunMessages/, "main must not own run message normalization");
  assert.doesNotMatch(mainSource, /function buildRunPayload/, "main must not own Hermes run payload shaping");
  assert.doesNotMatch(mainSource, /function parseSseFrame/, "main must not own Hermes SSE parsing");
  assert.doesNotMatch(mainSource, /async function readRunEventStream/, "main must not own Hermes run stream reading");
  assert.doesNotMatch(mainSource, /function lastUserPrompt/, "main must not own adapter prompt extraction");
  assert.doesNotMatch(mainSource, /function normalizeHermesError/, "main must not own Hermes error normalization");
});

test("Hermes slash-command execution lives behind a main hermes-slash-command service", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const slashSource = fs.readFileSync(path.join(root, "src/main/hermes-slash-command-service.js"), "utf8");

  assert.match(slashSource, /function createHermesSlashCommandService/, "Hermes slash-command service should exist");
  assert.match(mainSource, /createHermesSlashCommandService/, "main should instantiate Hermes slash-command execution");
  assert.doesNotMatch(mainSource, /function runHermesSlashCommand/, "main must not own Hermes slash-command execution");
  assert.doesNotMatch(mainSource, /_MIA_ZH_I18N/, "main must not embed Hermes slash-command i18n dictionaries");
  assert.doesNotMatch(mainSource, /GatewayRunner/, "main must not embed Hermes gateway Python scripts");
  assert.doesNotMatch(mainSource, /gateway\.help\.header/, "main must not own localized Hermes command copy");
});

test("macOS launchd plist and launchctl operations live behind a main launchd service", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const launchdSource = fs.readFileSync(path.join(root, "src/main/launchd-service.js"), "utf8");

  assert.match(launchdSource, /function createLaunchdService/, "launchd service should exist");
  assert.match(mainSource, /createLaunchdService/, "main should instantiate launchd orchestration");
  assert.doesNotMatch(mainSource, /function xmlEscape/, "main must not own launchd XML escaping");
  assert.doesNotMatch(mainSource, /function launchdDomain/, "main must not own launchd domain selection");
  assert.doesNotMatch(mainSource, /function runLaunchctl/, "main must not own launchctl invocation");
  assert.doesNotMatch(mainSource, /function launchAgentPlist/, "main must not own gateway LaunchAgent plist rendering");
  assert.doesNotMatch(mainSource, /function writeLaunchAgentPlist/, "main must not own gateway LaunchAgent writes");
  assert.doesNotMatch(mainSource, /function stopLaunchAgent/, "main must not own gateway launchd stop");
  assert.doesNotMatch(mainSource, /function startLaunchAgent/, "main must not own gateway launchd start");
  assert.doesNotMatch(mainSource, /function daemonLaunchAgentPlist/, "main must not own daemon LaunchAgent plist rendering");
  assert.doesNotMatch(mainSource, /function writeDaemonLaunchAgentPlist/, "main must not own daemon LaunchAgent writes");
  assert.doesNotMatch(mainSource, /function stopDaemonLaunchAgent/, "main must not own daemon launchd stop");
  assert.doesNotMatch(mainSource, /function startDaemonLaunchAgent/, "main must not own daemon launchd start");
});

test("Mia Hermes plugin files and install cleanup live behind a main engine-plugins service", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const pluginSource = fs.readFileSync(path.join(root, "src/main/engine-plugins-service.js"), "utf8");

  assert.match(pluginSource, /function createEnginePluginsService/, "engine plugins service should exist");
  assert.match(mainSource, /createEnginePluginsService/, "main should instantiate engine plugin installation");
  assert.doesNotMatch(mainSource, /function miaPluginFiles/, "main must not own embedded Python plugin source");
  assert.doesNotMatch(mainSource, /function ensureEnginePlugins/, "main must not own engine plugin install cleanup");
  assert.doesNotMatch(mainSource, /X-Mia-Fellow/, "main must not embed Hermes overlay Python code");
});

test("local Agent CLI discovery and version caching live behind a main local-agent-engine service", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const localAgentSource = fs.readFileSync(path.join(root, "src/main/local-agent-engine-service.js"), "utf8");

  assert.match(localAgentSource, /function createLocalAgentEngineService/, "local Agent engine service should exist");
  assert.match(mainSource, /createLocalAgentEngineService/, "main should instantiate local Agent engine discovery");
  assert.doesNotMatch(mainSource, /const CLI_PATH_SEGMENTS/, "main must not own CLI PATH candidates");
  assert.doesNotMatch(mainSource, /function cliPathEnv/, "main must not own CLI PATH expansion");
  assert.doesNotMatch(mainSource, /function shellCommandPath/, "main must not own shell command discovery");
  assert.doesNotMatch(mainSource, /function commandVersion/, "main must not own CLI version probing");
  assert.doesNotMatch(mainSource, /function localAgentEngines/, "main must not own local Agent status caching");
  assert.doesNotMatch(mainSource, /let agentEngineCache/, "main must not own local Agent engine cache state");
});

test("external Agent session binding persistence lives behind a main agent-session store", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const storeSource = fs.readFileSync(path.join(root, "src/main/agent-session-store.js"), "utf8");

  assert.match(storeSource, /function createAgentSessionStore/, "agent session store should exist");
  assert.match(mainSource, /createAgentSessionStore/, "main should instantiate agent session persistence");
  assert.doesNotMatch(mainSource, /function loadAgentSessionMap/, "main must not own external Agent session reads");
  assert.doesNotMatch(mainSource, /function saveAgentSessionMap/, "main must not own external Agent session writes");
  assert.doesNotMatch(mainSource, /function agentSessionKey/, "main must not own external Agent session key normalization");
  assert.doesNotMatch(mainSource, /function getAgentSessionId/, "main must not own external Agent session lookup");
  assert.doesNotMatch(mainSource, /function setAgentSessionId/, "main must not own external Agent session binding writes");
  assert.doesNotMatch(mainSource, /function getAgentSessionEntry/, "main must not own external Agent session entry lookup");
  assert.doesNotMatch(mainSource, /function setAgentSessionEntry/, "main must not own external Agent session entry writes");
});

test("scheduler MCP bridge context, spec, and Codex home setup live behind a main scheduler-mcp bridge", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const bridgeSource = fs.readFileSync(path.join(root, "src/main/scheduler-mcp-bridge.js"), "utf8");

  assert.match(bridgeSource, /function createSchedulerMcpBridge/, "scheduler MCP bridge should exist");
  assert.match(mainSource, /createSchedulerMcpBridge/, "main should instantiate scheduler MCP bridge");
  assert.doesNotMatch(mainSource, /function resolveNodePath/, "main must not own node CLI discovery for scheduler MCP");
  assert.doesNotMatch(mainSource, /function schedulerMcpContextPath/, "main must not own scheduler MCP context path");
  assert.doesNotMatch(mainSource, /function schedulerMcpServerScriptPath/, "main must not own scheduler MCP script path");
  assert.doesNotMatch(mainSource, /function writeSchedulerMcpContext/, "main must not own scheduler MCP context writes");
  assert.doesNotMatch(mainSource, /function resolveDaemonBaseUrl/, "main must not own scheduler MCP daemon URL selection");
  assert.doesNotMatch(mainSource, /function getSchedulerMcpSpec/, "main must not own scheduler MCP SDK config");
  assert.doesNotMatch(mainSource, /function ensureCodexHome/, "main must not own Codex home MCP config merging");
});

test("disabled system Hermes policy lives behind a main system-hermes service without dead probe code", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const systemSource = fs.readFileSync(path.join(root, "src/main/system-hermes-service.js"), "utf8");

  assert.match(systemSource, /function createSystemHermesService/, "system Hermes service should exist");
  assert.match(mainSource, /createSystemHermesService/, "main should instantiate system Hermes policy");
  assert.doesNotMatch(mainSource, /function readShebangPython/, "main must not keep disabled system Hermes shebang probing");
  assert.doesNotMatch(mainSource, /function systemHermesCachePath/, "main must not own system Hermes cache paths");
  assert.doesNotMatch(mainSource, /function loadSystemHermesCache/, "main must not own system Hermes cache reads");
  assert.doesNotMatch(mainSource, /function persistSystemHermesCache/, "main must not own system Hermes cache writes");
  assert.doesNotMatch(mainSource, /SYSTEM_HERMES_PROBE/, "main must not embed disabled system Hermes probe scripts");
  assert.doesNotMatch(mainSource, /systemHermesRefreshing/, "main must not keep disabled system Hermes refresh state");
  assert.doesNotMatch(mainSource, /function refreshSystemHermesAsync/, "main must not own system Hermes refresh policy");
  assert.doesNotMatch(mainSource, /function userHermesHomePath/, "main must not own disabled user Hermes home lookup");
  assert.doesNotMatch(mainSource, /function importFromSystemHermes/, "main must not keep unreachable system Hermes import logic");
  assert.doesNotMatch(mainSource, /function stripAnsi/, "main must not keep dotenv parsing helpers for disabled system Hermes");
  assert.doesNotMatch(mainSource, /function loadHermesDotenv/, "main must not own system Hermes dotenv imports");
});

test("engine runtime config files and Hermes config rendering live behind a main engine-runtime-config service", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const configSource = fs.readFileSync(path.join(root, "src/main/engine-runtime-config-service.js"), "utf8");

  assert.match(configSource, /function createEngineRuntimeConfigService/, "engine runtime config service should exist");
  assert.match(mainSource, /createEngineRuntimeConfigService/, "main should instantiate engine runtime config");
  assert.doesNotMatch(mainSource, /require\("js-yaml"\)/, "main must not own Hermes YAML parsing");
  assert.doesNotMatch(mainSource, /function apiKey/, "main must not own API server key persistence");
  assert.doesNotMatch(mainSource, /function modelSettings/, "main must not own model settings reads");
  assert.doesNotMatch(mainSource, /function externalSkillDirs/, "main must not own external skill directory filtering");
  assert.doesNotMatch(mainSource, /function atomicWriteFile/, "main must not own atomic config writes");
  assert.doesNotMatch(mainSource, /function writeRuntimeConfig/, "main must not own Hermes config rendering");
  assert.doesNotMatch(mainSource, /function effectiveHermesHome/, "main must not own effective Hermes home policy");
  assert.doesNotMatch(mainSource, /function readConfiguredPort/, "main must not own Hermes config port parsing");
});

test("engine port selection and health probing live behind a main engine-health service", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const healthSource = fs.readFileSync(path.join(root, "src/main/engine-health-service.js"), "utf8");

  assert.match(healthSource, /function createEngineHealthService/, "engine health service should exist");
  assert.match(mainSource, /createEngineHealthService/, "main should instantiate engine health probing");
  assert.doesNotMatch(mainSource, /require\("node:net"\)/, "main must not own TCP port probing");
  assert.doesNotMatch(mainSource, /function choosePort/, "main must not own local port selection");
  assert.doesNotMatch(mainSource, /async function isEngineHealthy/, "main must not own authenticated engine health probing");
  assert.doesNotMatch(mainSource, /async function adoptRunningEngine/, "main must not own running engine adoption");
  assert.doesNotMatch(mainSource, /async function waitForHealth/, "main must not own engine health polling");
});

test("engine installation lifecycle lives behind a main engine-install service", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const installSource = fs.readFileSync(path.join(root, "src/main/engine-install-service.js"), "utf8");
  const runtimePathsSource = fs.readFileSync(path.join(root, "src/main/runtime-paths.js"), "utf8");

  assert.match(installSource, /function createEngineInstallService/, "engine install service should exist");
  assert.match(mainSource, /createEngineInstallService/, "main should instantiate engine installation");
  assert.doesNotMatch(mainSource, /function officialEngineUrl/, "main must not own official engine archive URL policy");
  assert.doesNotMatch(mainSource, /function officialEngineRequirement/, "main must not own pip package requirement formatting");
  assert.doesNotMatch(mainSource, /function pythonVersion/, "main must not own Python version probing");
  assert.doesNotMatch(mainSource, /function selectOfficialEnginePython/, "main must not own Python candidate selection");
  assert.doesNotMatch(mainSource, /function isEngineInstalled/, "main must not own installed-runtime detection");
  assert.doesNotMatch(mainSource, /function runEngineInstallCommand/, "main must not own installation command execution");
  assert.doesNotMatch(mainSource, /function installEngineFromDevSource/, "main must not own local-source installation");
  assert.doesNotMatch(mainSource, /function installEngineFromOfficialPackage/, "main must not own official package installation");
  assert.doesNotMatch(mainSource, /function installEngine/, "main must not own install source routing");
  assert.doesNotMatch(mainSource, /function enginePython/, "main must not own engine Python executable selection");
  assert.doesNotMatch(mainSource, /function engineSource/, "main must not own engine source classification");
  assert.doesNotMatch(runtimePathsSource, /installation helpers .*stay in main\.js/s, "runtime paths docs must not claim installation stays in main");
});

test("runtime directory initialization lives behind a main runtime-initializer service", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const initializerSource = fs.readFileSync(path.join(root, "src/main/runtime-initializer-service.js"), "utf8");

  assert.match(initializerSource, /function createRuntimeInitializerService/, "runtime initializer service should exist");
  assert.match(mainSource, /createRuntimeInitializerService/, "main should instantiate runtime initialization");
  assert.doesNotMatch(mainSource, /function writeFileIfMissing/, "main must not own default runtime file writes");
  assert.doesNotMatch(mainSource, /function migrateLegacyPersonas/, "main must not own legacy persona migration");
  assert.doesNotMatch(mainSource, /function initializeRuntimeCore/, "main must not own runtime directory bootstrapping");
  assert.doesNotMatch(mainSource, /Mia Shared Soul/, "main must not embed default SOUL content");
  assert.doesNotMatch(mainSource, /runtime\/engine-home\/mia-model\.json/, "main must not own default settings creation bookkeeping");
});

test("runtime initializer does not eagerly read provider defaults before provider connections initialize", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const initializerBlock = mainSource.match(/const runtimeInitializerService = createRuntimeInitializerService\(\{[\s\S]*?\n\}\);/)?.[0] || "";

  assert.ok(initializerBlock, "runtime initializer construction should exist");
  assert.match(
    initializerBlock,
    /defaultProviderStore:\s*\(\)\s*=>\s*defaultProviderStore\(\)/,
    "runtime initializer must lazily call provider defaults after providerConnections has initialized"
  );
});

test("daemon HTTP control server lives behind a main daemon Module", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const controlSource = fs.readFileSync(path.join(root, "src/main/daemon/control-server.js"), "utf8");
  assert.match(controlSource, /function createDaemonControlServer/, "daemon control server Module should exist");
  assert.match(mainSource, /createDaemonControlServer/, "main should instantiate the daemon control server");
  assert.doesNotMatch(mainSource, /let controlServer\b/, "main must not own the daemon HTTP server instance");
  assert.doesNotMatch(mainSource, /let controlServerState\b/, "main must not own daemon control mutable state");
  assert.doesNotMatch(mainSource, /function requestAuthToken/, "main must not own daemon auth parsing");
  assert.doesNotMatch(mainSource, /function isControlRequestAuthorized/, "main must not own daemon request auth");
  assert.doesNotMatch(mainSource, /function readControlBody/, "main must not own daemon request body parsing");
  assert.doesNotMatch(mainSource, /async function handleControlRequest/, "main must not own daemon HTTP routing");
  assert.doesNotMatch(mainSource, /async function startControlServer/, "main must not own daemon HTTP lifecycle");
  assert.doesNotMatch(mainSource, /function stopControlServer/, "main must not own daemon HTTP lifecycle");
});

test("daemon task HTTP client and task event stream live behind a main daemon Module", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const tasksClientSource = fs.readFileSync(path.join(root, "src/main/daemon/tasks-client.js"), "utf8");

  assert.match(tasksClientSource, /function createDaemonTasksClient/, "daemon tasks client Module should exist");
  assert.match(mainSource, /createDaemonTasksClient/, "main should instantiate the daemon tasks client");
  assert.doesNotMatch(mainSource, /async function callDaemonTasks/, "main must not own daemon task HTTP calls");
  assert.doesNotMatch(mainSource, /function subscribeDaemonTaskEvents/, "main must not own daemon task SSE subscription");
  assert.doesNotMatch(mainSource, /\/api\/tasks\/events/, "main must not own the daemon task event stream route");
});
