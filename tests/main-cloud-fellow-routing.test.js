const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

test("main routes cloud conversation AI events to main-process responders", () => {
  const main = read("src/main.js");
  const routedSource = fs.existsSync(path.join(root, "src/main/cloud/cloud-events-client.js"))
    ? `${main}\n${read("src/main/cloud/cloud-events-client.js")}`
    : main;

  assert.match(main, /createLocalFellowResponder/);
  assert.match(main, /createMainGroupConductor/);
  assert.match(main, /createMainFellowConversationResponder/);
  assert.match(main, /createMainFellowRuntimeDispatcher/);
  assert.match(main, /getFellowRuntime:\s*async\s*\(fellowId,\s*runtimeKind\)/);
  assert.match(main, /socialApi\.getFellowRuntime\(fellowId,\s*runtimeKind\)/);
  assert.match(main, /sendChat,\s*\n\s*postConversationMessageAsFellow/s);
  assert.match(
    routedSource,
    /message\.type === CloudEvent\.ConversationFellowInvocationRequested[\s\S]*fellowRuntimeDispatcher\?\.handleCloudEvent\?\.\(message\)/
  );
  assert.match(
    routedSource,
    /message\.type === CloudEvent\.ConversationMessageAppended[\s\S]*fellowRuntimeDispatcher\?\.handleCloudEvent\?\.\(message\)/
  );
  const dispatcher = read("src/main/social/fellow-runtime-dispatcher.js");
  assert.match(dispatcher, /localFellowResponder\.respond/);
  assert.match(dispatcher, /mainGroupConductor\.handleConversationMessageAppended/);
  assert.match(dispatcher, /mainFellowConversationResponder\.handleConversationMessageAppended/);
});

test("renderer no longer executes local fellow replies for cloud conversation events", () => {
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
