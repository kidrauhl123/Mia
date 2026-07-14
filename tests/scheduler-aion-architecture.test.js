const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("scheduler follows AION cron skill and Rust response middleware without scheduler MCP", () => {
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
  assert.match(schedulerSkill, /\[CRON_LIST\]/, "Aion query step must remain in the native skill");
  assert.match(schedulerSkill, /\[CRON_CREATE\]/, "Aion create protocol must remain in the native skill");
  assert.match(schedulerSkill, /multiple scheduled tasks|多个定时任务/i, "a conversation must support multiple scheduled tasks");
  assert.doesNotMatch(schedulerSkill, /ONE task per conversation/, "the copied Aion single-task guidance must be retired");
  assert.doesNotMatch(schedulerSkill, /schedule_create|scheduler MCP/i, "scheduler skill must not depend on MCP");

  for (const relativePath of [
    "src/main/scheduler-mcp-server.js",
    "src/main/scheduler-mcp-bridge.js"
  ]) {
    assert.equal(fs.existsSync(path.join(root, relativePath)), false, `${relativePath} must be deleted`);
  }

  const coreLib = read("crates/mia-core-conversation/src/cron_protocol.rs");
  const coreTurn = read("crates/mia-core-app/src/cron_turn.rs");
  assert.match(coreLib, /CronCommand/);
  assert.match(coreTurn, /MAX_CRON_CONTINUATIONS/);
  assert.doesNotMatch(cloudRuntimeSource, /["']mia-scheduler["']\s*:/);
  assert.doesNotMatch(cloudMcpSource, /schedule_create|schedule_list|schedule_update|schedule_delete|MIA_CLOUD_MCP_MODE/);
  assert.doesNotMatch(enginePluginsSource, /["']scheduler_mcp\.py["']\s*:|MIA_CLOUD_TASKS_URL|schedule_create/);
});
