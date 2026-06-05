const { test } = require("node:test");
const assert = require("node:assert/strict");

const { deliverTaskReplyToConversation } = require("../src/main/task-reply-delivery.js");

test("deliverTaskReplyToConversation posts to normalized cloud conversation and returns message id", async () => {
  const calls = [];
  const result = await deliverTaskReplyToConversation({
    socialApi: {
      postConversationMessageAsBot: async (conversationId, body) => {
        calls.push({ conversationId, body });
        return { message: { id: "m_cloud_1" } };
      }
    },
    settingsStore: {
      cloudSettings: () => ({ enabled: true, token: "t", user: { id: "user_1" } })
    },
    bot: { key: "nhnh" },
    conversationId: "conversation:botc_user_1_session_1",
    assistantText: "该吃饭啦",
    assistantTracePayload: { reasoning: "到点提醒" },
    taskRunId: "r_1",
    fallbackMessageId: "local_msg_1"
  });

  assert.equal(result.messageId, "m_cloud_1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].conversationId, "botc_user_1_session_1");
  assert.deepEqual(calls[0].body, {
    botId: "nhnh",
    bodyMd: "该吃饭啦",
    trace: { reasoning: "到点提醒" },
    clientOpId: "op_task_r_1_local_msg_1"
  });
});

test("deliverTaskReplyToConversation fails when task reply cannot be delivered", async () => {
  await assert.rejects(
    deliverTaskReplyToConversation({
      socialApi: {
        postConversationMessageAsBot: async () => {
          throw new Error("you are not the owner of this bot in this conversation");
        }
      },
      settingsStore: {
        cloudSettings: () => ({ enabled: true, token: "t", user: { id: "user_1" } })
      },
      bot: { key: "nhnh" },
      conversationId: "conversation:botc_user_1_session_1",
      assistantText: "该吃饭啦",
      taskRunId: "r_1",
      fallbackMessageId: "local_msg_1"
    }),
    /you are not the owner/
  );
});
