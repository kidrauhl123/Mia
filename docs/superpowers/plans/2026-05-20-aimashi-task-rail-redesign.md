# Aimashi 任务面板（Task Rail）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 rail 第 4 项「工作台」替换为「任务」面板，daemon 内置 cron + 一次性 scheduler，AI 通过对话创建 / 修改任务，输出落回原 fellow 会话；GUI 提供任务列表 + 详情 + 历史内联查看。

**Architecture:** Scheduler 仅在 daemon 进程启动，是任务的唯一权威源；GUI 通过既有 HTTP control server + SSE 订阅 daemon。AI 通过新 MCP server `aimashi-scheduler` 调用 daemon 内部函数（Hermes 直调，Claude Code / Codex 走 MCP）。任务 fire 复用现有 `runRemoteChatRequest`，输出 message 上挂 `taskId / taskRunId` 元信息。

**Tech Stack:** Node.js（CommonJS）+ Electron 主进程 / 渲染进程；`cron-parser` 新增依赖；node:test 内置测试框架；现有 `aimashi-sessions.json` + 新增 `aimashi-tasks.json`；既有 LaunchAgent / 控制服务器 / MCP bridge。

**Reference spec:** `docs/superpowers/specs/2026-05-20-aimashi-task-rail-redesign.md`

---

## File Structure

新增（按依赖顺序）：

- `src/main/tasks-store.js` —— `aimashi-tasks.json` 的 CRUD + 原子写
- `src/main/scheduler.js` —— Scheduler 引擎（heap + setTimeout，cron-parser 解析）
- `src/main/scheduler-fire.js` —— 把 task 翻译成 `runRemoteChatRequest` 调用 + 记 run
- `src/main/scheduler-mcp.js` —— MCP server `aimashi-scheduler`，工具表
- `src/main/tasks-routes.js` —— `/api/tasks/*` HTTP handler
- `src/main/tasks-events.js` —— SSE broadcast bus
- `src/renderer/daemon-tasks-client.js` —— GUI 端 fetch + SSE 封装（通过 IPC 走主进程）
- `tests/tasks-store.test.js` / `tests/scheduler.test.js` / `tests/scheduler-fire.test.js` / `tests/scheduler-mcp.test.js` / `tests/tasks-routes.test.js`

修改：

- `package.json` —— 加 `cron-parser` 依赖
- `src/main.js` —— daemon 分支 `initScheduler()`、`handleControlRequest` 挂新路由、MCP bridge 注册、tasks IPC、删 workbench IPC
- `src/preload.js` —— 暴露 `tasks.*` API、删 workbench API（如有）
- `src/renderer/app.js` —— 删 workbench 渲染、抽 `renderChatMessage` 为纯函数、加 task 渲染
- `src/renderer/index.html` —— 删 workbench DOM、加 tasks DOM、rail 第 4 个按钮改属性
- `src/renderer/style.css`（或对应样式文件）—— 加 task 样式、删 workbench 样式

删：上面 workbench 相关。

---

## Phase 1: Backend foundations

### Task 1: 添加 cron-parser 依赖

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 安装依赖**

```bash
cd /Users/jung/GitHub/aimashi
npm install cron-parser@^4.9.0 --save
```

Expected: package.json 多一行 `"cron-parser": "^4.9.0"`，package-lock.json 更新。

- [ ] **Step 2: 验证可加载**

```bash
node -e "const p = require('cron-parser'); console.log(p.parseExpression('0 9 * * *').next().toISOString());"
```

Expected: 输出明天（或今天若 9 点前）的 09:00 ISO 字符串。

- [ ] **Step 3: 提交**

```bash
git add package.json package-lock.json
git commit -m "deps: add cron-parser for task scheduler"
```

---

### Task 2: tasks-store.js

**Files:**
- Create: `src/main/tasks-store.js`
- Test: `tests/tasks-store.test.js`

- [ ] **Step 1: 写 test 文件**

```javascript
// tests/tasks-store.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createTasksStore } = require("../src/main/tasks-store.js");

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aimashi-tasks-")), "tasks.json");
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
```

- [ ] **Step 2: 跑测试看失败**

```bash
npm test -- tests/tasks-store.test.js
```

Expected: FAIL — "Cannot find module '../src/main/tasks-store.js'".

- [ ] **Step 3: 写实现**

```javascript
// src/main/tasks-store.js
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function atomicWrite(filePath, content) {
  const tmp = filePath + ".tmp." + crypto.randomBytes(6).toString("hex");
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* tmp may not exist */ }
    throw e;
  }
}

function readJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}

function validateInput(input) {
  if (!input || typeof input !== "object") throw new Error("task input must be an object");
  if (!input.fellowId) throw new Error("fellowId is required");
  if (!input.sessionId) throw new Error("sessionId is required");
  if (!input.originMessageId) throw new Error("originMessageId is required");
  if (!input.prompt) throw new Error("prompt is required");
  if (!input.trigger || !input.trigger.type) throw new Error("trigger.type is required");
  if (input.trigger.type === "event") {
    throw new Error("event-triggered tasks are not supported in v1");
  }
  if (input.trigger.type === "cron" && !input.trigger.cron) {
    throw new Error("trigger.cron is required for type=cron");
  }
  if (input.trigger.type === "oneshot" && !input.trigger.at) {
    throw new Error("trigger.at is required for type=oneshot");
  }
}

function createTasksStore(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  function load() {
    return readJSON(filePath, { tasks: [] });
  }

  function save(state) {
    atomicWrite(filePath, JSON.stringify(state, null, 2) + "\n");
  }

  function list() {
    return load().tasks;
  }

  function get(id) {
    return load().tasks.find((t) => t.id === id) || null;
  }

  function create(input) {
    validateInput(input);
    const now = Date.now();
    const task = {
      id: "t-" + crypto.randomBytes(8).toString("hex"),
      title: String(input.title || "未命名任务"),
      fellowId: String(input.fellowId),
      sessionId: String(input.sessionId),
      originMessageId: String(input.originMessageId),
      trigger: { ...input.trigger },
      timezone: String(input.timezone || "UTC"),
      prompt: String(input.prompt),
      status: "active",
      runs: [],
      createdAt: now,
      updatedAt: now
    };
    const state = load();
    state.tasks.push(task);
    save(state);
    return task;
  }

  function update(id, partial) {
    const state = load();
    const idx = state.tasks.findIndex((t) => t.id === id);
    if (idx === -1) throw new Error("task not found: " + id);
    const merged = {
      ...state.tasks[idx],
      ...partial,
      id: state.tasks[idx].id,
      runs: state.tasks[idx].runs,
      createdAt: state.tasks[idx].createdAt,
      updatedAt: Date.now()
    };
    if (partial.trigger) {
      merged.trigger = { ...state.tasks[idx].trigger, ...partial.trigger };
      validateInput({ ...merged, prompt: merged.prompt });
    }
    state.tasks[idx] = merged;
    save(state);
    return merged;
  }

  function deleteTask(id) {
    const state = load();
    state.tasks = state.tasks.filter((t) => t.id !== id);
    save(state);
  }

  function pause(id) { return update(id, { status: "paused" }); }
  function resume(id) { return update(id, { status: "active" }); }

  function recordRun(id, run) {
    const state = load();
    const task = state.tasks.find((t) => t.id === id);
    if (!task) throw new Error("task not found: " + id);
    const runEntry = {
      id: run.id || ("r-" + crypto.randomBytes(6).toString("hex")),
      firedAt: run.firedAt,
      finishedAt: run.finishedAt || null,
      status: run.status,
      outputMessageId: run.outputMessageId || null,
      error: run.error
    };
    task.runs.push(runEntry);
    task.updatedAt = Date.now();
    save(state);
    return runEntry;
  }

  return { list, get, create, update, delete: deleteTask, pause, resume, recordRun };
}

module.exports = { createTasksStore };
```

- [ ] **Step 4: 跑测试看通过**

```bash
npm test -- tests/tasks-store.test.js
```

Expected: PASS（7 个测试）。

- [ ] **Step 5: 提交**

```bash
git add src/main/tasks-store.js tests/tasks-store.test.js
git commit -m "feat(tasks): tasks-store CRUD with atomic write"
```

---

### Task 3: scheduler.js — 计算 next fire + 排序

**Files:**
- Create: `src/main/scheduler.js`
- Test: `tests/scheduler.test.js`

- [ ] **Step 1: 写测试**

```javascript
// tests/scheduler.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeNextFire, isFireable } = require("../src/main/scheduler.js");

test("computeNextFire: cron returns parsed next time", () => {
  const now = new Date("2026-05-20T08:00:00Z").getTime();
  const next = computeNextFire(
    { type: "cron", cron: "0 9 * * *" },
    "UTC",
    now
  );
  assert.equal(new Date(next).toISOString(), "2026-05-20T09:00:00.000Z");
});

test("computeNextFire: oneshot returns at time if future", () => {
  const at = "2026-06-01T12:00:00Z";
  const now = new Date("2026-05-20T08:00:00Z").getTime();
  const next = computeNextFire({ type: "oneshot", at }, "UTC", now);
  assert.equal(next, new Date(at).getTime());
});

test("computeNextFire: oneshot returns null if past", () => {
  const at = "2026-04-01T12:00:00Z";
  const now = new Date("2026-05-20T08:00:00Z").getTime();
  assert.equal(computeNextFire({ type: "oneshot", at }, "UTC", now), null);
});

test("computeNextFire: event returns null (v1 unsupported)", () => {
  const now = Date.now();
  assert.equal(computeNextFire({ type: "event" }, "UTC", now), null);
});

test("isFireable: paused tasks not fireable", () => {
  assert.equal(isFireable({ status: "paused" }), false);
  assert.equal(isFireable({ status: "done" }), false);
  assert.equal(isFireable({ status: "failed" }), false);
  assert.equal(isFireable({ status: "active" }), true);
});
```

