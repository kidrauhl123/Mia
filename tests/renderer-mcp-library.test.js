const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const flushAsync = async (turns = 10) => {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
};

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function parseAttributes(raw = "") {
  const attrs = {};
  const pattern = /([A-Za-z0-9:_-]+)(?:="([^"]*)")?/g;
  let match;
  while ((match = pattern.exec(raw))) {
    attrs[match[1]] = decodeHtml(match[2] || "");
  }
  return attrs;
}

function selectedOptionValue(html) {
  const selected = html.match(/<option\b[^>]*value="([^"]*)"[^>]*selected[^>]*>/i)
    || html.match(/<option\b[^>]*selected[^>]*value="([^"]*)"[^>]*>/i);
  if (selected) return decodeHtml(selected[1]);
  const first = html.match(/<option\b[^>]*value="([^"]*)"[^>]*>/i);
  return first ? decodeHtml(first[1]) : "";
}

function datasetFromAttributes(attrs = {}) {
  const dataset = {};
  for (const [name, value] of Object.entries(attrs)) {
    if (!name.startsWith("data-")) continue;
    dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  return dataset;
}

function matchesSelector(node, selector) {
  const attr = selector.match(/^\[([^\]=]+)(?:="([^"]*)")?\]$/);
  if (attr) {
    const [, name, expected] = attr;
    if (!Object.prototype.hasOwnProperty.call(node.attributes, name)) return false;
    return typeof expected === "undefined" || String(node.attributes[name]) === expected;
  }
  const namedField = selector.match(/^([a-z]+)\[name="([^"]+)"\]$/i);
  if (namedField) {
    return node.tagName === namedField[1].toLowerCase() && node.name === namedField[2];
  }
  return false;
}

class FakeNode {
  constructor(tagName = "div", attrs = {}, documentRef = null) {
    this.tagName = String(tagName || "div").toLowerCase();
    this.attributes = { ...attrs };
    this.dataset = datasetFromAttributes(attrs);
    this.document = documentRef;
    this.parentNode = null;
    this.children = [];
    this.hidden = false;
    this.name = decodeHtml(attrs.name || "");
    this.value = decodeHtml(attrs.value || "");
    this.textContent = "";
    this.style = { setProperty() {} };
    this.classList = {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; }
    };
    this.listeners = new Map();
    this._innerHTML = "";
    this.innerHTMLWrites = 0;
    this._parsedNodes = [];
  }

  set innerHTML(value) {
    this.innerHTMLWrites += 1;
    this._innerHTML = String(value || "");
    this._parsedNodes = parseHtml(this._innerHTML, this.document);
    for (const node of this._parsedNodes) node.parentNode = this;
  }

  get innerHTML() {
    return this._innerHTML;
  }

  appendChild(node) {
    node.parentNode = this;
    this.children.push(node);
    return node;
  }

  remove() {
    if (!this.parentNode || !Array.isArray(this.parentNode.children)) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  dispatch(type, extra = {}) {
    const event = {
      type,
      target: this,
      currentTarget: this,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...extra
    };
    for (const handler of this.listeners.get(type) || []) handler(event);
    return event;
  }

  click() {
    return this.dispatch("click");
  }

  querySelectorAll(selector) {
    return queryAllFrom(this, selector);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "value") this.value = String(value);
    this.dataset = datasetFromAttributes(this.attributes);
  }

  getAttribute(name) {
    return this.attributes[name];
  }
}

function parseLeafNodes(html, documentRef) {
  const nodes = [];
  let match;

  const buttonPattern = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
  while ((match = buttonPattern.exec(html))) {
    const node = new FakeNode("button", parseAttributes(match[1]), documentRef);
    node.textContent = decodeHtml(match[2]);
    nodes.push(node);
  }

  const divPattern = /<div\b([^>]*)>([\s\S]*?)<\/div>/g;
  while ((match = divPattern.exec(html))) {
    const attrs = parseAttributes(match[1]);
    if (!Object.keys(attrs).some((name) => name.startsWith("data-"))) continue;
    nodes.push(new FakeNode("div", attrs, documentRef));
  }

  const labelPattern = /<label\b([^>]*)>/g;
  while ((match = labelPattern.exec(html))) {
    const attrs = parseAttributes(match[1]);
    if (!("data-mcp-stdio" in attrs) && !("data-mcp-url" in attrs)) continue;
    nodes.push(new FakeNode("label", attrs, documentRef));
  }

  const inputPattern = /<input\b([^>]*)>/g;
  while ((match = inputPattern.exec(html))) {
    nodes.push(new FakeNode("input", parseAttributes(match[1]), documentRef));
  }

  const textareaPattern = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g;
  while ((match = textareaPattern.exec(html))) {
    const node = new FakeNode("textarea", parseAttributes(match[1]), documentRef);
    node.value = decodeHtml(match[2]);
    nodes.push(node);
  }

  const selectPattern = /<select\b([^>]*)>([\s\S]*?)<\/select>/g;
  while ((match = selectPattern.exec(html))) {
    const node = new FakeNode("select", parseAttributes(match[1]), documentRef);
    node.value = selectedOptionValue(match[2]);
    nodes.push(node);
  }

  return nodes;
}

function parseHtml(html, documentRef) {
  const nodes = [];
  const formPattern = /<form\b([^>]*)>([\s\S]*?)<\/form>/g;
  let match;
  while ((match = formPattern.exec(html))) {
    const form = new FakeNode("form", parseAttributes(match[1]), documentRef);
    form.innerHTML = match[2];
    nodes.push(form);
  }
  const stripped = html.replace(formPattern, "");
  nodes.push(...parseLeafNodes(stripped, documentRef));
  return nodes;
}

function childNodes(node) {
  return [...node.children, ...node._parsedNodes];
}

function queryAllFrom(root, selector) {
  const matches = [];
  const visit = (node) => {
    for (const child of childNodes(node)) {
      if (matchesSelector(child, selector)) matches.push(child);
      visit(child);
    }
  };
  visit(root);
  return matches;
}

class FakeFormData {
  constructor(form) {
    this.values = new Map();
    for (const field of childNodes(form)) {
      if (!field.name) continue;
      this.values.set(field.name, field.value);
    }
  }

  get(name) {
    return this.values.has(name) ? this.values.get(name) : null;
  }
}

