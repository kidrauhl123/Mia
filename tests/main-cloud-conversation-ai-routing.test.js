const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

test("main owns cloud conversation fellow invocation and group conductor execution", () => {
  const main = read("src/main.js");
  const cloudEventsClient = read("src/main/cloud/cloud-events-client.js");

  assert.match(main, /createLocalFellowResponder/, "main must instantiate the local fellow responder Module");
  assert.match(main, /createCloudEventsClient/, "main must instantiate the cloud events client Module");
  assert.match(main, /createMainGroupConductor/, "main must instantiate the main-process group conductor Module");
  assert.match(main, /createMainFellowConversationResponder/, "main must instantiate the main-process fellow conversation responder Module");
  assert.match(main, /createMainFellowRuntimeDispatcher/, "main must instantiate the unified fellow runtime dispatcher Module");
  assert.match(main, /shouldHandleLocalCloudConversationAi/, "main must gate AI execution so foreground and daemon do not both answer");
  assert.match(
    cloudEventsClient,
    /message\.type === CloudEvent\.ConversationFellowInvocationRequested[\s\S]*fellowRuntimeDispatcher\?\.handleCloudEvent\?\.\(message\)/,
    "explicit @ cloud events must enter the unified fellow runtime dispatcher"
  );
  assert.match(
    cloudEventsClient,
    /message\.type === CloudEvent\.ConversationMessageAppended[\s\S]*fellowRuntimeDispatcher\?\.handleCloudEvent\?\.\(message\)/,
    "conversation message events must enter the unified fellow runtime dispatcher"
  );
  const dispatcher = read("src/main/social/fellow-runtime-dispatcher.js");
  assert.match(dispatcher, /localFellowResponder\.respond/, "dispatcher must own explicit desktop-local invocation execution");
  assert.match(dispatcher, /mainGroupConductor\.handleConversationMessageAppended/, "dispatcher must own group conductor fan-out");
  assert.match(
    dispatcher,
    /mainFellowConversationResponder\.handleConversationMessageAppended/,
    "dispatcher must own fellow private conversation fan-out"
  );
  assert.doesNotMatch(
    cloudEventsClient,
    /"conversation\.(fellow_invocation_requested|message_appended)"/,
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
    /handleFellowInvocation\(payload\)/.test(social),
    false,
    "renderer must not run explicit @ fellow invocation from cloud events"
  );
  assert.equal(
    /group-conductor\.js/.test(html),
    false,
    "renderer must not load the old conductor script after main owns conductor execution"
  );
  assert.equal(
    /sendChatStateless|postConversationMessageAsFellow|handleFellowInvocation/.test(groups),
    false,
    "renderer social-groups must not retain local engine invocation code"
  );
});

test("renderer IPC surface cannot post cloud conversation messages as a fellow", () => {
  const preload = read("src/preload.js");
  const channels = read("src/shared/ipc-channels.js");
  const socialIpc = read("src/main/social/social-ipc.js");

  assert.equal(
    /postConversationMessageAsFellow/.test(preload),
    false,
    "preload must not expose fellow-authored conversation posting to renderer"
  );
  assert.equal(
    /SocialPostMessageAsFellow/.test(channels),
    false,
    "shared IPC channels must not keep the renderer-to-main fellow posting channel"
  );
  assert.equal(
    /SocialPostMessageAsFellow/.test(socialIpc),
    false,
    "social IPC registration must not accept renderer fellow posting requests"
  );
});