- [ ] **Step 2: 跑测试看失败**

```bash
npm test -- tests/scheduler.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: 写最小实现**

```javascript
// src/main/scheduler.js
const cronParser = require("cron-parser");

function computeNextFire(trigger, timezone, nowMs) {
  if (!trigger) return null;
  if (trigger.type === "cron") {
    try {
      const it = cronParser.parseExpression(trigger.cron, {
        currentDate: new Date(nowMs),
        tz: timezone
      });
      return it.next().getTime();
    } catch {
      return null;
    }
  }
  if (trigger.type === "oneshot") {
    const at = new Date(trigger.at).getTime();
    if (Number.isNaN(at) || at <= nowMs) return null;
    return at;
  }
  return null;
}

function isFireable(task) {
  return task && task.status === "active";
}

function createScheduler({ store, onFire, logger = console }) {
  let timer = null;
  let inflight = new Set(); // taskIds currently firing
  let stopped = true;

  function fireableTasks(now) {
    return store.list()
      .filter(isFireable)
      .map((task) => ({ task, nextFire: computeNextFire(task.trigger, task.timezone, now) }))
      .filter(({ nextFire }) => nextFire !== null)
      .sort((a, b) => a.nextFire - b.nextFire);
  }

  function schedule() {
    if (stopped) return;
    if (timer) { clearTimeout(timer); timer = null; }
    const now = Date.now();
    const queue = fireableTasks(now);
    if (queue.length === 0) return;
    const next = queue[0];
    const delay = Math.max(0, next.nextFire - now);
    timer = setTimeout(() => fireAndReschedule(next.task.id), Math.min(delay, 2_147_483_000));
  }

  async function fireAndReschedule(taskId) {
    timer = null;
    const task = store.get(taskId);
    if (!task || !isFireable(task)) { schedule(); return; }
    if (inflight.has(taskId)) {
      store.recordRun(taskId, {
        firedAt: Date.now(), finishedAt: Date.now(),
        status: "skipped", error: "previous run still in progress"
      });
      schedule();
      return;
    }
    inflight.add(taskId);
    try {
      await onFire(task);
    } catch (e) {
      logger.error?.("[scheduler] onFire failed", e);
    } finally {
      inflight.delete(taskId);
      // For oneshot tasks, mark as done after first successful fire
      const after = store.get(taskId);
      if (after && after.trigger.type === "oneshot") {
        const lastRun = after.runs[after.runs.length - 1];
        if (lastRun && lastRun.status === "ok") {
          store.update(taskId, { status: "done" });
        }
      }
      schedule();
    }
  }

  function start() { stopped = false; schedule(); }
  function stop() { stopped = true; if (timer) { clearTimeout(timer); timer = null; } }
  function rescan() { schedule(); }

  return { start, stop, rescan, _fireableTasks: fireableTasks };
}

module.exports = { computeNextFire, isFireable, createScheduler };
```

- [ ] **Step 4: 跑测试看通过**

```bash
npm test -- tests/scheduler.test.js
```

Expected: PASS（5 个测试）。

- [ ] **Step 5: 提交**

```bash
git add src/main/scheduler.js tests/scheduler.test.js
git commit -m "feat(tasks): scheduler engine — cron + oneshot next-fire"
```

---

### Task 4: scheduler-fire.js + scheduler 集成测试

**Files:**
- Create: `src/main/scheduler-fire.js`
- Test: `tests/scheduler-fire.test.js`

- [ ] **Step 1: 写测试（验证 fire 调用 runRemoteChatRequest 并 recordRun）**

```javascript
// tests/scheduler-fire.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createTasksStore } = require("../src/main/tasks-store.js");
const { createFireRunner } = require("../src/main/scheduler-fire.js");

function tmpStore() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aimashi-fire-")), "tasks.json");
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
        response: { id: "msg-final" }
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
```

- [ ] **Step 2: 跑测试看失败**

```bash
npm test -- tests/scheduler-fire.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: 写实现**

```javascript
// src/main/scheduler-fire.js
const crypto = require("node:crypto");

function createFireRunner({ store, runRemoteChatRequest, emit, logger = console }) {
  async function fire(task) {
    const runId = "r-" + crypto.randomBytes(6).toString("hex");
    const firedAt = Date.now();
    emit("started", { taskId: task.id, runId, sessionId: task.sessionId });
    try {
      const result = await runRemoteChatRequest({
        fellowKey: task.fellowId,
        sessionId: task.sessionId,
        text: task.prompt,
        displayText: task.prompt,
        meta: { taskId: task.id, taskRunId: runId }
      });
      // Identify the message id of the assistant reply we just appended.
      // runRemoteChatRequest currently appends to session.messages; the last
      // assistant message is ours.
      const messages = result?.session?.messages || [];
      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
      const outputMessageId = lastAssistant?.id || result?.response?.id || null;
      const run = store.recordRun(task.id, {
        id: runId,
        firedAt,
        finishedAt: Date.now(),
        status: "ok",
        outputMessageId
      });
      emit("finished", {
        taskId: task.id,
        runId: run.id,
        sessionId: task.sessionId,
        messageId: outputMessageId,
        status: "ok"
      });
      return run;
    } catch (e) {
      logger.error?.("[scheduler-fire] task failed", task.id, e);
      const run = store.recordRun(task.id, {
        id: runId,
        firedAt,
        finishedAt: Date.now(),
        status: "failed",
        error: String(e?.message || e)
      });
      emit("failed", {
        taskId: task.id,
        runId: run.id,
        sessionId: task.sessionId,
        error: run.error
      });
      return run;
    }
  }
  return { fire };
}

module.exports = { createFireRunner };
```

- [ ] **Step 4: 跑测试看通过**

```bash
npm test -- tests/scheduler-fire.test.js
```

Expected: PASS（3 个测试）。

- [ ] **Step 5: 提交**

```bash
git add src/main/scheduler-fire.js tests/scheduler-fire.test.js
git commit -m "feat(tasks): scheduler fire runner — bridges scheduler to runRemoteChatRequest"
```

---

### Task 5: tasks-events.js — SSE 广播总线

**Files:**
- Create: `src/main/tasks-events.js`
- Test: 无单独 test（在 routes 测试里覆盖）

- [ ] **Step 1: 写实现**

```javascript
// src/main/tasks-events.js
function createTasksEventBus() {
  const subscribers = new Set();

  function subscribe(send) {
    subscribers.add(send);
    return () => subscribers.delete(send);
  }

  function emit(type, payload) {
    const envelope = { type, payload, at: Date.now() };
    for (const send of subscribers) {
      try { send(envelope); } catch { /* ignore broken pipe */ }
    }
  }

  return { subscribe, emit, _size: () => subscribers.size };
}

module.exports = { createTasksEventBus };
```

- [ ] **Step 2: 提交**

```bash
git add src/main/tasks-events.js
git commit -m "feat(tasks): SSE event bus for task lifecycle"
```

---

### Task 6: tasks-routes.js — `/api/tasks/*` HTTP handler

**Files:**
- Create: `src/main/tasks-routes.js`
- Test: `tests/tasks-routes.test.js`

- [ ] **Step 1: 写测试**

```javascript
// tests/tasks-routes.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createTasksStore } = require("../src/main/tasks-store.js");
const { createTasksEventBus } = require("../src/main/tasks-events.js");
const { createTasksRoutes } = require("../src/main/tasks-routes.js");

function ctx() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aimashi-routes-")), "tasks.json");
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
    title: "t", fellowId: "f", sessionId: "s", originMessageId: "m",
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
      title: "x", fellowId: "f", sessionId: "s", originMessageId: "m",
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
    title: "x", fellowId: "f", sessionId: "s", originMessageId: "m",
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
    title: "x", fellowId: "f", sessionId: "s", originMessageId: "m",
    trigger: { type: "cron", cron: "0 9 * * *" }, timezone: "UTC", prompt: "p"
  });
  const res = mkRes();
  await c.routes.handle({ method: "DELETE", url: `/api/tasks/${t.id}` }, res);
  assert.equal(c.store.list().length, 0);
  assert.ok(events.some((e) => e.type === "deleted"));
});
```

- [ ] **Step 2: 跑测试看失败**

```bash
npm test -- tests/tasks-routes.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: 写实现**

```javascript
// src/main/tasks-routes.js
function writeJSON(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(body));
}

