const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("scheduler uses the same built-in MCP contract in desktop Core and Cloud", () => {
  const forbiddenFiles = [
    "src/main/app-scheduler-reminder.js",
    "src/main/reminder-intent.js",
    "src/main/scheduler-skill-detector.js"
  ];
  for (const relativePath of forbiddenFiles) {
    assert.equal(fs.existsSync(path.join(root, relativePath)), false, `${relativePath} should not exist`);
  }

  const mainSource = read("src/main.js");
  const cloudDispatcherSource = read("src/cloud-agent/dispatcher.js");
  const cloudRuntimeSource = read("src/cloud-agent/runtime-assembly.js");
  const cloudMcpSource = read("src/cloud-agent/mia-cloud-mcp-server.js");
  const enginePluginsSource = read("src/main/engine-plugins-service.js");
  assert.equal(fs.existsSync(path.join(root, "src/main/social/local-bot-responder.js")), false, "retired local bot responder should not return as a scheduler side channel");

  for (const [label, source] of [
    ["main", mainSource],
    ["cloud dispatcher", cloudDispatcherSource]
  ]) {
    assert.doesNotMatch(source, /app-scheduler-reminder|reminder-intent|scheduler-skill-detector|handleReminderChatTurn|createScheduledReminderFromTurn|parseRelativeReminderIntent|isSchedulerIntent/, `${label} must not use direct reminder parsing`);
  }

  const schedulerSkill = read("skills/_builtin/mia-scheduler/SKILL.md");
  assert.match(schedulerSkill, /schedule_list_current/);
  assert.match(schedulerSkill, /schedule_create/);
  assert.match(schedulerSkill, /Creating a new task does not replace existing tasks/);
  assert.doesNotMatch(schedulerSkill, /ONE task per conversation/);
  assert.match(schedulerSkill, /Never output `\[CRON_LIST\]`/);

  for (const relativePath of [
    "src/main/scheduler-mcp-server.js",
    "src/main/scheduler-mcp-bridge.js"
  ]) {
    assert.equal(fs.existsSync(path.join(root, relativePath)), false, `${relativePath} must be deleted`);
  }

  const coreBuiltinMcp = read("crates/mia-core-app/src/builtin_mcp.rs");
  assert.match(coreBuiltinMcp, /"schedule_list_current"/);
  assert.match(coreBuiltinMcp, /"schedule_create"/);
  assert.equal(fs.existsSync(path.join(root, "crates/mia-core-conversation/src/cron_protocol.rs")), false);
  assert.equal(fs.existsSync(path.join(root, "crates/mia-core-app/src/cron_turn.rs")), false);
  assert.doesNotMatch(cloudRuntimeSource, /["']mia-scheduler["']\s*:/);
  for (const toolName of ["schedule_list_current", "schedule_create", "schedule_update", "schedule_delete"]) {
    assert.match(cloudMcpSource, new RegExp(`"${toolName}"`), `cloud MCP must expose ${toolName}`);
  }
  assert.doesNotMatch(enginePluginsSource, /["']scheduler_mcp\.py["']\s*:|MIA_CLOUD_TASKS_URL|schedule_create/);
});
