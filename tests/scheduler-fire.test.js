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
    title: "x", fellowId: "f", sessionId: "s", originMessageId: "m",
    trigger: { type: "cron", cron: "0 9 * * *" }, timezone: "UTC", prompt: "do"
  });
  const calls = [];
  const runner = createFireRunner({
    store,
    runRemoteChatRequest: async (body) => {
      calls.push(body);
      return {
        fellow: { key: "f" },
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
    emit: () => {}
  });
  await runner.fire(store.get(t.id));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fellowKey, "f");
  assert.equal(calls[0].sessionId, "s");
  assert.equal(calls[0].text, "do");
  const after = store.get(t.id);
  assert.equal(after.runs.length, 1);
  assert.equal(after.runs[0].status, "ok");
  assert.equal(after.runs[0].outputMessageId, "msg-mock");
});

test("createFireRunner.fire: error path records run with status=failed", async () => {
  const store = tmpStore();
  const t = store.create({
    title: "x", fellowId: "f", sessionId: "s", originMessageId: "m",
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
    title: "x", fellowId: "f", sessionId: "s", originMessageId: "m",
    trigger: { type: "cron", cron: "0 9 * * *" }, timezone: "UTC", prompt: "do"
  });
  const events = [];
  const runner = createFireRunner({
    store,
    runRemoteChatRequest: async () => ({
      fellow: { key: "f" },
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
    title: "x", fellowId: "f", sessionId: "s", originMessageId: "m",
    trigger: { type: "cron", cron: "0 9 * * *" }, timezone: "UTC", prompt: "do"
  });
  const events = [];
  const runner = createFireRunner({
    store,
    runRemoteChatRequest: async () => {
      // Simulate task being deleted during the chat call
      store.delete(t.id);
      return {
        fellow: { key: "f" },
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
