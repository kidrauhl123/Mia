const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createConversationTitleService } = require("../src/main/conversation-title-service.js");

test("generateTitle delegates title chat and falls back safely", async () => {
  const calls = [];
  const service = createConversationTitleService({
    randomUUID: () => "uuid_1",
    sendChatStateless: async (payload) => {
      calls.push(payload);
      return { content: "「短标题。」" };
    }
  });

  assert.deepEqual(await service.generateTitle({
    botId: "mia",
    conversationId: "bot:u_1:mia",
    messages: [
      { role: "user", content: "帮我总结今天的任务安排" },
      { role: "assistant", content: "好的" }
    ]
  }), { title: "短标题" });
  assert.equal(calls[0].botKey, "mia");
  assert.equal(calls[0].systemPrompt, "");
  assert.match(calls[0].userPrompt, /请给下面这段对话生成一个简短标题/);

  const failing = createConversationTitleService({
    sendChatStateless: async () => { throw new Error("down"); }
  });
  assert.deepEqual(await failing.generateTitle({
    messages: [{ role: "user", content: "一个很长的开头，用来回退标题" }]
  }), { title: "一个很长的开头，用来回退标题" });
});
