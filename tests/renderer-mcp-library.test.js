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
    this._parsedNodes = [];
  }

  set innerHTML(value) {
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
  assert.match(mcpCss, /\.mcp-action-strip-primary\s*\{[\s\S]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(mcpCss, /\.mcp-action-button\s*\{[\s\S]*font-size:\s*12\.5px;[\s\S]*white-space:\s*nowrap/);
});

test("mcp renderer includes diagnostics oauth and discovery actions", () => {
  const src = read("src/renderer/mcp/mcp-library.js");
  assert.match(src, /getAgentConfigs/);
  assert.match(src, /importAgentConfig/);
  assert.match(src, /oauth\.login/);
  assert.match(src, /oauth\.logout/);
  assert.match(src, /data-mcp-action="oauth-login"/);
  assert.match(src, /data-mcp-action="oauth-logout"/);
  assert.match(src, /data-mcp-action="import-agent-config"/);
  assert.match(src, /lastTestStatus|diagnostics|lastError/);
});

test("mcp-library renders installed, marketplace, and custom tabs", () => {
  const state = {
    skillFilter: "",
    mcp: {
      activeTab: "installed",
      servers: [{ id: "mcp_xhs", name: "小红书 MCP", enabled: true, status: "connected", transport: { type: "http", url: "http://127.0.0.1:18060/mcp" }, tools: [{ name: "search_notes" }], sync: {} }],
      templates: [{ id: "xiaohongshu", name: "小红书 MCP", description: "本地 HTTP", transport: { type: "http" } }],
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

  assert.match(harness.els.skillCardGrid.innerHTML, /小红书 MCP/);
  assert.match(harness.els.skillCardGrid.innerHTML, /mcp-server-actions/);
  assert.match(harness.els.skillCardGrid.innerHTML, /mcp-action-strip-primary/);
  assert.match(harness.els.skillCardGrid.innerHTML, /mcp-action-danger/);
  assert.match(harness.els.skillCardGrid.innerHTML, />检测连接</);
  assert.match(harness.els.skillCardGrid.innerHTML, />配置</);
  assert.match(harness.els.skillCardGrid.innerHTML, />删除</);
  assert.match(harness.els.skillCardGrid.innerHTML, /检测只验证配置可用，不代表实际运行时状态/);
  assert.doesNotMatch(harness.els.skillCardGrid.innerHTML, />同步</);
  assert.doesNotMatch(harness.els.skillCardGrid.innerHTML, />停用</);
  assert.doesNotMatch(harness.els.skillCardGrid.innerHTML, />启用</);
  assert.doesNotMatch(harness.els.skillCardGrid.innerHTML, />禁用</);
  assert.match(harness.els.skillChipRow.innerHTML, /已安装/);
  assert.match(harness.els.skillChipRow.innerHTML, /市场/);
  assert.match(harness.els.skillChipRow.innerHTML, /自定义/);
  assert.equal(harness.getLayoutCalls(), 1);
});

test("managed installed xiaohongshu card exposes app actions instead of setup commands", async () => {
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
        return { success: true, data: { id, name: "小红书 MCP", enabled: true, status: "connected", transport: { type: "http" } } };
      }
    }
  });

  harness.context.window.miaMcpLibrary.renderMcpLibrary();

  const html = harness.els.skillCardGrid.innerHTML;
  const defaultSurfaceHtml = html.replace(/<details class="mcp-advanced-diagnostics">[\s\S]*?<\/details>/, "");

  assert.match(html, /检测并启用/);
  assert.doesNotMatch(defaultSurfaceHtml, /go run/);
  assert.match(html, /<details class="mcp-advanced-diagnostics">[\s\S]*<code>go run cmd\/login\/main\.go<\/code>[\s\S]*<code>go run \.<\/code>/);
  assert.equal(harness.els.skillCardGrid.querySelector('[data-mcp-action="sync"]'), null);
  assert.equal(harness.els.skillCardGrid.querySelector('[data-mcp-action="toggle"]'), null);
  harness.els.skillCardGrid.querySelector('[data-mcp-managed-action="test"]').click();
  await flushAsync();

  assert.deepEqual(actions, [["mcp_xhs", "test"]]);
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
  assert.equal(harness.getAgentConfigCalls(), 1);
  assert.equal(state.mcp.loading, false);
  assert.equal(state.mcp.loaded, true);
  assert.equal(state.mcp.agentConfigsLoaded, true);
  assert.equal(state.mcp.loadAttempted, true);
  assert.match(harness.els.skillCardGrid.innerHTML, /暂无已安装 MCP 服务/);

  harness.context.window.miaMcpLibrary.renderMcpLibrary();
  assert.equal(harness.getListCalls(), 1);
  assert.equal(harness.getMarketplaceCalls(), 1);
  assert.equal(harness.getAgentConfigCalls(), 1);
  assert.match(harness.els.skillCardGrid.innerHTML, /暂无已安装 MCP 服务/);

  state.mcp.activeTab = "marketplace";
  harness.context.window.miaMcpLibrary.renderMcpLibrary();
  assert.equal(harness.getListCalls(), 1);
  assert.equal(harness.getMarketplaceCalls(), 1);
  assert.equal(harness.getAgentConfigCalls(), 1);
  assert.match(harness.els.skillCardGrid.innerHTML, /暂无可用模板/);
  assert.ok(harness.getLayoutCalls() >= 3);
});

