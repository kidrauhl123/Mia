const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createMainFellowRoomResponder } = require("../src/main/social/fellow-room-responder.js");

function setup(overrides = {}) {
  const calls = { respond: [], roomDetails: [], recent: [], log: [] };
  const responder = createMainFellowRoomResponder({
    getCurrentUserId: () => "u_1",
    getRoomDetails: async (roomId) => {
      calls.roomDetails.push(roomId);
      return {
        room: { id: roomId, type: "fellow", decorations: { fellowKey: "alice" } },
        members: [
          { member_kind: "user", member_ref: "u_1" },
          { member_kind: "fellow", member_ref: "alice", owner_id: "u_1" }
        ]
      };
    },
    listRecentMessages: async (roomId, sinceSeq, limit) => {
      calls.recent.push({ roomId, sinceSeq, limit });
      return [
        { id: "m_0", seq: 1, sender_kind: "user", sender_ref: "u_1", body_md: "前文" },
        { id: "m_1", seq: 2, sender_kind: "user", sender_ref: "u_1", body_md: "你好" }
      ];
    },
    responder: {
      respond: async (args) => calls.respond.push(args)
    },
    log: (line) => calls.log.push(line),
    ...overrides
  });
  return { responder, calls };
}

test("handles user messages in owned fellow rooms", async () => {
  const { responder, calls } = setup();

  await responder.handleRoomMessageAppended({
    roomId: "fellow:u_1:alice",
    message: { id: "m_1", seq: 2, sender_kind: "user", sender_ref: "u_1", body_md: "你好" }
  });

  assert.deepEqual(calls.roomDetails, ["fellow:u_1:alice"]);
  assert.deepEqual(calls.recent, [{ roomId: "fellow:u_1:alice", sinceSeq: 0, limit: 6 }]);
  assert.equal(calls.respond.length, 1);
  assert.equal(calls.respond[0].roomId, "fellow:u_1:alice");
  assert.equal(calls.respond[0].fellowId, "alice");
  assert.equal(calls.respond[0].dedupKey, "m_1:alice");
  assert.equal(calls.respond[0].userPrompt, "你好");
  assert.match(calls.respond[0].systemPrompt, /前文/);
});

test("ignores non-user messages and unowned fellow rooms", async () => {
  const first = setup();
  await first.responder.handleRoomMessageAppended({
    roomId: "fellow:u_1:alice",
    message: { id: "m_f", sender_kind: "fellow", sender_ref: "alice", body_md: "hi" }
  });
  assert.equal(first.calls.respond.length, 0);

  const second = setup({
    getRoomDetails: async () => ({
      room: { id: "fellow:u_2:alice", type: "fellow", decorations: { fellowKey: "alice" } },
      members: [
        { member_kind: "user", member_ref: "u_2" },
        { member_kind: "fellow", member_ref: "alice", owner_id: "u_2" }
      ]
    })
  });
  await second.responder.handleRoomMessageAppended({
    roomId: "fellow:u_2:alice",
    message: { id: "m_1", sender_kind: "user", sender_ref: "u_1", body_md: "你好" }
  });
  assert.equal(second.calls.respond.length, 0);
});

test("dedups repeated message events", async () => {
  const { responder, calls } = setup();
  const payload = {
    roomId: "fellow:u_1:alice",
    message: { id: "m_1", seq: 2, sender_kind: "user", sender_ref: "u_1", body_md: "你好" }
  };

  await responder.handleRoomMessageAppended(payload);
  await responder.handleRoomMessageAppended(payload);

  assert.equal(calls.respond.length, 1);
});
