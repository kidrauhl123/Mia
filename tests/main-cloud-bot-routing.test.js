const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

test("main no longer routes Cloud Events frames through the JS bot runtime dispatcher", () => {
  const main = read("src/main.js");
  const routedSource = `${main}\n${read("src/main/cloud/cloud-events-client.js")}`;

  assert.doesNotMatch(
    main,
    /createLocalBotResponder|const\s+localBotResponder\b/,
    "Electron main must not construct the retired JS local bot responder"
  );
  assert.doesNotMatch(main, /createMainBotRuntimeDispatcher/);
  assert.doesNotMatch(main, /createBotExecutionCore|botExecutionCore/, "Electron main must not wire the retired JS bot execution core");
  assert.doesNotMatch(main, /createMainGroupConductor/);
  assert.doesNotMatch(main, /createMainBotConversationResponder/);
  assert.doesNotMatch(
    routedSource,
    /message\.type === CloudEvent\.ConversationBotInvocationRequested[\s\S]*botRuntimeDispatcher\?\.handleCloudEvent\?\.\(message\)/
  );
  assert.match(routedSource, /\/api\/cloud\/events\/start/);
  assert.equal(fs.existsSync(path.join(root, "src/main/social/bot-runtime-dispatcher.js")), false);
  assert.equal(fs.existsSync(path.join(root, "src/main/social/local-bot-responder.js")), false);
  assert.equal(fs.existsSync(path.join(root, "src/main/bot-execution-core.js")), false);
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
