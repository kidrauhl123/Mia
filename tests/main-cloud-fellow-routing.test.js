const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

test("main routes cloud room AI events to main-process responders", () => {
  const main = read("src/main.js");
  const routedSource = fs.existsSync(path.join(root, "src/main/cloud/cloud-events-client.js"))
    ? `${main}\n${read("src/main/cloud/cloud-events-client.js")}`
    : main;

  assert.match(main, /createLocalFellowResponder/);
  assert.match(main, /createMainGroupConductor/);
  assert.match(main, /createMainFellowRoomResponder/);
  assert.match(main, /getFellowRuntime:\s*async\s*\(fellowId,\s*runtimeKind\)/);
  assert.match(main, /socialApi\.getFellowRuntime\(fellowId,\s*runtimeKind\)/);
  assert.match(main, /sendChat,\s*\n\s*postRoomMessageAsFellow/s);
  assert.match(
    routedSource,
    /message\.type === CloudEvent\.RoomFellowInvocationRequested[\s\S]*localFellowResponder\.respond/
  );
  assert.match(
    routedSource,
    /message\.type === CloudEvent\.RoomMessageAppended[\s\S]*mainGroupConductor\.handleRoomMessageAppended/
  );
  assert.match(
    routedSource,
    /message\.type === CloudEvent\.RoomMessageAppended[\s\S]*mainFellowRoomResponder\.handleRoomMessageAppended/
  );
});

test("renderer no longer executes local fellow replies for cloud room events", () => {
  const social = read("src/renderer/social/social.js");
  const groups = read("src/renderer/social/social-groups.js");
  const html = read("src/renderer/index.html");

  assert.equal(
    /window\.miaGroupConductor\.handleRoomMessageAppended/.test(social),
    false,
    "renderer must not run conductor dispatch from room.message_appended"
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
    /sendChatStateless|postRoomMessageAsFellow|handleFellowInvocation/.test(groups),
    false,
    "renderer social-groups must not retain local engine invocation code"
  );
});
