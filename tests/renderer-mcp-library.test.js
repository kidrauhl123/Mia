const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const flushAsync = async (turns = 3) => {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
};

function createFakeEl() {
  return {
    innerHTML: "",
    textContent: "",
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {} },
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: () => {},
    closest: () => null,
    getBoundingClientRect: () => ({ left: 0, width: 0, height: 0 })
  };
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function createMcpContext(overrides = {}) {
  const list = overrides.list || (async () => ({ success: true, data: { servers: [] } }));
  const fetchMarketplace = overrides.fetchMarketplace || (async () => ({ success: true, data: { templates: [] } }));
  const context = {
    console,
    window: {
      mia: {
        mcp: {
          list,
          fetchMarketplace
        }
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(read("src/renderer/mcp/mcp-library.js"), context, { filename: "mcp-library.js" });
  return context;
}

test("ability library exposes MCP service mode and loads MCP renderer script", () => {
  const appState = read("src/renderer/app-state.js");
  const skillLibrary = read("src/renderer/skills/skill-library.js");
  const html = read("src/renderer/index.html");

  assert.match(appState, /skillCapabilityMode:\s*"market"/);
  assert.match(appState, /mcp:\s*\{/);
  assert.match(skillLibrary, /data-skill-mode="mcp"/);
  assert.match(skillLibrary, /window\.miaMcpLibrary\.renderMcpLibrary/);
  assert.match(html, /styles\/mcp\.css/);
  assert.match(html, /mcp\/mcp-library\.js/);
});

test("mcp-library renders installed, marketplace, and custom tabs", async () => {
  const state = {
    skillFilter: "",
    mcp: {
      activeTab: "installed",
      servers: [{ id: "mcp_xhs", name: "小红书 MCP", enabled: true, status: "connected", transport: { type: "http", url: "http://127.0.0.1:18060/mcp" }, tools: [{ name: "search_notes" }], sync: {} }],
      templates: [{ id: "xhs-local-http", name: "小红书 MCP", description: "本地 HTTP", transport: { type: "http" } }],
      loaded: true,
      loadAttempted: true,
      loading: false,
      error: "",
      serverError: "",
      templateError: ""
    }
  };
  let layoutCalls = 0;
  const els = { skillPageTitle: createFakeEl(), skillChipRow: createFakeEl(), skillCardGrid: createFakeEl() };
  const context = createMcpContext({
    list: async () => ({ success: true, data: { servers: state.mcp.servers } }),
    fetchMarketplace: async () => ({ success: true, data: { templates: state.mcp.templates } })
  });
  context.window.miaMcpLibrary.initMcpLibrary({
    state,
    els,
    escapeHtml,
    setText: (node, value) => { node.textContent = value; },
    layoutCards: () => { layoutCalls += 1; }
  });
  context.window.miaMcpLibrary.renderMcpLibrary();

  assert.match(els.skillCardGrid.innerHTML, /小红书 MCP/);
  assert.match(els.skillChipRow.innerHTML, /已安装/);
  assert.match(els.skillChipRow.innerHTML, /市场/);
  assert.match(els.skillChipRow.innerHTML, /自定义/);
  assert.equal(layoutCalls, 1);
});

test("mcp-library settles empty successful responses into stable empty states", async () => {
  let listCalls = 0;
  let marketplaceCalls = 0;
  let layoutCalls = 0;
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
  const els = { skillPageTitle: createFakeEl(), skillChipRow: createFakeEl(), skillCardGrid: createFakeEl() };
  const context = createMcpContext({
    list: async () => {
      listCalls += 1;
      return { success: true, data: { servers: [] } };
    },
    fetchMarketplace: async () => {
      marketplaceCalls += 1;
      return { success: true, data: { templates: [] } };
    }
  });
  context.window.miaMcpLibrary.initMcpLibrary({
    state,
    els,
    escapeHtml,
    setText: (node, value) => { node.textContent = value; },
    layoutCards: () => { layoutCalls += 1; }
  });

  await context.window.miaMcpLibrary.loadMcpServers();
  await flushAsync();

  assert.equal(listCalls, 1);
  assert.equal(marketplaceCalls, 1);
  assert.equal(state.mcp.loading, false);
  assert.equal(state.mcp.loaded, true);
  assert.equal(state.mcp.loadAttempted, true);
  assert.match(els.skillCardGrid.innerHTML, /暂无已安装 MCP 服务/);

  context.window.miaMcpLibrary.renderMcpLibrary();
  assert.equal(listCalls, 1);
  assert.equal(marketplaceCalls, 1);
  assert.match(els.skillCardGrid.innerHTML, /暂无已安装 MCP 服务/);

  state.mcp.activeTab = "marketplace";
  context.window.miaMcpLibrary.renderMcpLibrary();
  assert.equal(listCalls, 1);
  assert.equal(marketplaceCalls, 1);
  assert.match(els.skillCardGrid.innerHTML, /暂无可用模板/);
  assert.ok(layoutCalls >= 3);
});

test("mcp-library keeps the custom tab stable with zero filtered records", () => {
  let layoutCalls = 0;
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
  const els = { skillPageTitle: createFakeEl(), skillChipRow: createFakeEl(), skillCardGrid: createFakeEl() };
  const context = { console, window: {} };
  vm.createContext(context);
  vm.runInContext(read("src/renderer/mcp/mcp-library.js"), context, { filename: "mcp-library.js" });
  context.window.miaMcpLibrary.initMcpLibrary({
    state,
    els,
    escapeHtml,
    setText: (node, value) => { node.textContent = value; },
    layoutCards: () => { layoutCalls += 1; }
  });

  context.window.miaMcpLibrary.renderMcpLibrary();

  assert.match(els.skillCardGrid.innerHTML, /没有匹配的入口/);
  assert.doesNotMatch(els.skillCardGrid.innerHTML, /MCP 服务暂不可用/);
  assert.equal(layoutCalls, 1);
});
