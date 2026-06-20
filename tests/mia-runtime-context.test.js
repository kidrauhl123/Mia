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
  assert.doesNotMatch(miaRuntimeSystemPrompt(), /浏览器 MCP/);
});

test("Mia runtime context keeps scheduler routing out of the global prompt", () => {
  assert.match(MIA_RUNTIME_CONTEXT, /Mia 是聊天式多 Agent 应用/);
  assert.doesNotMatch(MIA_RUNTIME_CONTEXT, /schedule_create|schedule_list|schedule_update|schedule_delete|schedule_pause|schedule_resume/);
  assert.doesNotMatch(MIA_RUNTIME_CONTEXT, /定时任务规则|Hermes cron|不要使用 shell|cronjob/);
  assert.doesNotMatch(miaRuntimeSystemPrompt(), /schedule_create|定时任务规则/);
});
