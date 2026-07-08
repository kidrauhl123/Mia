const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const zlib = require("node:zlib");
const { test } = require("node:test");

const root = path.join(__dirname, "..");

class MockElement {
  constructor(id = "") {
    this.id = id;
    this.hidden = false;
    this.dataset = {};
    this.style = { setProperty() {} };
    this._html = "";
    this.innerHTMLWrites = 0;
    this.classList = {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; }
    };
  }

  set innerHTML(value) {
    this.innerHTMLWrites += 1;
    this._html = String(value || "");
  }
  get innerHTML() { return this._html; }
  set textContent(value) { this._text = String(value || ""); }
  get textContent() { return this._text || ""; }

  addEventListener() {}
  getBoundingClientRect() { return { left: 0, width: 120 }; }

  querySelector(selector) {
    if (selector === "button.active") return new MockElement("active-button");
    return null;
  }

  querySelectorAll(selector) {
    if (selector === "[data-mode]") return dataElements(this._html, "mode");
    if (selector === "[data-history-filter]") return dataElements(this._html, "historyFilter", "history-filter");
    if (selector === "[data-run-card]") return dataElements(this._html, "runCard", "run-card");
    if (selector === "[data-task-id]") return dataElements(this._html, "taskId", "task-id");
    return [];
  }
}

function dataElements(html, datasetKey, attrName = datasetKey) {
  const attr = attrName.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
  const out = [];
  const re = new RegExp(`data-${attr}(?:="([^"]*)")?`, "g");
  let match;
  while ((match = re.exec(html))) {
    const el = new MockElement();
    el.dataset[datasetKey] = match[1] || "";
    out.push(el);
  }
  return out;
}

function loadTasksPanel() {
  const source = fs.readFileSync(path.join(root, "src/renderer/tasks/tasks-panel.js"), "utf8");
  const elements = new Map([
    ["taskModeToggle", new MockElement("taskModeToggle")],
    ["taskChipRow", new MockElement("taskChipRow")],
    ["taskPreviewDialog", new MockElement("taskPreviewDialog")],
    ["taskPreviewBody", new MockElement("taskPreviewBody")],
    ["taskPreviewTitle", new MockElement("taskPreviewTitle")],
    ["taskPreviewMeta", new MockElement("taskPreviewMeta")]
  ]);
  const mockWindow = {
    miaContact: require("../src/shared/contact"),
    miaUnread: require("../src/shared/unread"),
    addEventListener() {},
    requestAnimationFrame: (fn) => fn()
  };
  const context = vm.createContext({
    window: mockWindow,
    globalThis: mockWindow,
    document: {
      getElementById: (id) => elements.get(id) || null,
      addEventListener() {}
    },
    require,
    console,
    Date,
    Map,
    Set,
    String,
    Number,
    Infinity,
    Array,
    Object,
    RegExp,
    AbortController,
    requestAnimationFrame: (fn) => fn()
  });
  vm.runInContext(source, context, { filename: "src/renderer/tasks/tasks-panel.js" });
  return { panel: mockWindow.miaTasksPanel, elements };
}

test("tasks history unread appears on the history tab and unread run cards", () => {
  const { panel, elements } = loadTasksPanel();
  const state = {
    runtime: { bots: [{ id: "nhnh", key: "nhnh", name: "nhnh" }] },
    tasks: [{
      id: "task_1",
      title: "吃饭提醒",
      botId: "nhnh",
      status: "done",
      prompt: "提醒我吃饭。",
      trigger: { type: "oneshot", at: Date.now() - 60_000 },
      runs: [{ id: "run_1", status: "ok", firedAt: Date.now() - 30_000, outputText: "该吃饭了。" }]
    }],
    taskFilter: "",
    taskMode: "active",
    taskHistoryFilter: "all",
    selectedTaskId: "",
    selectedRunId: "",
    tasksUnread: new Map([["task_1", 1]])
  };
  const tasksContent = new MockElement("tasksContent");
  const tasksUnreadBadge = new MockElement("tasksUnreadBadge");

  panel.initTasksPanel({
    state,
    els: { tasksContent, tasksUnreadBadge },
    escapeHtml: (value) => String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;"),
    setText: (el, value) => { if (el) el.textContent = value; },
    formatRunTime: () => "06/02 18:20",
    render() {},
    renderView() {},
    renderChat() {}
  });

  panel.renderTaskView();
  assert.match(elements.get("taskModeToggle").innerHTML, /data-mode="history"[\s\S]*task-mode-unread/);

  state.taskMode = "history";
  panel.renderTaskView();
  assert.match(tasksContent.innerHTML, /task-run-card[\s\S]*task-card-unread/);
});

test("active tasks empty state uses the schedule lottie for any empty active list", () => {
  const { panel } = loadTasksPanel();
  const state = {
    runtime: { bots: [{ id: "nhnh", key: "nhnh", name: "nhnh" }] },
    tasks: [{
      id: "task_1",
      title: "已完成提醒",
      botId: "nhnh",
      status: "done",
      prompt: "提醒我。",
      trigger: { type: "oneshot", at: Date.now() - 60_000 },
      runs: [{ id: "run_1", status: "ok", firedAt: Date.now() - 30_000, outputText: "完成。" }]
    }],
    taskFilter: "",
    taskMode: "active",
    taskHistoryFilter: "all",
    selectedTaskId: "",
    selectedRunId: "",
    tasksUnread: new Map()
  };
  const tasksContent = new MockElement("tasksContent");
  const tasksUnreadBadge = new MockElement("tasksUnreadBadge");

  panel.initTasksPanel({
    state,
    els: { tasksContent, tasksUnreadBadge },
    escapeHtml: (value) => String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;"),
    setText: (el, value) => { if (el) el.textContent = value; },
    formatRunTime: () => "06/02 18:20",
    render() {},
    renderView() {},
    renderChat() {}
  });

  panel.renderTaskView();

  assert.match(tasksContent.innerHTML, /class="tasks-empty tasks-empty-active"/);
  assert.match(tasksContent.innerHTML, /data-lottie="task-schedule"/);
  assert.match(tasksContent.innerHTML, /data-lottie-path="\.\/assets\/lottie\/task-schedule\.tgs"/);
  assert.match(tasksContent.innerHTML, /data-lottie-format="tgs"/);
  assert.match(tasksContent.innerHTML, /data-lottie-trigger="loop"/);
  assert.match(tasksContent.innerHTML, /还没有活跃任务/);
  assert.doesNotMatch(tasksContent.innerHTML, /tasks-empty-emoji|没有匹配的活跃任务/);
});

