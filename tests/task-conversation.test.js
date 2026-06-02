const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeCloudConversationId,
  taskConversationFields
} = require("../src/main/task-conversation.js");

test("normalizeCloudConversationId strips engine conversation session prefix", () => {
  assert.equal(
    normalizeCloudConversationId("conversation:fellow:user_1:session_1"),
    "fellow:user_1:session_1"
  );
  assert.equal(normalizeCloudConversationId("fellow:user_1:session_1"), "fellow:user_1:session_1");
  assert.equal(normalizeCloudConversationId(" conversation:g_123 "), "g_123");
});

test("taskConversationFields preserves engine session id while storing cloud conversation id", () => {
  assert.deepEqual(
    taskConversationFields({ sessionId: "conversation:fellow:user_1:session_1" }),
    {
      conversationId: "fellow:user_1:session_1",
      sessionId: "conversation:fellow:user_1:session_1"
    }
  );
  assert.deepEqual(
    taskConversationFields({ conversationId: "fellow:user_1:session_1" }),
    {
      conversationId: "fellow:user_1:session_1",
      sessionId: "fellow:user_1:session_1"
    }
  );
});