function createTasksRoutes({ store, events, runNow, onChange }) {
  async function handle(req, res, body) {
    const url = req.url;
    const method = req.method;

    if (method === "GET" && url === "/api/tasks") {
      writeJSON(res, 200, { tasks: store.list() });
      return true;
    }
    if (method === "GET" && url.startsWith("/api/tasks/")) {
      const id = url.slice("/api/tasks/".length);
      const task = store.get(id);
      if (!task) { writeJSON(res, 404, { error: "task not found" }); return true; }
      writeJSON(res, 200, { task });
      return true;
    }
    if (method === "POST" && url === "/api/tasks") {
      try {
        const task = store.create(body || {});
        events.emit("created", { taskId: task.id, task });
        onChange?.();
        writeJSON(res, 201, { task });
      } catch (e) {
        writeJSON(res, 400, { error: String(e?.message || e) });
      }
      return true;
    }
    const idMatch = url.match(/^\/api\/tasks\/([^/]+)(?:\/(run-now|pause|resume))?$/);
    if (idMatch) {
      const id = idMatch[1];
      const action = idMatch[2];
      if (method === "PATCH" && !action) {
        try {
          const task = store.update(id, body || {});
          events.emit("updated", { taskId: id, task });
          onChange?.();
          writeJSON(res, 200, { task });
        } catch (e) {
          writeJSON(res, 400, { error: String(e?.message || e) });
        }
        return true;
      }
      if (method === "DELETE" && !action) {
        store.delete(id);
        events.emit("deleted", { taskId: id });
        onChange?.();
        writeJSON(res, 200, { ok: true });
        return true;
      }
      if (method === "POST" && action === "run-now") {
        try {
          const result = await runNow(id);
          writeJSON(res, 200, result);
        } catch (e) {
          writeJSON(res, 500, { error: String(e?.message || e) });
        }
        return true;
      }
      if (method === "POST" && action === "pause") {
        const task = store.pause(id);
        events.emit("updated", { taskId: id, task });
        onChange?.();
        writeJSON(res, 200, { task });
        return true;
      }
      if (method === "POST" && action === "resume") {
        const task = store.resume(id);
        events.emit("updated", { taskId: id, task });
        onChange?.();
        writeJSON(res, 200, { task });
        return true;
      }
    }
    return false;
  }

  function handleEventsStream(req, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*"
    });
    res.write(": connected\n\n");
    const unsubscribe = events.subscribe((envelope) => {
      if (res.destroyed || res.writableEnded) return;
      res.write(`event: ${envelope.type}\n`);
      res.write(`data: ${JSON.stringify(envelope.payload)}\n\n`);
    });
    req.on("close", () => { try { unsubscribe(); } catch {} });
  }

  return { handle, handleEventsStream };
}

module.exports = { createTasksRoutes };
```

- [ ] **Step 4: 跑测试看通过**

```bash
npm test -- tests/tasks-routes.test.js
```

Expected: PASS（4 个测试）。

- [ ] **Step 5: 提交**

```bash
git add src/main/tasks-routes.js tests/tasks-routes.test.js
git commit -m "feat(tasks): HTTP routes + SSE events stream"
```

---

### Task 7: scheduler-mcp.js — MCP server with schedule.* tools

**Files:**
- Create: `src/main/scheduler-mcp.js`
- Test: `tests/scheduler-mcp.test.js`

- [ ] **Step 1: 看现有 MCP server 模式**

```bash
grep -n "bridgeSkillsDir\|bridgeServerDir\|mcp.*server\|aimashi-skills" src/main.js | head -10
```

Expected: 找到 `bridgeSkillsDir`（约 main.js:1964）—— 它创建一个 `bridge/skills` 目录、写一个 `aimashi-skills.json` manifest，然后由 hermes runtime / claude-code 通过 MCP 协议加载。

阅读 main.js:1964-2010 段，弄清 manifest schema。

- [ ] **Step 2: 写实现（暴露 schedule.* 工具的 manifest + handler）**

```javascript
// src/main/scheduler-mcp.js
// MCP server bridge for scheduler. Writes a manifest into the bridge directory
// so Claude Code / Codex can discover the schedule.* tools, and exposes a
// handler that the bridge invokes.

const SCHEDULER_MCP_NAME = "aimashi-scheduler";

function makeManifest() {
  return {
    name: SCHEDULER_MCP_NAME,
    version: "0.1.0",
    description: "Aimashi scheduler — create / list / update / pause / resume / delete cron and one-shot tasks.",
    tools: [
      {
        name: "schedule.create",
        description: "Create a scheduled task. Returns { taskId }.",
        input: {
          title: { type: "string", description: "Short human-readable label" },
          fellowId: { type: "string", description: "Fellow that will execute the task" },
          sessionId: { type: "string", description: "Session where the originating conversation lives" },
          originMessageId: { type: "string", description: "Message id of the user instruction that prompted creation" },
          trigger: {
            type: "object",
            description: "{ type: 'cron'|'oneshot', cron?: string, at?: ISO-8601 }"
          },
          timezone: { type: "string", description: "IANA tz name; defaults to UTC" },
          prompt: { type: "string", description: "What the fellow should do each time the task fires" }
        }
      },
      { name: "schedule.list",   description: "List all tasks.",   input: {} },
      { name: "schedule.update", description: "Patch a task by id.", input: { id: { type: "string" }, partial: { type: "object" } } },
      { name: "schedule.delete", description: "Delete a task by id.", input: { id: { type: "string" } } },
      { name: "schedule.pause",  description: "Pause a task by id.",  input: { id: { type: "string" } } },
      { name: "schedule.resume", description: "Resume a task by id.", input: { id: { type: "string" } } }
    ]
  };
}

function createSchedulerMcp({ store, scheduler, events }) {
  async function invoke(toolName, args = {}) {
    switch (toolName) {
      case "schedule.create": {
        const task = store.create(args);
        events.emit("created", { taskId: task.id, task });
        scheduler.rescan();
        return { taskId: task.id };
      }
      case "schedule.list": {
        return { tasks: store.list() };
      }
      case "schedule.update": {
        const task = store.update(args.id, args.partial || {});
        events.emit("updated", { taskId: task.id, task });
        scheduler.rescan();
        return { task };
      }
      case "schedule.delete": {
        store.delete(args.id);
        events.emit("deleted", { taskId: args.id });
        scheduler.rescan();
        return { ok: true };
      }
      case "schedule.pause": {
        const task = store.pause(args.id);
        events.emit("updated", { taskId: task.id, task });
        scheduler.rescan();
        return { task };
      }
      case "schedule.resume": {
        const task = store.resume(args.id);
        events.emit("updated", { taskId: task.id, task });
        scheduler.rescan();
        return { task };
      }
      default:
        throw new Error("unknown tool: " + toolName);
    }
  }
  return { name: SCHEDULER_MCP_NAME, manifest: makeManifest(), invoke };
}

module.exports = { createSchedulerMcp, SCHEDULER_MCP_NAME };
```

- [ ] **Step 3: 写测试**

```javascript
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
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aimashi-mcp-")), "tasks.json");
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
```

- [ ] **Step 4: 跑测试**

```bash
npm test -- tests/scheduler-mcp.test.js
```

Expected: PASS（3 个测试）。

- [ ] **Step 5: 提交**

```bash
git add src/main/scheduler-mcp.js tests/scheduler-mcp.test.js
git commit -m "feat(tasks): MCP server for schedule.* tools"
```

---

### Task 8: Wire daemon init in main.js

**Files:**
- Modify: `src/main.js`

- [ ] **Step 0a: Patch `runRemoteChatRequest` 以支持 meta + 返回 assistant message id**

现有 `runRemoteChatRequest`（main.js:4648）的 `savedAssistant` 没有 id、没有 meta，所以 fire runner 拿不到 `outputMessageId`，历史详情也无法回查 message。需要先扩展函数。

在 main.js 4648 附近 `async function runRemoteChatRequest(body, eventSink = null)` 内：

找到：
```javascript
const savedUser = {
  role: "user",
  content: String(body?.displayText || "").trim() || userMessage.content || "请查看附件。",
  createdAt: userMessage.createdAt || now
};
if (userMessage.attachments.length) savedUser.attachments = userMessage.attachments;
const savedAssistant = {
  role: "assistant",
  content: assistantText,
  createdAt: new Date().toISOString()
};
```

替换为：
```javascript
const savedUser = {
  id: "msg-" + crypto.randomBytes(6).toString("hex"),
  role: "user",
  content: String(body?.displayText || "").trim() || userMessage.content || "请查看附件。",
  createdAt: userMessage.createdAt || now
};
if (userMessage.attachments.length) savedUser.attachments = userMessage.attachments;
if (body?.meta) savedUser.meta = { ...body.meta, fired: true };
const savedAssistant = {
  id: "msg-" + crypto.randomBytes(6).toString("hex"),
  role: "assistant",
  content: assistantText,
  createdAt: new Date().toISOString()
};
if (body?.meta) savedAssistant.meta = { ...body.meta };
```

并在函数末尾 `return { fellow, session, response };` 改为：
```javascript
return { fellow, session, response, userMessageId: savedUser.id, assistantMessageId: savedAssistant.id };
```

确保 main.js 顶部已 `const crypto = require("node:crypto");`（应已存在）。

跑现有测试确保没破：
```bash
npm test
```

提交：
```bash
git commit -am "refactor(chat): propagate meta + return ids from runRemoteChatRequest"
```

- [ ] **Step 0b: 更新 scheduler-fire.js 使用新返回字段**

修改 `src/main/scheduler-fire.js` 的 fire 函数里：
```javascript
const outputMessageId = lastAssistant?.id || result?.response?.id || null;
```
改为：
```javascript
const outputMessageId = result?.assistantMessageId || lastAssistant?.id || null;
```

跑 fire 测试（mock 里返回 `assistantMessageId`）：
```bash
npm test -- tests/scheduler-fire.test.js
```
如有失败，修 mock：在 mock 的 runRemoteChatRequest return 里加 `assistantMessageId: "msg-mock"`，断言改为 `assert.equal(after.runs[0].outputMessageId, "msg-mock")`。

提交：
```bash
git commit -am "fix(tasks): scheduler-fire reads assistantMessageId from chat response"
```

- [ ] **Step 1: 找到 daemon path 注册位置**

```bash
grep -n "runtimePaths\|daemonSettings\|IS_DAEMON_PROCESS" src/main.js | head
```

阅读 `runtimePaths()` 返回的对象（约 main.js:186）；它已经有 `daemonSettings`, `chatSessions` 等键。

- [ ] **Step 2: 在 runtimePaths() 加 `tasksFile`**

打开 src/main.js 找到 runtimePaths 返回的对象（约 line 184-200），在 `chatSessions: ...` 行下面加：

```javascript
tasks: path.join(home, "aimashi-tasks.json"),
```

- [ ] **Step 3: 在 main.js 顶部 require 新模块**

找到现有 require 块（约 line 1-50），加：

```javascript
const { createTasksStore } = require("./main/tasks-store.js");
const { computeNextFire, isFireable, createScheduler } = require("./main/scheduler.js");
const { createFireRunner } = require("./main/scheduler-fire.js");
const { createTasksEventBus } = require("./main/tasks-events.js");
const { createTasksRoutes } = require("./main/tasks-routes.js");
const { createSchedulerMcp, SCHEDULER_MCP_NAME } = require("./main/scheduler-mcp.js");
```

- [ ] **Step 4: 加 initScheduler() 函数（接近 startControlServer 的位置，约 main.js:4900 附近）**

在 `async function startControlServer` 上方插入：

```javascript
let tasksStore = null;
let tasksEvents = null;
let scheduler = null;
let tasksRoutes = null;
let schedulerMcp = null;

