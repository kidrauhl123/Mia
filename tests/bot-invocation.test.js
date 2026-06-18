const { test } = require("node:test");
const assert = require("node:assert/strict");

const { buildBotInvocation } = require("../src/main/social/bot-invocation.js");

test("buildBotInvocation turns an explicit @ event into responder args", () => {
  const args = buildBotInvocation({
    type: "conversation.bot_invocation_requested",
    conversationId: "g_1",
    botId: "codex",
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
      { sender_kind: "bot", sender_ref: "codex", body_md: "收到" }
    ]
  }, [
    { key: "codex", name: "Codex" }
  ]);

  assert.equal(args.conversationId, "g_1");
  assert.equal(args.botId, "codex");
  assert.equal(args.botSnapshot.key, "codex");
  assert.equal(args.dedupKey, "m_1:codex");
  assert.equal(args.userPrompt, "@codex 看看这个");
  assert.equal(args.turnId, "turn_1");
  assert.match(args.systemPrompt, /你是 Codex/);
  assert.deepEqual(args.historyMessages, [
    { role: "user", content: "[user:u_alice] 先看背景" },
    { role: "assistant", content: "[bot:codex] 收到" }
  ]);
});

test("buildBotInvocation treats bot conversations as private chats", () => {
  const args = buildBotInvocation({
    type: "conversation.bot_invocation_requested",
    conversationId: "botc_review",
    conversationType: "bot",
    botId: "reviewer",
    triggeringMessage: {
      id: "m_1",
      sender_kind: "user",
      sender_ref: "u_alice",
      body_md: "你好"
    },
    members: [
      { member_kind: "user", member_ref: "u_alice", username: "alice" },
      { member_kind: "bot", member_ref: "reviewer", bot_name: "Reviewer" }
    ],
    recentMessages: [
      { id: "m_prev_user", sender_kind: "user", sender_ref: "u_alice", body_md: "前面我问过开题" },
      { id: "m_prev_bot", sender_kind: "bot", sender_ref: "reviewer", body_md: "我建议先列提纲" },
      { id: "m_1", sender_kind: "user", sender_ref: "u_alice", body_md: "你好" }
    ]
  }, []);

  assert.equal(args.conversationType, "bot");
  assert.match(args.systemPrompt, /正在和用户私聊/);
  assert.doesNotMatch(args.systemPrompt, /群聊/);
  assert.doesNotMatch(args.systemPrompt, /群成员/);
  assert.deepEqual(args.historyMessages, [
    { role: "user", content: "前面我问过开题" },
    { role: "assistant", content: "我建议先列提纲" }
  ]);
});

test("buildBotInvocation uses internal scheduled task prompts without visible user message text", () => {
  const args = buildBotInvocation({
    type: "conversation.bot_invocation_requested",
    conversationId: "botc_review",
    conversationType: "bot",
    botId: "reviewer",
    triggeringMessage: {
      id: "task:t-1:r-1",
      turn_id: "task:t-1:r-1",
      sender_kind: "system",
      sender_ref: "mia.scheduler",
      body_md: "",
      task_prompt: "提醒我吃饭"
    },
    members: [
      { member_kind: "user", member_ref: "u_alice", username: "alice" },
      { member_kind: "bot", member_ref: "reviewer", bot_name: "Reviewer" }
    ],
    recentMessages: [
      { id: "m_prev_user", sender_kind: "user", sender_ref: "u_alice", body_md: "前面我问过开题" }
    ]
  }, []);

  assert.equal(args.userPrompt, "提醒我吃饭");
  assert.equal(args.triggerMessageId, "task:t-1:r-1");
  assert.equal(args.turnId, "task:t-1:r-1");
  assert.deepEqual(args.historyMessages, [
    { role: "user", content: "前面我问过开题" }
  ]);
});

test("buildBotInvocation returns null for missing trigger, conversation, or bot id", () => {
  const bots = [{ key: "codex", name: "Codex" }];
  const base = {
    conversationId: "g_1",
    botId: "codex",
    triggeringMessage: { id: "m_1", body_md: "hi" }
  };

  assert.equal(buildBotInvocation({ ...base, triggeringMessage: null }, bots), null);
  assert.equal(buildBotInvocation({ ...base, conversationId: "" }, bots), null);
  assert.equal(buildBotInvocation({ ...base, botId: "" }, bots), null);
});

test("buildBotInvocation keeps cloud-only bots runnable without a local manifest entry", () => {
  const args = buildBotInvocation({
    conversationId: "botc_remote",
    botId: "remote",
    runtimeConfig: { agentEngine: "codex" },
    triggeringMessage: { id: "m_1", body_md: "hi" },
    members: [{ member_kind: "bot", member_ref: "remote", bot_name: "Remote Bot" }]
  }, []);

  assert.equal(args.botId, "remote");
  assert.equal(args.botSnapshot.key, "remote");
  assert.equal(args.botSnapshot.name, "Remote Bot");
  assert.equal(args.botSnapshot.agentEngine, "codex");
  assert.match(args.systemPrompt, /Remote Bot/);
});

test("buildBotInvocation preserves local manifest agent engine for desktop bots", () => {
  const args = buildBotInvocation({
    conversationId: "botc_win",
    botId: "win",
    triggeringMessage: { id: "m_1", body_md: "hi" },
    members: [{ member_kind: "bot", member_ref: "win", bot_name: "Windows Bot" }]
  }, [
    { key: "win", name: "Windows Bot", agentEngine: "codex", engineConfig: { effortLevel: "medium" } }
  ]);

  assert.equal(args.botSnapshot.key, "win");
  assert.equal(args.botSnapshot.agentEngine, "codex");
  assert.deepEqual(args.botSnapshot.engineConfig, { effortLevel: "medium" });
});

test("buildBotInvocation lets local manifest engine override stale Hermes runtime config", () => {
  const args = buildBotInvocation({
    conversationId: "botc_win",
    botId: "win",
    runtimeConfig: { agentEngine: "hermes", permissionMode: "ask" },
    triggeringMessage: { id: "m_1", body_md: "hi" }
  }, [
    { key: "win", name: "Windows Bot", agentEngine: "codex" }
  ]);

  assert.equal(args.botSnapshot.agentEngine, "codex");
  assert.deepEqual(args.runtimeConfig, {
    agentEngine: "codex",
    permissionMode: "ask"
  });
});
