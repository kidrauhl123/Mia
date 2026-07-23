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
    this._classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this._classes.add(name)),
      remove: (...names) => names.forEach((name) => this._classes.delete(name)),
      toggle: (name, force) => {
        if (force === true) this._classes.add(name);
        else if (force === false) this._classes.delete(name);
        else if (this._classes.has(name)) this._classes.delete(name);
        else this._classes.add(name);
        return this._classes.has(name);
      },
      contains: (name) => this._classes.has(name)
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

function loadTasksPanel(options = {}) {
  const source = fs.readFileSync(path.join(root, "src/renderer/tasks/tasks-panel.js"), "utf8");
  const elements = new Map([
    ["taskModeToggle", new MockElement("taskModeToggle")],
    ["taskChipRow", new MockElement("taskChipRow")],
    ["taskPreviewDialog", new MockElement("taskPreviewDialog")],
    ["taskPreviewBody", new MockElement("taskPreviewBody")],
    ["taskPreviewTitle", new MockElement("taskPreviewTitle")],
    ["taskPreviewActions", new MockElement("taskPreviewActions")]
  ]);
  const mockWindow = {
    miaContact: require("../src/shared/contact"),
    miaUnread: require("../src/shared/unread"),
    miaMarkdown: { renderMarkdown: (value) => String(value || "") },
    miaAvatar: {
      avatarHtml: ({ className, image, attrs }) =>
        `<div class="${className}" data-test-avatar-image="${image || ""}" ${attrs || ""}></div>`,
      hydrateAvatarMedia() {}
    },
    miaBotManager: { allOwnedBots: () => options.bots || [] },
    mia: options.mia,
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

test("task panel render entry points are inert before dependencies are injected", () => {
  const { panel } = loadTasksPanel();

  assert.doesNotThrow(() => panel.renderTaskView());
  assert.doesNotThrow(() => panel.updateTasksRailBadge());
});

test("task refresh keeps real cloud tasks and removes unread ids that no longer exist", async () => {
  const cloudTask = {
    id: "t-cloud-1",
    title: "吃饭提醒",
    status: "done",
    taskSource: "mia-cloud",
    runs: [{ id: "r-cloud-1", status: "ok", outputText: "该吃饭啦" }]
  };
  const { panel } = loadTasksPanel({
    mia: { tasks: { list: async () => [cloudTask] } }
  });
  const state = {
    tasks: [],
    tasksUnread: new Map([
      ["t-cloud-1", 1],
      ["t-orphan", 2]
    ])
  };

  panel.initTasksPanel({
    state,
    els: {},
    mia: { tasks: { list: async () => [cloudTask] } },
    escapeHtml: String,
    setText() {},
    formatRunTime: String,
    render() {},
    renderView() {},
    renderChat() {}
  });

  await panel.loadTasksFromDaemon();

  assert.deepEqual(state.tasks, [cloudTask]);
  assert.equal(state.tasksUnread.get("t-cloud-1"), 1);
  assert.equal(state.tasksUnread.has("t-orphan"), false);
});

test("task completion event never creates an unread badge for a task absent from the real list", async () => {
  const { panel } = loadTasksPanel({
    mia: { tasks: { list: async () => [] } }
  });
  const state = {
    activeView: "chat",
    selectedTaskId: "",
    tasks: [],
    tasksUnread: new Map()
  };

  panel.initTasksPanel({
    state,
    els: {},
    mia: { tasks: { list: async () => [] } },
    escapeHtml: String,
    setText() {},
    formatRunTime: String,
    render() {},
    renderView() {},
    renderChat() {}
  });

  await panel.handleTaskEvent({ type: "finished", payload: { taskId: "t-missing" } });

  assert.equal(state.tasksUnread.size, 0);
});

test("task unread updates both rail and bottom navigation badges", () => {
  const { panel } = loadTasksPanel();
  const state = {
    tasks: [],
    tasksUnread: new Map([["t-cloud-1", 2]])
  };
  const tasksUnreadBadge = new MockElement("tasksUnreadBadge");
  const sidebarTasksUnreadBadge = new MockElement("sidebarTasksUnreadBadge");

  panel.initTasksPanel({
    state,
    els: { tasksUnreadBadge, sidebarTasksUnreadBadge },
    escapeHtml: String,
    setText() {},
    formatRunTime: String,
    render() {},
    renderView() {},
    renderChat() {}
  });

  panel.updateTasksRailBadge();
  assert.equal(tasksUnreadBadge.textContent, "2");
  assert.equal(sidebarTasksUnreadBadge.textContent, "2");
  assert.equal(tasksUnreadBadge.classList.contains("hidden"), false);
  assert.equal(sidebarTasksUnreadBadge.classList.contains("hidden"), false);

  state.tasksUnread.clear();
  panel.updateTasksRailBadge();
  assert.equal(tasksUnreadBadge.classList.contains("hidden"), true);
  assert.equal(sidebarTasksUnreadBadge.classList.contains("hidden"), true);
});

test("task history groups runs into one unread card per task", () => {
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
      runs: [
        { id: "run_old", status: "failed", firedAt: Date.now() - 45_000, error: "旧的失败" },
        { id: "run_1", status: "ok", firedAt: Date.now() - 30_000, outputText: "该吃饭了。" }
      ]
    }],
    taskFilter: "",
    taskMode: "active",
    taskHistoryFilter: "all",
    selectedTaskId: "",
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
  assert.match(elements.get("taskModeToggle").innerHTML, /data-mode="history"[\s\S]*task-mode-count">1</);

  state.taskMode = "history";
  panel.renderTaskView();
  assert.equal((tasksContent.innerHTML.match(/task-history-card/g) || []).length, 1);
  assert.match(tasksContent.innerHTML, /task-history-card[\s\S]*该吃饭了。[\s\S]*执行 2 次[\s\S]*task-card-unread/);
  assert.doesNotMatch(tasksContent.innerHTML, /旧的失败/);
  assert.match(elements.get("taskChipRow").innerHTML, /data-history-filter="all"[\s\S]*<span>1<\/span>/);
  assert.match(elements.get("taskChipRow").innerHTML, /data-history-filter="ok"[\s\S]*<span>1<\/span>/);
  assert.match(elements.get("taskChipRow").innerHTML, /data-history-filter="failed"[\s\S]*<span>0<\/span>/);
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
  assert.match(source, /mia\.tasks\.create\(\{ title, botId, conversationId, instructions: prompt, scheduleIntent \}\)/);
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

test("pending task detail does not reveal its original instruction", () => {
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
  assert.match(detailHtml, /等待首次执行/);
  assert.doesNotMatch(detailHtml, /该发布新版本了/);
  assert.doesNotMatch(detailHtml, /提醒我发布新版本/);
});

test("task detail stacks every real run as a chronological chat bubble", () => {
  const executorBot = {
    id: "starter_9038338_mia",
    key: "starter_9038338_mia",
    name: "Mia",
    avatarImage: "https://example.test/mia.png",
    avatarCrop: { x: 48, y: 52, zoom: 1.1 }
  };
  const { panel, elements } = loadTasksPanel({ bots: [executorBot] });
  const state = {
    runtime: { bots: [executorBot] },
    tasks: [{
      id: "t-cloud-1",
      title: "吃饭提醒",
      botId: "starter_9038338_mia",
      conversationId: "c-cloud-1",
      status: "done",
      taskSource: "mia-cloud",
      prompt: "2分钟后提醒我吃饭",
      trigger: { type: "oneshot", at: Date.now() - 120_000 },
      runs: [
        { id: "r-old", status: "ok", firedAt: Date.now() - 180_000, outputText: "旧的提醒" },
        { id: "r-latest", status: "ok", firedAt: Date.now() - 60_000, outputText: "该吃饭啦，别饿着肚子忙～" }
      ]
    }],
    taskFilter: "",
    taskMode: "history",
    taskHistoryFilter: "all",
    selectedTaskId: "t-cloud-1",
    tasksUnread: new Map()
  };

  panel.initTasksPanel({
    state,
    els: { tasksContent: new MockElement("tasksContent"), tasksUnreadBadge: new MockElement("tasksUnreadBadge") },
    escapeHtml: (value) => String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;"),
    setText: (el, value) => { if (el) el.textContent = value; },
    formatRunTime: () => "07/13 17:13",
    render() {},
    renderView() {},
    renderChat() {}
  });

  panel.renderTaskView();

  const detailHtml = elements.get("taskPreviewBody").innerHTML;
  assert.match(detailHtml, /class="task-detail-card"/);
  assert.equal((detailHtml.match(/class="task-output-row message assistant"/g) || []).length, 2);
  assert.equal((detailHtml.match(/class="avatar task-output-avatar"/g) || []).length, 2);
  assert.equal((detailHtml.match(/data-test-avatar-image="https:\/\/example\.test\/mia\.png"/g) || []).length, 2);
  assert.equal((detailHtml.match(/aria-label="打开对话"/g) || []).length, 2);
  assert.ok(detailHtml.indexOf("旧的提醒") < detailHtml.indexOf("该吃饭啦，别饿着肚子忙～"));
  assert.match(detailHtml, /class="bubble task-output-bubble"[\s\S]*旧的提醒/);
  assert.match(detailHtml, /class="bubble task-output-bubble"[\s\S]*该吃饭啦，别饿着肚子忙～/);
  assert.match(detailHtml, /data-jump-conversation="c-cloud-1"/);
  assert.doesNotMatch(detailHtml, /原始指令|历史记录|task-disclosure|data-run-id/);
  assert.doesNotMatch(detailHtml, /task-detail-sidebar|task-detail-main|data-action="run-now"|运行一次/);
  assert.doesNotMatch(elements.get("taskPreviewActions").innerHTML, /data-action="run-now"|运行一次/);
});

test("opening a history task card shows all outputs without a nested history control", () => {
  const { panel, elements } = loadTasksPanel();
  const state = {
    runtime: { bots: [{ id: "mia", key: "mia", name: "Mia" }] },
    tasks: [{
      id: "t-cloud-1",
      title: "吃饭提醒",
      botId: "mia",
      conversationId: "c-cloud-1",
      status: "done",
      taskSource: "mia-cloud",
      prompt: "提醒我吃饭",
      trigger: { type: "oneshot", at: Date.now() - 120_000 },
      runs: [
        { id: "r-old", status: "ok", firedAt: Date.now() - 180_000, outputText: "旧的真实输出" },
        { id: "r-latest", status: "ok", firedAt: Date.now() - 60_000, outputText: "最新输出" }
      ]
    }],
    taskFilter: "",
    taskMode: "history",
    taskHistoryFilter: "all",
    selectedTaskId: "t-cloud-1",
    tasksUnread: new Map()
  };

  panel.initTasksPanel({
    state,
    els: { tasksContent: new MockElement("tasksContent"), tasksUnreadBadge: new MockElement("tasksUnreadBadge") },
    escapeHtml: String,
    setText: (el, value) => { if (el) el.textContent = value; },
    formatRunTime: () => "07/13 17:10",
    render() {},
    renderView() {},
    renderChat() {}
  });

  panel.renderTaskView();

  const detailHtml = elements.get("taskPreviewBody").innerHTML;
  assert.match(detailHtml, /class="bubble task-output-bubble"[\s\S]*旧的真实输出/);
  assert.match(detailHtml, /class="bubble task-output-bubble"[\s\S]*最新输出/);
  assert.ok(detailHtml.indexOf("旧的真实输出") < detailHtml.indexOf("最新输出"));
  assert.doesNotMatch(detailHtml, /run-detail-output|返回任务|data-action="run-now"|原始指令|历史记录|data-run-id/);
});