function initSchedulerSubsystem() {
  if (tasksStore) return; // idempotent
  const p = runtimePaths();
  tasksStore = createTasksStore(p.tasks);
  tasksEvents = createTasksEventBus();
  const fireRunner = createFireRunner({
    store: tasksStore,
    runRemoteChatRequest,
    emit: (type, payload) => tasksEvents.emit(type, payload)
  });
  scheduler = createScheduler({
    store: tasksStore,
    onFire: (task) => fireRunner.fire(task)
  });
  tasksRoutes = createTasksRoutes({
    store: tasksStore,
    events: tasksEvents,
    runNow: async (id) => {
      const task = tasksStore.get(id);
      if (!task) throw new Error("task not found");
      const run = await fireRunner.fire(task);
      return { runId: run.id };
    },
    onChange: () => scheduler.rescan()
  });
  schedulerMcp = createSchedulerMcp({
    store: tasksStore,
    scheduler,
    events: tasksEvents
  });
  if (IS_DAEMON_PROCESS) {
    sweepExpiredOneshotTasks(tasksStore);
    scheduler.start();
    appendDaemonLog("Scheduler started");
  }
}

// Per spec §9: oneshot tasks whose 'at' has passed while daemon was down
// transition to status="failed" with a recorded run noting "daemon offline".
function sweepExpiredOneshotTasks(store) {
  const now = Date.now();
  for (const task of store.list()) {
    if (task.status !== "active") continue;
    if (task.trigger.type !== "oneshot") continue;
    const at = new Date(task.trigger.at).getTime();
    if (Number.isNaN(at) || at > now) continue;
    store.recordRun(task.id, {
      firedAt: at,
      finishedAt: now,
      status: "failed",
      error: "missed: daemon offline at scheduled time"
    });
    store.update(task.id, { status: "failed" });
  }
}
```

- [ ] **Step 5: 在 handleControlRequest 里挂任务路由**

找 `async function handleControlRequest` 主体（约 main.js:4726），在路由分发顶部（已有 `if (req.method === "OPTIONS")` 之后）加：

```javascript
initSchedulerSubsystem();
const tasksHandled = await tasksRoutes.handle(req, res, await readControlBody(req).catch(() => null));
if (tasksHandled) return;
if (req.method === "GET" && new URL(req.url, `http://${req.headers.host}`).pathname === "/api/tasks/events") {
  tasksRoutes.handleEventsStream(req, res);
  return;
}
```

注意：`readControlBody` 已经存在；如果它只能读一次，需要先 peek 路径再决定是否读 body。如果 readControlBody 不支持重入，把上面改成：

```javascript
initSchedulerSubsystem();
const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
if (url.pathname === "/api/tasks/events" && req.method === "GET") {
  tasksRoutes.handleEventsStream(req, res);
  return;
}
if (url.pathname.startsWith("/api/tasks")) {
  const body = ["POST", "PATCH"].includes(req.method) ? await readControlBody(req) : null;
  const handled = await tasksRoutes.handle(req, res, body);
  if (handled) return;
}
```

- [ ] **Step 6: 在 MCP bridge 注册新 server**

找到 `bridgeSkillsDir`（约 main.js:1964）所在函数体。在 `skills` manifest 写完之后追加：

```javascript
const bridgeSchedulerDir = path.join(bridgeDir, "scheduler");
fs.mkdirSync(bridgeSchedulerDir, { recursive: true });
fs.writeFileSync(
  path.join(bridgeSchedulerDir, `${SCHEDULER_MCP_NAME}.json`),
  JSON.stringify({
    name: SCHEDULER_MCP_NAME,
    description: schedulerMcp?.manifest?.description || "",
    invokeUrl: `${getDaemonStatus().baseUrl}/api/mcp/${SCHEDULER_MCP_NAME}/invoke`
  }, null, 2) + "\n"
);
```

并在 tasks-routes 已挂的同一 dispatcher 里加 MCP invoke 路由：

```javascript
// 在 handleControlRequest 里 url.pathname 分发上加
if (url.pathname === `/api/mcp/${SCHEDULER_MCP_NAME}/invoke` && req.method === "POST") {
  initSchedulerSubsystem();
  const body = await readControlBody(req);
  try {
    const result = await schedulerMcp.invoke(body?.tool, body?.args || {});
    writeControlJson(res, 200, result);
  } catch (e) {
    writeControlJson(res, 400, { error: String(e?.message || e) });
  }
  return;
}
```

- [ ] **Step 7: 暂不动 IPC，跑现有测试确保没破东西**

```bash
npm test
```

Expected: PASS（所有原测试 + 新测试），无 import 错误。

- [ ] **Step 8: 提交**

```bash
git add src/main.js
git commit -m "feat(tasks): wire scheduler subsystem into daemon"
```

---

### Task 9: Cascade —— fellow / session 删除时把孤儿任务转 paused

**Files:**
- Modify: `src/main.js`（找到 fellow / session 删除路径，在其后调用）
- Modify: `src/main/tasks-store.js`（加 `orphanByFellow` / `orphanBySession` 方法）

- [ ] **Step 1: 给 tasks-store 加 orphan 方法**

```javascript
// 加到 src/main/tasks-store.js 的 return 块内（在 recordRun 之前）

function orphanByFellow(fellowId) {
  const state = load();
  let changed = 0;
  state.tasks.forEach((t) => {
    if (t.fellowId === fellowId && t.status !== "done") {
      t.status = "paused";
      t.orphanReason = "fellow_deleted";
      t.updatedAt = Date.now();
      changed += 1;
    }
  });
  if (changed) save(state);
  return changed;
}

function orphanBySession(sessionId) {
  const state = load();
  let changed = 0;
  state.tasks.forEach((t) => {
    if (t.sessionId === sessionId && t.status !== "done") {
      t.status = "paused";
      t.orphanReason = "session_deleted";
      t.updatedAt = Date.now();
      changed += 1;
    }
  });
  if (changed) save(state);
  return changed;
}
```

并加到 `return` 对象里。

- [ ] **Step 2: 写测试覆盖 orphan**

加到 tests/tasks-store.test.js 末尾：

```javascript
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
```

跑测试，PASS。

- [ ] **Step 3: 在 main.js 找 fellow / session 删除调用点**

```bash
grep -n "fellow.*delete\|session.*delete\|deleteFellow\|deleteSession\|sessions:delete\|fellows:delete" src/main.js | head -10
```

定位 IPC handler 或对应函数。在删除完成后插入：

```javascript
initSchedulerSubsystem();
const orphaned = tasksStore.orphanByFellow(fellowKey); // 或 orphanBySession(sessionId)
if (orphaned > 0) {
  tasksEvents.emit("orphaned", { fellowId: fellowKey, count: orphaned });
  scheduler.rescan();
}
```

- [ ] **Step 4: 跑全部测试**

```bash
npm test
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/main.js src/main/tasks-store.js tests/tasks-store.test.js
git commit -m "feat(tasks): cascade orphan tasks when fellow/session deleted"
```

---

## Phase 2: Frontend foundation

### Task 10: preload IPC for tasks

**Files:**
- Modify: `src/preload.js`

- [ ] **Step 1: 看现有 preload 模式**

```bash
grep -n "loadSkills\|ipcRenderer\.invoke" src/preload.js | head -10
```

注意到 preload 用 `ipcRenderer.invoke("xxx:yyy")` 风格。

- [ ] **Step 2: 加 tasks 命名空间**

在 preload.js 现有 API 对象里加：

```javascript
tasks: {
  list: () => ipcRenderer.invoke("tasks:list"),
  get: (id) => ipcRenderer.invoke("tasks:get", id),
  create: (input) => ipcRenderer.invoke("tasks:create", input),
  update: (id, partial) => ipcRenderer.invoke("tasks:update", id, partial),
  delete: (id) => ipcRenderer.invoke("tasks:delete", id),
  pause: (id) => ipcRenderer.invoke("tasks:pause", id),
  resume: (id) => ipcRenderer.invoke("tasks:resume", id),
  runNow: (id) => ipcRenderer.invoke("tasks:run-now", id),
  subscribe: (cb) => {
    const wrapped = (_e, envelope) => cb(envelope);
    ipcRenderer.on("tasks:event", wrapped);
    return () => ipcRenderer.removeListener("tasks:event", wrapped);
  }
}
```

- [ ] **Step 3: 在 main.js 加 ipcMain handler，转发到 daemon HTTP**

找到现有 `ipcMain.handle(...)` 块，在末尾加：

```javascript
async function callDaemonTasks(pathSegment, opts = {}) {
  const settings = daemonSettings();
  const baseUrl = controlServerState.baseUrl || `http://${settings.host}:${settings.port}`;
  const response = await fetch(`${baseUrl}${pathSegment}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${daemonToken()}`,
      ...(opts.headers || {})
    }
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`daemon ${response.status}: ${body || response.statusText}`);
  }
  return response.json();
}

