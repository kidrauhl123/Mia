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
  const contentBlocksSource = fs.readFileSync(path.join(__dirname, "..", "src", "shared", "assistant-content-blocks.js"), "utf8");
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "shared", "trace-blocks.js"), "utf8");
  const state = { openTraceKeys: new Set(), animatedTraceKeys: new Set() };
  const mockWindow = { miaMarkdown: { escapeHtml } };
  const context = vm.createContext({ window: mockWindow, Set, String, Array, Math });
  vm.runInContext(contentBlocksSource, context);
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

test("renderAssistantContentBlocks keeps thinking, text, tool, text render order", () => {
  const { traceBlocks } = loadTraceBlocks();
  const html = traceBlocks.renderAssistantContentBlocks({
    blocks: [
      { type: "thinking", id: "think_1", text: "检查上下文", status: "completed" },
      { type: "text", id: "text_1", text: "我先看目录。" },
      { type: "tool", id: "tool_1", name: "shell", preview: "pwd", status: "completed" },
      { type: "text", id: "text_2", text: "结论是已确认。" }
    ],
    scopeKey: "msg:m1",
    renderTextBlock(block) {
      return `<div class="bubble assistant-text-block">${escapeHtml(block.text)}</div>`;
    }
  });

  const thinkingIdx = html.indexOf('class="trace-row reasoning');
  const firstTextIdx = html.indexOf("我先看目录。");
  const toolIdx = html.indexOf('class="trace-row tool');
  const secondTextIdx = html.indexOf("结论是已确认。");
  assert.ok(thinkingIdx >= 0);
  assert.ok(firstTextIdx > thinkingIdx);
  assert.ok(toolIdx > firstTextIdx);
  assert.ok(secondTextIdx > toolIdx);
  assert.match(html, /data-trace-key="msg:m1::block::0::reasoning"/);
  assert.match(html, /data-trace-key="msg:m1::block::2::tool::tool_1"/);
});

