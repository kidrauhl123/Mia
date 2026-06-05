const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeCloudConversationId,
  taskConversationFields
} = require("../src/main/task-conversation.js");

test("normalizeCloudConversationId strips engine conversation session prefix", () => {
  assert.equal(
    normalizeCloudConversationId("conversation:botc_user_1_session_1"),
    "botc_user_1_session_1"
  );
  assert.equal(normalizeCloudConversationId("botc_user_1_session_1"), "botc_user_1_session_1");
  assert.equal(normalizeCloudConversationId(" conversation:g_123 "), "g_123");
});

test("taskConversationFields preserves engine session id while storing cloud conversation id", () => {
  assert.deepEqual(
    taskConversationFields({ sessionId: "conversation:botc_user_1_session_1" }),
    {
      conversationId: "botc_user_1_session_1",
      sessionId: "conversation:botc_user_1_session_1"
    }
  );
  assert.deepEqual(
    taskConversationFields({ conversationId: "botc_user_1_session_1" }),
    {
      conversationId: "botc_user_1_session_1",
      sessionId: "botc_user_1_session_1"
    }
  );
});
