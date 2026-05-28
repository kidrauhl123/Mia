const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function loadTraceBlocks() {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "shared", "trace-blocks.js"), "utf8");
  const state = { openTraceKeys: new Set(), animatedTraceKeys: new Set() };
  const mockWindow = { miaMarkdown: { escapeHtml } };
  const context = vm.createContext({ window: mockWindow, Set, String, Array, Math });
  vm.runInContext(source, context);
  mockWindow.miaTraceBlocks.initTraceBlocks({ state });
  return { traceBlocks: mockWindow.miaTraceBlocks, state };
}

test("markRenderedTraceBlocks prevents trace enter animation replay after rebuild", () => {
  const { traceBlocks, state } = loadTraceBlocks();
  const trace = {
    reasoning: "checking project files",
    tools: [{ id: "tool_1", name: "shell", status: "running", preview: "ls" }],
    content: "",
    expanded: true,
    scopeKey: "cloud-run:car_1"
  };

  const firstRender = traceBlocks.renderTraceBlocks(trace);
  assert.match(firstRender, /trace-anim-enter/);
  assert.match(firstRender, /--trace-delay/);

  traceBlocks.markRenderedTraceBlocks({
    querySelectorAll(selector) {
      assert.equal(selector, "details.trace-row[data-trace-key]");
      return [
        { getAttribute: () => "cloud-run:car_1::reasoning" },
        { getAttribute: () => "cloud-run:car_1::tool::tool_1" }
      ];
    }
  });

  assert.equal(state.animatedTraceKeys.has("cloud-run:car_1::reasoning"), true);
  assert.equal(state.animatedTraceKeys.has("cloud-run:car_1::tool::tool_1"), true);

  const secondRender = traceBlocks.renderTraceBlocks(trace);
  assert.doesNotMatch(secondRender, /trace-anim-enter/);
  assert.doesNotMatch(secondRender, /--trace-delay/);
});

test("renderTraceBlocks hides summary previews for open trace rows", () => {
  const { traceBlocks } = loadTraceBlocks();
  const trace = {
    reasoning: "checking project files",
    tools: [{ id: "tool_1", name: "shell", status: "completed", preview: "ls package.json" }],
    content: "",
    scopeKey: "cloud-run:car_1"
  };

  const collapsed = traceBlocks.renderTraceBlocks({ ...trace, expanded: false });
  assert.match(collapsed, /class="trace-arg"/);
  assert.match(collapsed, /checking project files/);
  assert.match(collapsed, /ls package\.json/);

  const open = traceBlocks.renderTraceBlocks({ ...trace, expanded: true });
  assert.doesNotMatch(open, /class="trace-arg"/);
  assert.match(open, /<pre class="trace-body">checking project files<\/pre>/);
  assert.match(open, /<pre class="trace-body">ls package\.json<\/pre>/);
});

test("trace CSS hides previews immediately when a row is toggled open", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "styles", "chat.css"), "utf8");
  assert.match(css, /\.trace-row\[open\]\s*>\s*summary\s*>\s*\.trace-arg\s*\{\s*display:\s*none;/);
});
