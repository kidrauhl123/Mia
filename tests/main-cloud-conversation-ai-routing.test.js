const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const LEGACY_CORE_ENTRY = path.join("src", "core", "mia-core.js");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

test("main gates cloud conversation bot invocation execution behind the Core process", () => {
  const main = read("src/main.js");
  const cloudEventsClient = read("src/main/cloud/cloud-events-client.js");

  assert.doesNotMatch(
    main,
    /const\s+botExecutionCore\s*=\s*createBotExecutionCore\(/,
    "foreground main must not unconditionally instantiate the bot execution Module"
  );
  assert.doesNotMatch(
    main,
    /createBotExecutionCore|const\s+botExecutionCore\b/,
    "Electron main must not construct the retired JS bot execution Module"
  );
  assert.doesNotMatch(
    main,
    /const\s+localBotResponder\s*=\s*createLocalBotResponder\(/,
    "foreground main must not unconditionally instantiate the local bot responder Module"
  );
  assert.doesNotMatch(
    main,
    /createLocalBotResponder|const\s+localBotResponder\b/,
    "Electron main must not construct the retired JS local bot responder Module"
  );
  assert.match(main, /createCloudEventsClient/, "main may construct the cloud events adapter, but it must not host sockets in foreground");
  assert.doesNotMatch(main, /createMainGroupConductor/, "main must not instantiate a desktop group conductor");
  assert.doesNotMatch(main, /createMainBotConversationResponder/, "main must not instantiate a desktop DM auto-responder");
  assert.doesNotMatch(main, /createMainBotRuntimeDispatcher/, "main must not route Core-owned cloud event frames through the JS dispatcher");
  assert.doesNotMatch(main, /shouldHandleLocalCloudConversationAi/, "main must not keep cloud event execution ownership in Electron");
  assert.doesNotMatch(
    cloudEventsClient,
    /message\.type === CloudEvent\.ConversationBotInvocationRequested[\s\S]*botRuntimeDispatcher\?\.handleCloudEvent\?\.\(message\)/,
    "explicit bot invocation events must no longer enter the JS dispatcher from Cloud Events"
  );
  assert.match(cloudEventsClient, /startCloudEventsRequest/, "cloud events client should only request Core lifecycle start");
  assert.doesNotMatch(
    cloudEventsClient,
    /"conversation\.(bot_invocation_requested|message_appended)"/,
    "cloud events client must use shared CloudEvent conversation constants, not raw event strings"
  );
  assert.doesNotMatch(main, /function handleCloudEventsMessage/, "main must not own cloud event routing implementation");
  assert.doesNotMatch(main, /let cloudEventsClient/, "main must not own cloud events websocket state");
  assert.doesNotMatch(main, /cloudEventsReconnectTimer/, "main must not own cloud events reconnect timer state");
  assert.equal(fs.existsSync(path.join(ROOT, "src/main/social/bot-runtime-dispatcher.js")), false, "retired JS cloud bot dispatcher should be deleted");
  assert.equal(fs.existsSync(path.join(ROOT, "src/main/social/local-bot-responder.js")), false, "retired JS local bot responder should be deleted");
  assert.equal(fs.existsSync(path.join(ROOT, "src/main/bot-execution-core.js")), false, "retired JS bot execution core should be deleted");
});

test("cloud events execution and cursor have a single owner (ADR 2026-06-12)", () => {
  const main = read("src/main.js");

  assert.equal(fs.existsSync(path.join(ROOT, LEGACY_CORE_ENTRY)), false, "old Node Core entry should be deleted");
  assert.doesNotMatch(
    main,
    /if \(IS_CORE_PROCESS\) \{[\s\S]*startCloudRuntimeSockets\(\);[\s\S]*setInterval/,
    "Electron must not inline cloud socket boot behind a daemon branch"
  );
  assert.match(main, /\/api\/cloud\/status/, "cloud status should be read through the Rust Core HTTP API");
  assert.equal(fs.existsSync(path.join(ROOT, "src/main/social/local-bot-responder.js")), false, "execution must have a single owner in Rust Core, not a dead JS responder");
  const cloudEventsBlock = main.match(/cloudEventSocketRuntime = createCloudEventsClient\(\{[\s\S]*?\n\}\);/)?.[0] || "";
  assert.doesNotMatch(cloudEventsBlock, /persistCursor|writeCloudSettings/, "Electron must not write the cloud events cursor");
});

test("desktop only manages a daemon running from the same runtime home", () => {
  const main = read("src/main.js");
  assert.match(
    main,
    /const expectedRuntimeHome = runtimePaths\(\)\.home;[\s\S]*miaCoreControlServer\.ping\(settings, 500, \{ expectedRuntimeHome \}\)/,
    "desktop must not manage a stale LaunchAgent pointed at another MIA_HOME"
  );
});

test("cloud runtime status exposes events socket health separately from bridge health", () => {
  const main = read("src/main.js");
  assert.match(main, /function cloudEventsStatus\(\)/);
  assert.match(
    main,
    /events:\s*cloudEventsStatus\(\)/,
    "runtime status must show whether /api/events is connected, not only /api/bridge"
  );
});

test("foreground shutdown cleanup does not dereference daemon-only AgentSession manager", () => {
  const main = read("src/main.js");
  assert.match(
    main,
    /if\s*\(\s*agentSessionManager\s*&&\s*typeof\s+agentSessionManager\.closeAllSessions\s*===\s*"function"\s*\)\s*\{[\s\S]*agentSessionManager\.closeAllSessions\(\)/,
    "shutdown cleanup should only close AgentSession sessions when the daemon-owned manager exists"
  );
});

test("daemon startup does not run foreground MCP initialization before serving control API", () => {
  const main = read("src/main.js");
  assert.equal(fs.existsSync(path.join(ROOT, LEGACY_CORE_ENTRY)), false, "old Node Core entry should stay deleted");
  assert.match(
    main,
    /startupMcpInitializer\.start\(\);\s*\n\s*const win = createWindow\(\);/,
    "the foreground MCP warmup must run only on the window startup path"
  );
  assert.doesNotMatch(
    main,
    /require\(["']\.\/core\/mia-core\.js["']\)|src\/core\/mia-core/,
    "Electron main must not import the deleted Node Core entry"
  );
});

test("daemon bridge capability URL warms local Agent inventory when cache is cold", () => {
  const main = read("src/main.js");
  assert.match(
    main,
    /function bridgeEngineIdsFromView\(engines = \{\}\) \{[\s\S]*engines\.codex\?\.available[\s\S]*ids\.push\("codex"\)/,
    "bridge capabilities must include supported usable local Agent engines, not just Hermes"
  );
  assert.doesNotMatch(main, /engines\.openClaw/, "bridge capabilities must not advertise removed OpenClaw support");
  assert.match(
    main,
    /IS_CORE_PROCESS && !ids\.length && typeof localAgentEngineService\?\.localAgentEngines === "function"[\s\S]*localAgentEngineService\.localAgentEngines\(\)/,
    "daemon bridge startup must synchronously warm cold Agent inventory before first cloud registration"
  );
});

test("renderer social module no longer runs local engines for cloud conversation AI", () => {
  const social = read("src/renderer/social/social.js");
  const groups = read("src/renderer/social/social-groups.js");
  const html = read("src/renderer/index.html");

  assert.equal(
    /window\.miaGroupConductor\.handleConversationMessageAppended/.test(social),
    false,
    "renderer must not run conductor dispatch from conversation.message_appended"
  );
  assert.equal(
    /handleBotInvocation\(payload\)/.test(social),
    false,
    "renderer must not run explicit @ bot invocation from cloud events"
  );
  assert.equal(
    /group-conductor\.js/.test(html),
    false,
    "renderer must not load the old conductor script after main owns conductor execution"
  );
  assert.equal(
    /sendChatStateless|postConversationMessageAsBot|handleBotInvocation/.test(groups),
    false,
    "renderer social-groups must not retain local engine invocation code"
  );
});

test("renderer IPC surface cannot post cloud conversation messages as a bot", () => {
  const preload = read("src/preload.js");
  const channels = read("src/shared/ipc-channels.js");
  const socialIpc = read("src/main/social/social-ipc.js");

  assert.equal(
    /postConversationMessageAsBot/.test(preload),
    false,
    "preload must not expose bot-authored conversation posting to renderer"
  );
  assert.equal(
    /SocialPostMessageAsBot/.test(channels),
    false,
    "shared IPC channels must not keep the renderer-to-main bot posting channel"
  );
  assert.equal(
    /SocialPostMessageAsBot/.test(socialIpc),
    false,
    "social IPC registration must not accept renderer bot posting requests"
  );
});
