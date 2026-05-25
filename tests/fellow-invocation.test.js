const { test } = require("node:test");
const assert = require("node:assert/strict");

const { buildInvocation } = require("../src/main/social/fellow-invocation.js");

test("buildInvocation turns an explicit @ event into responder args", () => {
  const args = buildInvocation({
    type: "room.fellow_invocation_requested",
    roomId: "g_1",
    fellowId: "codex",
    invokedBy: { username: "alice" },
    triggeringMessage: {
      id: "m_1",
      turn_id: "turn_1",
      sender_kind: "user",
      sender_ref: "u_alice",
      body_md: "@codex 看看这个"
    },
    recentMessages: [
      { sender_kind: "user", sender_ref: "u_alice", body_md: "先看背景" },
      { sender_kind: "fellow", sender_ref: "codex", body_md: "收到" }
    ]
  }, [
    { key: "codex", name: "Codex" }
  ]);

  assert.equal(args.roomId, "g_1");
  assert.equal(args.fellowId, "codex");
  assert.equal(args.dedupKey, "m_1:codex");
  assert.equal(args.userPrompt, "@codex 看看这个");
  assert.equal(args.turnId, "turn_1");
  assert.match(args.systemPrompt, /你是 Codex/);
  assert.match(args.systemPrompt, /alice/);
  assert.match(args.systemPrompt, /\[user:u_alice\] 先看背景/);
  assert.match(args.systemPrompt, /\[fellow:codex\] 收到/);
});

test("buildInvocation returns null for missing trigger, room, fellow, or local fellow", () => {
  const fellows = [{ key: "codex", name: "Codex" }];
  const base = {
    roomId: "g_1",
    fellowId: "codex",
    triggeringMessage: { id: "m_1", body_md: "hi" }
  };

  assert.equal(buildInvocation({ ...base, triggeringMessage: null }, fellows), null);
  assert.equal(buildInvocation({ ...base, roomId: "" }, fellows), null);
  assert.equal(buildInvocation({ ...base, fellowId: "" }, fellows), null);
  assert.equal(buildInvocation({ ...base, fellowId: "remote" }, fellows), null);
});
