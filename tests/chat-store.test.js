const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createChatStore } = require("../src/main/chat-store.js");

function createStore() {
  return createChatStore({
    runtimePaths: () => ({ chatSessions: "" }),
    readJson: () => ({}),
    normalizeAttachments: (value) => Array.isArray(value) ? value : []
  });
}

test("normalizeChatStore preserves structured command results", () => {
  const { normalizeChatStore } = createStore();
  const store = normalizeChatStore({
    sessions: {
      alice: [{
        id: "s1",
        personaKey: "alice",
        title: "Resume",
        messages: [{
          role: "assistant",
          content: "choose",
          createdAt: "2026-05-23T00:00:00.000Z",
          commandResult: {
            type: "session-list",
            command: "/resume",
            engine: "codex",
            sourceDeviceId: "aimashi-device-a",
            rows: [{
              id: "019e53ab-cb8a-71a2-a2a4-ca7bdf0520d6",
              title: "Indexed title",
              preview: "hello",
              project: "/repo",
              updatedAt: 1779525746671
            }]
          }
        }]
      }]
    }
  });

  assert.deepEqual(store.sessions.alice[0].messages[0].commandResult, {
    type: "session-list",
    command: "/resume",
    engine: "codex",
    sourceDeviceId: "aimashi-device-a",
    rows: [{
      id: "019e53ab-cb8a-71a2-a2a4-ca7bdf0520d6",
      title: "Indexed title",
      preview: "hello",
      project: "/repo",
      updatedAt: 1779525746671
    }]
  });
});

test("mergeChatMessageRecord keeps existing command results when cloud copy lacks them", () => {
  const { mergeChatMessageRecord } = createStore();
  const existing = {
    role: "assistant",
    content: "choose",
    createdAt: "2026-05-23T00:00:00.000Z",
    commandResult: { type: "session-list", command: "/resume", engine: "claude-code", rows: [{ id: "s1" }] }
  };
  const incoming = {
    role: "assistant",
    content: "choose",
    createdAt: "2026-05-23T00:00:00.000Z"
  };

  assert.deepEqual(mergeChatMessageRecord(existing, incoming).commandResult, existing.commandResult);
});
