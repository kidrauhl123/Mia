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

  assert.match(main, /createLocalFellowResponder/);
  assert.match(main, /createMainGroupConductor/);
  assert.match(main, /createMainFellowRoomResponder/);
  assert.match(main, /sendChat,\s*\n\s*postRoomMessageAsFellow/s);
  assert.match(
    main,
    /message\.type === CloudEvent\.RoomFellowInvocationRequested[\s\S]*localFellowResponder\.respond/
  );
  assert.match(
    main,
    /message\.type === CloudEvent\.RoomMessageAppended[\s\S]*mainGroupConductor\.handleRoomMessageAppended/
  );
  assert.match(
    main,
    /message\.type === CloudEvent\.RoomMessageAppended[\s\S]*mainFellowRoomResponder\.handleRoomMessageAppended/
  );
});
