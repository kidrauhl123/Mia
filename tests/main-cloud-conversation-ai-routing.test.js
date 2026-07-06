const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

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
  assert.match(
    main,
    /const\s+botExecutionCore\s*=\s*IS_DAEMON_PROCESS\s*\?\s*createBotExecutionCore\(/,
    "bot execution may only be constructed by the Core/daemon process"
  );
  assert.doesNotMatch(
    main,
    /const\s+localBotResponder\s*=\s*createLocalBotResponder\(/,
    "foreground main must not unconditionally instantiate the local bot responder Module"
  );
  assert.match(
    main,
    /const\s+localBotResponder\s*=\s*IS_DAEMON_PROCESS\s*\?\s*createLocalBotResponder\(/,
    "local bot responder may only be constructed by the Core/daemon process"
  );
  assert.match(main, /createCloudEventsClient/, "main may construct the cloud events adapter, but it must not host sockets in foreground");
  assert.doesNotMatch(main, /createMainGroupConductor/, "main must not instantiate a desktop group conductor");
  assert.doesNotMatch(main, /createMainBotConversationResponder/, "main must not instantiate a desktop DM auto-responder");
  assert.match(main, /createMainBotRuntimeDispatcher/, "main must instantiate the unified bot runtime dispatcher adapter");
  assert.match(main, /shouldHandleLocalCloudConversationAi/, "main must gate AI execution with cloud idempotency aware process ownership");
  assert.match(
    cloudEventsClient,
    /message\.type === CloudEvent\.ConversationBotInvocationRequested[\s\S]*botRuntimeDispatcher\?\.handleCloudEvent\?\.\(message\)/,
    "explicit bot invocation events must enter the unified bot runtime dispatcher"
  );
  const dispatcher = read("src/main/social/bot-runtime-dispatcher.js");
  assert.match(dispatcher, /localBotResponder\.respond/, "dispatcher must own explicit desktop-local invocation execution");
  assert.doesNotMatch(dispatcher, /mainGroupConductor/, "dispatcher must not run group conductor fan-out from message events");
  assert.doesNotMatch(dispatcher, /mainBotConversationResponder/, "dispatcher must not re-derive invocation from raw message events");
  assert.doesNotMatch(
    cloudEventsClient,
    /"conversation\.(bot_invocation_requested|message_appended)"/,
    "cloud events client must use shared CloudEvent conversation constants, not raw event strings"
  );
  assert.doesNotMatch(main, /function handleCloudEventsMessage/, "main must not own cloud event routing implementation");
  assert.doesNotMatch(main, /let cloudEventsClient/, "main must not own cloud events websocket state");
  assert.doesNotMatch(main, /cloudEventsReconnectTimer/, "main must not own cloud events reconnect timer state");
});

test("cloud events execution and cursor have a single owner (ADR 2026-06-12)", () => {
  const main = read("src/main.js");
  const core = read("src/core/mia-core.js");
  const responder = read("src/main/social/local-bot-responder.js");
  // Migration slice 5c: the daemon is the standalone node Core, so the cloud
  // socket boot now lives in Core's startWithCloud(), not an Electron
  // `if (IS_DAEMON_PROCESS)` whenReady branch (deleted). Core keeps BOTH the
  // events and bridge sockets alive when cloud is enabled with a token.
  assert.match(
    core,
    /async function startWithCloud\(\) \{[\s\S]*cloudEvents\(\)\.start\(\);[\s\S]*cloudBridge\(\)\.start\(\);[\s\S]*\}/,
    "node Core (the daemon) must keep both the cloud events and bridge sockets alive"
  );
  // The Electron process is never the daemon now: it must NOT re-host the cloud
  // sockets behind an IS_DAEMON_PROCESS whenReady branch (the deleted GUI daemon).
  assert.doesNotMatch(
    main,
    /if \(IS_DAEMON_PROCESS\) \{[\s\S]*startCloudRuntimeSockets\(\);[\s\S]*setInterval/,
    "Electron must not boot the cloud sockets as a daemon — node Core owns that boot"
  );
  assert.match(
    responder,
    /return Boolean\(isDaemon && daemonEnabled\);/,
    "execution must have a single owner: daemon executes, window never covers a dead daemon (ADR 2026-06-12)"
  );
  // Single-writer cursor: node Core (the daemon) persists; the Electron window
  // is never the daemon so its persistCursor is false-by-construction.
  assert.match(
    core,
    /persistCursor: \(\) => true/,
    "node Core (the daemon) must be the single writer of the lastEventSeq cursor"
  );
  assert.match(
    main,
    /persistCursor: \(\) => IS_DAEMON_PROCESS/,
    "the Electron window must never persist the cursor (IS_DAEMON_PROCESS is false-by-construction)"
  );
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

test("daemon startup does not run foreground MCP initialization before serving control API", () => {
  const main = read("src/main.js");
  const core = read("src/core/mia-core.js");
  // Migration slice 5c: the foreground MCP warmup is a WINDOW-only concern. The
  // node Core daemon never imports/runs startupMcpInitializer, so its cold start
  // serves the control server without that warmup blocking it.
  assert.match(
    main,
    /startupMcpInitializer\.start\(\);\s*\n\s*const win = createWindow\(\);/,
    "the foreground MCP warmup must run only on the window startup path"
  );
  assert.doesNotMatch(
    core,
    /startupMcpInitializer/,
    "the node Core daemon must not run the foreground MCP warmup before serving the control API"
  );
});

test("daemon bridge capability URL warms local Agent inventory when cache is cold", () => {
  const main = read("src/main.js");
  assert.match(
    main,
    /function bridgeEngineIdsFromView\(engines = \{\}\) \{[\s\S]*engines\.codex\?\.available[\s\S]*engines\.openClaw\?\.available/,
    "bridge capabilities must include all usable local Agent engines, not just Hermes"
  );
  assert.match(
    main,
    /IS_DAEMON_PROCESS && !ids\.length && typeof localAgentEngineService\?\.localAgentEngines === "function"[\s\S]*localAgentEngineService\.localAgentEngines\(\)/,
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
