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
  const markdownSource = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "helpers", "markdown-helpers.js"), "utf8");
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "shared", "trace-blocks.js"), "utf8");
  const state = { openTraceKeys: new Set(), animatedTraceKeys: new Set() };
  const mockWindow = {};
  const context = vm.createContext({ window: mockWindow, Set, String, Array, Math, URL });
  vm.runInContext(markdownSource, context);
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

test("renderTraceBlocks exposes trace bodies as managed accordions", () => {
  const { traceBlocks } = loadTraceBlocks();
  const html = traceBlocks.renderTraceBlocks({
    reasoning: "checking project files",
    tools: [
      {
        id: "tool_1",
        name: "shell",
        status: "completed",
        preview: "git status",
        durationMs: 4
      }
    ],
    expanded: true,
    scopeKey: "msg:m_trace"
  });

  assert.match(html, /<details class="trace-row reasoning[^"]*"[^>]*data-accordion="true"/);
  assert.match(
    html,
    /<div class="trace-accordion-body accordion-body"><pre class="trace-body">checking project files<\/pre><\/div>/
  );
  assert.match(html, /<details class="trace-row tool[^"]*"[^>]*data-accordion="true"/);
  assert.match(
    html,
    /<div class="trace-accordion-body accordion-body"><pre class="trace-body">git status<\/pre><\/div>/
  );
});

