const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");

class MockElement {
  constructor(id = "") {
    this.id = id;
    this.hidden = false;
    this.dataset = {};
    this.style = { setProperty() {} };
    this._html = "";
    this.classList = {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; }
    };
  }

  set innerHTML(value) { this._html = String(value || ""); }
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
    document: { getElementById: (id) => elements.get(id) || null },
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
