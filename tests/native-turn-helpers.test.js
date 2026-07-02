const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createNativeTurnHelpers } = require("../src/main/native-turn-helpers.js");

test("currentUserPrompt keeps only the current user turn plus current-turn attachment context", () => {
  const helpers = createNativeTurnHelpers({
    normalizeAttachments: (attachments) => Array.isArray(attachments) ? attachments : [],
    attachmentContext: (attachments) => attachments.map((item) => item.name).join("\n")
  });

  const prompt = helpers.currentUserPrompt([
    { role: "system", content: "最近消息上下文：用户 earlier；助手 earlier reply" },
    { role: "user", content: "earlier user" },
    { role: "assistant", content: "earlier reply" },
    {
      role: "user",
      content: "现在这条才是当前问题",
      attachments: [{ name: "current-plan.md" }]
    }
  ]);

  assert.match(prompt, /现在这条才是当前问题/);
  assert.match(prompt, /附件上下文：\ncurrent-plan\.md/);
  assert.doesNotMatch(prompt, /会话前文/);
  assert.doesNotMatch(prompt, /earlier user|earlier reply|最近消息上下文/);
});

test("slashCommandText still reads the current user turn", () => {
  const helpers = createNativeTurnHelpers({
    normalizeAttachments: () => [],
    attachmentContext: () => ""
  });

  assert.equal(helpers.slashCommandText([
    { role: "user", content: "普通消息" },
    { role: "assistant", content: "ignored" },
    { role: "user", content: "/task list" }
  ]), "/task list");
});
