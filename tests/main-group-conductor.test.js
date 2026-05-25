const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createMainGroupConductor } = require("../src/main/social/group-conductor.js");

function setup(overrides = {}) {
  const calls = { dispatch: [], respond: [], roomDetails: [], recent: [], log: [] };
  const members = [
    { member_kind: "user", member_ref: "u_me", username: "me" },
    { member_kind: "fellow", member_ref: "codex", owner_id: "u_me", fellow_name: "Codex" },
    { member_kind: "fellow", member_ref: "remote", owner_id: "u_remote", fellow_name: "Remote" }
  ];
  const conductor = createMainGroupConductor({
    getCurrentUserId: () => "u_me",
    listFellows: () => [{ key: "codex", name: "Codex" }],
    loadPrompts: async () => ({
      dispatch: [
        "members:",
        "{{members}}",
        "summary: {{summary}}",
        "recent:",
        "{{recent}}",
        "user: {{userMessage}}"
      ].join("\n")
    }),
    getRoomDetails: async (roomId) => {
      calls.roomDetails.push(roomId);
      return {
        room: {
          id: roomId,
          type: "group",
          decorations: { responseMode: "conductor" },
          contextCard: { summary: "ship the feature" }
        },
        members
      };
    },
    listRecentMessages: async (roomId, sinceSeq, limit) => {
      calls.recent.push({ roomId, sinceSeq, limit });
      return [
        { id: "m_0", seq: 1, sender_kind: "user", sender_ref: "u_me", sender_username: "me", body_md: "背景" },
        { id: "m_1", seq: 2, sender_kind: "user", sender_ref: "u_me", sender_username: "me", body_md: "大家怎么看" }
      ];
    },
    sendChatStateless: async (args) => {
      calls.dispatch.push(args);
      return { content: JSON.stringify({ speak: ["codex", "remote", "missing"] }) };
    },
    responder: {
      respond: async (args) => calls.respond.push(args)
    },
    log: (line) => calls.log.push(line),
    ...overrides
  });
  return { conductor, calls };
}

const userMessage = {
  id: "m_1",
  seq: 2,
  sender_kind: "user",
  sender_ref: "u_me",
  sender_username: "me",
  body_md: "大家怎么看"
};

test("handleRoomMessageAppended dispatches and invokes only owned chosen fellows", async () => {
  const { conductor, calls } = setup();

  await conductor.handleRoomMessageAppended({ roomId: "g_1", message: userMessage });

  assert.equal(calls.dispatch.length, 1);
  assert.equal(calls.dispatch[0].fellowKey, "codex");
  assert.match(calls.dispatch[0].userPrompt, /ship the feature/);
  assert.match(calls.dispatch[0].userPrompt, /Codex/);
  assert.match(calls.dispatch[0].userPrompt, /大家怎么看/);
  assert.deepEqual(calls.recent, [{ roomId: "g_1", sinceSeq: 0, limit: 6 }]);
  assert.equal(calls.respond.length, 1);
  assert.equal(calls.respond[0].roomId, "g_1");
  assert.equal(calls.respond[0].fellowId, "codex");
  assert.equal(calls.respond[0].dedupKey, "m_1:codex");
  assert.equal(calls.respond[0].userPrompt, "大家怎么看");
  assert.match(calls.respond[0].systemPrompt, /你是 Codex/);
});

test("handleRoomMessageAppended skips explicit mentions from mentions_json", async () => {
  const { conductor, calls } = setup();

  await conductor.handleRoomMessageAppended({
    roomId: "g_1",
    message: {
      ...userMessage,
      mentions_json: JSON.stringify([{ kind: "fellow", fellowId: "codex" }])
    }
  });

  assert.equal(calls.dispatch.length, 0);
  assert.equal(calls.respond.length, 0);
});

test("handleRoomMessageAppended treats mentions and mentions_json as one mention source", async () => {
  const { conductor, calls } = setup();

  await conductor.handleRoomMessageAppended({
    roomId: "g_1",
    message: {
      ...userMessage,
      mentions: [],
      mentions_json: JSON.stringify([{ kind: "fellow", fellowId: "codex" }])
    }
  });

  assert.equal(calls.dispatch.length, 0);
  assert.equal(calls.respond.length, 0);
});

test("handleRoomMessageAppended skips when the conductor host fellow is remote-owned", async () => {
  const { conductor, calls } = setup({
    getRoomDetails: async (roomId) => ({
      room: {
        id: roomId,
        type: "group",
        decorations: {
          responseMode: "conductor",
          hostMember: { kind: "fellow", fellowId: "remote" }
        }
      },
      members: [
        { member_kind: "fellow", member_ref: "codex", owner_id: "u_me", fellow_name: "Codex" },
        { member_kind: "fellow", member_ref: "remote", owner_id: "u_remote", fellow_name: "Remote" }
      ]
    })
  });

  await conductor.handleRoomMessageAppended({ roomId: "g_1", message: userMessage });

  assert.equal(calls.dispatch.length, 0);
  assert.equal(calls.respond.length, 0);
});

