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

test("createTasksStore: create succeeds without originMessageId (optional metadata)", () => {
  const store = createTasksStore(tmpFile());
  // Engines pass "" when the originating message has no id — must not block.
  const task = store.create({
    title: "remind", botId: "f1", conversationId: "botc_u1_f1",
    trigger: { type: "oneshot", at: "2026-05-25T21:04:45+08:00" },
    timezone: "Asia/Shanghai", prompt: "吃饭"
  });
  assert.ok(task.id.startsWith("t-"));
  assert.equal(task.originMessageId, "");
  assert.equal(task.conversationId, "botc_u1_f1");
  assert.equal(task.sessionId, "botc_u1_f1");
});

test("createTasksStore: botId and conversationId remain required", () => {
  const store = createTasksStore(tmpFile());
  assert.throws(() => store.create({
    title: "t", conversationId: "botc_u1_f", trigger: { type: "oneshot", at: "2026-05-25T21:04:45+08:00" },
    timezone: "UTC", prompt: "p"
  }), /botId is required/);
  assert.throws(() => store.create({
    title: "t", botId: "f", trigger: { type: "oneshot", at: "2026-05-25T21:04:45+08:00" },
    timezone: "UTC", prompt: "p"
  }), /conversationId is required/);
});

test("createTasksStore: create assigns id and persists", () => {
  const file = tmpFile();
  const store = createTasksStore(file);
  const task = store.create({
    title: "test",
    botId: "f1",
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

test("createTasksStore: drops persisted legacy fellowId-only tasks on load", () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    tasks: [
      {
        id: "legacy",
        title: "old",
        fellowId: "codex",
        conversationId: "botc_u1_codex",
        trigger: { type: "cron", cron: "0 9 * * *" },
        timezone: "UTC",
        prompt: "old",
        status: "active",
        runs: [],
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: "current",
        title: "new",
        botId: "mia",
        conversationId: "botc_u1_mia",
        sessionId: "botc_u1_mia",
        trigger: { type: "cron", cron: "0 9 * * *" },
        timezone: "UTC",
        prompt: "new",
        status: "active",
        runs: [],
        createdAt: 2,
        updatedAt: 2
      }
    ]
  }, null, 2));

  const store = createTasksStore(file);

  assert.deepEqual(store.list().map((task) => task.id), ["current"]);
  assert.equal(store.get("legacy"), null);
  const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(persisted.tasks.map((task) => task.id), ["current"]);
});

test("createTasksStore: rejects trigger.type=event in v1", () => {
  const store = createTasksStore(tmpFile());
  assert.throws(
    () => store.create({
      title: "t", botId: "f", sessionId: "s", originMessageId: "m",
      trigger: { type: "event", event: { source: "x", filter: null } },
      timezone: "UTC", prompt: "p"
    }),
    /event-triggered tasks are not supported in v1/
  );
});

test("createTasksStore: update merges partial and bumps updatedAt", async () => {
  const store = createTasksStore(tmpFile());
  const t = store.create({
    title: "a", botId: "f", sessionId: "s", originMessageId: "m",
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
    title: "a", botId: "f", sessionId: "s", originMessageId: "m",
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
    title: "a", botId: "f", sessionId: "s", originMessageId: "m",
    trigger: { type: "cron", cron: "0 9 * * *" }, timezone: "UTC", prompt: "p"
  });
  store.delete(t.id);
  assert.equal(store.list().length, 0);
});

test("createTasksStore: pause/resume toggles status", () => {
  const store = createTasksStore(tmpFile());
  const t = store.create({
    title: "a", botId: "f", sessionId: "s", originMessageId: "m",
    trigger: { type: "cron", cron: "0 9 * * *" }, timezone: "UTC", prompt: "p"
  });
  assert.equal(store.pause(t.id).status, "paused");
  assert.equal(store.resume(t.id).status, "active");
});

test("createTasksStore: rejects invalid cron expression", () => {
  const store = createTasksStore(tmpFile());
  assert.throws(() => store.create({
    title: "t", botId: "f", sessionId: "s", originMessageId: "m",
    trigger: { type: "cron", cron: "not a cron" }, timezone: "UTC", prompt: "p"
  }), /not a valid cron expression/);
});

test("createTasksStore: rejects invalid timezone", () => {
  const store = createTasksStore(tmpFile());
  assert.throws(() => store.create({
    title: "t", botId: "f", sessionId: "s", originMessageId: "m",
    trigger: { type: "cron", cron: "0 9 * * *" }, timezone: "Not/A_Zone", prompt: "p"
  }), /invalid timezone/);
});

test("createTasksStore: rejects invalid oneshot at", () => {
  const store = createTasksStore(tmpFile());
  assert.throws(() => store.create({
    title: "t", botId: "f", sessionId: "s", originMessageId: "m",
    trigger: { type: "oneshot", at: "tomorrow" }, timezone: "UTC", prompt: "p"
  }), /not a valid ISO-8601 timestamp/);
});

test("orphanByBot: pauses active tasks of that bot", () => {
  const store = createTasksStore(tmpFile());
  const t1 = store.create({
    title: "a", botId: "F1", sessionId: "s1", originMessageId: "m",
    trigger: { type: "cron", cron: "0 9 * * *" }, timezone: "UTC", prompt: "p"
  });
  const t2 = store.create({
    title: "b", botId: "F2", sessionId: "s2", originMessageId: "m",
    trigger: { type: "cron", cron: "0 9 * * *" }, timezone: "UTC", prompt: "p"
  });
  const changed = store.orphanByBot("F1");
  assert.equal(changed, 1);
  assert.equal(store.get(t1.id).status, "paused");
  assert.equal(store.get(t1.id).orphanReason, "bot_deleted");
  assert.equal(store.get(t2.id).status, "active");
});
