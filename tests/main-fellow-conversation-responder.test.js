const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createMainFellowConversationResponder } = require("../src/main/social/fellow-conversation-responder.js");

function setup(overrides = {}) {
  const calls = { respond: [], conversationDetails: [], recent: [], runtime: [], log: [] };
  const responder = createMainFellowConversationResponder({
    getCurrentUserId: () => "u_1",
    getConversationDetails: async (conversationId) => {
      calls.conversationDetails.push(conversationId);
      return {
        conversation: { id: conversationId, type: "fellow", decorations: { fellowKey: "alice" } },
        members: [
          { member_kind: "user", member_ref: "u_1" },
          { member_kind: "fellow", member_ref: "alice", owner_id: "u_1" }
        ]
      };
    },
    listRecentMessages: async (conversationId, sinceSeq, limit) => {
      calls.recent.push({ conversationId, sinceSeq, limit });
      return [
        { id: "m_0", seq: 1, sender_kind: "user", sender_ref: "u_1", body_md: "前文" },
        { id: "m_1", seq: 2, sender_kind: "user", sender_ref: "u_1", body_md: "你好" }
      ];
    },
    getFellowRuntime: async (fellowId, runtimeKind) => {
      calls.runtime.push({ fellowId, runtimeKind });
      return null;
    },
    responder: {
      respond: async (args) => {
        calls.respond.push(args);
        return true;
      }
    },
    log: (line) => calls.log.push(line),
    ...overrides
  });
  return { responder, calls };
}

test("handles user messages in owned fellow conversations", async () => {
  const { responder, calls } = setup();

  await responder.handleConversationMessageAppended({
    conversationId: "fellow:u_1:alice",
    message: { id: "m_1", seq: 2, sender_kind: "user", sender_ref: "u_1", body_md: "你好" }
  });

  assert.deepEqual(calls.conversationDetails, ["fellow:u_1:alice"]);
  assert.deepEqual(calls.recent, [{ conversationId: "fellow:u_1:alice", sinceSeq: 0, limit: 6 }]);
  assert.equal(calls.respond.length, 1);
  assert.equal(calls.respond[0].conversationId, "fellow:u_1:alice");
  assert.equal(calls.respond[0].fellowId, "alice");
  assert.equal(calls.respond[0].dedupKey, "m_1:alice");
  assert.equal(calls.respond[0].userPrompt, "你好");
  assert.match(calls.respond[0].systemPrompt, /前文/);
});

test("falls back to stable fellow conversation id suffix when details omit fellow metadata", async () => {
  const { responder, calls } = setup({
    getConversationDetails: async () => ({
      conversation: { id: "fellow:u_1:alice", type: "fellow" },
      members: []
    })
  });

  await responder.handleConversationMessageAppended({
    conversationId: "fellow:u_1:alice",
    message: { id: "m_1", seq: 2, sender_kind: "user", sender_ref: "u_1", body_md: "你好" }
  });

  assert.equal(calls.respond.length, 1);
  assert.equal(calls.respond[0].fellowId, "alice");
});

test("falls back to conversation list metadata when conversation details are too slow", async () => {
  const { responder, calls } = setup({
    getConversationDetails: async () => {
      throw new Error("The operation was aborted due to timeout");
    },
    listConversations: async () => ([
      {
        id: "fellow:u_1:session_1",
        type: "fellow",
        decorations: { fellowKey: "alice", runtimeKind: "desktop-local" }
      }
    ])
  });

  await responder.handleConversationMessageAppended({
    conversationId: "fellow:u_1:session_1",
    message: { id: "m_1", seq: 2, sender_kind: "user", sender_ref: "u_1", body_md: "你好" }
  });

  assert.equal(calls.respond.length, 1);
  assert.equal(calls.respond[0].fellowId, "alice");
  assert.match(calls.log.join("\n"), /get conversation failed/);
});

test("ignores non-user messages and unowned fellow conversations", async () => {
  const first = setup();
  await first.responder.handleConversationMessageAppended({
    conversationId: "fellow:u_1:alice",
    message: { id: "m_f", sender_kind: "fellow", sender_ref: "alice", body_md: "hi" }
  });
  assert.equal(first.calls.respond.length, 0);

  const second = setup({
    getConversationDetails: async () => ({
      conversation: { id: "fellow:u_2:alice", type: "fellow", decorations: { fellowKey: "alice" } },
      members: [
        { member_kind: "user", member_ref: "u_2" },
        { member_kind: "fellow", member_ref: "alice", owner_id: "u_2" }
      ]
    })
  });
  await second.responder.handleConversationMessageAppended({
    conversationId: "fellow:u_2:alice",
    message: { id: "m_1", sender_kind: "user", sender_ref: "u_1", body_md: "你好" }
  });
  assert.equal(second.calls.respond.length, 0);
});

test("dedups repeated message events", async () => {
  const { responder, calls } = setup();
  const payload = {
    conversationId: "fellow:u_1:alice",
    message: { id: "m_1", seq: 2, sender_kind: "user", sender_ref: "u_1", body_md: "你好" }
  };

  await responder.handleConversationMessageAppended(payload);
  await responder.handleConversationMessageAppended(payload);

  assert.equal(calls.respond.length, 1);
});

test("retries repeated message events until responder succeeds", async () => {
  const { responder, calls } = setup({
    responder: {
      respond: async (args) => {
        calls.respond.push(args);
        return calls.respond.length > 1;
      }
    }
  });
  const payload = {
    conversationId: "fellow:u_1:alice",
    message: { id: "m_1", seq: 2, sender_kind: "user", sender_ref: "u_1", body_md: "你好" }
  };

  await responder.handleConversationMessageAppended(payload);
  await responder.handleConversationMessageAppended(payload);
  await responder.handleConversationMessageAppended(payload);

  assert.equal(calls.respond.length, 2);
});

test("passes desktop-local runtime binding config to the local responder", async () => {
  const { responder, calls } = setup({
    getFellowRuntime: async (fellowId, runtimeKind) => {
      calls.runtime.push({ fellowId, runtimeKind });
      return {
        fellowId,
        runtimeKind,
        enabled: true,
        config: {
          model: "mia-pro",
          effortLevel: "high",
          permissionMode: "auto"
        }
      };
    }
  });

  await responder.handleConversationMessageAppended({
    conversationId: "fellow:u_1:alice",
    message: { id: "m_1", seq: 2, sender_kind: "user", sender_ref: "u_1", body_md: "你好" }
  });

  assert.deepEqual(calls.runtime, [{ fellowId: "alice", runtimeKind: "desktop-local" }]);
  assert.equal(calls.respond.length, 1);
  assert.deepEqual(calls.respond[0].runtimeConfig, {
    model: "mia-pro",
    effortLevel: "high",
    permissionMode: "auto"
  });
});

test("skips cloud runtime fellow conversations", async () => {
  const { responder, calls } = setup({
    getConversationDetails: async () => ({
      conversation: { id: "fellow:u_1:alice", type: "fellow", decorations: { fellowKey: "alice", runtimeKind: "cloud-hermes" } },
      members: [
        { member_kind: "user", member_ref: "u_1" },
        { member_kind: "fellow", member_ref: "alice", owner_id: "u_1" }
      ]
    })
  });

  await responder.handleConversationMessageAppended({
    conversationId: "fellow:u_1:alice",
    message: { id: "m_1", seq: 2, sender_kind: "user", sender_ref: "u_1", body_md: "你好" }
  });

  assert.equal(calls.respond.length, 0);
});
