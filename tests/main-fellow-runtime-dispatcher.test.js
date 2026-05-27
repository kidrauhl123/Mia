const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createMainFellowRuntimeDispatcher } = require("../src/main/social/fellow-runtime-dispatcher.js");

function setup(overrides = {}) {
  const calls = {
    responder: [],
    group: [],
    fellowConversation: [],
    logs: []
  };
  const dispatcher = createMainFellowRuntimeDispatcher({
    shouldHandle: () => true,
    listFellows: () => [{ key: "codex", name: "Codex" }],
    localFellowResponder: {
      respond: async (args) => {
        calls.responder.push(args);
        return true;
      }
    },
    mainGroupConductor: {
      handleConversationMessageAppended: async (args) => calls.group.push(args)
    },
    mainFellowConversationResponder: {
      handleConversationMessageAppended: async (args) => calls.fellowConversation.push(args)
    },
    log: (line) => calls.logs.push(line),
    ...overrides
  });
  return { dispatcher, calls };
}

test("explicit fellow invocation goes through the unified runtime dispatcher", async () => {
  const { dispatcher, calls } = setup();

  await dispatcher.handleCloudEvent({
    type: "conversation.fellow_invocation_requested",
    conversationId: "g_1",
    fellowId: "codex",
    invokedBy: { username: "alice" },
    triggeringMessage: { id: "m_1", body_md: "@codex 看看", sender_kind: "user" },
    recentMessages: [{ sender_kind: "user", sender_ref: "u_1", body_md: "背景" }]
  });

  assert.equal(calls.responder.length, 1);
  assert.equal(calls.responder[0].conversationId, "g_1");
  assert.equal(calls.responder[0].fellowId, "codex");
  assert.equal(calls.responder[0].dedupKey, "m_1:codex");
  assert.match(calls.responder[0].systemPrompt, /背景/);
});

test("conversation message events fan out through one fellow runtime dispatcher", async () => {
  const { dispatcher, calls } = setup();
  const message = { id: "m_2", seq: 2, sender_kind: "user", body_md: "大家看看" };

  await dispatcher.handleCloudEvent({
    type: "conversation.message_appended",
    conversationId: "g_1",
    message
  });

  assert.deepEqual(calls.group, [{ conversationId: "g_1", message }]);
  assert.deepEqual(calls.fellowConversation, [{ conversationId: "g_1", message }]);
  assert.equal(calls.responder.length, 0);
});

test("dispatcher gate prevents duplicate foreground and daemon replies", async () => {
  const { dispatcher, calls } = setup({ shouldHandle: () => false });

  await dispatcher.handleCloudEvent({
    type: "conversation.fellow_invocation_requested",
    conversationId: "g_1",
    fellowId: "codex",
    triggeringMessage: { id: "m_1", body_md: "@codex 看看" }
  });
  await dispatcher.handleCloudEvent({
    type: "conversation.message_appended",
    conversationId: "g_1",
    message: { id: "m_2", sender_kind: "user", body_md: "hi" }
  });

  assert.deepEqual(calls.responder, []);
  assert.deepEqual(calls.group, []);
  assert.deepEqual(calls.fellowConversation, []);
});

test("invokeFellow is limited to desktop-local adapters in the main process", async () => {
  const { dispatcher, calls } = setup();

  const skipped = await dispatcher.invokeFellow({
    conversationId: "g_1",
    fellowId: "codex",
    dedupKey: "m_1:codex",
    runtimeKind: "cloud-hermes",
    systemPrompt: "system",
    userPrompt: "hi"
  });

  assert.equal(skipped, false);
  assert.equal(calls.responder.length, 0);
});
