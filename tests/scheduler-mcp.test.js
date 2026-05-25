// tests/scheduler-mcp.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createTasksStore } = require("../src/main/tasks-store.js");
const { createTasksEventBus } = require("../src/main/tasks-events.js");
const { createSchedulerMcp } = require("../src/main/scheduler-mcp.js");

function setup() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mia-mcp-")), "tasks.json");
  const store = createTasksStore(file);
  const events = createTasksEventBus();
  const rescans = { count: 0 };
  const scheduler = { rescan: () => { rescans.count += 1; } };
  return { store, events, scheduler, rescans, mcp: createSchedulerMcp({ store, scheduler, events }) };
}

test("schedule.create persists + rescans", async () => {
  const c = setup();
  const result = await c.mcp.invoke("schedule.create", {
    title: "t", fellowId: "f", sessionId: "s", originMessageId: "m",
    trigger: { type: "cron", cron: "0 9 * * *" }, timezone: "UTC", prompt: "p"
  });
  assert.ok(result.taskId);
  assert.equal(c.store.list().length, 1);
  assert.equal(c.rescans.count, 1);
});

test("schedule.list returns tasks", async () => {
  const c = setup();
  c.store.create({
    title: "t", fellowId: "f", sessionId: "s", originMessageId: "m",
    trigger: { type: "cron", cron: "0 9 * * *" }, timezone: "UTC", prompt: "p"
  });
  const result = await c.mcp.invoke("schedule.list");
  assert.equal(result.tasks.length, 1);
});

test("unknown tool throws", async () => {
  const c = setup();
  await assert.rejects(() => c.mcp.invoke("schedule.nope"), /unknown tool/);
});