test("completed legacy trace is grouped behind one manually expandable process row", () => {
  const { traceBlocks, state } = loadTraceBlocks();
  const input = {
    reasoning: "checking project files",
    tools: [{ id: "tool_1", name: "shell", status: "completed", preview: "git status" }],
    content: "最终回复",
    completed: true,
    scopeKey: "msg:m_legacy"
  };

  const collapsed = traceBlocks.renderTraceBlocks(input);
  assert.match(collapsed, /class="trace-row assistant-process/);
  assert.match(collapsed, /data-trace-key="msg:m_legacy::process"/);
  assert.doesNotMatch(collapsed, /checking project files|git status/);

  state.openTraceKeys.add("msg:m_legacy::process");
  const expanded = traceBlocks.renderTraceBlocks(input);
  assert.match(expanded, /checking project files/);
  assert.match(expanded, /git status/);
});

test("collapsed trace bodies are hydrated only when the row opens", () => {
  const { traceBlocks } = loadTraceBlocks();
  const key = "msg:m_lazy::tool::tool_1";
  const html = traceBlocks.renderTraceBlocks({
    reasoning: "",
    tools: [{ id: "tool_1", name: "shell", status: "completed", preview: "git status" }],
    expanded: false,
    scopeKey: "msg:m_lazy"
  });

  assert.match(html, /data-lazy-trace-body="true"/);
  const body = {
    dataset: {},
    innerHTML: "",
    removeAttribute(name) { delete this.dataset[name.replace(/^data-/, "").replace(/-([a-z])/g, (_m, c) => c.toUpperCase())]; }
  };
  const row = {
    dataset: { traceKey: key },
    querySelector(selector) {
      return selector === "[data-lazy-trace-body]" ? body : null;
    }
  };

  assert.equal(traceBlocks.hydrateTraceRow(row), true);
  assert.match(body.innerHTML, /<pre class="trace-body">git status<\/pre>/);
});

test("Mia memory traces use a brain status and never render raw MCP payloads", () => {
  const { traceBlocks } = loadTraceBlocks();
  const payload = JSON.stringify({
    result: {
      content: [{
        type: "text",
        text: JSON.stringify({ currentEntries: ["用户说喜欢 Mia。"], success: true })
      }]
    }
  });
  const html = traceBlocks.renderTraceBlocks({
    reasoning: "",
    tools: [{
      id: "memory_1",
      name: "mcp.mia-app.memory",
      status: "completed",
      preview: payload
    }],
    content: "",
    expanded: true,
    scopeKey: "msg:m_memory"
  });

  assert.match(html, /class="trace-row tool memory-tool/);
  assert.match(html, /🧠/);
  assert.match(html, /记忆已更新/);
  assert.match(html, /已更新当前 Bot 的记忆。/);
  assert.doesNotMatch(html, /mcp\.mia-app\.memory|currentEntries|用户说喜欢 Mia/);
});

test("renderTraceBlocks linkifies URL and local path text only inside trace bodies", () => {
  const { traceBlocks } = loadTraceBlocks();
  const preview = "open https://example.com/docs?x=1, then /Users/jung/GitHub/Mia/src/shared/trace-blocks.js:42:7";
  const trace = {
    reasoning: "",
    tools: [
      {
        id: "tool_1",
        name: "shell",
        status: "completed",
        preview
      }
    ],
    scopeKey: "msg:m_links"
  };
  const collapsed = traceBlocks.renderTraceBlocks({ ...trace, expanded: false });
  assert.match(
    collapsed,
    /<span class="trace-arg">open https:\/\/example\.com\/docs\?x=1, then \/Users\/jung\/GitHub\/Mia\/src\/shared\/trace-blocks\.js:42:7<\/span>/
  );
  const html = traceBlocks.renderTraceBlocks({ ...trace, expanded: true });

  assert.match(
    html,
    /<a class="message-link trace-link" data-external-link="https:\/\/example\.com\/docs\?x=1"[^>]*data-trace-link="true"[^>]*>https:\/\/example\.com\/docs\?x=1<\/a>,/
  );
  assert.doesNotMatch(html, /message-link-site-icon/);
  assert.match(
    html,
    /<a class="message-link trace-link" data-local-file-path="\/Users\/jung\/GitHub\/Mia\/src\/shared\/trace-blocks\.js" data-local-file-line="42" data-local-file-column="7"[^>]*data-trace-link="true"[^>]*>\/Users\/jung\/GitHub\/Mia\/src\/shared\/trace-blocks\.js:42:7<\/a>/
  );
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

test("completed assistant content collapses prior text and trace while keeping the final reply visible", () => {
  const { traceBlocks, state } = loadTraceBlocks();
  const input = {
    blocks: [
      { type: "thinking", id: "think_1", text: "检查上下文", status: "completed" },
      { type: "text", id: "text_1", text: "我先看一下目录。" },
      { type: "tool", id: "tool_1", name: "shell", preview: "pwd", status: "completed" },
      { type: "text", id: "text_2", text: "最终结论：开发态已修复。" }
    ],
    completed: true,
    scopeKey: "msg:m_completed",
    renderTextBlock(block) {
      return `<div class="bubble assistant-text-block">${escapeHtml(block.text)}</div>`;
    }
  };

  const collapsed = traceBlocks.renderAssistantContentBlocks(input);
  assert.match(collapsed, /class="trace-row assistant-process/);
  assert.match(collapsed, /data-trace-key="msg:m_completed::process"/);
  assert.match(collapsed, /<span class="trace-cmd">查看过程<\/span>/);
  assert.match(collapsed, /最终结论：开发态已修复。/);
  assert.doesNotMatch(collapsed, /我先看一下目录。|检查上下文|pwd/);

  state.openTraceKeys.add("msg:m_completed::process");
  const expanded = traceBlocks.renderAssistantContentBlocks(input);
  assert.match(expanded, /class="trace-row assistant-process[^"]*"[^>]*open/);
  assert.match(expanded, /我先看一下目录。/);
  assert.match(expanded, /检查上下文/);
  assert.match(expanded, /pwd/);
  assert.ok(expanded.indexOf("最终结论：开发态已修复。") > expanded.indexOf("我先看一下目录。"));
});

test("renderAssistantContentBlocks displays agent-provided recap blocks", () => {
  const { traceBlocks } = loadTraceBlocks();
  const html = traceBlocks.renderAssistantContentBlocks({
    blocks: [
      { type: "text", id: "text_1", text: "先给答案。" },
      {
        type: "recap",
        id: "recap_1",
        text: "You asked how to share phone VPN; use a same-WiFi HTTP proxy."
      }
    ],
    scopeKey: "msg:m_recap",
    renderTextBlock(block) {
      return `<div class="bubble assistant-text-block">${escapeHtml(block.text)}</div>`;
    }
  });

  assert.ok(html.indexOf("先给答案。") < html.indexOf("Recap"));
  assert.match(html, /class="trace-row recap/);
  assert.match(html, /<span class="trace-cmd">Recap<\/span>/);
  assert.match(html, /You asked how to share phone VPN/);
  assert.match(html, /data-trace-key="msg:m_recap::block::1::recap::recap_1"/);
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
    expanded: true,
    renderTextBlock(block) {
      return `<div class="bubble assistant-text-block">${escapeHtml(block.text)}</div>`;
    }
  });

  assert.ok(html.indexOf("我先改文件。") < html.indexOf("Edited src/web/app.js"));
  assert.ok(html.indexOf("Edited src/web/app.js") < html.indexOf("改完了。"));
  assert.match(html, /class="trace-row file-edit/);
  assert.match(html, /class="trace-row file-edit[^"]*"[^>]*data-accordion="true"/);
  assert.match(html, /data-trace-key="msg:m2::block::1::file_edit::edit_1"/);
  assert.doesNotMatch(html, /Edited src\/web\/app\.js \(\+5 -1\)/);
  assert.match(html, /<span class="trace-meta diff-stats"><span class="diff-stat diff-stat-add">\+5<\/span><span class="diff-stat diff-stat-del">-1<\/span><\/span>/);
  assert.doesNotMatch(html, /diff --git/);
  assert.doesNotMatch(html, /--- a\/src\/web\/app\.js/);
  assert.doesNotMatch(html, /\+\+\+ b\/src\/web\/app\.js/);
  assert.doesNotMatch(html, /@@ -1,2 \+1,2 @@/);
  assert.match(html, /<div class="trace-accordion-body accordion-body"><pre class="trace-body diff-body">/);
  assert.doesNotMatch(html, /<\/span>\n<span class="diff-line/);
  assert.match(html, /<span class="diff-line diff-meta diff-hunk"><span class="diff-ln">···<\/span><span class="diff-code"><\/span><\/span>/);
  assert.match(html, /<span class="diff-line diff-del"><span class="diff-ln">1<\/span><span class="diff-code">-old<\/span><\/span>/);
  assert.match(html, /<span class="diff-line diff-add"><span class="diff-ln">1<\/span><span class="diff-code">\+new<\/span><\/span>/);
  assert.match(html, /<span class="diff-line diff-context"><span class="diff-ln">2<\/span><span class="diff-code"> same<\/span><\/span>/);
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

  assert.match(html, /diff-context"><span class="diff-ln">7<\/span><span class="diff-code"> context/);
  assert.match(html, /diff-del"><span class="diff-ln">8<\/span><span class="diff-code">-old/);
  assert.match(html, /diff-add"><span class="diff-ln">8<\/span><span class="diff-code">\+new/);
  assert.match(html, /diff-add"><span class="diff-ln">9<\/span><span class="diff-code">\+extra/);
  assert.match(html, /diff-context"><span class="diff-ln">10<\/span><span class="diff-code"> tail/);
});

test("renderAssistantContentBlocks trims shared indentation from diff code", () => {
  const { traceBlocks } = loadTraceBlocks();
  const html = traceBlocks.renderAssistantContentBlocks({
    blocks: [{
      type: "file_edit",
      id: "edit_1",
      path: "src/app.js",
      action: "update",
      diff: "@@ -20,2 +20,2 @@\n         const oldValue = value;\n-        return oldValue;\n+        return nextValue;",
      additions: 1,
      deletions: 1,
      status: "completed"
    }],
    scopeKey: "msg:m_indent",
    expanded: true,
    renderTextBlock(block) {
      return `<div class="bubble assistant-text-block">${escapeHtml(block.text)}</div>`;
    }
  });

  assert.match(html, /diff-context"><span class="diff-ln">20<\/span><span class="diff-code"> const oldValue = value;<\/span>/);
  assert.match(html, /diff-del"><span class="diff-ln">21<\/span><span class="diff-code">-return oldValue;<\/span>/);
  assert.match(html, /diff-add"><span class="diff-ln">21<\/span><span class="diff-code">\+return nextValue;<\/span>/);
  assert.doesNotMatch(html, /<span class="diff-code">[ +-] {4,}/);
});

test("trace CSS hides previews immediately when a row is toggled open", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "styles", "chat.css"), "utf8");
  assert.match(css, /\.trace-row\[open\]\s*>\s*summary\s*>\s*\.trace-arg\s*\{\s*display:\s*none;/);
});

test("trace CSS supports accordion height transitions", () => {
  const rendererCss = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "styles", "chat.css"), "utf8");
  const webCss = fs.readFileSync(path.join(__dirname, "..", "src", "web", "styles.css"), "utf8");
  for (const css of [rendererCss, webCss]) {
    assert.match(css, /\.trace-accordion-body\s*\{[\s\S]*?overflow:\s*hidden;/);
    assert.match(
      css,
      /\.trace-row\.accordion-closing\s*>\s*summary\s*>\s*\.trace-chevron\s*\{[\s\S]*?transform:\s*rotate\(0deg\);/
    );
  }
});

test("trace bodies are clipped instead of creating nested scroll containers", () => {
  const rendererCss = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "styles", "chat.css"), "utf8");
  const webCss = fs.readFileSync(path.join(__dirname, "..", "src", "web", "styles.css"), "utf8");
  for (const css of [rendererCss, webCss]) {
    const traceBodyRule = css.match(/\.trace-body\s*\{([\s\S]*?)\n\}/)?.[1] || "";
    const diffBodyRule = css.match(/\.trace-body\.diff-body\s*\{([\s\S]*?)\n\}/)?.[1] || "";
    assert.match(traceBodyRule, /overflow:\s*hidden;/);
    assert.doesNotMatch(traceBodyRule, /overflow:\s*(?:auto|scroll);/);
    assert.match(diffBodyRule, /overflow:\s*hidden;/);
    assert.doesNotMatch(diffBodyRule, /overflow:\s*(?:auto|scroll);/);
  }
});

test("trace CSS styles diff rows with terminal-like add/delete colors", () => {
  const rendererCss = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "styles", "chat.css"), "utf8");
  const webCss = fs.readFileSync(path.join(__dirname, "..", "src", "web", "styles.css"), "utf8");
  for (const css of [rendererCss, webCss]) {
    assert.match(css, /\.trace-body\.diff-body/);
    assert.match(css, /\.trace-body\.diff-body\s*\{[\s\S]*?background:\s*#0f1117;/);
    assert.match(css, /\.diff-line\s*\{[\s\S]*?grid-template-columns:\s*4ch minmax\(0,\s*1fr\);/);
    assert.match(css, /\.diff-line\s*\{[\s\S]*?min-width:\s*0;/);
    assert.match(css, /\.diff-ln\s*\{[\s\S]*?text-align:\s*right;/);
    assert.match(css, /\.diff-code\s*\{[\s\S]*?white-space:\s*pre-wrap;/);
    assert.match(css, /\.diff-code\s*\{[\s\S]*?overflow-wrap:\s*anywhere;/);
    assert.match(css, /\.trace-meta\.diff-stats/);
    assert.match(css, /\.diff-stat\.diff-stat-add/);
    assert.match(css, /\.diff-stat\.diff-stat-del/);
    assert.match(css, /\.diff-line\.diff-del\s*\{[\s\S]*?background:\s*rgba\(\s*248,\s*81,\s*73,\s*0\.30\s*\);/);
    assert.match(css, /\.diff-line\.diff-del \.diff-ln\s*\{[\s\S]*?background:\s*rgba\(\s*248,\s*81,\s*73,\s*0\.18\s*\);/);
    assert.match(css, /\.diff-line\.diff-add\s*\{[\s\S]*?background:\s*rgba\(\s*63,\s*185,\s*80,\s*0\.28\s*\);/);
    assert.match(css, /\.diff-line\.diff-add \.diff-ln\s*\{[\s\S]*?background:\s*rgba\(\s*63,\s*185,\s*80,\s*0\.16\s*\);/);
  }
});

test("trace CSS keeps trace links hidden until modifier hover", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "styles", "chat.css"), "utf8");
  assert.match(css, /\.trace-link\s*\{[\s\S]*?color:\s*inherit;/);
  assert.match(css, /\.trace-link\s*\{[\s\S]*?text-decoration:\s*none;/);
  assert.match(css, /\.trace-link\s*\{[\s\S]*?cursor:\s*text;/);
  assert.match(css, /\.trace-link-modifier-active\s+\.trace-link:hover\s*\{[\s\S]*?text-decoration:\s*underline;/);
  assert.match(css, /\.trace-link-modifier-active\s+\.trace-link:hover\s*\{[\s\S]*?cursor:\s*pointer;/);
});