ipcMain.handle("tasks:list",   async () => (await callDaemonTasks("/api/tasks")).tasks);
ipcMain.handle("tasks:get",    async (_e, id) => (await callDaemonTasks(`/api/tasks/${id}`)).task);
ipcMain.handle("tasks:create", async (_e, input) => (await callDaemonTasks("/api/tasks", { method: "POST", body: JSON.stringify(input) })).task);
ipcMain.handle("tasks:update", async (_e, id, partial) => (await callDaemonTasks(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(partial) })).task);
ipcMain.handle("tasks:delete", async (_e, id) => callDaemonTasks(`/api/tasks/${id}`, { method: "DELETE" }));
ipcMain.handle("tasks:pause",  async (_e, id) => (await callDaemonTasks(`/api/tasks/${id}/pause`,  { method: "POST" })).task);
ipcMain.handle("tasks:resume", async (_e, id) => (await callDaemonTasks(`/api/tasks/${id}/resume`, { method: "POST" })).task);
ipcMain.handle("tasks:run-now", async (_e, id) => callDaemonTasks(`/api/tasks/${id}/run-now`, { method: "POST" }));
```

- [ ] **Step 4: 加 SSE 订阅转发（GUI mode only，daemon-self 跳过）**

在 main.js 启动完 BrowserWindow 后调用：

```javascript
function subscribeDaemonTaskEvents() {
  if (IS_DAEMON_PROCESS) return;
  const settings = daemonSettings();
  const baseUrl = controlServerState.baseUrl || `http://${settings.host}:${settings.port}`;
  const token = daemonToken();
  let reconnectDelay = 1000;

  function connect() {
    const req = require("node:http").request(`${baseUrl}/api/tasks/events`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" }
    });
    req.on("response", (res) => {
      reconnectDelay = 1000;
      let buf = "";
      res.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const events = buf.split("\n\n");
        buf = events.pop() || "";
        for (const evt of events) {
          const lines = evt.split("\n");
          let type = ""; let data = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) type = line.slice(7).trim();
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (!type) continue;
          try {
            const payload = JSON.parse(data || "null");
            for (const w of BrowserWindow.getAllWindows()) {
              w.webContents.send("tasks:event", { type, payload });
            }
          } catch { /* ignore parse errors */ }
        }
      });
      res.on("end", () => setTimeout(connect, reconnectDelay));
      res.on("error", () => setTimeout(connect, reconnectDelay));
    });
    req.on("error", () => {
      reconnectDelay = Math.min(reconnectDelay * 2, 15000);
      setTimeout(connect, reconnectDelay);
    });
    req.end();
  }
  connect();
}

// 在 daemon 启动完之后调用 subscribeDaemonTaskEvents();
```

- [ ] **Step 5: 启动 app，开 devtools 验证 IPC 可用**

```bash
npm run open
```

在 devtools console 跑：

```javascript
await window.aimashi.tasks.list();  // 应返回 []
```

Expected: 返回 `[]`，无报错。

- [ ] **Step 6: 提交**

```bash
git add src/preload.js src/main.js
git commit -m "feat(tasks): renderer IPC + SSE forwarding"
```

---

### Task 11: Extract renderMessage from chat code

**Files:**
- Modify: `src/renderer/app.js`

- [ ] **Step 1: 找到现有 message 渲染逻辑**

```bash
grep -n "renderChatMessage\|renderMessage\|renderAssistantMessage" src/renderer/app.js | head
```

定位现有渲染函数（按结果，可能名叫 `renderChatMessage` 或在 `renderChat` 内联）。

- [ ] **Step 2: 抽成 `renderMessage(message, ctx)` 纯函数**

确保签名只依赖：
- `message`（含 role / content / attachments / tools / reasoning / meta）
- `ctx`（含 `fellow`、`showAvatar`、`onJumpToTask` 等可选回调）

不直接读取 `state.activeSession` 等全局变量。原 chatView 渲染代码改为：

```javascript
const html = state.activeSession.messages.map((m) => renderMessage(m, {
  fellow: activePersona(),
  showAvatar: state.showAssistantAvatar,
  showTaskAffordance: true
})).join("");
```

- [ ] **Step 3: 启动 app，确认聊天界面没回归**

```bash
npm run open
```

发几条消息（fellow + tool 调用），确认渲染和之前一致。

- [ ] **Step 4: 提交**

```bash
git add src/renderer/app.js
git commit -m "refactor(chat): extract renderMessage as pure function for task page reuse"
```

---

## Phase 3: UI swap

### Task 12: 删 workbench DOM / JS / CSS / IPC

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/app.js`
- Modify: `src/main.js`

- [ ] **Step 1: 列出 workbench 占用的全部代码**

```bash
grep -n "workbench\|Workbench" src/renderer/index.html src/renderer/app.js src/main.js src/preload.js
```

- [ ] **Step 2: index.html 删 workbench 三块**

删 `workbenchSidebar`（约 line 102-110）、`workbenchView`（约 line 248-261）、其它含 `workbench` 类的节点。**不动 rail 第 4 个按钮**（下个任务改它的 data-view）。

- [ ] **Step 3: app.js 删函数和 state**

删除：
- `renderWorkbench` / `renderWorkbenchNav` / `renderWorkbenchAction` / `renderWorkbenchExample`（约 line 2463-2570）
- `workbenchSections` / `workbenchSectionRows`（约 line 2428-2461）
- `state.workbenchSection` / `state.workbenchFilter` 引用
- DOM 引用：`els.workbenchNav` / `els.workbenchContent` / `els.workbenchPageTitle` / `els.workbenchPageMeta`（约 line 211-216）
- 调用点：`renderWorkbench();` 在 `renderAll` 或类似函数里（grep `renderWorkbench()`）

- [ ] **Step 4: app.js 里凡是依赖被删函数的代码也要清理**

```bash
grep -n "workbench" src/renderer/app.js
```

应返回空。

- [ ] **Step 5: 找 workbench CSS 删**

```bash
grep -rn "workbench-" src/renderer/
```

删除相关 CSS 块（不动通用 workspace / sidebar 类）。

- [ ] **Step 6: main.js / preload.js workbench IPC 删（如有）**

```bash
grep -n "workbench" src/main.js src/preload.js
```

删返回的所有命中。

- [ ] **Step 7: 启动验证**

```bash
npm run open
```

打开 rail 第 4 个按钮 —— 应该没东西显示（因为 view 已删，按钮还是旧的 data-view="workbench"，下个任务修）。其它 view 正常。

- [ ] **Step 8: 提交**

```bash
git add src/renderer/ src/main.js src/preload.js
git commit -m "refactor: remove workbench placeholder ahead of tasks rail"
```

---

### Task 13: 加 tasks DOM 在 index.html

**Files:**
- Modify: `src/renderer/index.html`

- [ ] **Step 1: rail 第 4 按钮改属性**

找到 rail 那行（约 line 30），把：

```html
<button class="rail-button" type="button" data-view="workbench" title="工作台" aria-label="工作台">
```

改成：

```html
<button class="rail-button" type="button" data-view="tasks" title="任务" aria-label="任务">
  <span class="rail-icon" aria-hidden="true">📅</span>
  <span class="rail-badge hidden" id="tasksUnreadBadge" aria-hidden="true">0</span>
</button>
```

（按钮内已有的图标 markup 保留，确保跟其它 rail 按钮风格一致；上面是示意，照搬现有 rail 按钮的内部结构再加 badge）

- [ ] **Step 2: 加 tasks sidebar（中栏）**

在删掉的 `workbenchSidebar` 位置加：

```html
<aside id="tasksSidebar" class="sidebar tasks-sidebar hidden">
  <header class="sidebar-tools tasks-sidebar-tools">
    <label class="search-box">
      <span>⌕</span>
      <input id="taskSearch" autocomplete="off" placeholder="搜索任务">
    </label>
  </header>
  <section id="tasksNav" class="tasks-nav"></section>
</aside>
```

- [ ] **Step 3: 加 tasks view（右栏）**

在删掉的 `workbenchView` 位置加：

```html
<section id="tasksView" class="workspace tasks-workspace hidden">
  <header class="topbar">
    <button class="narrow-back-button" type="button" data-narrow-back title="返回任务" aria-label="返回任务">‹</button>
    <div class="group-title">
      <div>
        <h1><span id="tasksPageTitle">任务</span></h1>
        <p id="tasksPageMeta">日常任务和定时执行的统一入口</p>
      </div>
    </div>
    <div class="top-actions" id="taskActions"></div>
  </header>
  <section class="tasks-layout">
    <div id="tasksContent" class="tasks-content"></div>
  </section>
</section>
```