test("installed cards render diagnostics and oauth actions", () => {
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

  assert.match(harness.els.skillCardGrid.innerHTML, /mcp-diagnostic/);
  assert.match(harness.els.skillCardGrid.innerHTML, /AUTH_REQUIRED · Sign in required/);
  assert.match(harness.els.skillCardGrid.innerHTML, /data-mcp-action="oauth-login"/);
  assert.match(harness.els.skillCardGrid.innerHTML, /data-mcp-action="oauth-logout"/);
});

test("custom tab renders agent config discovery before JSON import and blocks skipped rows", () => {
  const state = {
    skillFilter: "",
    mcp: {
      activeTab: "custom",
      servers: [],
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
  assert.ok(html.indexOf("mcp-discovery") >= 0);
  assert.ok(html.indexOf("mcp-discovery") < html.indexOf('data-mcp-action="import"'));
  assert.match(html, /data-mcp-action="import-agent-config" data-mcp-source="Claude" data-mcp-name="xhs"/);
  assert.match(html, /data-mcp-name="existing"[\s\S]*disabled/);
  assert.match(html, /已安装/);
});

test("oauth and agent config import actions call preload APIs and reload", async () => {
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
        id: "authed",
        name: "Authed MCP",
        enabled: true,
        status: "connected",
        oauth: { authenticated: true },
        transport: { type: "http", url: "https://example.com/authed" },
        tools: [],
        sync: {}
      }],
      templates: [],
      agentConfigs: [{
        source: "Claude",
        servers: [{ name: "xhs", importable: true, transport: { type: "stdio" } }]
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
      oauth: {
        login: async (payload) => {
          apiCalls.push(["oauth.login", JSON.parse(JSON.stringify(payload))]);
          return { success: true };
        },
        logout: async (payload) => {
          apiCalls.push(["oauth.logout", JSON.parse(JSON.stringify(payload))]);
          return { success: true };
        }
      },
      importAgentConfig: async (payload) => {
        apiCalls.push(["importAgentConfig", JSON.parse(JSON.stringify(payload))]);
        return { success: true };
      }
    }
  });

  harness.context.window.miaMcpLibrary.renderMcpLibrary();
  harness.els.skillCardGrid.querySelector('[data-mcp-action="oauth-login"]').click();
  await flushAsync();
  harness.els.skillCardGrid.querySelector('[data-mcp-action="oauth-logout"]').click();
  await flushAsync();
  state.mcp.activeTab = "custom";
  harness.context.window.miaMcpLibrary.renderMcpLibrary();
  harness.els.skillCardGrid.querySelector('[data-mcp-action="import-agent-config"]').click();
  await flushAsync();

  assert.deepEqual(apiCalls, [
    ["oauth.login", { serverId: "auth", serverUrl: "https://example.com/mcp" }],
    ["oauth.logout", { serverId: "authed", serverUrl: "https://example.com/authed" }],
    ["importAgentConfig", { sourceAgent: "Claude", serverName: "xhs" }]
  ]);
  assert.equal(harness.getListCalls(), 3);
  assert.equal(harness.getMarketplaceCalls(), 3);
  assert.equal(harness.getAgentConfigCalls(), 3);
});