test("task schedule empty-state lottie asset is bundled as valid TGS", () => {
  const assetPath = path.join(root, "src/renderer/assets/lottie/task-schedule.tgs");
  const animation = JSON.parse(zlib.gunzipSync(fs.readFileSync(assetPath)).toString("utf8"));

  assert.equal(animation.w, 512);
  assert.equal(animation.h, 512);
  assert.ok(Number(animation.op) > 0);
});

test("task create shows Core schedule validation errors instead of owning future-time validation", () => {
  const source = fs.readFileSync(path.join(root, "src/renderer/tasks/tasks-panel.js"), "utf8");

  assert.doesNotMatch(source, /执行时间必须在未来/);
  assert.doesNotMatch(source, /at\.getTime\(\)\s*<=\s*Date\.now\(\)/);
  assert.match(source, /function taskCreateErrorMessage\(error\)/);
  assert.match(source, /showError\(taskCreateErrorMessage\(e\)\)/);
});

test("task create sends declarative schedule intent instead of renderer-owned cron", () => {
  const source = fs.readFileSync(path.join(root, "src/renderer/tasks/tasks-panel.js"), "utf8");

  assert.match(source, /const scheduleIntent = \{ kind: freq, time, timezone \}/);
  assert.match(source, /window\.mia\.tasks\.create\(\{ title, botId, conversationId, instructions: prompt, scheduleIntent \}\)/);
  assert.doesNotMatch(source, /trigger\s*=\s*\{/);
  assert.doesNotMatch(source, /cron:\s*`\$\{m\}/);
});

test("task mode and history chips are stable across unchanged renders", () => {
  const { panel, elements } = loadTasksPanel();
  const state = {
    runtime: { bots: [{ id: "nhnh", key: "nhnh", name: "nhnh" }] },
    tasks: [{
      id: "task_1",
      title: "吃饭提醒",
      botId: "nhnh",
      status: "active",
      prompt: "提醒我吃饭。",
      trigger: { type: "oneshot", at: Date.now() + 60_000 },
      nextFireAt: Date.now() + 60_000,
      runs: [{ id: "run_1", status: "ok", firedAt: Date.now() - 30_000, outputText: "该吃饭了。" }]
    }],
    taskFilter: "",
    taskMode: "history",
    taskHistoryFilter: "all",
    selectedTaskId: "",
    selectedRunId: "",
    tasksUnread: new Map()
  };
  const tasksContent = new MockElement("tasksContent");
  const tasksUnreadBadge = new MockElement("tasksUnreadBadge");

  panel.initTasksPanel({
    state,
    els: { tasksContent, tasksUnreadBadge },
    escapeHtml: (value) => String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;"),
    setText: (el, value) => { if (el) el.textContent = value; },
    formatRunTime: () => "06/02 18:20",
    render() {},
    renderView() {},
    renderChat() {}
  });

  panel.renderTaskView();
  const modeWrites = elements.get("taskModeToggle").innerHTMLWrites;
  const chipWrites = elements.get("taskChipRow").innerHTMLWrites;
  const contentWrites = tasksContent.innerHTMLWrites;
  panel.renderTaskView();

  assert.equal(elements.get("taskModeToggle").innerHTMLWrites, modeWrites);
  assert.equal(elements.get("taskChipRow").innerHTMLWrites, chipWrites);
  assert.equal(tasksContent.innerHTMLWrites, contentWrites);
});

test("direct delivery task detail shows delivery text instead of scheduling prompt", () => {
  const { panel, elements } = loadTasksPanel();
  const state = {
    runtime: { bots: [{ id: "nhnh", key: "nhnh", name: "nhnh" }] },
    tasks: [{
      id: "task_1",
      title: "发布提醒",
      botId: "nhnh",
      status: "active",
      fireMode: "deliver",
      deliveryText: "该发布新版本了",
      prompt: "提醒我发布新版本",
      trigger: { type: "oneshot", at: Date.now() + 60_000 },
      nextFireAt: Date.now() + 60_000,
      runs: []
    }],
    taskFilter: "",
    taskMode: "active",
    taskHistoryFilter: "all",
    selectedTaskId: "task_1",
    selectedRunId: "",
    tasksUnread: new Map()
  };
  const tasksContent = new MockElement("tasksContent");
  const tasksUnreadBadge = new MockElement("tasksUnreadBadge");

  panel.initTasksPanel({
    state,
    els: { tasksContent, tasksUnreadBadge },
    escapeHtml: (value) => String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;"),
    setText: (el, value) => { if (el) el.textContent = value; },
    formatRunTime: () => "06/02 18:20",
    render() {},
    renderView() {},
    renderChat() {}
  });

  panel.renderTaskView();

  const detailHtml = elements.get("taskPreviewBody").innerHTML;
  assert.match(detailHtml, /该发布新版本了/);
  assert.doesNotMatch(detailHtml, /提醒我发布新版本/);
});
