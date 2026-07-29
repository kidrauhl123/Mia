const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  collapseConversationMessages,
  logicalMessageId
} = require("../src/shared/conversation-message-identity.js");

test("assistant cloud and Core mirrors collapse by turn while retaining the richer trace", () => {
  const messages = collapseConversationMessages([
    {
      id: "m_cloud_reply",
      seq: 12,
      sender_kind: "bot",
      sender_ref: "bot_1",
      body_md: "done",
      turn_id: "turn_1",
      created_at: "2026-07-29T12:00:01.000Z"
    },
    {
      id: "msg_core_reply",
      seq: 12,
      sender_kind: "bot",
      sender_ref: "bot_1",
      body_md: "done",
      turn_id: "turn_1",
      trace: { reasoning: "checked" },
      _localCoreConversationId: "cloud_bridge_botc_1",
      created_at: "2026-07-29T12:00:01.000Z"
    }
  ]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "m_cloud_reply");
  assert.equal(messages[0].logical_message_id, "assistant:turn_1");
  assert.deepEqual(messages[0].trace, { reasoning: "checked" });
  assert.equal(messages[0]._localCoreConversationId, undefined);
});

test("legacy cloud and Core user mirrors collapse only inside the narrow bridge window", () => {
  const messages = collapseConversationMessages([
    {
      id: "m_cloud_user",
      seq: 11,
      sender_kind: "user",
      sender_ref: "u1",
      body_md: "我们收集精灵用的是收纳尸体",
      created_at: "2026-07-29T12:00:00.000Z"
    },
    {
      id: "msg_core_user",
      seq: 11,
      sender_kind: "user",
      sender_ref: "u1",
      body_md: "我们收集精灵用的是收纳尸体",
      _localCoreConversationId: "cloud_bridge_botc_1",
      created_at: "2026-07-29T12:00:00.221Z"
    }
  ]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "m_cloud_user");
});

test("intentional repeated user messages remain separate", () => {
  const messages = collapseConversationMessages([
    {
      id: "m_cloud_user",
      seq: 11,
      sender_kind: "user",
      body_md: "再试一次",
      created_at: "2026-07-29T12:00:00.000Z"
    },
    {
      id: "msg_core_user",
      seq: 12,
      sender_kind: "user",
      body_md: "再试一次",
      _localCoreConversationId: "cloud_bridge_botc_1",
      created_at: "2026-07-29T12:00:02.000Z"
    }
  ]);

  assert.equal(messages.length, 2);
});

test("a cloud-origin user id is the same logical identity inside Core", () => {
  const cloud = {
    id: "m_user_1",
    sender_kind: "user",
    body_md: "hello"
  };
  const core = {
    id: "m_user_1",
    sender_kind: "user",
    body_md: "hello",
    content: { logicalMessageId: "m_user_1" }
  };

  assert.equal(logicalMessageId(cloud), "message:m_user_1");
  assert.equal(logicalMessageId(core), "message:m_user_1");
  assert.equal(collapseConversationMessages([cloud, core]).length, 1);
});
