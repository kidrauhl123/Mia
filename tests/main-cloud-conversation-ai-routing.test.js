const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

test("main owns cloud conversation bot invocation execution without group coordination", () => {
  const main = read("src/main.js");
  const cloudEventsClient = read("src/main/cloud/cloud-events-client.js");

  assert.match(main, /createLocalBotResponder/, "main must instantiate the local bot responder Module");
  assert.match(main, /createCloudEventsClient/, "main must instantiate the cloud events client Module");
  assert.doesNotMatch(main, /createMainGroupConductor/, "main must not instantiate a desktop group conductor");
  assert.doesNotMatch(main, /createMainBotConversationResponder/, "main must not instantiate a desktop DM auto-responder");
  assert.match(main, /createMainBotRuntimeDispatcher/, "main must instantiate the unified bot runtime dispatcher Module");
  assert.match(main, /shouldHandleLocalCloudConversationAi/, "main must gate AI execution so foreground and daemon do not both answer");
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

test("daemon process does not consume the cloud events socket for visible conversation AI", () => {
  const main = read("src/main.js");
  assert.doesNotMatch(
    main,
    /startCloudEvents\(\);\n\s*setInterval\(startCloudEvents, 10000\)/,
    "daemon must not advance the shared /api/events cursor while the foreground owns visible conversation AI"
  );
});

test("desktop only trusts a daemon running from the same runtime home", () => {
  const main = read("src/main.js");
  assert.match(
    main,
    /const expectedRuntimeHome = runtimePaths\(\)\.home;[\s\S]*daemonControlServer\.ping\(settings, 500, \{ expectedRuntimeHome \}\)/,
    "desktop must not defer group AI to a stale LaunchAgent pointed at another MIA_HOME"
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