function createFakeDocument() {
  const listeners = new Map();
  const document = {
    body: null,
    createElement(tagName) {
      return new FakeNode(tagName, {}, document);
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    querySelectorAll(selector) {
      return document.body ? document.body.querySelectorAll(selector) : [];
    },
    querySelector(selector) {
      return document.body ? document.body.querySelector(selector) : null;
    }
  };
  document.body = new FakeNode("body", {}, document);
  return document;
}

function fakeEl(tagName = "div") {
  return new FakeNode(tagName);
}

function createMcpHarness({ state, mcpOverrides = {}, confirmResult = true } = {}) {
  let listCalls = 0;
  let marketplaceCalls = 0;
  let agentConfigCalls = 0;
  const alerts = [];
  const confirms = [];
  const document = createFakeDocument();
  const mcp = {
    list: async () => {
      listCalls += 1;
      return { success: true, data: { servers: state.mcp.servers || [] } };
    },
    fetchMarketplace: async () => {
      marketplaceCalls += 1;
      return { success: true, data: { templates: state.mcp.templates || [] } };
    },
    getAgentConfigs: async () => {
      agentConfigCalls += 1;
      return { success: true, data: { sources: state.mcp.agentConfigs || [] } };
    },
    save: async () => ({ success: true, data: {} }),
    importJson: async () => ({ success: true, data: {} }),
    importAgentConfig: async () => ({ success: true, data: {} }),
    test: async () => ({ success: true, data: {} }),
    sync: async () => ({ success: true, data: {} }),
    setEnabled: async () => ({ success: true, data: {} }),
    delete: async () => ({ success: true, data: {} }),
    installTemplate: async () => ({ success: true, data: {} }),
    oauth: {
      login: async () => ({ success: true, data: {} }),
      logout: async () => ({ success: true, data: {} })
    },
    ...mcpOverrides
  };
  const context = {
    console,
    document,
    FormData: FakeFormData,
    window: {
      alert: (message) => alerts.push(String(message || "")),
      confirm: (message) => {
        confirms.push(String(message || ""));
        return confirmResult;
      },
      mia: { mcp }
    }
  };
  vm.createContext(context);
  vm.runInContext(read("src/renderer/mcp/mcp-library.js"), context, { filename: "mcp-library.js" });

  const els = {
    skillPageTitle: fakeEl("h1"),
    skillChipRow: fakeEl("div"),
    skillCardGrid: fakeEl("div")
  };
  let layoutCalls = 0;
  context.window.miaMcpLibrary.initMcpLibrary({
    state,
    els,
    escapeHtml,
    setText: (node, value) => { node.textContent = String(value || ""); },
    layoutCards: () => { layoutCalls += 1; }
  });

  return {
    context,
    document,
    els,
    alerts,
    confirms,
    getLayoutCalls: () => layoutCalls,
    getListCalls: () => listCalls,
    getMarketplaceCalls: () => marketplaceCalls,
    getAgentConfigCalls: () => agentConfigCalls
  };
}

function bodyDialogHtml(harness) {
  return harness.document.body.children.map((child) => child.innerHTML || "").join("\n");
}

function assertMcpAlert(harness, expectedText) {
  const html = bodyDialogHtml(harness);
  assert.match(html, /data-mcp-alert/);
  assert.match(html, new RegExp(expectedText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

test("ability library exposes MCP service mode and loads MCP renderer script", () => {
  const appState = read("src/renderer/app-state.js");
  const skillLibrary = read("src/renderer/skills/skill-library.js");
  const html = read("src/renderer/index.html");
  const mcpCss = read("src/renderer/styles/mcp.css");

  assert.match(appState, /skillCapabilityMode:\s*"market"/);
  assert.match(appState, /mcp:\s*\{/);
  assert.match(skillLibrary, /data-skill-mode="mcp"/);
  assert.match(skillLibrary, /window\.miaMcpLibrary\.renderMcpLibrary/);
  assert.match(html, /styles\/mcp\.css/);
  assert.match(html, /mcp\/mcp-library\.js/);
  assert.match(mcpCss, /\.skill-chip-row\.mcp-toolbar-row\s*\{[\s\S]*background:\s*transparent/);
  assert.match(mcpCss, /\.mcp-connection-card\s*\{/);
  assert.match(mcpCss, /\.mcp-connect-status-connected\s*\{/);
  assert.match(mcpCss, /\.mcp-action-button\s*\{[\s\S]*font-size:\s*12\.5px;[\s\S]*white-space:\s*nowrap/);
  assert.match(mcpCss, /\.mcp-dialog-panel\s*\{[\s\S]*background:\s*color-mix\(in srgb,\s*#fff 96%,\s*var\(--surface\)\)/);
  assert.match(mcpCss, /\.mcp-dialog-panel input,[\s\S]*border:\s*1px solid color-mix\(in srgb,\s*var\(--text\) 16%,\s*transparent\)/);
  assert.match(mcpCss, /\.mcp-dialog-actions \.mcp-dialog-primary\s*\{[\s\S]*background:\s*var\(--accent\);[\s\S]*color:\s*#fff/);
  assert.match(mcpCss, /\.mcp-message-panel\s*\{/);
});

test("mcp renderer includes flat connection oauth and custom actions", () => {
  const src = read("src/renderer/mcp/mcp-library.js");
  assert.match(src, /connectMcpServer/);
  assert.match(src, /disconnectMcpServer/);
  assert.match(src, /oauth\.login/);
  assert.match(src, /oauth\.logout/);
  assert.match(src, /data-mcp-toolbar-action="create"/);
  assert.match(src, /connect-server/);
  assert.match(src, /disconnect-server/);
  assert.match(src, /oauth-login/);
  assert.doesNotMatch(src, /data-mcp-tab=/);
});

test("mcp-library renders one flat connection list without category capsules", () => {
  const state = {
    skillFilter: "",
    mcp: {
      activeTab: "installed",
      servers: [{
        id: "mcp_xhs",
        name: "小红书 MCP",
        nativeName: "xiaohongshu",
        registryId: "xiaohongshu",
        enabled: true,
        status: "connected",
        transport: { type: "http", url: "http://127.0.0.1:18060/mcp" },
        tools: [{ name: "search_notes" }],
        sync: {}
      }],
      templates: [
        { id: "xiaohongshu", name: "小红书 MCP", description: "本地 HTTP", transport: { type: "http" } },
        { id: "github", name: "GitHub MCP", description: "读取仓库", transport: { type: "stdio" } }
      ],
      loaded: true,
      loadAttempted: true,
      loading: false,
      error: "",
      serverError: "",
      templateError: ""
    }
  };
  const harness = createMcpHarness({ state });

  harness.context.window.miaMcpLibrary.renderMcpLibrary();

  const html = harness.els.skillCardGrid.innerHTML;
  assert.match(html, /小红书 MCP/);
  assert.match(html, /GitHub MCP/);
  assert.match(html, /已连接/);
  assert.match(html, /未连接/);
  assert.match(html, /data-mcp-action="disconnect-server"/);
  assert.match(html, /data-mcp-action="connect-template"/);
  assert.doesNotMatch(html, /mcp-server-actions|mcp-action-strip-primary|mcp-setup-guide|mcp-advanced-diagnostics/);
  assert.doesNotMatch(html, /检测连接|检测只验证|连接地址|0 个工具|1 个工具|模板|安装/);
  assert.doesNotMatch(harness.els.skillChipRow.innerHTML, /已安装/);
  assert.doesNotMatch(harness.els.skillChipRow.innerHTML, /市场/);
  assert.match(harness.els.skillChipRow.innerHTML, /自定义/);
  assert.match(harness.els.skillChipRow.innerHTML, /data-mcp-toolbar-action="create"/);
  assert.equal(harness.getLayoutCalls(), 1);
});

test("mcp-library keeps connection card nodes stable across unchanged renders", () => {
  const state = {
    skillFilter: "",
    mcp: {
      servers: [{
        id: "mcp_xhs",
        name: "小红书 MCP",
        enabled: false,
        status: "disconnected",
        managedRuntime: { connectorId: "xiaohongshu", state: "installed" }
      }],
      templates: [],
      loaded: true,
      loadAttempted: true,
      loading: false,
      error: "",
      serverError: "",
      templateError: ""
    }
  };
  const harness = createMcpHarness({ state });

  harness.context.window.miaMcpLibrary.renderMcpLibrary();
  const firstButton = harness.els.skillCardGrid.querySelector("[data-mcp-action]");
  const writes = harness.els.skillCardGrid.innerHTMLWrites;
  harness.context.window.miaMcpLibrary.renderMcpLibrary();

  assert.equal(harness.els.skillCardGrid.innerHTMLWrites, writes);
  assert.equal(harness.els.skillCardGrid.querySelector("[data-mcp-action]"), firstButton);
});

test("managed installed xiaohongshu card exposes a single connect action", async () => {
  const actions = [];
  const state = {
    skillFilter: "",
    mcp: {
      activeTab: "installed",
      servers: [{
        id: "mcp_xhs",
        name: "小红书 MCP",
        nativeName: "xiaohongshu",
        enabled: false,
        status: "disconnected",
        managedRuntime: { connectorId: "xiaohongshu", state: "installed", expectedToolCount: 13 },
        connectionWizard: {
          state: "ready_to_test",
          nextAction: "test",
          message: "Mia 已启动服务，可以检测。",
          actions: [{ id: "test", label: "检测并启用" }]
        },
        setupCommands: ["go run cmd/login/main.go", "go run ."],
        transport: { type: "http", url: "http://127.0.0.1:18060/mcp" },
        tools: [],
        sync: {}
      }],
      templates: [],
      loaded: true,
      loadAttempted: true,
      loading: false,
      error: "",
      serverError: "",
      templateError: ""
    }
  };
  const harness = createMcpHarness({
    state,
    mcpOverrides: {
      runManagedAction: async (id, action) => {
        actions.push([id, action]);
        if (action === "start") {
          return {
            success: true,
            data: {
              id,
              name: "小红书 MCP",
              enabled: false,
              status: "disconnected",
              managementMode: "managed",
              managedRuntime: { connectorId: "xiaohongshu", state: "running" },
              connectionWizard: { nextAction: "test", actions: [{ id: "test", label: "检测并启用" }] },
              transport: { type: "http" }
            }
          };
        }
        return { success: true, data: { id, name: "小红书 MCP", enabled: true, status: "connected", transport: { type: "http" } } };
      }
    }
  });

  harness.context.window.miaMcpLibrary.renderMcpLibrary();

  const html = harness.els.skillCardGrid.innerHTML;
  assert.match(html, /小红书 MCP/);
  assert.match(html, /data-mcp-action="connect-server"/);
  assert.match(html, />连接</);
  assert.doesNotMatch(html, /检测并启用|go run|mcp-action-strip-primary|mcp-managed-actions|mcp-advanced-diagnostics|连接地址|13 个工具/);
  assert.equal(harness.els.skillCardGrid.querySelector('[data-mcp-action="sync"]'), null);
  assert.equal(harness.els.skillCardGrid.querySelector('[data-mcp-action="toggle"]'), null);
  assert.equal(harness.els.skillCardGrid.querySelector('[data-mcp-managed-action="test"]'), null);
  harness.els.skillCardGrid.querySelector('[data-mcp-action="connect-server"]').click();
  await flushAsync();

  assert.deepEqual(actions, [["mcp_xhs", "start"], ["mcp_xhs", "test"]]);
});

test("managed error cards keep verbose command failures out of the default surface", () => {
  const verboseError = "Command failed:\ngit clone https://github.com/xpzouying/xiaohongshu-mcp /Users/jung/Library/Application Support/Mia/runtime/engine-home/managed-mcp/xiaohongshu-mcp\nfatal: destination path '/Users/jung/Library/Application Support/Mia/runtime/engine-home/managed-mcp/xiaohongshu-mcp' already exists and is not an empty directory.";
  const state = {
    skillFilter: "",
    mcp: {
      activeTab: "installed",
      servers: [{
        id: "mcp_xhs",
        name: "小红书 MCP",
        nativeName: "xiaohongshu",
        enabled: false,
        status: "disconnected",
        lastError: verboseError,
        diagnostics: { code: "MANAGED_ACTION_FAILED", message: verboseError },
        managedRuntime: { connectorId: "xiaohongshu", state: "error", lastAction: "install", expectedToolCount: 13 },
        connectionWizard: {
          state: "managed_error",
          nextAction: "install",
          message: verboseError,
          actions: [{ id: "install", label: "重新安装" }]
        },
        homepage: "https://github.com/xpzouying/xiaohongshu-mcp",
        transport: { type: "http", url: "http://127.0.0.1:18060/mcp" },
        tools: [],
        sync: {}
      }],
      templates: [],
      loaded: true,
      loadAttempted: true,
      loading: false,
      error: "",
      serverError: "",
      templateError: ""
    }
  };
  const harness = createMcpHarness({ state });

  harness.context.window.miaMcpLibrary.renderMcpLibrary();

  const html = harness.els.skillCardGrid.innerHTML;
  assert.match(html, /连接失败/);
  assert.match(html, /data-mcp-action="connect-server"/);
  assert.doesNotMatch(html, /MANAGED_ACTION_FAILED|Command failed|git clone|destination path|Application Support|127\.0\.0\.1:18060\/mcp|xpzouying\/xiaohongshu-mcp|检测只验证配置可用|高级诊断/);
});

test("managed action failure alerts are concise", async () => {
  const verboseError = "Command failed:\ngit clone https://github.com/xpzouying/xiaohongshu-mcp /Users/jung/Library/Application Support/Mia/runtime/engine-home/managed-mcp/xiaohongshu-mcp\nfatal: destination path already exists and is not an empty directory.";
  const state = {
    skillFilter: "",
    mcp: {
      activeTab: "installed",
      servers: [{
        id: "mcp_xhs",
        name: "小红书 MCP",
        nativeName: "xiaohongshu",
        enabled: false,
        status: "disconnected",
        managedRuntime: { connectorId: "xiaohongshu", state: "not_installed", expectedToolCount: 13 },
        connectionWizard: {
          state: "needs_managed_action",
          nextAction: "install",
          message: "需要安装小红书 MCP。",
          actions: [{ id: "install", label: "安装" }]
        },
        transport: { type: "http", url: "http://127.0.0.1:18060/mcp" },
        tools: [],
        sync: {}
      }],
      templates: [],
      loaded: true,
      loadAttempted: true,
      loading: false,
      error: "",
      serverError: "",
      templateError: ""
    }
  };
  const harness = createMcpHarness({
    state,
    mcpOverrides: {
      runManagedAction: async () => ({ success: false, error: verboseError })
    }
  });

  harness.context.window.miaMcpLibrary.renderMcpLibrary();
  harness.els.skillCardGrid.querySelector('[data-mcp-action="connect-server"]').click();
  await flushAsync();

  assertMcpAlert(harness, "安装失败，请重试。");
});

test("missing managed runtime alerts are concise", async () => {
  const state = {
    skillFilter: "",
    mcp: {
      activeTab: "installed",
      servers: [{
        id: "mcp_xhs",
        name: "小红书 MCP",
        nativeName: "xiaohongshu",
        enabled: false,
        status: "disconnected",
        managedRuntime: { connectorId: "xiaohongshu", state: "error", expectedToolCount: 13 },
        connectionWizard: {
          state: "managed_error",
          nextAction: "login",
          message: "Xiaohongshu login command failed to start: spawn go ENOENT",
          actions: [{ id: "login", label: "打开登录" }]
        },
        transport: { type: "http", url: "http://127.0.0.1:18060/mcp" },
        tools: [],
        sync: {}
      }],
      templates: [],
      loaded: true,
      loadAttempted: true,
      loading: false,
      error: "",
      serverError: "",
      templateError: ""
    }
  };
  const harness = createMcpHarness({
    state,
    mcpOverrides: {
      runManagedAction: async () => ({
        success: false,
        error: "Xiaohongshu login command failed to start: spawn go ENOENT"
      })
    }
  });

  harness.context.window.miaMcpLibrary.renderMcpLibrary();
  harness.els.skillCardGrid.querySelector('[data-mcp-action="connect-server"]').click();
  await flushAsync();

  assertMcpAlert(harness, "登录失败，请重试。");
  assert.doesNotMatch(bodyDialogHtml(harness), /spawn go|ENOENT|go run/);
});

test("managed endpoint health errors stay out of user alerts", async () => {
  const state = {
    skillFilter: "",
    mcp: {
      activeTab: "installed",
      servers: [{
        id: "mcp_xhs",
        name: "小红书 MCP",
        nativeName: "xiaohongshu",
        enabled: false,
        status: "disconnected",
        managedRuntime: { connectorId: "xiaohongshu", state: "error", expectedToolCount: 13 },
        connectionWizard: {
          state: "managed_error",
          nextAction: "start",
          message: "Xiaohongshu endpoint health check failed for http://127.0.0.1:18060/mcp. Status 405.",
          actions: [{ id: "start", label: "启动服务" }]
        },
        transport: { type: "http", url: "http://127.0.0.1:18060/mcp" },
        tools: [],
        sync: {}
      }],
      templates: [],
      loaded: true,
      loadAttempted: true,
      loading: false,
      error: "",
      serverError: "",
      templateError: ""
    }
  };
  const harness = createMcpHarness({
    state,
    mcpOverrides: {
      runManagedAction: async () => ({
        success: false,
        error: "Xiaohongshu endpoint health check failed for http://127.0.0.1:18060/mcp. Status 405."
      })
    }
  });

  harness.context.window.miaMcpLibrary.renderMcpLibrary();
  harness.els.skillCardGrid.querySelector('[data-mcp-action="connect-server"]').click();
  await flushAsync();

  assertMcpAlert(harness, "启动失败，请重试。");
  assert.doesNotMatch(bodyDialogHtml(harness), /127\.0\.0\.1:18060|Status 405|endpoint health check/);
});

test("xiaohongshu stale endpoint test errors restart before retesting", async () => {
  const actions = [];
  const state = {
    skillFilter: "",
    mcp: {
      activeTab: "installed",
      servers: [{
        id: "mcp_xhs",
        name: "小红书 MCP",
        nativeName: "xiaohongshu",
        enabled: false,
        status: "disconnected",
        managedRuntime: { connectorId: "xiaohongshu", state: "error", expectedToolCount: 13 },
        connectionWizard: {
          state: "managed_error",
          nextAction: "test",
          message: "Xiaohongshu endpoint health check failed for http://127.0.0.1:18060/mcp. fetch failed",
          actions: [{ id: "test", label: "检测并启用" }]
        },
        transport: { type: "http", url: "http://127.0.0.1:18060/mcp" },
        tools: [],
        sync: {}
      }],
      templates: [],
      loaded: true,
      loadAttempted: true,
      loading: false,
      error: "",
      serverError: "",
      templateError: ""
    }
  };
  const harness = createMcpHarness({
    state,
    mcpOverrides: {
      runManagedAction: async (id, action) => {
        actions.push([id, action]);
        if (action === "start") {
          return {
            success: true,
            data: {
              id,
              name: "小红书 MCP",
              managementMode: "managed",
              enabled: false,
              status: "disconnected",
              managedRuntime: { connectorId: "xiaohongshu", state: "running" },
              connectionWizard: { state: "ready_to_test", nextAction: "test", actions: [{ id: "test", label: "检测并启用" }] },
              transport: { type: "http", url: "http://127.0.0.1:18060/mcp" }
            }
          };
        }
        return { success: true, data: { id, name: "小红书 MCP", enabled: true, status: "connected", transport: { type: "http" } } };
      }
    }
  });

  harness.context.window.miaMcpLibrary.renderMcpLibrary();
  harness.els.skillCardGrid.querySelector('[data-mcp-action="connect-server"]').click();
  await flushAsync();

  assert.deepEqual(actions, [["mcp_xhs", "start"], ["mcp_xhs", "test"]]);
  assert.equal(harness.context.document.querySelector('[role="dialog"]'), null);
});

test("managed error with empty actions still uses nextAction", async () => {
  const actions = [];
  const state = {
    skillFilter: "",
    mcp: {
      activeTab: "installed",
      servers: [{
        id: "mcp_xhs",
        name: "小红书 MCP",
        nativeName: "xiaohongshu",
        enabled: false,
        status: "disconnected",
        managedRuntime: { connectorId: "xiaohongshu", state: "running", expectedToolCount: 13 },
        connectionWizard: {
          state: "managed_error",
          nextAction: "start",
          message: "Xiaohongshu MCP service failed to start: spawn go ENOENT",
          actions: []
        },
        transport: { type: "http", url: "http://127.0.0.1:18060/mcp" },
        tools: [],
        sync: {}
      }],
      templates: [],
      loaded: true,
      loadAttempted: true,
      loading: false,
      error: "",
      serverError: "",
      templateError: ""
    }
  };
  const harness = createMcpHarness({
    state,
    mcpOverrides: {
      runManagedAction: async (id, action) => {
        actions.push([id, action]);
        return {
          success: false,
          error: "Xiaohongshu MCP service failed to start: spawn go ENOENT"
        };
      },
      test: async () => {
        actions.push(["generic-test"]);
        return { success: false, error: "fetch failed" };
      }
    }
  });

  harness.context.window.miaMcpLibrary.renderMcpLibrary();
  harness.els.skillCardGrid.querySelector('[data-mcp-action="connect-server"]').click();
  await flushAsync();

  assert.deepEqual(actions, [["mcp_xhs", "start"]]);
  assertMcpAlert(harness, "启动失败，请重试。");
});

test("installed card omits legacy setupHint self-start guidance from default surface", () => {
  const state = {
    skillFilter: "",
    mcp: {
      activeTab: "installed",
      servers: [{
        id: "mcp_legacy",
        name: "Legacy MCP",
        enabled: false,
        status: "disconnected",
        setupHint: "Run `go run .` to start the local service before connecting.",
        transport: { type: "http", url: "http://127.0.0.1:9090/mcp" },
        tools: [],
        sync: {}
      }],
      templates: [],
      loaded: true,
      loadAttempted: true,
      loading: false,
      error: "",
      serverError: "",
      templateError: ""
    }
  };
  const harness = createMcpHarness({ state });

  harness.context.window.miaMcpLibrary.renderMcpLibrary();

  assert.doesNotMatch(harness.els.skillCardGrid.innerHTML, /Run `go run \.` to start the local service before connecting\./);
  assert.doesNotMatch(harness.els.skillCardGrid.innerHTML, /start the local service/i);
});

test("installed native built-ins hide generic edit while custom records keep it", () => {
  const state = {
    skillFilter: "",
    mcp: {
      activeTab: "installed",
      servers: [{
        id: "mcp_github",
        name: "GitHub MCP",
        nativeName: "github",
        registryId: "github",
        managementMode: "native",
        enabled: true,
        status: "connected",
        transport: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: {} },
        tools: [],
        sync: {}
      }, {
        id: "mcp_custom",
        name: "Custom MCP",
        managementMode: "custom",
        enabled: false,
        status: "disconnected",
        transport: { type: "stdio", command: "node", args: ["server.js"], env: {} },
        tools: [],
        sync: {}
      }],
      templates: [],
      loaded: true,
      loadAttempted: true,
      loading: false,
      error: "",
      serverError: "",
      templateError: ""
    }
  };
  const harness = createMcpHarness({ state });

  harness.context.window.miaMcpLibrary.renderMcpLibrary();

  const html = harness.els.skillCardGrid.innerHTML;
  const editButtons = harness.els.skillCardGrid.querySelectorAll('[data-mcp-action="edit"]');
  const builtInChunk = html.match(/data-mcp-id="mcp_github"[\s\S]*?<\/article>/)?.[0] || "";
  const customChunk = html.match(/data-mcp-id="mcp_custom"[\s\S]*?<\/article>/)?.[0] || "";

  assert.equal(editButtons.length, 1);
  assert.equal(editButtons[0].dataset.mcpId, "mcp_custom");
  assert.doesNotMatch(builtInChunk, /@modelcontextprotocol\/server-github|mcp-advanced-diagnostics|data-mcp-action="edit"/);
  assert.match(customChunk, /data-mcp-action="edit"/);
  assert.match(customChunk, /data-mcp-action="delete"/);
});

test("mcp-library settles empty successful responses into stable empty states", async () => {
  const state = {
    skillFilter: "",
    mcp: {
      activeTab: "installed",
      servers: [],
      templates: [],
      loaded: false,
      loadAttempted: false,
      loading: false,
      syncing: false,
      error: "",
      serverError: "",
      templateError: ""
    }
  };
  const harness = createMcpHarness({ state });

  await harness.context.window.miaMcpLibrary.loadMcpServers();
  await flushAsync();

  assert.equal(harness.getListCalls(), 1);
  assert.equal(harness.getMarketplaceCalls(), 1);
  assert.equal(harness.getAgentConfigCalls(), 0);
  assert.equal(state.mcp.loading, false);
  assert.equal(state.mcp.loaded, true);
  assert.equal(state.mcp.agentConfigsLoaded, true);
  assert.equal(state.mcp.loadAttempted, true);
  assert.match(harness.els.skillCardGrid.innerHTML, /暂无可连接 MCP 服务/);

  harness.context.window.miaMcpLibrary.renderMcpLibrary();
  assert.equal(harness.getListCalls(), 1);
  assert.equal(harness.getMarketplaceCalls(), 1);
  assert.equal(harness.getAgentConfigCalls(), 0);
  assert.match(harness.els.skillCardGrid.innerHTML, /暂无可连接 MCP 服务/);

  state.mcp.activeTab = "marketplace";
  harness.context.window.miaMcpLibrary.renderMcpLibrary();
  assert.equal(harness.getListCalls(), 1);
  assert.equal(harness.getMarketplaceCalls(), 1);
  assert.equal(harness.getAgentConfigCalls(), 0);
  assert.match(harness.els.skillCardGrid.innerHTML, /暂无可连接 MCP 服务/);
  assert.ok(harness.getLayoutCalls() >= 3);
});

test("auth-required cards render login without diagnostics", () => {
  const state = {
    skillFilter: "",
    mcp: {
      activeTab: "installed",
      servers: [{
        id: "needs-auth",
        name: "Needs Auth",
        enabled: true,
        status: "disconnected",
        lastTestStatus: "auth_required",
        lastTestCode: "AUTH_REQUIRED",
        lastError: "Sign in required",
        diagnostics: { code: "OAUTH_REQUIRED", message: "Open login" },
        transport: { type: "http", url: "https://example.com/mcp" },
        tools: [],
        sync: {}
      }, {
        id: "authed",
        name: "Authed MCP",
        enabled: true,
        status: "connected",
        oauth: { authenticated: true },
        diagnostics: { code: "OK" },
        transport: { type: "http", url: "https://example.com/authed" },
        tools: [],
        sync: {}
      }],
      templates: [],
      loaded: true,
      loadAttempted: true,
      loading: false,
      syncing: false,
      error: "",
      serverError: "",
      templateError: ""
    }
  };
  const harness = createMcpHarness({ state });

  harness.context.window.miaMcpLibrary.renderMcpLibrary();

  assert.match(harness.els.skillCardGrid.innerHTML, /需要登录/);
  assert.match(harness.els.skillCardGrid.innerHTML, /data-mcp-action="oauth-login"/);
  assert.match(harness.els.skillCardGrid.innerHTML, /data-mcp-action="disconnect-server"/);
  assert.doesNotMatch(harness.els.skillCardGrid.innerHTML, /mcp-diagnostic|AUTH_REQUIRED|Sign in required|OAUTH_REQUIRED|Open login|data-mcp-action="oauth-logout"/);
});

test("custom entry is a single toolbar button instead of a rendered category", () => {
  const state = {
    skillFilter: "",
    mcp: {
      activeTab: "custom",
      servers: [{
        id: "custom",
        name: "Custom MCP",
        managementMode: "custom",
        enabled: false,
        status: "disconnected",
        transport: { type: "stdio", command: "node", args: ["server.js"], env: {} },
        tools: [],
        sync: {}
      }],
      templates: [],
      agentConfigs: [{
        source: "Claude",
        servers: [{
          name: "xhs",
          importable: true,
          transport: { type: "stdio" }
        }, {
          name: "existing",
          importable: false,
          importSkipReason: "已安装",
          transport: { type: "http" }
        }]
      }],
      loaded: true,
      loadAttempted: true,
      loading: false,
      syncing: false,
      error: "",
      serverError: "",
      templateError: ""
    }
  };
  const harness = createMcpHarness({ state });

  harness.context.window.miaMcpLibrary.renderMcpLibrary();

  const html = harness.els.skillCardGrid.innerHTML;
  assert.match(html, /Custom MCP/);
  assert.match(harness.els.skillChipRow.innerHTML, /data-mcp-toolbar-action="create"/);
  assert.doesNotMatch(html, /mcp-discovery|data-mcp-action="import"|data-mcp-action="import-agent-config"|新建服务|导入 JSON|同步状态/);
});

test("oauth login action calls preload API and reloads", async () => {
  const apiCalls = [];
  const state = {
    skillFilter: "",
    mcp: {
      activeTab: "installed",
      servers: [{
        id: "auth",
        name: "Auth MCP",
        enabled: true,
        status: "disconnected",
        lastTestStatus: "auth_required",
        transport: { type: "http", url: "https://example.com/mcp" },
        tools: [],
        sync: {}
      }, {
        id: "plain",
        name: "Plain MCP",
        enabled: true,
        status: "connected",
        transport: { type: "http", url: "https://example.com/plain" },
        tools: [],
        sync: {}
      }],
      templates: [],
      agentConfigs: [],
      loaded: true,
      loadAttempted: true,
      loading: false,
      syncing: false,
      error: "",
      serverError: "",
      templateError: ""
    }
  };
  const harness = createMcpHarness({
    state,
    mcpOverrides: {
      oauth: {
        login: async (payload) => {
          apiCalls.push(["oauth.login", JSON.parse(JSON.stringify(payload))]);
          return { success: true };
        },
        logout: async (payload) => {
          apiCalls.push(["oauth.logout", JSON.parse(JSON.stringify(payload))]);
          return { success: true };
        }
      }
    }
  });

  harness.context.window.miaMcpLibrary.renderMcpLibrary();
  harness.els.skillCardGrid.querySelector('[data-mcp-action="oauth-login"]').click();
  await flushAsync();

  assert.deepEqual(apiCalls, [
    ["oauth.login", { serverId: "auth", serverUrl: "https://example.com/mcp" }]
  ]);
  assert.equal(harness.getListCalls(), 1);
  assert.equal(harness.getMarketplaceCalls(), 1);
  assert.equal(harness.getAgentConfigCalls(), 0);
});

test("mcp-library keeps the flat list stable with zero filtered records", () => {
  const state = {
    skillFilter: "missing",
    mcp: {
      activeTab: "custom",
      servers: [{
        id: "xhs",
        name: "小红书 MCP",
        enabled: true,
        status: "connected",
        transport: { type: "http" },
        tools: [],
        sync: {}
      }],
      templates: [],
      loaded: true,
      loadAttempted: true,
      loading: false,
      syncing: false,
      error: "",
      serverError: "",
      templateError: ""
    }
  };
  const harness = createMcpHarness({ state });

  harness.context.window.miaMcpLibrary.renderMcpLibrary();

  assert.match(harness.els.skillCardGrid.innerHTML, /没有匹配的 MCP 服务/);
  assert.doesNotMatch(harness.els.skillCardGrid.innerHTML, /MCP 服务暂不可用/);
  assert.equal(harness.getLayoutCalls(), 1);
});

test("connection card actions connect and disconnect without delete prompts", async () => {
  const apiCalls = [];
  const state = {
    skillFilter: "",
    mcp: {
      activeTab: "installed",
      servers: [{
        id: "xhs",
        name: "小红书 MCP",
        registryId: "xiaohongshu",
        nativeName: "xiaohongshu",
        enabled: true,
        status: "connected",
        transport: { type: "http", url: "http://127.0.0.1:18060/mcp" },
        tools: [{ name: "search_notes" }],
        sync: {}
      }, {
        id: "github",
        name: "GitHub MCP",
        registryId: "github",
        nativeName: "github",
        enabled: false,
        status: "disconnected",
        transport: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: {} },
        tools: [],
        sync: {}
      }],
      templates: [],
      loaded: true,
      loadAttempted: true,
      loading: false,
      syncing: false,
      error: "",
      serverError: "",
      templateError: ""
    }
  };
  const harness = createMcpHarness({
    state,
    mcpOverrides: {
      test: async (id) => {
        apiCalls.push(["test", id]);
        return { success: true, data: { status: "connected" } };
      },
      setEnabled: async (id, enabled) => {
        apiCalls.push(["setEnabled", id, enabled]);
        return { success: true };
      }
    }
  });

  harness.context.window.miaMcpLibrary.renderMcpLibrary();

  assert.equal(harness.els.skillCardGrid.querySelector('[data-mcp-action="sync"]'), null);
  assert.equal(harness.els.skillCardGrid.querySelector('[data-mcp-action="toggle"]'), null);
  assert.equal(harness.els.skillCardGrid.querySelector('[data-mcp-action="delete"]'), null);
  harness.els.skillCardGrid.querySelectorAll('[data-mcp-action="connect-server"]')
    .find((button) => button.dataset.mcpId === "github")
    .click();
  await flushAsync();
  harness.els.skillCardGrid.querySelectorAll('[data-mcp-action="disconnect-server"]')
    .find((button) => button.dataset.mcpId === "xhs")
    .click();
  await flushAsync();

  assert.deepEqual(apiCalls, [
    ["test", "github"],
    ["setEnabled", "github", true],
    ["setEnabled", "xhs", false]
  ]);
  assert.equal(harness.getListCalls(), 2);
  assert.equal(harness.getMarketplaceCalls(), 2);
  assert.deepEqual(harness.confirms, []);
});

test("create form submits stdio payloads with parsed args and env", async () => {
  const saveCalls = [];
  const state = {
    skillFilter: "",
    mcp: {
      activeTab: "custom",
      servers: [],
      templates: [],
      loaded: true,
      loadAttempted: true,
      loading: false,
      syncing: false,
      error: "",
      serverError: "",
      templateError: ""
    }
  };
  const harness = createMcpHarness({
    state,
    mcpOverrides: {
      save: async (payload) => {
        saveCalls.push(JSON.parse(JSON.stringify(payload)));
        return { success: true, data: { id: "xhs" } };
      }
    }
  });

  harness.context.window.miaMcpLibrary.renderMcpLibrary();
  harness.els.skillChipRow.querySelector('[data-mcp-toolbar-action="create"]').click();

  const form = harness.document.body.querySelector("[data-mcp-form]");
  form.querySelector('input[name="name"]').value = "XHS MCP";
  form.querySelector('input[name="description"]').value = "stdio server";
  form.querySelector('input[name="command"]').value = "npx xhs-mcp";
  form.querySelector('textarea[name="args"]').value = "--token\nabc";
  form.querySelector('textarea[name="env"]').value = "XHS_TOKEN=abc\nDEBUG=1";
  form.dispatch("submit");
  await flushAsync();

  assert.deepEqual(saveCalls, [{
    id: "",
    name: "XHS MCP",
    description: "stdio server",
    enabled: true,
    transport: {
      type: "stdio",
      command: "npx xhs-mcp",
      args: ["--token", "abc"],
      env: { XHS_TOKEN: "abc", DEBUG: "1" }
    }
  }]);
  assert.equal(harness.getListCalls(), 1);
  assert.equal(harness.getMarketplaceCalls(), 1);
  assert.equal(state.mcp.activeTab, "custom");
  assert.equal(harness.document.body.querySelector("[data-mcp-form]"), null);
});

test("edit form submits URL payloads with parsed headers and bearer token env vars", async () => {
  const saveCalls = [];
  const state = {
    skillFilter: "",
    mcp: {
      activeTab: "installed",
      servers: [{
        id: "xhs",
        name: "小红书 MCP",
        description: "old",
        enabled: false,
        status: "connected",
        transport: {
          type: "http",
          url: "http://127.0.0.1:18060/mcp",
          headers: { Authorization: "Bearer old" },
          bearerTokenEnvVar: "OLD_TOKEN"
        },
        tools: [],
        sync: {}
      }],
      templates: [],
      loaded: true,
      loadAttempted: true,
      loading: false,
      syncing: false,
      error: "",
      serverError: "",
      templateError: ""
    }
  };
  const harness = createMcpHarness({
    state,
    mcpOverrides: {
      save: async (payload) => {
        saveCalls.push(JSON.parse(JSON.stringify(payload)));
        return { success: true, data: { id: "xhs" } };
      }
    }
  });

  harness.context.window.miaMcpLibrary.renderMcpLibrary();
  harness.els.skillCardGrid.querySelector('[data-mcp-action="edit"]').click();

  const form = harness.document.body.querySelector("[data-mcp-form]");
  const typeSelect = form.querySelector('select[name="type"]');
  typeSelect.value = "streamable_http";
  typeSelect.dispatch("change");
  form.querySelector('input[name="name"]').value = "XHS HTTP";
  form.querySelector('input[name="description"]').value = "updated";
  form.querySelector('input[name="url"]').value = "https://example.com/mcp";
  form.querySelector('textarea[name="headers"]').value = "Authorization: Bearer demo\nX-Trace: abc";
  form.querySelector('input[name="bearerTokenEnvVar"]').value = "XHS_TOKEN";
  form.dispatch("submit");
  await flushAsync();

  assert.deepEqual(saveCalls, [{
    id: "xhs",
    name: "XHS HTTP",
    description: "updated",
    enabled: false,
    transport: {
      type: "streamable_http",
      url: "https://example.com/mcp",
      headers: {
        Authorization: "Bearer demo",
        "X-Trace": "abc"
      },
      bearerTokenEnvVar: "XHS_TOKEN"
    }
  }]);
  assert.equal(harness.getListCalls(), 1);
  assert.equal(harness.getMarketplaceCalls(), 1);
});

test("marketplace template cards open a no-command connection wizard", async () => {
  const installCalls = [];
  const state = {
    skillFilter: "",
    mcp: {
      activeTab: "marketplace",
      servers: [],
      templates: [{
        id: "github",
        name: "GitHub MCP",
        managementMode: "native",
        description: "GitHub",
        category: "开发",
        transport: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: {} },
        requiredInputs: [{ key: "GITHUB_PERSONAL_ACCESS_TOKEN", label: "GitHub Personal Access Token", secret: true, target: "env", required: true }]
      }],
      loaded: true,
      loadAttempted: true,
      loading: false,
      syncing: false,
      error: "",
      serverError: "",
      templateError: ""
    }
  };
  const harness = createMcpHarness({
    state,
    mcpOverrides: {
      installTemplate: async (id, values) => {
        installCalls.push({ id, values: JSON.parse(JSON.stringify(values)) });
        return { success: true, data: { id: "mcp_github", name: "GitHub MCP", enabled: true, status: "connected", transport: { type: "stdio" } } };
      }
    }
  });

  harness.context.window.miaMcpLibrary.renderMcpLibrary();
  harness.els.skillCardGrid.querySelector('[data-mcp-action="connect-template"]').click();

  const form = harness.document.body.querySelector("[data-mcp-template-form]");
  assert.match(form.innerHTML, /GitHub Personal Access Token/);
  assert.equal(form.querySelector('input[name="GITHUB_PERSONAL_ACCESS_TOKEN"]').getAttribute("type"), "password");
  assert.doesNotMatch(form.innerHTML, /npx -y/);
  form.querySelector('input[name="GITHUB_PERSONAL_ACCESS_TOKEN"]').value = "ghp_secret";
  form.dispatch("submit");
  await flushAsync();

  assert.deepEqual(installCalls, [{ id: "github", values: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret" } }]);
  assert.equal(harness.getListCalls(), 1);
  assert.equal(harness.getMarketplaceCalls(), 1);
  assert.equal(state.mcp.activeTab, "marketplace");
});

test("flat MCP page does not expose JSON import as a category card", () => {
  const state = {
    skillFilter: "",
    mcp: {
      activeTab: "custom",
      servers: [],
      templates: [],
      loaded: true,
      loadAttempted: true,
      loading: false,
      syncing: false,
      error: "",
      serverError: "",
      templateError: ""
    }
  };
  const harness = createMcpHarness({ state });

  harness.context.window.miaMcpLibrary.renderMcpLibrary();

  assert.equal(harness.els.skillCardGrid.querySelector('[data-mcp-action="import"]'), null);
  assert.equal(harness.document.body.querySelector("[data-mcp-import-form]"), null);
  assert.match(harness.els.skillChipRow.innerHTML, /自定义 MCP/);
});

test("template without required inputs connects directly on the page", async () => {
  const installCalls = [];
  const state = {
    skillFilter: "",
    mcp: {
      activeTab: "marketplace",
      servers: [],
      templates: [{
        id: "context7",
        name: "Context7 MCP",
        managementMode: "native",
        description: "文档检索",
        transport: { type: "stdio" },
        requiredInputs: []
      }],
      loaded: true,
      loadAttempted: true,
      loading: false,
      syncing: false,
      error: "",
      serverError: "",
      templateError: ""
    }
  };
  const harness = createMcpHarness({
    state,
    mcpOverrides: {
      installTemplate: async (id, values) => {
        installCalls.push([id, JSON.parse(JSON.stringify(values))]);
        return { success: true };
      }
    }
  });

  harness.context.window.miaMcpLibrary.renderMcpLibrary();
  harness.els.skillCardGrid.querySelector('[data-mcp-action="connect-template"]').click();
  await flushAsync();

  assert.deepEqual(installCalls, [["context7", {}]]);
  assert.equal(harness.getListCalls(), 1);
  assert.equal(harness.getMarketplaceCalls(), 1);
  assert.equal(harness.document.body.querySelector("[data-mcp-template-form]"), null);
});

test("failed save keeps the form dialog open with user input intact", async () => {
  const state = {
    skillFilter: "",
    mcp: {
      activeTab: "custom",
      servers: [],
      templates: [],
      loaded: true,
      loadAttempted: true,
      loading: false,
      syncing: false,
      error: "",
      serverError: "",
      templateError: ""
    }
  };
  const harness = createMcpHarness({
    state,
    mcpOverrides: {
      save: async () => ({ success: false, error: "boom" })
    }
  });

  harness.context.window.miaMcpLibrary.renderMcpLibrary();
  harness.els.skillChipRow.querySelector('[data-mcp-toolbar-action="create"]').click();

  const form = harness.document.body.querySelector("[data-mcp-form]");
  const nameInput = form.querySelector('input[name="name"]');
  nameInput.value = "Broken MCP";
  form.dispatch("submit");
  await flushAsync();

  assertMcpAlert(harness, "保存失败：boom");
  const openForm = harness.document.body.querySelector("[data-mcp-form]");
  assert.ok(openForm);
  assert.equal(openForm.querySelector('input[name="name"]').value, "Broken MCP");
  assert.equal(harness.getListCalls(), 0);
  assert.equal(harness.getMarketplaceCalls(), 0);
});

test("failed direct template connection stays on the flat page with a short alert", async () => {
  const verboseError = "Command failed:\nnpx -y broken-mcp\nfatal: long local command output";
  const state = {
    skillFilter: "",
    mcp: {
      activeTab: "marketplace",
      servers: [],
      templates: [{
        id: "broken",
        name: "Broken MCP",
        description: "Broken",
        managementMode: "native",
        transport: { type: "stdio" },
        requiredInputs: []
      }],
      loaded: true,
      loadAttempted: true,
      loading: false,
      syncing: false,
      error: "",
      serverError: "",
      templateError: ""
    }
  };
  const harness = createMcpHarness({
    state,
    mcpOverrides: {
      installTemplate: async () => ({ success: false, error: verboseError })
    }
  });

  harness.context.window.miaMcpLibrary.renderMcpLibrary();
  harness.els.skillCardGrid.querySelector('[data-mcp-action="connect-template"]').click();
  await flushAsync();

  assertMcpAlert(harness, "连接失败，请重试。");
  assert.equal(harness.document.body.querySelector("[data-mcp-import-form]"), null);
  assert.match(harness.els.skillCardGrid.innerHTML, /Broken MCP/);
  assert.equal(harness.getListCalls(), 0);
  assert.equal(harness.getMarketplaceCalls(), 0);
});

test("failed template wizard connection keeps verbose errors out of alerts", async () => {
  const verboseError = "Command failed:\ngit clone https://github.com/example/mcp /Users/jung/Library/Application Support/Mia/runtime/mcp\nfatal: destination path already exists";
  const state = {
    skillFilter: "",
    mcp: {
      activeTab: "marketplace",
      servers: [],
      templates: [{
        id: "needs-token",
        name: "Needs Token MCP",
        description: "Needs a token",
        managementMode: "native",
        transport: { type: "stdio" },
        requiredInputs: [{ key: "TOKEN", label: "Token", secret: true, required: true }]
      }],
      loaded: true,
      loadAttempted: true,
      loading: false,
      syncing: false,
      error: "",
      serverError: "",
      templateError: ""
    }
  };
  const harness = createMcpHarness({
    state,
    mcpOverrides: {
      installTemplate: async () => ({ success: false, error: verboseError })
    }
  });

  harness.context.window.miaMcpLibrary.renderMcpLibrary();
  harness.els.skillCardGrid.querySelector('[data-mcp-action="connect-template"]').click();
  const form = harness.document.body.querySelector("[data-mcp-template-form]");
  form.querySelector('input[name="TOKEN"]').value = "secret";
  form.dispatch("submit");
  await flushAsync();

  assertMcpAlert(harness, "连接失败，请重试。");
  assert.ok(harness.document.body.querySelector("[data-mcp-template-form]"));
  assert.doesNotMatch(bodyDialogHtml(harness), /Command failed|git clone|Application Support|destination path/);
});