- [ ] **Step 4: 保存、启动 app 看 DOM 在**

```bash
npm run open
```

打开 devtools elements 面板，确认新节点都存在且 hidden。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/index.html
git commit -m "feat(tasks): add tasks rail DOM (sidebar + view)"
```

---

### Task 14: render task sidebar（中栏）

**Files:**
- Modify: `src/renderer/app.js`

- [ ] **Step 1: 在 els 注册新节点引用**

找到 `const els = { ... }` 块，加：

```javascript
tasksUnreadBadge: document.getElementById("tasksUnreadBadge"),
tasksSidebar: document.getElementById("tasksSidebar"),
tasksNav: document.getElementById("tasksNav"),
tasksView: document.getElementById("tasksView"),
tasksContent: document.getElementById("tasksContent"),
tasksPageTitle: document.getElementById("tasksPageTitle"),
tasksPageMeta: document.getElementById("tasksPageMeta"),
taskActions: document.getElementById("taskActions"),
taskSearch: document.getElementById("taskSearch"),
```

- [ ] **Step 2: 加 state**

```javascript
state.tasks = [];                  // 所有任务镜像
state.taskFilter = "";
state.selectedTaskId = "";
state.selectedRunId = "";          // 选中历史记录时设置
state.historyExpanded = false;
state.disabledExpanded = false;
state.tasksUnread = new Map();     // taskId -> unread fire count
```

- [ ] **Step 3: 加分组函数**

```javascript
function groupTasksForSidebar(tasks, now = Date.now()) {
  const SEVEN_DAYS = 7 * 24 * 3600 * 1000;
  const today = [];
  const upcoming = [];
  const disabled = [];
  const history = []; // recent runs (across all tasks)

  for (const task of tasks) {
    if (task.status === "paused" || task.status === "done" || task.status === "failed") {
      disabled.push(task);
      continue;
    }
    const next = computeNextFireForUi(task, now);
    if (next == null) {
      disabled.push(task);
      continue;
    }
    if (isToday(next, now)) today.push({ task, nextFire: next });
    else if (next - now <= SEVEN_DAYS) upcoming.push({ task, nextFire: next });
    else upcoming.push({ task, nextFire: next });
  }
  today.sort((a, b) => a.nextFire - b.nextFire);
  upcoming.sort((a, b) => a.nextFire - b.nextFire);

  for (const task of tasks) {
    for (const run of task.runs.slice(-50)) {
      history.push({ task, run });
    }
  }
  history.sort((a, b) => b.run.firedAt - a.run.firedAt);

  return { today, upcoming, history, disabled };
}

function computeNextFireForUi(task, now) {
  // Use same logic as scheduler but in browser — re-export via preload, or
  // duplicate the small bit here. Simplest: read task.nextFire if backend
  // populates it. For v1 we keep it minimal and call into preload helper.
  return window.aimashi.tasks._computeNext?.(task, now) ?? null;
}

function isToday(ms, now) {
  const a = new Date(ms);
  const b = new Date(now);
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}
```

注意：`computeNextFireForUi` 当前依赖 preload 提供的 helper，否则用 placeholder（始终返回 null，让 today/upcoming 暂时为空）。这个 helper 在 Task 19 解决。短期可以让 backend 在 GET /api/tasks 返回里加 `nextFireAt` 字段，前端直接读。**简单路径**：去 Task 6 的 tasks-routes 里把 list response 加上 `nextFireAt`。

加到 tasks-routes.js 的 GET /api/tasks 处理：

```javascript
const { computeNextFire } = require("./scheduler.js");
// ...
if (method === "GET" && url === "/api/tasks") {
  const now = Date.now();
  const tasks = store.list().map((t) => ({
    ...t,
    nextFireAt: computeNextFire(t.trigger, t.timezone, now)
  }));
  writeJSON(res, 200, { tasks });
  return true;
}
```

并在前端 `computeNextFireForUi` 直接读 `task.nextFireAt`：

```javascript
function computeNextFireForUi(task) {
  return task.nextFireAt != null ? task.nextFireAt : null;
}
```

- [ ] **Step 4: 写渲染函数**

```javascript
function renderTaskSidebar() {
  if (!els.tasksNav) return;
  const filter = state.taskFilter.trim().toLowerCase();
  const filtered = state.tasks.filter((t) =>
    !filter || `${t.title} ${t.prompt}`.toLowerCase().includes(filter)
  );
  const groups = groupTasksForSidebar(filtered);

  function row(task, label, dot, taskId) {
    const unread = state.tasksUnread.get(taskId) || 0;
    return `
      <button class="task-row${state.selectedTaskId === taskId ? " active" : ""}"
              type="button" data-task-id="${escapeHtml(taskId)}">
        <span class="task-dot ${dot}"></span>
        <span class="task-row-body">
          <strong>${escapeHtml(task.title)}</strong>
          <small>${escapeHtml(label)} · ${escapeHtml(fellowName(task.fellowId))}</small>
        </span>
        ${unread ? `<em class="task-unread">${unread}</em>` : ""}
      </button>
    `;
  }

  function historyRow(task, run) {
    const id = `${task.id}:${run.id}`;
    const selected = state.selectedRunId === run.id ? " active" : "";
    const icon = run.status === "ok" ? "✓" : run.status === "failed" ? "✗" : "·";
    return `
      <button class="task-row history${selected}" type="button"
              data-task-id="${escapeHtml(task.id)}" data-run-id="${escapeHtml(run.id)}">
        <span class="task-status">${icon}</span>
        <span class="task-row-body">
          <strong>${escapeHtml(task.title)}</strong>
          <small>${formatRunTime(run.firedAt)}${run.status === "failed" ? " 失败" : ""}</small>
        </span>
      </button>
    `;
  }

  let html = "";
  if (groups.today.length) {
    html += `<div class="task-group-head">今天 (${groups.today.length})</div>`;
    html += groups.today.map((g) => row(g.task, formatNextTime(g.nextFire), "active", g.task.id)).join("");
  }
  if (groups.upcoming.length) {
    html += `<div class="task-group-head">即将 (${groups.upcoming.length})</div>`;
    html += groups.upcoming.map((g) => row(g.task, formatNextTime(g.nextFire), "upcoming", g.task.id)).join("");
  }
  if (groups.history.length) {
    const open = state.historyExpanded;
    html += `<div class="task-group-head collapsible" data-toggle="history">
              历史 (${groups.history.length}) ${open ? "⌃" : "⌄"}
            </div>`;
    if (open) html += groups.history.slice(0, 50).map((g) => historyRow(g.task, g.run)).join("");
  }
  if (groups.disabled.length) {
    const open = state.disabledExpanded;
    html += `<div class="task-group-head collapsible" data-toggle="disabled">
              已停用 (${groups.disabled.length}) ${open ? "⌃" : "⌄"}
            </div>`;
    if (open) html += groups.disabled.map((t) => row(t, "暂停 / 已完成", "disabled", t.id)).join("");
  }
  if (!html) {
    html = `<div class="task-empty-side">还没有定时任务</div>`;
  }
  els.tasksNav.innerHTML = html;

  els.tasksNav.querySelectorAll("[data-task-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.selectedTaskId = btn.dataset.taskId;
      state.selectedRunId = btn.dataset.runId || "";
      if (state.selectedRunId) {
        // entering history-detail mode
      }
      // clear unread for this task
      state.tasksUnread.delete(state.selectedTaskId);
      updateTasksRailBadge();
      renderTaskSidebar();
      renderTaskView();
    });
  });
  els.tasksNav.querySelectorAll("[data-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.toggle === "history") state.historyExpanded = !state.historyExpanded;
      if (btn.dataset.toggle === "disabled") state.disabledExpanded = !state.disabledExpanded;
      renderTaskSidebar();
    });
  });
}

function fellowName(fellowId) {
  const f = state.fellows?.find((x) => x.key === fellowId || x.id === fellowId);
  return f?.name || fellowId;
}

