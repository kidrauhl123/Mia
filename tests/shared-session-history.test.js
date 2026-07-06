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
  assert.equal(sessionHistory.conversationType({ id: "botc_1" }), "bot");
  assert.equal(browserContract.conversationType({ id: "dm:a:b" }), "dm");
  assert.equal(browserContract.botId({ id: "botc_1", decorations: { botId: "bot_mia" } }), "bot_mia");
  assert.equal(typeof browserContract.createBotSessionPayload, "function");
  assert.equal(typeof browserContract.isUntitledBotConversation, "function");
});

test("session-history groups bot conversations by bot id and sorts by latest message", () => {
  const messages = new Map([
    ["botc_s1", { messages: [{ created_at: "2026-01-01T00:00:00.000Z" }] }],
    ["botc_s2", { messages: [{ created_at: "2026-01-02T00:00:00.000Z" }] }]
  ]);
  const conversations = [
    { id: "botc_s1", type: "bot", decorations: { botId: "bot_mia" } },
    { id: "botc_s2", type: "bot", decorations: { botId: "bot_mia" } },
    { id: "botc_c1", type: "bot", decorations: { botId: "bot_codex" } },
    { id: "g_1", type: "group", name: "群聊" }
  ];

  const grouped = sessionHistory.sessionConversationsForConversation(conversations[0], conversations, { messageCache: messages });
  assert.deepEqual(grouped.map((conversation) => conversation.id), ["botc_s2", "botc_s1"]);
});

test("session-history prefers message-bearing bot sessions over newer metadata-only sessions", () => {
  const messages = new Map([
    ["botc_with-message", { messages: [{ created_at: "2026-01-01T10:00:00.000Z" }] }],
    ["botc_metadata-only", { messages: [] }]
  ]);
  const conversations = [
    { id: "botc_with-message", type: "bot", decorations: { botId: "bot_mia" }, updatedAt: "2026-01-01T10:00:00.000Z" },
    { id: "botc_metadata-only", type: "bot", decorations: { botId: "bot_mia" }, updatedAt: "2026-01-01T11:00:00.000Z" }
  ];

  const sidebar = sessionHistory.sidebarConversations(conversations, { messageCache: messages });

  assert.deepEqual(sidebar.map((conversation) => conversation.id), ["botc_with-message"]);
});

test("session-history derives title and new-session payload consistently", () => {
  const conversation = {
    id: "botc_s1",
    type: "bot",
    decorations: { botId: "bot_mia", runtimeKind: "cloud-claude-code" }
  };
  const title = sessionHistory.sessionTitle(conversation, {
    bots: [{ id: "bot_mia", displayName: "Mia" }]
  });
  const payload = sessionHistory.createBotSessionPayload(conversation, "sess_new", { title: "新对话" });

  assert.equal(title, "Mia");
  assert.deepEqual(payload, {
    botId: "bot_mia",
    title: "新对话",
    runtimeKind: "cloud-claude-code",
    sessionId: "sess_new"
  });
});

test("session-history resolves runtime kind from explicit root or runtime config before desktop-local fallback", () => {
  assert.equal(sessionHistory.runtimeKind({
    id: "botc_root",
    type: "bot",
    runtimeKind: "cloud-claude-code",
    decorations: { botId: "bot_root" }
  }, "desktop-local"), "cloud-claude-code");

  assert.equal(sessionHistory.runtimeKind({
    id: "botc_cfg",
    type: "bot",
    runtime_config: { runtimeKind: "cloud-claude-code" },
    decorations: { botId: "bot_cfg" }
  }, "desktop-local"), "cloud-claude-code");

  assert.equal(sessionHistory.runtimeKind({
    id: "botc_alias",
    type: "bot",
    decorations: { botId: "bot_alias", runtimeKind: "cloud-hermes" }
  }, "desktop-local"), "cloud-claude-code");
});

test("session-history treats default and bot-name titles as untitled bot sessions", () => {
  assert.equal(sessionHistory.isUntitledBotConversation({
    id: "botc_s1",
    type: "bot",
    name: "新对话",
    decorations: { botId: "bot_kongling" }
  }, {
    bots: [{ id: "bot_kongling", displayName: "空铃" }]
  }), true);

  assert.equal(sessionHistory.isUntitledBotConversation({
    id: "botc_kongling",
    type: "bot",
    name: "空铃",
    decorations: { botId: "bot_kongling" }
  }, {
    bots: [{ id: "bot_kongling", displayName: "空铃" }]
  }), true);

  assert.equal(sessionHistory.isUntitledBotConversation({
    id: "botc_kongling",
    type: "bot",
    name: "聊项目日报",
    decorations: { botId: "bot_kongling" }
  }, {
    bots: [{ id: "bot_kongling", displayName: "空铃" }]
  }), false);
});

test("session-history collapses bot sessions for sidebars but keeps the active blank session selected", () => {
  const messages = new Map([
    ["botc_old", { messages: [{ created_at: "2026-01-03T00:00:00.000Z" }] }],
    ["botc_new", { messages: [] }]
  ]);
  const conversations = [
    { id: "botc_old", type: "bot", name: "旧标题", decorations: { botId: "bot_rongcha" } },
    { id: "botc_new", type: "bot", name: "新对话", decorations: { botId: "bot_rongcha" }, created_at: "2026-01-01T00:00:00.000Z" },
    { id: "dm:a:b", type: "dm" },
    { id: "g_1", type: "group" }
  ];

  const sidebar = sessionHistory.sidebarConversations(conversations, {
    activeConversationId: "botc_new",
    messageCache: messages
  });

  assert.deepEqual(sidebar.map((conversation) => conversation.id).sort(), ["dm:a:b", "botc_new", "g_1"].sort());
  assert.equal(sessionHistory.botDisplayTitle(sidebar.find((conversation) => conversation.id === "botc_new"), [
    { id: "bot_rongcha", displayName: "荣茶" }
  ]), "荣茶");
});

test("session-history honors the device-local last selected bot session in sidebar collapse", () => {
  const messages = new Map([
    ["botc_first", { messages: [{ created_at: "2026-01-03T00:00:00.000Z" }] }],
    ["botc_last-selected", { messages: [{ created_at: "2026-01-01T00:00:00.000Z" }] }]
  ]);
  const conversations = [
    { id: "botc_first", type: "bot", decorations: { botId: "bot_nhnh" } },
    { id: "botc_last-selected", type: "bot", decorations: { botId: "bot_nhnh" } }
  ];

  const sidebar = sessionHistory.sidebarConversations(conversations, {
    messageCache: messages,
    preferredConversationIdByBotId: { bot_nhnh: "botc_last-selected" }
  });

  assert.deepEqual(sidebar.map((conversation) => conversation.id), ["botc_last-selected"]);
});
