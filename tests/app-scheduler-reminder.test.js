const { test } = require("node:test");
const assert = require("node:assert/strict");
const { chatCompletionResponse } = require("../src/main/chat-response.js");
const {
  createScheduledReminderFromTurn,
  handleReminderChatTurn
} = require("../src/main/app-scheduler-reminder.js");

const nowMs = Date.parse("2026-06-18T05:26:00.000Z");

test("createScheduledReminderFromTurn creates a Mia task input from the last user reminder", async () => {
  const calls = [];
  const result = await createScheduledReminderFromTurn({
    messages: [
      { role: "system", content: "sys" },
      { role: "user", id: "m1", content: "普通聊天" },
      { role: "assistant", content: "ok" },
      { role: "user", id: "m2", content: "1分钟后提醒我睡觉" }
    ],
    botId: "6859845",
    sessionId: "botc_7d852259-ed51-47c5-a84f-2f3e1987ad72",
    createScheduledTask: async (input) => {
      calls.push(input);
      return { id: "t_1", ...input, nextFireAt: new Date(input.trigger.at).getTime() };
    },
    nowMs: () => nowMs
  });

  assert.equal(result.intent.content, "睡觉");
  assert.deepEqual(calls, [{
    title: "提醒：睡觉",
    botId: "6859845",
    conversationId: "botc_7d852259-ed51-47c5-a84f-2f3e1987ad72",
    sessionId: "botc_7d852259-ed51-47c5-a84f-2f3e1987ad72",
    originMessageId: "m2",
    trigger: { type: "oneshot", at: "2026-06-18T05:27:00.000Z" },
    timezone: "Asia/Shanghai",
    prompt: "请在 Mia 会话里提醒用户：睡觉"
  }]);
});

test("handleReminderChatTurn returns a chat response without calling the engine", async () => {
  const emitted = [];
  const result = await handleReminderChatTurn({
    messages: [{ role: "user", id: "m2", content: "1分钟后提醒我睡觉" }],
    bot: { key: "6859845" },
    sessionId: "botc_7d852259-ed51-47c5-a84f-2f3e1987ad72",
    model: "hermes-agent",
    chatCompletionResponse,
    createScheduledTask: async (input) => ({ id: "t_1", ...input }),
    emit: (kind, data) => emitted.push({ kind, data }),
    nowMs: () => nowMs
  });

  assert.match(result.choices[0].message.content, /1 分钟后/);
  assert.match(result.choices[0].message.content, /睡觉/);
  assert.equal(result.mia.transport, "app-scheduler");
  assert.equal(result.mia.task_id, "t_1");
  assert.deepEqual(emitted.map((item) => item.kind), ["tool_call_started", "tool_call_completed", "complete"]);
  assert.equal(emitted[0].data.name, "schedule_create");
  assert.equal(emitted[1].data.name, "schedule_create");
});

test("handleReminderChatTurn does not recreate tasks while a scheduled task is firing", async () => {
  const calls = [];
  const result = await handleReminderChatTurn({
    messages: [{ role: "user", id: "m2", content: "1分钟后提醒我睡觉" }],
    bot: { key: "6859845" },
    sessionId: "botc_7d852259-ed51-47c5-a84f-2f3e1987ad72",
    scheduledFire: true,
    chatCompletionResponse,
    createScheduledTask: async (input) => {
      calls.push(input);
      return { id: "t_1" };
    },
    nowMs: () => nowMs
  });

  assert.equal(result, null);
  assert.deepEqual(calls, []);
});

test("handleReminderChatTurn returns a visible failure response when task creation fails", async () => {
  const emitted = [];
  const result = await handleReminderChatTurn({
    messages: [{ role: "user", id: "m2", content: "1分钟后提醒我睡觉" }],
    bot: { key: "6859845" },
    sessionId: "botc_7d852259-ed51-47c5-a84f-2f3e1987ad72",
    model: "hermes-agent",
    chatCompletionResponse,
    createScheduledTask: async () => {
      throw new Error("scheduler down");
    },
    emit: (kind, data) => emitted.push({ kind, data }),
    nowMs: () => nowMs
  });

  assert.match(result.choices[0].message.content, /没能创建这个提醒/);
  assert.equal(result.mia.transport, "app-scheduler");
  assert.equal(result.mia.error, true);
  assert.equal(emitted.at(-2).kind, "tool_call_completed");
  assert.equal(emitted.at(-2).data.error, true);
  assert.equal(emitted.at(-1).kind, "complete");
});
