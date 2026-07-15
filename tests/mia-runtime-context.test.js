const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  MIA_RUNTIME_CONTEXT,
  miaRuntimeSystemPrompt
} = require("../src/main/mia-runtime-context.js");

test("Mia runtime context keeps browser automation out of the global prompt", () => {
  assert.doesNotMatch(MIA_RUNTIME_CONTEXT, /Codex in-app Browser/);
  assert.doesNotMatch(MIA_RUNTIME_CONTEXT, /\biab\b/);
  assert.doesNotMatch(MIA_RUNTIME_CONTEXT, /chrome-devtools|playwright/);
  assert.doesNotMatch(miaRuntimeSystemPrompt(), /browser MCP/i);
});

test("Mia runtime context keeps scheduler routing out of the global prompt", () => {
  assert.match(MIA_RUNTIME_CONTEXT, /聊天式多 Agent 应用/);
  assert.match(MIA_RUNTIME_CONTEXT, /`memory` 工具/);
  assert.match(MIA_RUNTIME_CONTEXT, /没有 read\/list\/search 记忆动作/);
  assert.doesNotMatch(MIA_RUNTIME_CONTEXT, /schedule_create|schedule_list|schedule_update|schedule_delete|schedule_pause|schedule_resume/);
  assert.doesNotMatch(MIA_RUNTIME_CONTEXT, /scheduled task rules|Hermes cron|do not use shell|cronjob/i);
  assert.doesNotMatch(miaRuntimeSystemPrompt(), /schedule_create|scheduled task rules/i);
});