function formatNextTime(ms) {
  const d = new Date(ms);
  return d.toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function formatRunTime(ms) {
  const d = new Date(ms);
  return d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
```

- [ ] **Step 5: 把 sidebar 渲染挂到现有 view 切换路径**

找到 rail 按钮点击路由的 dispatch（grep `data-view`）。加 case：

```javascript
if (view === "tasks") {
  els.tasksSidebar.classList.remove("hidden");
  els.tasksView.classList.remove("hidden");
  loadTasksFromDaemon();
  renderTaskSidebar();
  renderTaskView();
}
```

并在切走时 hide：

```javascript
els.tasksSidebar.classList.add("hidden");
els.tasksView.classList.add("hidden");
```

- [ ] **Step 6: 写 loadTasksFromDaemon 和 SSE 订阅**

```javascript
async function loadTasksFromDaemon() {
  try {
    state.tasks = await window.aimashi.tasks.list();
  } catch (e) {
    console.error("load tasks failed", e);
    state.tasks = [];
  }
}

let tasksUnsubscribe = null;
function subscribeTaskEvents() {
  if (tasksUnsubscribe) return;
  tasksUnsubscribe = window.aimashi.tasks.subscribe(async (envelope) => {
    await loadTasksFromDaemon();
    if (envelope.type === "finished" || envelope.type === "failed") {
      const taskId = envelope.payload?.taskId;
      if (taskId && state.selectedTaskId !== taskId) {
        state.tasksUnread.set(taskId, (state.tasksUnread.get(taskId) || 0) + 1);
      }
    }
    updateTasksRailBadge();
    if (currentView === "tasks") {
      renderTaskSidebar();
      renderTaskView();
    }
  });
}

function updateTasksRailBadge() {
  const total = [...state.tasksUnread.values()].reduce((a, b) => a + b, 0);
  if (!els.tasksUnreadBadge) return;
  if (total > 0) {
    els.tasksUnreadBadge.classList.remove("hidden");
    els.tasksUnreadBadge.textContent = String(total > 99 ? "99+" : total);
  } else {
    els.tasksUnreadBadge.classList.add("hidden");
  }
}
```

并在 app 启动后 (`initialize()` 或类似) 调一次 `subscribeTaskEvents()`。

- [ ] **Step 7: 启动 app 验证**

```bash
npm run open
```

进入「任务」tab，应看到空 state 或之前测试时创建的 task 列表。把 `state.tasks` 推一条 mock 数据到 console 验证渲染。

- [ ] **Step 8: 提交**

```bash
git add src/renderer/app.js src/main/tasks-routes.js
git commit -m "feat(tasks): render task sidebar with grouping + unread badge"
```

---

### Task 15: render task workspace state a（选中任务）

**Files:**
- Modify: `src/renderer/app.js`

- [ ] **Step 1: 写 renderTaskView 入口和 state a 分支**

```javascript
function renderTaskView() {
  if (!els.tasksContent) return;
  setText(els.tasksPageTitle, "任务");
  setText(els.tasksPageMeta, `${state.tasks.filter(t => t.status === "active").length} 个活跃`);
  if (!state.selectedTaskId) { renderTasksEmpty(); return; }
  const task = state.tasks.find(t => t.id === state.selectedTaskId);
  if (!task) { renderTasksEmpty(); return; }
  if (state.selectedRunId) { renderRunDetail(task); return; }
  renderTaskDetail(task);
}

function renderTaskDetail(task) {
  els.tasksContent.innerHTML = `
    <article class="task-detail">
      <header class="task-detail-head">
        <div class="task-detail-source">
          <small>来源会话</small>
          <strong>${escapeHtml(sessionTitle(task.sessionId))} · ${escapeHtml(fellowName(task.fellowId))}</strong>
          <button class="link" data-jump-session="${escapeHtml(task.sessionId)}">[打开 →]</button>
        </div>
        <div class="task-detail-actions">
          <button class="secondary" data-action="run-now">运行一次</button>
          <button class="secondary" data-action="${task.status === "paused" ? "resume" : "pause"}">${task.status === "paused" ? "启用" : "暂停"}</button>
          <button class="danger" data-action="delete">删除</button>
        </div>
      </header>
      <section class="task-schedule">
        <h3>调度</h3>
        <div class="task-form-row">
          <label><input type="radio" name="triggerType" value="cron" ${task.trigger.type === "cron" ? "checked" : ""}>重复</label>
          <label><input type="radio" name="triggerType" value="oneshot" ${task.trigger.type === "oneshot" ? "checked" : ""}>一次性</label>
          <label><input type="radio" name="triggerType" value="event" disabled>事件触发（V1 不可用）</label>
        </div>
        <div class="task-form-row" ${task.trigger.type === "cron" ? "" : "hidden"}>
          <label>Cron <input id="taskCron" value="${escapeHtml(task.trigger.cron || "")}"></label>
        </div>
        <div class="task-form-row" ${task.trigger.type === "oneshot" ? "" : "hidden"}>
          <label>触发时间 <input id="taskAt" type="datetime-local" value="${task.trigger.at ? toLocalDatetime(task.trigger.at) : ""}"></label>
        </div>
        <div class="task-form-row">
          <label>时区 <input id="taskTimezone" value="${escapeHtml(task.timezone || "UTC")}"></label>
        </div>
        <div class="task-form-row">
          <small>下次: ${task.nextFireAt ? formatRunTime(task.nextFireAt) : "—"}</small>
        </div>
      </section>
      <section class="task-prompt">
        <h3>Prompt</h3>
        <textarea id="taskPrompt" rows="3">${escapeHtml(task.prompt)}</textarea>
      </section>
      <section class="task-history">
        <h3>历史记录 (${task.runs.length})</h3>
        ${task.runs.slice(-20).reverse().map((run) => `
          <button class="task-history-row" data-run-id="${escapeHtml(run.id)}">
            <span>${run.status === "ok" ? "✓" : run.status === "failed" ? "✗" : "·"}</span>
            <span>${formatRunTime(run.firedAt)}</span>
            <span>${run.status === "failed" ? "失败" : "完成"}</span>
            <em>→ 查看本次输出</em>
          </button>
        `).join("")}
        ${task.runs.length > 20 ? `<button class="link" data-action="show-all-runs">展开全部 ${task.runs.length} 条</button>` : ""}
      </section>
    </article>
  `;
  attachTaskDetailHandlers(task);
}
```

- [ ] **Step 2: 写 attachTaskDetailHandlers（autosave + 按钮）**

```javascript
function attachTaskDetailHandlers(task) {
  const debouncedSave = debounce(async (patch) => {
    try {
      const updated = await window.aimashi.tasks.update(task.id, patch);
      const idx = state.tasks.findIndex(t => t.id === task.id);
      if (idx >= 0) state.tasks[idx] = updated;
      renderTaskSidebar();
    } catch (e) {
      console.error("update task failed", e);
    }
  }, 400);

  document.querySelectorAll("[name=triggerType]").forEach((r) => {
    r.addEventListener("change", () => {
      if (r.value === "event") return; // disabled anyway
      debouncedSave({ trigger: { type: r.value, cron: task.trigger.cron, at: task.trigger.at } });
    });
  });
  document.getElementById("taskCron")?.addEventListener("input", (e) => {
    debouncedSave({ trigger: { ...task.trigger, type: "cron", cron: e.target.value } });
  });
  document.getElementById("taskAt")?.addEventListener("input", (e) => {
    debouncedSave({ trigger: { ...task.trigger, type: "oneshot", at: new Date(e.target.value).toISOString() } });
  });
  document.getElementById("taskTimezone")?.addEventListener("input", (e) => {
    debouncedSave({ timezone: e.target.value });
  });
  document.getElementById("taskPrompt")?.addEventListener("input", (e) => {
    debouncedSave({ prompt: e.target.value });
  });
  els.tasksContent.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const action = btn.dataset.action;
      try {
        if (action === "run-now")  await window.aimashi.tasks.runNow(task.id);
        if (action === "pause")    await window.aimashi.tasks.pause(task.id);
        if (action === "resume")   await window.aimashi.tasks.resume(task.id);
        if (action === "delete") {
          if (!confirm(`删除任务「${task.title}」？已发生的历史记录会保留在会话里。`)) return;
          await window.aimashi.tasks.delete(task.id);
          state.selectedTaskId = "";
        }
      } catch (e) { console.error(e); }
      await loadTasksFromDaemon();
      renderTaskSidebar();
      renderTaskView();
    });
  });
  els.tasksContent.querySelectorAll("[data-run-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.selectedRunId = btn.dataset.runId;
      renderTaskSidebar();
      renderTaskView();
    });
  });
  els.tasksContent.querySelectorAll("[data-jump-session]").forEach((btn) => {
    btn.addEventListener("click", () => {
      jumpToSession(btn.dataset.jumpSession);
    });
  });
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function toLocalDatetime(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function jumpToSession(sessionId) {
  // existing app code: switch view back to chat and select session
  // grep for an existing "set active session" function to reuse here
  selectSession(sessionId);
  switchView("chat");
}

function sessionTitle(sessionId) {
  return state.allSessions?.find((s) => s.id === sessionId)?.title || sessionId;
}
```

- [ ] **Step 3: 验证手动**

启动 app，手工通过 daemon HTTP 加几条任务（用 curl + token），刷新看渲染：

```bash
# 找到 daemon baseUrl + token
cat ~/Library/Application\ Support/Aimashi/aimashi-daemon.json
cat ~/Library/Application\ Support/Aimashi/aimashi-daemon.key
TOKEN=$(cat ~/Library/Application\ Support/Aimashi/aimashi-daemon.key)
curl -X POST http://127.0.0.1:PORT/api/tasks \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"测试","fellowId":"FELLOW_KEY","sessionId":"SESSION_ID","originMessageId":"m","trigger":{"type":"cron","cron":"0 9 * * *"},"timezone":"Asia/Shanghai","prompt":"测试"}'
```

回到 GUI 进任务 tab，应看到这条任务。点击 → 右栏出现编辑表单。

- [ ] **Step 4: 提交**

```bash
git add src/renderer/app.js
git commit -m "feat(tasks): render task detail with inline edit"
```

---

### Task 16: render task workspace state b（选中历史记录）

**Files:**
- Modify: `src/renderer/app.js`

- [ ] **Step 1: 写 renderRunDetail**

```javascript
function renderRunDetail(task) {
  const run = task.runs.find((r) => r.id === state.selectedRunId);
  if (!run) { state.selectedRunId = ""; renderTaskDetail(task); return; }
  const message = lookupMessage(task.sessionId, run.outputMessageId);
  els.tasksContent.innerHTML = `
    <article class="run-detail">
      <header class="run-detail-head">
        <button class="link" data-action="back-to-task">← 返回任务</button>
        <h2>${escapeHtml(task.title)} · ${formatRunTime(run.firedAt)} ${run.status === "ok" ? "完成" : "失败"}</h2>
        <div class="run-detail-actions">
          <button class="link" data-action="open-conversation">打开对话 →</button>
          <button class="secondary" data-action="run-now">运行一次</button>
        </div>
      </header>
      <details class="run-detail-prompt">
        <summary>原始指令</summary>
        <pre>${escapeHtml(task.prompt)}</pre>
      </details>
      <section class="run-detail-output">
        <h3>AI 输出</h3>
        ${message
          ? renderMessage(message, { fellow: state.fellows?.find(f => f.key === task.fellowId), showAvatar: true, showTaskAffordance: false })
          : `<div class="run-detail-empty">本次输出消息已不在会话历史里（可能被清理过）。${run.error ? `失败原因：${escapeHtml(run.error)}` : ""}</div>`
        }
      </section>
    </article>
  `;
  els.tasksContent.querySelector("[data-action='back-to-task']").addEventListener("click", () => {
    state.selectedRunId = "";
    renderTaskSidebar();
    renderTaskView();
  });
  els.tasksContent.querySelector("[data-action='open-conversation']").addEventListener("click", () => {
    jumpToSession(task.sessionId);
  });
  els.tasksContent.querySelector("[data-action='run-now']").addEventListener("click", async () => {
    await window.aimashi.tasks.runNow(task.id);
    await loadTasksFromDaemon();
    renderTaskView();
  });
}

function lookupMessage(sessionId, messageId) {
  if (!messageId) return null;
  const session = state.allSessions?.find((s) => s.id === sessionId);
  if (!session) return null;
  return session.messages?.find((m) => m.id === messageId) || null;
}
```

- [ ] **Step 2: 确认 renderMessage（Task 11 抽出来的）签名匹配**

它应该能接受 `(message, ctx)` 并返回 HTML 字符串。如不返回字符串而是直接挂 DOM，调整为返回字符串或在这里改成 appendChild。

- [ ] **Step 3: 验证手动**

进任务 → 触发"运行一次" → 等任务跑完 → 看 sidebar 历史区出现一条 → 点开 → 右栏显示 AI 输出。

- [ ] **Step 4: 提交**

```bash
git add src/renderer/app.js
git commit -m "feat(tasks): render history detail with inline message reuse"
```

---

### Task 17: task-fire 角标 in chatView

**Files:**
- Modify: `src/renderer/app.js`

- [ ] **Step 1: 在 renderMessage 里识别 task-fire message**

在 renderMessage 函数里，message 有 `meta.taskId` 时，前面加 affordance bar：

```javascript
// 在 renderMessage 里 message body 上方
const taskMeta = message.meta?.taskId ? state.tasks.find(t => t.id === message.meta.taskId) : null;
const affordanceHtml = (ctx.showTaskAffordance && taskMeta)
  ? `<div class="task-fire-affordance">
       📅 来自定时任务「${escapeHtml(taskMeta.title)}」·
       ${formatRunTime(message.meta.firedAt || message.createdAt)} ·
       <button class="link" data-jump-task="${escapeHtml(taskMeta.id)}">打开任务</button>
     </div>`
  : "";
// 把 affordanceHtml 拼在 message body 之前
```

- [ ] **Step 2: 在 chat container 上加 jump-task click handler**

找到 chat container 已有的 delegated handler（grep `chat.addEventListener` 或类似），加：

```javascript
const jumpBtn = e.target.closest("[data-jump-task]");
if (jumpBtn) {
  state.selectedTaskId = jumpBtn.dataset.jumpTask;
  state.selectedRunId = "";
  switchView("tasks");
  els.tasksSidebar.classList.remove("hidden");
  els.tasksView.classList.remove("hidden");
  renderTaskSidebar();
  renderTaskView();
  return;
}
```

- [ ] **Step 3: 验证**

跑一次任务 → 进对应 fellow 会话 → 看到 AI 输出消息上方有 "📅 来自定时任务..." → 点 "打开任务" → 跳到任务 tab + 选中那条 task。

- [ ] **Step 4: 提交**

```bash
git add src/renderer/app.js
git commit -m "feat(tasks): task-fire affordance bar in chatView"
```

---

### Task 18: 空状态

**Files:**
- Modify: `src/renderer/app.js`

- [ ] **Step 1: 写 renderTasksEmpty**

```javascript
function renderTasksEmpty() {
  els.tasksContent.innerHTML = `
    <div class="tasks-empty">
      <div class="tasks-empty-emoji">📅</div>
      <h2>还没有定时任务</h2>
      <p>回到任意聊天告诉 Aimashi：<br><em>"每天 9 点帮我做 X"</em><br>它会自动帮你建好任务。</p>
    </div>
  `;
}
```

- [ ] **Step 2: 加 CSS（在现有 renderer 样式文件，参考其它 -empty 类的风格）**

```css
.tasks-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
  color: var(--color-text-secondary, #999);
  gap: 12px;
}
.tasks-empty-emoji { font-size: 64px; opacity: 0.8; }
.task-fire-affordance {
  font-size: 12px; color: var(--color-text-secondary, #888);
  border-top: 1px dashed var(--color-border, #ddd);
  border-bottom: 1px dashed var(--color-border, #ddd);
  padding: 4px 8px; margin: 8px 0;
}
.task-fire-affordance .link { background: none; border: none; color: var(--accent); cursor: pointer; }
```

- [ ] **Step 3: 验证**

清空所有任务，进任务 tab → 看到引导文案。

- [ ] **Step 4: 提交**

```bash
git add src/renderer/app.js src/renderer/
git commit -m "feat(tasks): empty state + task-fire affordance styling"
```

---

## Phase 4: End-to-end smoke + verify

### Task 19: E2E smoke 验证

**Files:**
- 无新文件；手动 + 文档

- [ ] **Step 1: 跑全部自动测试**

```bash
npm test
```

Expected: 所有测试 PASS（含 tasks-store / scheduler / scheduler-fire / scheduler-mcp / tasks-routes）。

- [ ] **Step 2: 启动 daemon + GUI**

```bash
npm run open
```

`/api/tasks/events` 订阅应在 console 看到 connected 日志。

- [ ] **Step 3: 通过对话创建任务（端到端）**

在一个 fellow 会话里发："每分钟帮我说一次 hello"

预期：
- fellow 解析 → 调 `schedule.create` → 返回 taskId
- fellow 在会话里回一条确认（如果它写了的话）
- 进任务 tab → 看到这条任务
- 等 1 分钟 → AI 在原会话里 push 一条 "hello" 消息，消息上方有 📅 角标
- rail 角标 +1
- 任务 tab 历史区出现新一条记录

- [ ] **Step 4: 手动 inline 编辑验证**

任务详情里：
- 改 cron 为 `*/2 * * * *` → autosave → 下次时间变化
- 暂停 → 状态变 paused → 该任务进"已停用"折叠组 → 不再 fire
- 启用 → 恢复 active

- [ ] **Step 5: 关 GUI、保留 daemon 验证**

```bash
# 关闭 Aimashi.app 窗口（不退出 daemon）
# 等下一次 fire
# 重新打开 Aimashi.app → 应看到 daemon 关期间的 fire 已经在历史里
tail -F ~/Library/Logs/Aimashi/daemon.log  # 或类似日志
```

- [ ] **Step 6: 校对 spec coverage**

打开 `docs/superpowers/specs/2026-05-20-aimashi-task-rail-redesign.md`，逐节对照实现是否落地：
- §3 导航变更 ✓
- §4 实体 schema ✓
- §5 用户流程（create / fire / view / edit / cascade）✓
- §6 布局 ✓
- §7 架构 ✓
- §8 文件级改动 ✓
- §9 不变量 ✓
- §10 V2 预留 ✓

发现缺失项 → 补任务。

- [ ] **Step 7: 提交收尾**

```bash
git status
# 应无 untracked / unstaged 文件
echo "task rail implementation complete" > /dev/null
```

如果有 docs 改动（如把 spec 标为"已实施"），提交：

```bash
git add docs/superpowers/specs/2026-05-20-aimashi-task-rail-redesign.md
git commit -m "docs: mark task rail spec as shipped"
```

---

## 收尾 checklist

实施完成前再过一遍：

- [ ] 所有 `npm test` 通过
- [ ] GUI 关闭时 daemon 继续 fire 任务（实测）
- [ ] AI 通过对话创建任务可用（实测 Hermes 至少一个 fellow）
- [ ] AI 通过对话创建任务可用（实测 Claude Code 或 Codex MCP path 至少一个 fellow）
- [ ] 任务详情 inline 编辑全字段 autosave 正常
- [ ] task-fire 消息在原会话里带 📅 角标
- [ ] rail 角标计数正确（fire 时 +1，进任务 tab 后清零）
- [ ] 历史记录默认折叠
- [ ] 空状态文案正确
- [ ] 删除 fellow / session 时孤儿任务自动 paused
- [ ] 一次性任务 fire 成功后状态转 done
- [ ] 删除任务后历史 message 仍在原会话里（不级联删 message）
- [ ] 启动 / 关 daemon 多次 → 任务持久化正常
- [ ] `~/Library/Application Support/Aimashi/aimashi-tasks.json` 文件存在且 schema 正确
- [ ] 把这一行 spec coverage 检查放进 commit message 里：参 spec §X 已实现 / §Y V2 留位