test("mcp-library keeps the custom tab stable with zero filtered records", () => {
  const state = {
    skillFilter: "missing",
    mcp: {
      activeTab: "custom",
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

  harness.context.window.miaMcpLibrary.renderMcpLibrary();

  assert.match(harness.els.skillCardGrid.innerHTML, /没有匹配的入口/);
  assert.doesNotMatch(harness.els.skillCardGrid.innerHTML, /MCP 服务暂不可用/);
  assert.equal(harness.getLayoutCalls(), 1);
});

test("installed-card actions align with AION-style availability checks", async () => {
  const apiCalls = [];
  const state = {
    skillFilter: "",
    mcp: {
      activeTab: "installed",
      servers: [{
        id: "xhs",
        name: "小红书 MCP",
        enabled: true,
        status: "connected",
        transport: { type: "http", url: "http://127.0.0.1:18060/mcp" },
        tools: [{ name: "search_notes" }],
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
        return { success: true };
      },
      delete: async (id) => {
        apiCalls.push(["delete", id]);
        return { success: true };
      }
    }
  });

  harness.context.window.miaMcpLibrary.renderMcpLibrary();

  assert.equal(harness.els.skillCardGrid.querySelector('[data-mcp-action="sync"]'), null);
  assert.equal(harness.els.skillCardGrid.querySelector('[data-mcp-action="toggle"]'), null);
  harness.els.skillCardGrid.querySelector('[data-mcp-action="test"]').click();
  await flushAsync();
  harness.els.skillCardGrid.querySelector('[data-mcp-action="delete"]').click();
  await flushAsync();

  assert.deepEqual(apiCalls, [
    ["test", "xhs"],
    ["delete", "xhs"]
  ]);
  assert.equal(harness.getListCalls(), 2);
  assert.equal(harness.getMarketplaceCalls(), 2);
  assert.deepEqual(harness.confirms, ["删除这个 MCP 服务？"]);
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
  harness.els.skillCardGrid.querySelector('[data-mcp-action="create"]').click();

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
  assert.equal(state.mcp.activeTab, "installed");
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
  assert.equal(state.mcp.activeTab, "installed");
});

test("import flow submits JSON text and reloads on success", async () => {
  const importCalls = [];
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
      importJson: async (text) => {
        importCalls.push(text);
        return { success: true };
      }
    }
  });

  harness.context.window.miaMcpLibrary.renderMcpLibrary();
  harness.els.skillCardGrid.querySelector('[data-mcp-action="import"]').click();

  const form = harness.document.body.querySelector("[data-mcp-import-form]");
  const textarea = form.querySelector('textarea[name="json"]');
  textarea.value = '{"mcpServers":{"xhs":{"command":"npx","args":["xhs"]}}}';
  form.dispatch("submit");
  await flushAsync();

  assert.deepEqual(importCalls, ['{"mcpServers":{"xhs":{"command":"npx","args":["xhs"]}}}']);
  assert.equal(harness.getListCalls(), 1);
  assert.equal(harness.getMarketplaceCalls(), 1);
  assert.equal(state.mcp.activeTab, "installed");
  assert.equal(harness.document.body.querySelector("[data-mcp-import-form]"), null);
});

test("import flow asks before replacing duplicate MCP names", async () => {
  const importCalls = [];
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
      importJson: async (text, options) => {
        importCalls.push([text, options || null]);
        if (!options?.replaceDuplicates) {
          return { success: true, data: { requiresConfirmation: true, duplicates: ["xhs"] } };
        }
        return { success: true, data: { imported: 1, replaced: 1 } };
      }
    }
  });

  harness.context.window.miaMcpLibrary.renderMcpLibrary();
  harness.els.skillCardGrid.querySelector('[data-mcp-action="import"]').click();

  const form = harness.document.body.querySelector("[data-mcp-import-form]");
  form.querySelector('textarea[name="json"]').value = '{"mcpServers":{"xhs":{"command":"npx"}}}';
  form.dispatch("submit");
  await flushAsync();

  assert.equal(importCalls.length, 2);
  assert.equal(importCalls[0][0], '{"mcpServers":{"xhs":{"command":"npx"}}}');
  assert.equal(importCalls[0][1], null);
  assert.equal(importCalls[1][0], '{"mcpServers":{"xhs":{"command":"npx"}}}');
  assert.equal(importCalls[1][1]?.replaceDuplicates, true);
  assert.deepEqual(harness.confirms, ["已存在同名 MCP 服务：xhs。替换后会先清理旧服务的 Agent 同步状态，继续？"]);
  assert.equal(harness.getListCalls(), 1);
  assert.equal(harness.getMarketplaceCalls(), 1);
  assert.equal(state.mcp.activeTab, "installed");
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
  harness.els.skillCardGrid.querySelector('[data-mcp-action="create"]').click();

  const form = harness.document.body.querySelector("[data-mcp-form]");
  const nameInput = form.querySelector('input[name="name"]');
  nameInput.value = "Broken MCP";
  form.dispatch("submit");
  await flushAsync();

  assert.deepEqual(harness.alerts, ["保存失败：boom"]);
  const openForm = harness.document.body.querySelector("[data-mcp-form]");
  assert.ok(openForm);
  assert.equal(openForm.querySelector('input[name="name"]').value, "Broken MCP");
  assert.equal(harness.getListCalls(), 0);
  assert.equal(harness.getMarketplaceCalls(), 0);
});

test("failed import keeps the import dialog and JSON text available", async () => {
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
      importJson: async () => ({ success: false, error: "bad json" })
    }
  });

  harness.context.window.miaMcpLibrary.renderMcpLibrary();
  harness.els.skillCardGrid.querySelector('[data-mcp-action="import"]').click();

  const form = harness.document.body.querySelector("[data-mcp-import-form]");
  const textarea = form.querySelector('textarea[name="json"]');
  textarea.value = '{"mcpServers":{"broken":}}';
  form.dispatch("submit");
  await flushAsync();

  assert.deepEqual(harness.alerts, ["导入失败：bad json"]);
  const openForm = harness.document.body.querySelector("[data-mcp-import-form]");
  assert.ok(openForm);
  assert.equal(openForm.querySelector('textarea[name="json"]').value, '{"mcpServers":{"broken":}}');
  assert.equal(harness.getListCalls(), 0);
  assert.equal(harness.getMarketplaceCalls(), 0);
});
