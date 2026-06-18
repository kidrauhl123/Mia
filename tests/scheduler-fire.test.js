// tests/scheduler-fire.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createTasksStore } = require("../src/main/tasks-store.js");
const { createFireRunner } = require("../src/main/scheduler-fire.js");

function tmpStore() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mia-fire-")), "tasks.json");
  return createTasksStore(file);
}

test("createFireRunner.fire: ok path records run with outputMessageId", async () => {
  const store = tmpStore();
  const t = store.create({
    title: "x", botId: "f", sessionId: "conversation:botc_u1_f", originMessageId: "m",
    trigger: { type: "cron", cron: "0 9 * * *" }, timezone: "UTC", prompt: "do"
  });
  const calls = [];
  const emits = [];
  const runner = createFireRunner({
    store,
    runRemoteChatRequest: async (body) => {
      calls.push(body);
      return {
        bot: { key: "f" },
        session: {
          id: "s",
          messages: [
            { role: "user", content: "do", createdAt: "2026-05-20T09:00:00Z" },
            { role: "assistant", content: "done", createdAt: "2026-05-20T09:00:01Z", meta: { taskId: t.id, taskRunId: "r-fixed" } }
          ]
        },
        response: { id: "msg-final" },
        assistantMessageId: "msg-mock"
      };
    },
    emit: (type, payload) => emits.push({ type, payload })
  });
  await runner.fire(store.get(t.id));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].botKey, "f");
  assert.equal(calls[0].botId, "f");
  assert.equal(calls[0].conversationId, "botc_u1_f");
  assert.equal(calls[0].agentSessionId, "conversation:botc_u1_f");
  assert.equal(calls[0].sessionId, undefined);
  assert.equal(calls[0].text, "do");
  // Task runs go through the independent (background) abort path.
  assert.equal(calls[0].background, true);
  const after = store.get(t.id);
  assert.equal(after.runs.length, 1);
  assert.equal(after.runs[0].status, "ok");
  assert.equal(after.runs[0].outputMessageId, "msg-mock");
  // Reply text is copied onto the run so it survives chat-session write races.
  assert.equal(after.runs[0].outputText, "done");
  // The finished event carries the reply so the desktop can merge it into the
  // executor's conversation (delivery-by-event, not direct cross-process write).
  const finished = emits.find((e) => e.type === "finished");
  assert.equal(finished.payload.botId, "f");
  assert.equal(finished.payload.outputText, "done");
  assert.equal(finished.payload.createdAt, "2026-05-20T09:00:01Z");
});

test("createFireRunner.fire suppresses the task prompt as a visible user message", async () => {
  const store = tmpStore();
  const t = store.create({
    title: "提醒：睡觉",
    botId: "f",
    sessionId: "conversation:botc_u1_f",
    originMessageId: "m",
    trigger: { type: "oneshot", at: new Date(Date.now() + 60_000).toISOString() },
    timezone: "Asia/Shanghai",
    prompt: "请在 Mia 会话里提醒用户：睡觉"
  });
  const calls = [];
  const runner = createFireRunner({
    store,
    runRemoteChatRequest: async (body) => {
      calls.push(body);
      return {
        bot: { key: "f" },
        session: { id: "s", messages: [{ role: "assistant", content: "该睡觉了", id: "msg-1" }] },
        response: { id: "msg-1" },
        assistantMessageId: "msg-1"
      };
    },
    emit: () => {}
  });

  await runner.fire(store.get(t.id));

  assert.equal(calls[0].text, "请在 Mia 会话里提醒用户：睡觉");
  assert.equal(calls[0].suppressUserMessage, true);
});

test("createFireRunner.fire directly delivers reminder text without remote chat", async () => {
  const store = tmpStore();
  const t = store.create({
    title: "发布新版本提醒",
    botId: "f",
    sessionId: "conversation:botc_u1_f",
    originMessageId: "m",
    trigger: { type: "oneshot", at: new Date(Date.now() + 60_000).toISOString() },
    timezone: "Asia/Shanghai",
    prompt: "提醒我发布新版本",
    fireMode: "deliver",
    deliveryText: "该发布新版本了"
  });
  const calls = [];
  const deliveries = [];
  const emits = [];
  const runner = createFireRunner({
    store,
    runRemoteChatRequest: async (body) => {
      calls.push(body);
      throw new Error("remote chat should not run");
    },
    deliverTaskMessage: async (payload) => {
      deliveries.push(payload);
      return { messageId: "msg-direct" };
    },
    emit: (type, payload) => emits.push({ type, payload })
  });

  await runner.fire(store.get(t.id));

  assert.equal(calls.length, 0);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].task.id, t.id);
  assert.equal(deliveries[0].text, "该发布新版本了");
  const after = store.get(t.id);
  assert.equal(after.runs.length, 1);
  assert.equal(after.runs[0].status, "ok");
  assert.equal(after.runs[0].outputMessageId, "msg-direct");
  assert.equal(after.runs[0].outputText, "该发布新版本了");
  const finished = emits.find((event) => event.type === "finished");
  assert.equal(finished.payload.messageId, "msg-direct");
  assert.equal(finished.payload.outputText, "该发布新版本了");
});

test("createFireRunner.fire: error path records run with status=failed", async () => {
  const store = tmpStore();
  const t = store.create({
    title: "x", botId: "f", conversationId: "botc_u1_f", originMessageId: "m",
    trigger: { type: "cron", cron: "0 9 * * *" }, timezone: "UTC", prompt: "do"
  });
  const runner = createFireRunner({
    store,
    runRemoteChatRequest: async () => { throw new Error("engine down"); },
    emit: () => {}
  });
  await runner.fire(store.get(t.id));
  const after = store.get(t.id);
  assert.equal(after.runs[0].status, "failed");
  assert.match(after.runs[0].error, /engine down/);
});

test("createFireRunner.fire: emits lifecycle events", async () => {
  const store = tmpStore();
  const t = store.create({
    title: "x", botId: "f", conversationId: "botc_u1_f", originMessageId: "m",
    trigger: { type: "cron", cron: "0 9 * * *" }, timezone: "UTC", prompt: "do"
  });
  const events = [];
  const runner = createFireRunner({
    store,
    runRemoteChatRequest: async () => ({
      bot: { key: "f" },
      session: { id: "s", messages: [{ role: "assistant", content: "x" }] },
      response: { id: "msg" }
    }),
    emit: (type, payload) => events.push({ type, payload })
  });
  await runner.fire(store.get(t.id));
  const types = events.map((e) => e.type);
  assert.ok(types.includes("started"));
  assert.ok(types.includes("finished"));
});

test("createFireRunner.fire: tolerates task deletion during run", async () => {
  const store = tmpStore();
  const t = store.create({
    title: "x", botId: "f", conversationId: "botc_u1_f", originMessageId: "m",
    trigger: { type: "cron", cron: "0 9 * * *" }, timezone: "UTC", prompt: "do"
  });
  const events = [];
  const runner = createFireRunner({
    store,
    runRemoteChatRequest: async () => {
      // Simulate task being deleted during the chat call
      store.delete(t.id);
      return {
        bot: { key: "f" },
        session: { id: "s", messages: [{ role: "assistant", content: "x", id: "msg-1" }] },
        response: { id: "msg-1" },
        assistantMessageId: "msg-1"
      };
    },
    emit: (type, payload) => events.push({ type, payload })
  });
  // Should not throw
  await runner.fire({ ...t });
  assert.ok(events.some((e) => e.type === "started"));
  assert.ok(events.some((e) => e.type === "finished"));
});
