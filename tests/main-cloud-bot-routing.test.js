const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

test("main wires the bot runtime dispatcher without foreground execution ownership", () => {
  const main = read("src/main.js");
  const routedSource = `${main}\n${read("src/main/cloud/cloud-events-client.js")}`;

  assert.match(
    main,
    /const\s+localBotResponder\s*=\s*IS_DAEMON_PROCESS\s*\?\s*createLocalBotResponder\(/,
    "local bot responder must be daemon-only"
  );
  assert.match(main, /createMainBotRuntimeDispatcher/);
  assert.doesNotMatch(main, /createMainGroupConductor/);
  assert.doesNotMatch(main, /createMainBotConversationResponder/);
  assert.match(
    routedSource,
    /message\.type === CloudEvent\.ConversationBotInvocationRequested[\s\S]*botRuntimeDispatcher\?\.handleCloudEvent\?\.\(message\)/
  );
  const dispatcher = read("src/main/social/bot-runtime-dispatcher.js");
  assert.match(dispatcher, /localBotResponder\.respond/);
  assert.doesNotMatch(dispatcher, /mainGroupConductor/);
  assert.doesNotMatch(dispatcher, /mainBotConversationResponder/);
});

test("renderer no longer executes local bot replies for cloud conversation events", () => {
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
