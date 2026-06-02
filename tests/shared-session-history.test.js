const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const sessionHistory = require("../packages/shared/session-history");

function loadBrowserGlobal() {
  const source = fs.readFileSync(path.join(root, "packages/shared/session-history.js"), "utf8");
  const context = { window: {} };
  context.globalThis = context.window;
  vm.runInNewContext(source, context, { filename: "packages/shared/session-history.js" });
  return context.window.miaSessionHistory;
}

test("session-history contract is available in Node and browser contexts", () => {
  const browserContract = loadBrowserGlobal();
  assert.equal(sessionHistory.conversationType({ id: "fellow:u:mia" }), "fellow");
  assert.equal(browserContract.conversationType({ id: "dm:a:b" }), "dm");
  assert.equal(browserContract.fellowKey({ id: "fellow:u:sess", decorations: { fellowKey: "mia" } }), "mia");
  assert.equal(browserContract.fellowConversationId("u", "mia"), "fellow:u:mia");
  assert.equal(typeof browserContract.isUntitledFellowConversation, "function");
});

test("session-history owns fellow conversation id composition", () => {
  const conversationId = sessionHistory.fellowConversationId(" user_1 ", "provider:mia");

  assert.equal(conversationId, "fellow:user_1:provider:mia");
  assert.equal(sessionHistory.fellowKey({ id: conversationId }), "provider:mia");
  assert.throws(() => sessionHistory.fellowConversationId("", "mia"), /ownerUserId required/);
  assert.throws(() => sessionHistory.fellowConversationId("u", ""), /fellowKey required/);
});

test("session-history groups fellow conversations by fellow key and sorts by latest message", () => {
  const messages = new Map([
    ["fellow:u:s1", { messages: [{ created_at: "2026-01-01T00:00:00.000Z" }] }],
    ["fellow:u:s2", { messages: [{ created_at: "2026-01-02T00:00:00.000Z" }] }]
  ]);
  const conversations = [
    { id: "fellow:u:s1", type: "fellow", decorations: { fellowKey: "mia" } },
    { id: "fellow:u:s2", type: "fellow", decorations: { fellowKey: "mia" } },
    { id: "fellow:u:c1", type: "fellow", decorations: { fellowKey: "codex" } },
    { id: "g_1", type: "group", name: "群聊" }
  ];

  const grouped = sessionHistory.sessionConversationsForConversation(conversations[0], conversations, { messageCache: messages });
  assert.deepEqual(grouped.map((conversation) => conversation.id), ["fellow:u:s2", "fellow:u:s1"]);
});

test("session-history prefers message-bearing fellow sessions over newer metadata-only sessions", () => {
  const messages = new Map([
    ["fellow:u:with-message", { messages: [{ created_at: "2026-01-01T10:00:00.000Z" }] }],
    ["fellow:u:metadata-only", { messages: [] }]
  ]);
  const conversations = [
    { id: "fellow:u:with-message", type: "fellow", decorations: { fellowKey: "mia" }, updatedAt: "2026-01-01T10:00:00.000Z" },
    { id: "fellow:u:metadata-only", type: "fellow", decorations: { fellowKey: "mia" }, updatedAt: "2026-01-01T11:00:00.000Z" }
  ];

  const sidebar = sessionHistory.sidebarConversations(conversations, { messageCache: messages });

  assert.deepEqual(sidebar.map((conversation) => conversation.id), ["fellow:u:with-message"]);
});

test("session-history derives title and new-session payload consistently", () => {
  const conversation = {
    id: "fellow:u:s1",
    type: "fellow",
    decorations: { fellowKey: "mia", runtimeKind: "cloud-hermes" }
  };
  const title = sessionHistory.sessionTitle(conversation, {
    fellows: [{ id: "mia", name: "Mia" }]
  });
  const payload = sessionHistory.createFellowSessionPayload(conversation, "sess_new", { title: "新对话" });

  assert.equal(title, "Mia");
  assert.deepEqual(payload, {
    fellowKey: "mia",
    title: "新对话",
    runtimeKind: "cloud-hermes",
    sessionId: "sess_new"
  });
});

test("session-history treats default and fellow-name titles as untitled fellow sessions", () => {
  assert.equal(sessionHistory.isUntitledFellowConversation({
    id: "fellow:u:s1",
    type: "fellow",
    name: "新对话",
    decorations: { fellowKey: "kongling" }
  }, {
    fellows: [{ id: "kongling", name: "空铃" }]
  }), true);

  assert.equal(sessionHistory.isUntitledFellowConversation({
    id: "fellow:u:kongling",
    type: "fellow",
    name: "空铃",
    decorations: { fellowKey: "kongling" }
  }, {
    fellows: [{ id: "kongling", name: "空铃" }]
  }), true);

  assert.equal(sessionHistory.isUntitledFellowConversation({
    id: "fellow:u:kongling",
    type: "fellow",
    name: "聊项目日报",
    decorations: { fellowKey: "kongling" }
  }, {
    fellows: [{ id: "kongling", name: "空铃" }]
  }), false);
});

test("session-history collapses fellow sessions for sidebars but keeps the active blank session selected", () => {
  const messages = new Map([
    ["fellow:u:old", { messages: [{ created_at: "2026-01-03T00:00:00.000Z" }] }],
    ["fellow:u:new", { messages: [] }]
  ]);
  const conversations = [
    { id: "fellow:u:old", type: "fellow", name: "旧标题", decorations: { fellowKey: "rongcha" } },
    { id: "fellow:u:new", type: "fellow", name: "新对话", decorations: { fellowKey: "rongcha" }, created_at: "2026-01-01T00:00:00.000Z" },
    { id: "dm:a:b", type: "dm" },
    { id: "g_1", type: "group" }
  ];

  const sidebar = sessionHistory.sidebarConversations(conversations, {
    activeConversationId: "fellow:u:new",
    messageCache: messages
  });

  assert.deepEqual(sidebar.map((conversation) => conversation.id).sort(), ["dm:a:b", "fellow:u:new", "g_1"].sort());
  assert.equal(sessionHistory.fellowDisplayTitle(sidebar.find((conversation) => conversation.id === "fellow:u:new"), [
    { id: "rongcha", name: "荣茶" }
  ]), "荣茶");
});

test("session-history honors the device-local last selected fellow session in sidebar collapse", () => {
  const messages = new Map([
    ["fellow:u:first", { messages: [{ created_at: "2026-01-03T00:00:00.000Z" }] }],
    ["fellow:u:last-selected", { messages: [{ created_at: "2026-01-01T00:00:00.000Z" }] }]
  ]);
  const conversations = [
    { id: "fellow:u:first", type: "fellow", decorations: { fellowKey: "nhnh" } },
    { id: "fellow:u:last-selected", type: "fellow", decorations: { fellowKey: "nhnh" } }
  ];

  const sidebar = sessionHistory.sidebarConversations(conversations, {
    messageCache: messages,
    preferredConversationIdByFellowKey: { nhnh: "fellow:u:last-selected" }
  });

  assert.deepEqual(sidebar.map((conversation) => conversation.id), ["fellow:u:last-selected"]);
});
