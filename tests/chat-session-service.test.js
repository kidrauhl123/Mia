const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createChatStore } = require("../src/main/chat-store.js");
const { createChatSessionService } = require("../src/main/chat-session-service.js");

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimashi-chat-session-service-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const chatSessions = path.join(dir, "chat-sessions.json");
  const calls = { initialize: 0, titleChats: [] };
  const chatStore = createChatStore({
    runtimePaths: () => ({ chatSessions }),
    readJson,
    normalizeAttachments: (attachments) => Array.isArray(attachments) ? attachments : []
  });
  const service = createChatSessionService({
    initializeRuntime: () => { calls.initialize += 1; },
    chatStore,
    randomUUID: () => "title_uuid",
    sendChat: async (payload) => {
      calls.titleChats.push(payload);
      return { choices: [{ message: { content: "\"短标题。\"" } }] };
    },
    ...overrides
  });
  return { calls, chatSessions, chatStore, service };
}

test("saveChatSession owns merge, transient filtering, and persistence", async (t) => {
  const { chatStore, service } = setup(t);

  await service.saveChatSession({
    personaKey: "aimashi",
    session: {
      id: "s_1",
      title: "First",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      messages: [
        { role: "user", content: "hello", createdAt: "2026-01-01T00:00:01.000Z" },
        { role: "assistant", content: "typing", createdAt: "2026-01-01T00:00:02.000Z", transient: true }
      ]
    }
  });
  await service.saveChatSession({
    personaKey: "aimashi",
    session: {
      id: "s_1",
      title: "Ignored",
      updatedAt: "2026-01-01T00:00:03.000Z",
      messages: [
        { role: "user", content: "hello", createdAt: "2026-01-01T00:00:01.000Z", pinned: true },
        { role: "assistant", content: "done", createdAt: "2026-01-01T00:00:03.000Z" }
      ]
    }
  });

  const saved = chatStore.loadChatStore().sessions.aimashi[0];
  assert.equal(saved.title, "First");
  assert.equal(saved.updatedAt, "2026-01-01T00:00:03.000Z");
  assert.deepEqual(saved.messages.map((message) => [message.role, message.content, Boolean(message.pinned)]), [
    ["user", "hello", true],
    ["assistant", "done", false]
  ]);
});

test("newChatSession prunes empty sessions and saveChatReadState persists unread overrides", async (t) => {
  const { chatStore, service } = setup(t);

  await service.saveChatSession({ personaKey: "aimashi", session: { id: "empty", messages: [] } });
  await service.saveChatSession({
    personaKey: "aimashi",
    session: { id: "kept", messages: [{ role: "user", content: "keep", createdAt: "2026-01-01T00:00:00.000Z" }] }
  });
  await service.newChatSession({ personaKey: "aimashi" });
  await service.saveChatReadState({
    readAt: { aimashi: "2026-01-02T00:00:00.000Z", empty: "" },
    manualUnread: { aimashi: true, ignored: false }
  });

  const store = chatStore.loadChatStore();
  assert.equal(store.sessions.aimashi.length, 2);
  assert.deepEqual(store.sessions.aimashi.map((session) => session.id).includes("empty"), false);
  assert.deepEqual(store.readAt, { aimashi: "2026-01-02T00:00:00.000Z" });
  assert.deepEqual(store.manualUnread, { aimashi: true });
});

test("generateSessionTitle delegates title chat and falls back safely", async (t) => {
  const { calls, service } = setup(t);

  assert.deepEqual(await service.generateSessionTitle({
    personaKey: "aimashi",
    messages: [
      { role: "system", content: "ignored" },
      { role: "user", content: "请帮我设计一个同步方案" },
      { role: "assistant", content: "可以从事件日志开始。" }
    ]
  }), { title: "短标题" });

  assert.equal(calls.titleChats.length, 1);
  assert.equal(calls.titleChats[0].sessionId, "title:title_uuid");
  assert.match(calls.titleChats[0].messages[1].content, /user: 请帮我设计一个同步方案/);

  const failing = setup(t, { sendChat: async () => { throw new Error("down"); } }).service;
  assert.deepEqual(await failing.generateSessionTitle({
    personaKey: "aimashi",
    messages: [{ role: "user", content: "Fallback title from user content" }]
  }), { title: "Fallback title from user content" });
});
