const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  permissionClassForTool,
  toolDefinitions
} = require("../src/main/mia-app-mcp-server.js");

test("mia-app MCP exposes scheduler, skills, social, and bot tools", () => {
  const names = toolDefinitions().map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "bot_list",
    "conversation_create_group",
    "conversation_list",
    "conversation_post_message",
    "schedule_create",
    "schedule_delete",
    "schedule_list",
    "schedule_pause",
    "schedule_resume",
    "schedule_update",
    "skill_install",
    "skill_search",
    "skill_show"
  ]);
});

test("write tools require permission", () => {
  assert.equal(permissionClassForTool("schedule_list"), "read");
  assert.equal(permissionClassForTool("skill_search"), "read");
  assert.equal(permissionClassForTool("skill_install"), "write");
  assert.equal(permissionClassForTool("conversation_create_group"), "write");
  assert.equal(permissionClassForTool("conversation_post_message"), "write");
  assert.equal(permissionClassForTool("unknown"), "unknown");
});
