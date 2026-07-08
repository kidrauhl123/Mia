const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
function extractFunctionSource(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} should exist`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test("preload exposes Rust Core startup state and a single HTTP request adapter", () => {
  const channels = read("src/shared/ipc-channels.js");
  const preload = read("src/preload.js");
  const main = read("src/main.js");

  assert.match(channels, /MiaCoreStartupState:\s*"mia-core:startup-state"/);
  assert.match(channels, /MiaCoreHttpRequest:\s*"mia-core:http-request"/);
  assert.match(preload, /const miaCoreStartupState = ipcRenderer\.sendSync\(IpcChannel\.MiaCoreStartupState\)/);
  assert.match(preload, /contextBridge\.exposeInMainWorld\("__miaCorePort"/);
  assert.match(preload, /contextBridge\.exposeInMainWorld\("__miaCoreStartupFailed"/);
  assert.match(preload, /contextBridge\.exposeInMainWorld\("__miaCoreVersion"/);
  assert.match(preload, /contextBridge\.exposeInMainWorld\("__miaCoreUserId",\s*miaCoreStartupState\.userId \|\| ""\)/);
  assert.match(preload, /miaCoreRequest:\s*\(method,\s*route,\s*body\)\s*=>\s*ipcRenderer\.invoke\(IpcChannel\.MiaCoreHttpRequest/);
  assert.match(main, /ipcMain\.on\(IpcChannel\.MiaCoreStartupState/);
  assert.match(extractFunctionSource(main, "currentMiaCoreStartupState"), /userId:\s*currentMiaUserId\(\)/);
  assert.match(main, /ipcMain\.handle\(IpcChannel\.MiaCoreHttpRequest/);
  assert.match(main, /createMiaCoreHttpClient/);
});

test("model-selection preload bridge routes provider/model intent to Rust Core", () => {
  const channels = read("src/shared/ipc-channels.js");
  const preload = read("src/preload.js");
  const main = read("src/main.js");

  assert.match(preload, /function saveCoreModelSelection/);
  assert.match(preload, /miaCorePost\("\/api\/settings\/model-selection",\s*\{\s*selection:\s*coreModelSelection\(settings\)\s*\}\)/);
  assert.match(preload, /saveModel:\s*\(settings\)\s*=>\s*saveCoreModelSelection\(settings\)/);
  assert.match(preload, /function getCoreSettingsRuntimeControlOptions/);
  assert.match(preload, /miaCorePost\("\/api\/settings\/runtime-control-options",\s*request\)/);
  assert.match(preload, /getSettingsRuntimeControlOptions:\s*\(input\)\s*=>\s*getCoreSettingsRuntimeControlOptions\(input\)/);
  assert.doesNotMatch(channels, /ModelSave/);
  assert.doesNotMatch(preload, /IpcChannel\.ModelSave/);
  assert.doesNotMatch(main, /IpcChannel\.ModelSave|createModelSettingsService|modelSettingsService/);
});

test("renderer settings model controls consume Core-owned runtime options", () => {
  const modelSettings = read("src/renderer/settings/model-settings.js");

  assert.match(modelSettings, /getSettingsRuntimeControlOptions/);
  assert.match(modelSettings, /runtimeControlOptionsRequest/);
  assert.doesNotMatch(modelSettings, /externalModelEntries/);
  assert.doesNotMatch(modelSettings, /externalPermissionOptions/);
  assert.doesNotMatch(modelSettings, /window\.miaEngineOptions\.effortOptions/);
  assert.doesNotMatch(modelSettings, /window\.miaEngineContracts\.miaModelEntries/);
});

test("renderer bot runtime controls send state snapshots instead of UI-owned option tables", () => {
  const app = read("src/renderer/app.js");
  const contactCard = read("src/renderer/social/contact-card.js");
  const combined = `${app}\n${contactCard}`;

  assert.match(combined, /getBotRuntimeControlOptions/);
  assert.match(combined, /runtimeControlStateSnapshot/);
  assert.match(combined, /modelCatalog/);
  assert.match(combined, /platformModels/);
  assert.match(combined, /engineCapabilities/);
  assert.match(combined, /codexModels/);
  assert.doesNotMatch(combined, /modelOptionsByEngine/);
  assert.doesNotMatch(combined, /effortOptionsByEngine/);
  assert.doesNotMatch(combined, /permissionOptionsByEngine/);
  assert.doesNotMatch(combined, /externalModelEntries/);
  assert.doesNotMatch(combined, /externalPermissionOptions/);
  assert.doesNotMatch(combined, /window\.miaEngineOptions\?\.effortOptions/);
});

test("renderer engine options facade exposes display helpers only", () => {
  const engineOptions = read("src/renderer/settings/engine-options.js");

  assert.match(engineOptions, /activeAgentEngine/);
  assert.match(engineOptions, /engineConfigForPersona/);
  assert.match(engineOptions, /engineIconProvider/);
  assert.doesNotMatch(engineOptions, /externalModelEntries/);
  assert.doesNotMatch(engineOptions, /externalPermissionOptions/);
  assert.doesNotMatch(engineOptions, /function effortOptions/);
  assert.doesNotMatch(engineOptions, /effortLabelForLevel/);
  assert.doesNotMatch(engineOptions, /engineCapabilities/);
  assert.doesNotMatch(engineOptions, /codexModels/);
});

test("MCP preload bridge routes renderer intent to Rust Core REST paths", () => {
  const preload = read("src/preload.js");

  assert.match(preload, /list:\s*\(\)\s*=>\s*mcpCoreOk\(miaCoreGet\("\/api\/mcp\/servers"\)\)/);
  assert.match(preload, /delete:\s*\(id\)\s*=>\s*mcpCoreOk\(miaCoreDelete\(`\/api\/mcp\/servers\/\$\{encodeURIComponent\(id\)\}`\)\)/);
  assert.match(preload, /setEnabled:\s*\(id,\s*enabled\)\s*=>\s*mcpCoreOk\(miaCorePatch\(`\/api\/mcp\/servers\/\$\{encodeURIComponent\(id\)\}`,\s*\{\s*enabled:\s*Boolean\(enabled\)\s*\}\)\)/);
  assert.match(preload, /test:\s*\(input\)\s*=>\s*testCoreMcpServer\(input\)/);
  assert.match(preload, /getAgentConfigs:\s*\(\)\s*=>\s*mcpCoreOk\(miaCoreGet\("\/api\/mcp\/agent-configs"\)\)/);
  assert.match(preload, /login:\s*\(input\)\s*=>\s*mcpCoreOk\(miaCorePost\(`\/api\/mcp\/oauth\/\$\{encodeURIComponent\(mcpInputId\(input\)\)\}\/login`,\s*input \|\| \{\}\)\)/);
  assert.doesNotMatch(preload, /mcp:\s*\{[\s\S]{0,1400}IpcChannel\.McpList/);
  assert.doesNotMatch(preload, /mcp:\s*\{[\s\S]{0,1800}IpcChannel\.McpSave/);
});

test("bot preload bridge keeps legacy social data primary with Rust Core fallback", () => {
  const preload = read("src/preload.js");

  assert.match(preload, /listBots:\s*\(\)\s*=>\s*listBotsCompat\(\)/);
  assert.match(preload, /getBotIdentity:\s*\(botId\)\s*=>\s*getBotIdentityCompat\(botId\)/);
  assert.match(preload, /saveBotIdentity:\s*\(botId,\s*body\)\s*=>\s*saveBotIdentityCompat\(botId,\s*body\)/);
  assert.match(preload, /deleteBot:\s*\(botId\)\s*=>\s*deleteBotCompat\(botId\)/);
  assert.match(preload, /getBotRuntime:\s*\(botId,\s*runtimeKind\)\s*=>\s*getBotRuntimeCompat\(botId,\s*runtimeKind\)/);
  assert.match(preload, /saveBotRuntime:\s*\(botId,\s*body\)\s*=>\s*saveBotRuntimeCompat\(botId,\s*body\)/);
  assert.match(preload, /async function listBotsCompat\(\)/);
  assert.match(preload, /IpcChannel\.SocialListBots/);
  assert.match(preload, /return coreOk\(miaCoreGet\("\/api\/bots"\)\)/);
  assert.match(preload, /getBotRuntimeTargetOptions:\s*\(input\)\s*=>\s*getCoreBotRuntimeTargetOptions\(input\)/);
  assert.match(preload, /getBotRuntimeControlOptions:\s*\(input\)\s*=>\s*getCoreBotRuntimeControlOptions\(input\)/);
  assert.match(preload, /getBotCapabilityOptions:\s*\(input\)\s*=>\s*getCoreBotCapabilityOptions\(input\)/);
  assert.match(preload, /ensureStarterEngineBots:\s*\(input\)\s*=>\s*ensureCoreStarterEngineBots\(input\)/);
  assert.match(preload, /\/api\/bots\/runtime-target-options/);
  assert.match(preload, /\/api\/bots\/runtime-control-options/);
  assert.match(preload, /\/api\/bots\/capability-options/);
  assert.match(preload, /\/api\/bots\/starter-ensure/);
  assert.match(preload, /targetIntent:\s*input\.targetIntent/);
  assert.match(preload, /syncIntent:\s*input\.syncIntent/);
  assert.match(preload, /controlIntent:\s*input\.controlIntent/);
  const runtimeRequest = extractFunctionSource(preload, "buildCoreBotRuntimeRequest");
  assert.doesNotMatch(runtimeRequest, /input\.config|input\.runtimeConfig|config\.providerConnectionId|config\.modelProfileId|config\.model/);
  assert.match(preload, /ensureBotSessionConversation:\s*\(sessionId,\s*body\)\s*=>\s*ensureBotSessionConversationCompat\(sessionId,\s*body\)/);
  assert.match(preload, /IpcChannel\.SocialSaveBotIdentity/);
  assert.match(preload, /IpcChannel\.SocialDeleteBot/);
  assert.match(preload, /IpcChannel\.SocialEnsureBotSessionConversation/);
  assert.match(preload, /IpcChannel\.SocialSaveBotRuntime/);
});

test("conversation preload bridge keeps legacy social data primary with Rust Core fallback", () => {
  const preload = read("src/preload.js");
  const channels = read("src/shared/ipc-channels.js");
  const main = read("src/main.js");

  assert.match(preload, /listConversations:\s*\(\)\s*=>\s*listConversationsCompat\(\)/);
  assert.match(preload, /getConversation:\s*\(conversationId\)\s*=>\s*getConversationCompat\(conversationId\)/);
  assert.match(preload, /createConversation:\s*\(payload\)\s*=>\s*createConversationCompat\(payload\)/);
  assert.match(preload, /postConversationMessage:\s*\(conversationId,\s*body\)\s*=>\s*postConversationMessageCompat\(conversationId,\s*body\)/);
  assert.match(preload, /async function getConversationCompat\(conversationId\)/);
  assert.match(preload, /function isDesktopLocalBotPost\(body = \{\}\)/);
  assert.match(preload, /function isCloudClaudeCodeBotPost\(body = \{\}\)/);
  assert.match(preload, /function isDesktopLocalBotConversationPost\(conversationId,\s*body = \{\}\)/);
  assert.match(preload, /function localCoreConversationIdForBotConversation\(conversationId\)/);
  assert.match(preload, /async function listLocalDesktopBotMessages\(conversationId,\s*sinceSeq,\s*limit\)/);
  assert.match(preload, /async function postLocalDesktopBotMessage\(conversationId,\s*body = \{\}\)/);
  assert.match(preload, /id:\s*firstText\(response\?\.messageId,\s*response\?\.message_id,\s*`msg_\$\{runId\}`\)/);
  const postConversationSource = extractFunctionSource(preload, "postConversationMessageCompat");
  assert.match(postConversationSource, /if \(isDesktopLocalBotConversationPost\(conversationId,\s*body\)\) \{\s*return postLocalDesktopBotMessage\(conversationId,\s*body\);\s*\}/);
  assert.match(postConversationSource, /isCloudClaudeCodeBotPost\(body\)/);
  assert.match(preload, /IpcChannel\.SocialListConversations/);
  assert.match(preload, /IpcChannel\.SocialGetConversation/);
  assert.match(preload, /IpcChannel\.SocialCreateConversation/);
  assert.match(preload, /IpcChannel\.SocialPostConversationMessage/);
  assert.match(preload, /return coreConversationOk\(miaCoreGet\("\/api\/conversations"\)\)/);
  assert.match(preload, /input\.bodyMd \|\| input\.body_md \|\| input\.body \|\| input\.text \|\| input\.message/);
  assert.match(preload, /function normalizeCoreConversation/);
  const coreConversationIdSource = extractFunctionSource(preload, "isCoreConversationId");
  assert.match(coreConversationIdSource, /botc_starter_/);
  assert.doesNotMatch(coreConversationIdSource, /id\.startsWith\("botc_"\)/);
  assert.match(preload, /listConversationMessages:\s*\(conversationId,\s*sinceSeq,\s*limit\)\s*=>\s*listConversationMessagesCompat\(conversationId,\s*sinceSeq,\s*limit\)/);
  const listMessagesSource = extractFunctionSource(preload, "listConversationMessagesCompat");
  assert.match(listMessagesSource, /if \(isBotConversationId\(conversationId\)\) \{\s*return listLocalDesktopBotMessages\(conversationId,\s*sinceSeq,\s*limit\);\s*\}/);
  assert.match(preload, /deleteConversation:\s*\(conversationId\)\s*=>\s*deleteConversationCompat\(conversationId\)/);
  assert.match(preload, /sendChatStateless:\s*\(payload\)\s*=>\s*runCoreConversationUtilityTurn\(payload\)/);
  assert.match(preload, /miaCorePost\("\/api\/conversations\/utility-turns",\s*buildCoreConversationUtilityTurnRequest\(payload\)\)/);
  assert.match(preload, /stopChat:\s*\(payload\)\s*=>\s*cancelCoreConversationTurn\(payload\)/);
  assert.match(preload, /\/api\/conversations\/\$\{encodeURIComponent\(conversationId\)\}\/turns\/\$\{encodeURIComponent\(turnId\)\}\/cancel/);
  assert.doesNotMatch(channels, /ChatSendStateless/);
  assert.doesNotMatch(main, /IpcChannel\.ChatSendStateless|async function sendChatStateless|createBotTurnHelpers|normalizeTurnRuntimeConfig/);
  assert.doesNotMatch(preload, /IpcChannel\.ChatSendStateless/);
});

test("conversation preload bridge normalizes Core millisecond timestamps for message times", () => {
  const preload = read("src/preload.js");
  const normalizeCoreMessageSource = extractFunctionSource(preload, "normalizeCoreMessage");

  assert.match(preload, /function coreTimestampIso\(value\)/);
  assert.match(preload, /function coreMessageCreatedAt\(message = \{\}, fallback = \{\}\)/);
  assert.match(normalizeCoreMessageSource, /created_at:\s*coreMessageCreatedAt\(message,\s*fallback\)/);
  assert.match(
    normalizeCoreMessageSource,
    /sender_ref:\s*firstText\(message\.sender_ref,\s*message\.senderRef,\s*fallback\.senderRef,\s*normalizedSenderKind === "user" \? miaCoreStartupState\.userId : ""\)/,
    "Core role=user messages must normalize to the current user side"
  );
  assert.doesNotMatch(
    normalizeCoreMessageSource,
    /created_at:\s*firstText\(message\.created_at,\s*message\.createdAt/,
    "Core numeric createdAt must not bypass ISO normalization"
  );
});

test("Rust Core runtime assistant message events carry persisted created_at", () => {
  const conversationCore = read("crates/mia-core-conversation/src/lib.rs");
  const conversationRoute = read("crates/mia-core-app/src/router/conversation.rs");
  const cloudBridge = read("crates/mia-core-app/src/cloud_bridge.rs");

  assert.match(conversationCore, /pub struct CompletedRuntimeMessage \{[\s\S]*pub created_at: i64,/);
  assert.match(conversationCore, /CompletedRuntimeMessage \{[\s\S]*created_at: now,/);
  assert.match(conversationRoute, /"created_at": completed\.created_at/);
  assert.match(cloudBridge, /"created_at": completed\.created_at/);
  assert.doesNotMatch(conversationRoute, /"created_at": "",/);
  assert.doesNotMatch(cloudBridge, /"created_at": "",/);
});

test("tasks preload bridge routes scheduling ownership to Rust Core REST paths", () => {
  const preload = read("src/preload.js");

  assert.match(preload, /list:\s*\(\)\s*=>\s*listCoreTaskJobs\(\)/);
  assert.match(preload, /get:\s*\(id\)\s*=>\s*getCoreTaskJob\(id\)/);
  assert.match(preload, /create:\s*\(input\)\s*=>\s*createCoreTaskJob\(input\)/);
  assert.match(preload, /update:\s*\(id,\s*partial\)\s*=>\s*updateCoreTaskJob\(id,\s*partial\)/);
  assert.match(preload, /delete:\s*\(id\)\s*=>\s*coreOk\(miaCoreDelete\(`\/api\/tasks\/jobs\/\$\{encodeURIComponent\(id\)\}`\)\)/);
  assert.match(preload, /pause:\s*\(id\)\s*=>\s*updateCoreTaskJob\(id,\s*\{\s*status:\s*"paused"\s*\}\)/);
  assert.match(preload, /resume:\s*\(id\)\s*=>\s*updateCoreTaskJob\(id,\s*\{\s*status:\s*"active"\s*\}\)/);
  assert.match(preload, /runNow:\s*\(id\)\s*=>\s*miaCorePost\(`\/api\/tasks\/jobs\/\$\{encodeURIComponent\(id\)\}\/run`,\s*\{\s*\}\)/);
  assert.match(preload, /request\.scheduleIntent = payload\.scheduleIntent/);
  assert.doesNotMatch(preload, /function coreScheduleFromLegacyTask/);
  assert.doesNotMatch(preload, /tasks:\s*\{[\s\S]{0,900}IpcChannel\.TasksList/);
  assert.doesNotMatch(preload, /tasks:\s*\{[\s\S]{0,900}IpcChannel\.TasksCreate/);
  assert.doesNotMatch(preload, /tasks:\s*\{[\s\S]{0,900}IpcChannel\.TasksRunNow/);
});

test("cloud preload and main bridge route backend state to Rust Core REST paths", () => {
  const preload = read("src/preload.js");
  const main = read("src/main.js");

  assert.match(preload, /const miaCorePut = \(route,\s*body\) => miaCoreRequest\("PUT",\s*route,\s*body\)/);
  assert.match(preload, /cloudStatus:\s*\(\)\s*=>\s*miaCoreGet\("\/api\/cloud\/status"\)/);
  assert.match(preload, /settingsGet:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(IpcChannel\.CloudSettingsGet\)/);
  assert.match(preload, /settingsPut:\s*\(settings\)\s*=>\s*ipcRenderer\.invoke\(IpcChannel\.CloudSettingsPut,\s*settings\)/);
  assert.match(main, /route:\s*"\/api\/cloud\/connect"/);
  assert.match(main, /route:\s*"\/api\/cloud\/disconnect"/);
  assert.match(main, /route:\s*"\/api\/cloud\/settings"/);
  assert.match(main, /isDaemonProcess:\s*true/);
  assert.match(main, /isDaemonEnabled:\s*\(\)\s*=>\s*Boolean\(settingsStore\?\.coreSettings\?\.\(\)\.enabled\)/);
  assert.match(main, /async function syncCloudSettingsToCore[\s\S]*startCloudRuntimeSockets\(\)/);
  assert.match(main, /return await cloudSettingsGet\(\)/);
  assert.match(main, /return await cloudSettingsPut\(settings \|\| \{\}\)/);
  assert.match(main, /ipcMain\.handle\(IpcChannel\.CloudStatus,\s*\(\) => coreCloudStatus\(false\)\)/);
  assert.doesNotMatch(preload, /cloudStatus:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(IpcChannel\.CloudStatus\)/);
});