test("renderAssistantContentBlocks hides thinking that duplicates the final message", () => {
  const { traceBlocks } = loadTraceBlocks();
  const finalText = "今天（6月19日周五）邱县下雨。现在是傍晚到夜间的情况。";
  const html = traceBlocks.renderAssistantContentBlocks({
    blocks: [
      { type: "thinking", id: "think_1", text: finalText, status: "completed" },
      { type: "text", id: "text_1", text: finalText }
    ],
    scopeKey: "msg:m_dup",
    renderTextBlock(block) {
      return `<div class="bubble assistant-text-block">${escapeHtml(block.text)}</div>`;
    }
  });

  assert.doesNotMatch(html, /class="trace-row reasoning/);
  assert.equal((html.match(/今天（6月19日周五）邱县下雨/g) || []).length, 1);
  assert.match(html, /class="bubble assistant-text-block"/);
});

test("renderAssistantContentBlocks renders file edit blocks as expandable diff trace rows", () => {
  const { traceBlocks } = loadTraceBlocks();
  const html = traceBlocks.renderAssistantContentBlocks({
    blocks: [
      { type: "text", id: "text_1", text: "我先改文件。" },
      {
        type: "file_edit",
        id: "edit_1",
        path: "src/web/app.js",
        action: "update",
        title: "Edited src/web/app.js (+5 -1)",
        diff: "diff --git a/src/web/app.js b/src/web/app.js\n--- a/src/web/app.js\n+++ b/src/web/app.js\n@@ -1,2 +1,2 @@\n-old\n+new\n same",
        additions: 5,
        deletions: 1,
        status: "completed"
      },
      { type: "text", id: "text_2", text: "改完了。" }
    ],
    scopeKey: "msg:m2",
    renderTextBlock(block) {
      return `<div class="bubble assistant-text-block">${escapeHtml(block.text)}</div>`;
    }
  });

  assert.ok(html.indexOf("我先改文件。") < html.indexOf("Edited src/web/app.js"));
  assert.ok(html.indexOf("Edited src/web/app.js") < html.indexOf("改完了。"));
  assert.match(html, /class="trace-row file-edit/);
  assert.match(html, /data-trace-key="msg:m2::block::1::file_edit::edit_1"/);
  assert.doesNotMatch(html, /Edited src\/web\/app\.js \(\+5 -1\)/);
  assert.match(html, /<span class="trace-meta diff-stats"><span class="diff-stat diff-stat-add">\+5<\/span><span class="diff-stat diff-stat-del">-1<\/span><\/span>/);
  assert.doesNotMatch(html, /diff --git/);
  assert.doesNotMatch(html, /--- a\/src\/web\/app\.js/);
  assert.doesNotMatch(html, /\+\+\+ b\/src\/web\/app\.js/);
  assert.doesNotMatch(html, /@@ -1,2 \+1,2 @@/);
  assert.match(html, /<pre class="trace-body diff-body">/);
  assert.doesNotMatch(html, /<\/span>\n<span class="diff-line/);
  assert.match(html, /<span class="diff-line diff-meta diff-hunk"><span class="diff-ln diff-ln-old">···<\/span><span class="diff-ln diff-ln-new">···<\/span><span class="diff-code"><\/span><\/span>/);
  assert.match(html, /<span class="diff-line diff-del"><span class="diff-ln diff-ln-old">1<\/span><span class="diff-ln diff-ln-new"><\/span><span class="diff-code">-old<\/span><\/span>/);
  assert.match(html, /<span class="diff-line diff-add"><span class="diff-ln diff-ln-old"><\/span><span class="diff-ln diff-ln-new">1<\/span><span class="diff-code">\+new<\/span><\/span>/);
  assert.match(html, /<span class="diff-line diff-context"><span class="diff-ln diff-ln-old">2<\/span><span class="diff-ln diff-ln-new">2<\/span><span class="diff-code"> same<\/span><\/span>/);
});

test("renderAssistantContentBlocks derives diff line numbers from hunk ranges", () => {
  const { traceBlocks } = loadTraceBlocks();
  const html = traceBlocks.renderAssistantContentBlocks({
    blocks: [{
      type: "file_edit",
      id: "edit_1",
      path: "src/app.js",
      action: "update",
      diff: "@@ -7,3 +7,4 @@\n context\n-old\n+new\n+extra\n tail",
      additions: 2,
      deletions: 1,
      status: "completed"
    }],
    scopeKey: "msg:m3",
    expanded: true,
    renderTextBlock(block) {
      return `<div class="bubble assistant-text-block">${escapeHtml(block.text)}</div>`;
    }
  });

  assert.match(html, /diff-context"><span class="diff-ln diff-ln-old">7<\/span><span class="diff-ln diff-ln-new">7<\/span><span class="diff-code"> context/);
  assert.match(html, /diff-del"><span class="diff-ln diff-ln-old">8<\/span><span class="diff-ln diff-ln-new"><\/span><span class="diff-code">-old/);
  assert.match(html, /diff-add"><span class="diff-ln diff-ln-old"><\/span><span class="diff-ln diff-ln-new">8<\/span><span class="diff-code">\+new/);
  assert.match(html, /diff-add"><span class="diff-ln diff-ln-old"><\/span><span class="diff-ln diff-ln-new">9<\/span><span class="diff-code">\+extra/);
  assert.match(html, /diff-context"><span class="diff-ln diff-ln-old">9<\/span><span class="diff-ln diff-ln-new">10<\/span><span class="diff-code"> tail/);
});

test("trace CSS hides previews immediately when a row is toggled open", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "styles", "chat.css"), "utf8");
  assert.match(css, /\.trace-row\[open\]\s*>\s*summary\s*>\s*\.trace-arg\s*\{\s*display:\s*none;/);
});

test("trace CSS styles diff rows with terminal-like add/delete colors", () => {
  const rendererCss = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "styles", "chat.css"), "utf8");
  const webCss = fs.readFileSync(path.join(__dirname, "..", "src", "web", "styles.css"), "utf8");
  for (const css of [rendererCss, webCss]) {
    assert.match(css, /\.trace-body\.diff-body/);
    assert.match(css, /\.trace-body\.diff-body\s*\{[\s\S]*?background:\s*#0f1117;/);
    assert.match(css, /\.diff-line\s*\{[\s\S]*?grid-template-columns:\s*4ch 4ch minmax\(0,\s*1fr\);/);
    assert.match(css, /\.diff-ln\s*\{[\s\S]*?text-align:\s*right;/);
    assert.match(css, /\.trace-meta\.diff-stats/);
    assert.match(css, /\.diff-stat\.diff-stat-add/);
    assert.match(css, /\.diff-stat\.diff-stat-del/);
    assert.match(css, /\.diff-line\.diff-del\s*\{[\s\S]*?background:\s*rgba\(\s*239,\s*68,\s*68,/);
    assert.match(css, /\.diff-line\.diff-add\s*\{[\s\S]*?background:\s*rgba\(\s*34,\s*197,\s*94,/);
  }
});
