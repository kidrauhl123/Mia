const test = require("node:test");
const assert = require("node:assert");
const { buildConversationListItems } = require("../src/mobile/lib/conversation-list-model");

test("按最后活动时间倒序,带未读数与末句", () => {
  const items = buildConversationListItems({
    conversations: [
      { id: "dm:a", name: "Alice", last_message_text: "hi", last_activity_at: "2026-06-01T10:00:00Z" },
      { id: "fellow::bob", name: "Bob", last_message_text: "done", last_activity_at: "2026-06-01T12:00:00Z" }
    ],
    unreadByConversation: { "dm:a": 3 }
  });
  assert.equal(items[0].id, "fellow::bob");
  assert.equal(items[0].unread, 0);
  assert.equal(items[1].id, "dm:a");
  assert.equal(items[1].unread, 3);
  assert.equal(items[1].subtitle, "hi");
});

test("缺字段时安全降级", () => {
  const items = buildConversationListItems({ conversations: [{ id: "dm:x" }], unreadByConversation: {} });
  assert.equal(items[0].title, "dm:x");
  assert.equal(items[0].subtitle, "");
  assert.equal(items[0].unread, 0);
});