test("handleRoomMessageAppended falls back to the host fellow when dispatch chooses nobody", async () => {
  const { conductor, calls } = setup({
    sendChatStateless: async (args) => {
      calls.dispatch.push(args);
      return { content: JSON.stringify({ speak: [] }) };
    }
  });

  await conductor.handleRoomMessageAppended({ roomId: "g_1", message: userMessage });

  assert.equal(calls.dispatch.length, 1);
  assert.equal(calls.respond.length, 1);
  assert.equal(calls.respond[0].fellowId, "codex");
});

test("handleRoomMessageAppended falls back to the host fellow when dispatch returns invalid JSON", async () => {
  const { conductor, calls } = setup({
    sendChatStateless: async (args) => {
      calls.dispatch.push(args);
      return { content: "我觉得 Codex 应该说话" };
    }
  });

  await conductor.handleRoomMessageAppended({ roomId: "g_1", message: userMessage });

  assert.equal(calls.dispatch.length, 1);
  assert.equal(calls.respond.length, 1);
  assert.equal(calls.respond[0].fellowId, "codex");
});

test("handleRoomMessageAppended skips dispatch when the group has one owned fellow", async () => {
  const { conductor, calls } = setup({
    getRoomDetails: async (roomId) => ({
      room: {
        id: roomId,
        type: "group",
        decorations: { responseMode: "conductor" }
      },
      members: [
        { member_kind: "user", member_ref: "u_me", username: "me" },
        { member_kind: "fellow", member_ref: "codex", owner_id: "u_me", fellow_name: "Codex" }
      ]
    })
  });

  await conductor.handleRoomMessageAppended({ roomId: "g_1", message: userMessage });

  assert.equal(calls.dispatch.length, 0);
  assert.equal(calls.respond.length, 1);
  assert.equal(calls.respond[0].fellowId, "codex");
});

test("handleRoomMessageAppended skips dispatch when the user text names an owned fellow", async () => {
  const { conductor, calls } = setup();

  await conductor.handleRoomMessageAppended({
    roomId: "g_1",
    message: { ...userMessage, id: "m_named", body_md: "Codex 说句话" }
  });

  assert.equal(calls.dispatch.length, 0);
  assert.equal(calls.respond.length, 1);
  assert.equal(calls.respond[0].fellowId, "codex");
});

test("handleRoomMessageAppended routes search requests to an owned Codex fellow", async () => {
  const members = [
    { member_kind: "user", member_ref: "u_me", username: "me" },
    { member_kind: "fellow", member_ref: "xiaoli", owner_id: "u_me", fellow_name: "小栗" },
    { member_kind: "fellow", member_ref: "alice", owner_id: "u_me", fellow_name: "爱丽丝" },
    { member_kind: "fellow", member_ref: "blackcat", owner_id: "u_me", fellow_name: "黑猫" }
  ];
  const { conductor, calls } = setup({
    listFellows: () => [
      { key: "xiaoli", name: "小栗", agentEngine: "claude-code" },
      { key: "alice", name: "爱丽丝", agentEngine: "claude-code" },
      { key: "blackcat", name: "黑猫", agentEngine: "codex" }
    ],
    getRoomDetails: async (roomId) => ({
      room: {
        id: roomId,
        type: "group",
        decorations: { responseMode: "conductor" }
      },
      members
    })
  });

  await conductor.handleRoomMessageAppended({
    roomId: "g_1",
    message: { ...userMessage, id: "m_search", body_md: "谁能搜，搜一下" }
  });

  assert.equal(calls.dispatch.length, 0);
  assert.equal(calls.respond.length, 1);
  assert.equal(calls.respond[0].fellowId, "blackcat");
});

test("handleRoomMessageAppended overrides a non-search-capable named fellow for latest-news requests", async () => {
  const members = [
    { member_kind: "user", member_ref: "u_me", username: "me" },
    { member_kind: "fellow", member_ref: "alice", owner_id: "u_me", fellow_name: "爱丽丝" },
    { member_kind: "fellow", member_ref: "blackcat", owner_id: "u_me", fellow_name: "黑猫" }
  ];
  const { conductor, calls } = setup({
    listFellows: () => [
      { key: "alice", name: "爱丽丝", agentEngine: "claude-code" },
      { key: "blackcat", name: "黑猫", agentEngine: "codex" }
    ],
    getRoomDetails: async (roomId) => ({
      room: {
        id: roomId,
        type: "group",
        decorations: { responseMode: "conductor" }
      },
      members
    })
  });

  await conductor.handleRoomMessageAppended({
    roomId: "g_1",
    message: { ...userMessage, id: "m_news", body_md: "爱丽丝你帮我找下AI领域最新新闻" }
  });

  assert.equal(calls.dispatch.length, 0);
  assert.equal(calls.respond.length, 1);
  assert.equal(calls.respond[0].fellowId, "blackcat");
});

test("handleRoomMessageAppended dedups by triggering message id", async () => {
  const { conductor, calls } = setup();

  await conductor.handleRoomMessageAppended({ roomId: "g_1", message: userMessage });
  await conductor.handleRoomMessageAppended({ roomId: "g_1", message: userMessage });

  assert.equal(calls.dispatch.length, 1);
  assert.equal(calls.respond.length, 1);
});
