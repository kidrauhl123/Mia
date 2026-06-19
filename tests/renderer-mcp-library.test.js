const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

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
  const src = read("src/renderer/mcp/mcp-library.js");
  const fakeEl = () => ({
    innerHTML: "",
    textContent: "",
    classList: { add() {}, remove() {}, toggle() {} },
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: () => {}
  });
  const state = {
    skillFilter: "",
    mcp: {
      activeTab: "installed",
      servers: [{ id: "mcp_xhs", name: "小红书 MCP", enabled: true, status: "connected", transport: { type: "http", url: "http://127.0.0.1:18060/mcp" }, tools: [{ name: "search_notes" }], sync: {} }],
      templates: [{ id: "xhs-local-http", name: "小红书 MCP", description: "本地 HTTP", transport: { type: "http" } }],
      loading: false,
      error: ""
    }
  };
  const els = { skillPageTitle: fakeEl(), skillChipRow: fakeEl(), skillCardGrid: fakeEl() };
  const context = {
    console,
    window: { mia: { mcp: { list: async () => ({ success: true, data: { servers: state.mcp.servers } }) } } }
  };
  vm.createContext(context);
  vm.runInContext(src, context, { filename: "mcp-library.js" });
  context.window.miaMcpLibrary.initMcpLibrary({
    state,
    els,
    escapeHtml: (value) => String(value || "").replace(/&/g, "&amp;"),
    setText: (node, value) => { node.textContent = value; }
  });
  context.window.miaMcpLibrary.renderMcpLibrary();

  assert.match(els.skillCardGrid.innerHTML, /小红书 MCP/);
  assert.match(els.skillChipRow.innerHTML, /已安装/);
  assert.match(els.skillChipRow.innerHTML, /市场/);
  assert.match(els.skillChipRow.innerHTML, /自定义/);
});
