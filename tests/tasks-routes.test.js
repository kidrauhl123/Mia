const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createTasksStore } = require("../src/main/tasks-store.js");
const { createTasksEventBus } = require("../src/main/tasks-events.js");
const { createTasksRoutes } = require("../src/main/tasks-routes.js");

function ctx() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mia-routes-")), "tasks.json");
  const store = createTasksStore(file);
  const events = createTasksEventBus();
  const fired = [];
  const routes = createTasksRoutes({
    store, events,
    runNow: async (id) => { fired.push(id); return { runId: "r-test" }; },
    onChange: () => {}
  });
  return { store, events, routes, fired };
}

function mkRes() {
  const chunks = [];
  let status = 0;
  let headers = null;
  return {
    statusCode: 0,
    writeHead(s, h) { status = s; headers = h; },
    setHeader() {},
    write(c) { chunks.push(c); },
    end(c) { if (c) chunks.push(c); },
    get status() { return status; },
    get headers() { return headers; },
    get body() { return chunks.join(""); }
  };
}

test("GET /api/tasks returns list", async () => {
  const c = ctx();
  c.store.create({
    title: "t", botId: "f", sessionId: "s", originMessageId: "m",
    trigger: { type: "cron", cron: "0 9 * * *" }, timezone: "UTC", prompt: "p"
  });
  const res = mkRes();
  await c.routes.handle({ method: "GET", url: "/api/tasks" }, res);
  const body = JSON.parse(res.body);
  assert.equal(body.tasks.length, 1);
});

test("POST /api/tasks creates and emits 'created'", async () => {
  const c = ctx();
  const events = [];
  c.events.subscribe((e) => events.push(e));
  const res = mkRes();
  await c.routes.handle(
    { method: "POST", url: "/api/tasks" },
    res,
    {
      title: "x", botId: "f", sessionId: "s", originMessageId: "m",
      trigger: { type: "cron", cron: "0 9 * * *" }, timezone: "UTC", prompt: "p"
    }
  );
  const body = JSON.parse(res.body);
  assert.ok(body.task.id);
  assert.ok(events.some((e) => e.type === "created"));
});

test("POST /api/tasks/:id/run-now triggers runNow", async () => {
  const c = ctx();
  const t = c.store.create({
    title: "x", botId: "f", sessionId: "s", originMessageId: "m",
    trigger: { type: "cron", cron: "0 9 * * *" }, timezone: "UTC", prompt: "p"
  });
  const res = mkRes();
  await c.routes.handle({ method: "POST", url: `/api/tasks/${t.id}/run-now` }, res);
  assert.deepEqual(c.fired, [t.id]);
});

test("DELETE /api/tasks/:id removes and emits 'deleted'", async () => {
  const c = ctx();
  const events = [];
  c.events.subscribe((e) => events.push(e));
  const t = c.store.create({
    title: "x", botId: "f", sessionId: "s", originMessageId: "m",
    trigger: { type: "cron", cron: "0 9 * * *" }, timezone: "UTC", prompt: "p"
  });
  const res = mkRes();
  await c.routes.handle({ method: "DELETE", url: `/api/tasks/${t.id}` }, res);
  assert.equal(c.store.list().length, 0);
  assert.ok(events.some((e) => e.type === "deleted"));
});
