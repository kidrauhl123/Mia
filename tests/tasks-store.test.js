// tests/tasks-store.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createTasksStore } = require("../src/main/tasks-store.js");

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mia-tasks-")), "tasks.json");
}

test("createTasksStore: empty file returns empty list", () => {
  const store = createTasksStore(tmpFile());
  assert.deepEqual(store.list(), []);
});

test("createTasksStore: create assigns id and persists", () => {
  const file = tmpFile();
  const store = createTasksStore(file);
  const task = store.create({
    title: "test",
    fellowId: "f1",
    sessionId: "s1",
    originMessageId: "m1",
    trigger: { type: "cron", cron: "0 9 * * *" },
    timezone: "Asia/Shanghai",
    prompt: "do it"
  });
  assert.ok(task.id.startsWith("t-"));
  assert.equal(task.status, "active");
  assert.equal(task.runs.length, 0);
  // re-open store, should persist
  const store2 = createTasksStore(file);
  assert.equal(store2.list().length, 1);
});

test("createTasksStore: rejects trigger.type=event in v1", () => {
  const store = createTasksStore(tmpFile());
  assert.throws(
    () => store.create({
      title: "t", fellowId: "f", sessionId: "s", originMessageId: "m",
      trigger: { type: "event", event: { source: "x", filter: null } },
      timezone: "UTC", prompt: "p"
    }),
    /event-triggered tasks are not supported in v1/
  );
});

test("createTasksStore: update merges partial and bumps updatedAt", async () => {
  const store = createTasksStore(tmpFile());
  const t = store.create({
    title: "a", fellowId: "f", sessionId: "s", originMessageId: "m",
    trigger: { type: "cron", cron: "0 9 * * *" }, timezone: "UTC", prompt: "p"
  });
  const oldUpdated = t.updatedAt;
  await new Promise((r) => setTimeout(r, 2));
  const updated = store.update(t.id, { title: "b", prompt: "q" });
  assert.equal(updated.title, "b");
  assert.equal(updated.prompt, "q");
  assert.equal(updated.trigger.cron, "0 9 * * *");
  assert.ok(updated.updatedAt > oldUpdated);
});

test("createTasksStore: recordRun appends to runs[]", () => {
  const store = createTasksStore(tmpFile());
  const t = store.create({
    title: "a", fellowId: "f", sessionId: "s", originMessageId: "m",
    trigger: { type: "cron", cron: "0 9 * * *" }, timezone: "UTC", prompt: "p"
  });
  store.recordRun(t.id, {
    firedAt: Date.now(), finishedAt: Date.now(), status: "ok",
    outputMessageId: "msg-1"
  });
  const got = store.get(t.id);
  assert.equal(got.runs.length, 1);
  assert.equal(got.runs[0].status, "ok");
});

test("createTasksStore: delete removes from list", () => {
  const store = createTasksStore(tmpFile());
  const t = store.create({
    title: "a", fellowId: "f", sessionId: "s", originMessageId: "m",
    trigger: { type: "cron", cron: "0 9 * * *" }, timezone: "UTC", prompt: "p"
  });
  store.delete(t.id);
  assert.equal(store.list().length, 0);
});

test("createTasksStore: pause/resume toggles status", () => {
  const store = createTasksStore(tmpFile());
  const t = store.create({
    title: "a", fellowId: "f", sessionId: "s", originMessageId: "m",
    trigger: { type: "cron", cron: "0 9 * * *" }, timezone: "UTC", prompt: "p"
  });
  assert.equal(store.pause(t.id).status, "paused");
  assert.equal(store.resume(t.id).status, "active");
});

test("createTasksStore: rejects invalid cron expression", () => {
  const store = createTasksStore(tmpFile());
  assert.throws(() => store.create({
    title: "t", fellowId: "f", sessionId: "s", originMessageId: "m",
    trigger: { type: "cron", cron: "not a cron" }, timezone: "UTC", prompt: "p"
  }), /not a valid cron expression/);
});

test("createTasksStore: rejects invalid timezone", () => {
  const store = createTasksStore(tmpFile());
  assert.throws(() => store.create({
    title: "t", fellowId: "f", sessionId: "s", originMessageId: "m",
    trigger: { type: "cron", cron: "0 9 * * *" }, timezone: "Not/A_Zone", prompt: "p"
  }), /invalid timezone/);
});

test("createTasksStore: rejects invalid oneshot at", () => {
  const store = createTasksStore(tmpFile());
  assert.throws(() => store.create({
    title: "t", fellowId: "f", sessionId: "s", originMessageId: "m",
    trigger: { type: "oneshot", at: "tomorrow" }, timezone: "UTC", prompt: "p"
  }), /not a valid ISO-8601 timestamp/);
});

test("orphanByFellow: pauses active tasks of that fellow", () => {
  const store = createTasksStore(tmpFile());
  const t1 = store.create({
    title: "a", fellowId: "F1", sessionId: "s1", originMessageId: "m",
    trigger: { type: "cron", cron: "0 9 * * *" }, timezone: "UTC", prompt: "p"
  });
  const t2 = store.create({
    title: "b", fellowId: "F2", sessionId: "s2", originMessageId: "m",
    trigger: { type: "cron", cron: "0 9 * * *" }, timezone: "UTC", prompt: "p"
  });
  const changed = store.orphanByFellow("F1");
  assert.equal(changed, 1);
  assert.equal(store.get(t1.id).status, "paused");
  assert.equal(store.get(t1.id).orphanReason, "fellow_deleted");
  assert.equal(store.get(t2.id).status, "active");
});
