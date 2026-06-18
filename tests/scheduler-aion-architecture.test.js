const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("scheduler follows AION-style structured tool path without app-side reminder parsing", () => {
  const forbiddenFiles = [
    "src/main/app-scheduler-reminder.js",
    "src/main/reminder-intent.js",
    "src/main/scheduler-skill-detector.js"
  ];
  for (const relativePath of forbiddenFiles) {
    assert.equal(fs.existsSync(path.join(root, relativePath)), false, `${relativePath} should not exist`);
  }

  const mainSource = read("src/main.js");
  const localResponderSource = read("src/main/social/local-bot-responder.js");
  const cloudDispatcherSource = read("src/cloud-agent/dispatcher.js");

  for (const [label, source] of [
    ["main", mainSource],
    ["local responder", localResponderSource],
    ["cloud dispatcher", cloudDispatcherSource]
  ]) {
    assert.doesNotMatch(source, /app-scheduler-reminder|reminder-intent|scheduler-skill-detector|handleReminderChatTurn|createScheduledReminderFromTurn|parseRelativeReminderIntent|isSchedulerIntent/, `${label} must not use direct reminder parsing`);
  }

  const schedulerSkill = read("skills/_builtin/mia-scheduler/SKILL.md");
  assert.match(schedulerSkill, /schedule_create/, "structured scheduler tool guidance must remain");
  assert.match(read("src/main/scheduler-mcp-server.js"), /name: "schedule_create"/, "desktop scheduler MCP tool must remain");
  assert.match(read("src/main/engine-plugins-service.js"), /'name': 'schedule_create'/, "cloud Hermes scheduler MCP tool must remain");
});
