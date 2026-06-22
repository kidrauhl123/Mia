const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");

function loadMarkdownHelpers() {
  const mockWindow = {};
  const context = vm.createContext({
    window: mockWindow,
    globalThis: mockWindow,
    console
  });
  vm.runInContext(fs.readFileSync(path.join(root, "src/renderer/helpers/markdown-helpers.js"), "utf8"), context, {
    filename: "src/renderer/helpers/markdown-helpers.js"
  });
  return mockWindow.miaMarkdown;
}

test("markdown code block renders the language label as the copy button", () => {
  const markdown = loadMarkdownHelpers();
  const html = markdown.renderMarkdown("```shell\npwd\n```");

  assert.match(html, /<figure class="message-code-block" data-language="bash">/);
  assert.match(html, /<button type="button" class="message-code-copy" data-copy-code data-slot-copy-label="Shell" aria-label="复制 Shell 代码" title="复制 Shell 代码">Shell<\/button>/);
  assert.doesNotMatch(html, />⧉<\/button>/);
  assert.doesNotMatch(html, /<figcaption>[\s\S]*<span>Shell<\/span>/);
});

test("markdown renders bracketed absolute file paths as local file links", () => {
  const markdown = loadMarkdownHelpers();
  const html = markdown.renderMarkdown("[mia-diff-demo.txt]\n(/Users/jung/Library/Application%20Support/Mia/runtime/engine-home/workspace/mia-diff-demo.txt)");

  assert.match(html, /<a class="message-link" data-local-file-path="\/Users\/jung\/Library\/Application Support\/Mia\/runtime\/engine-home\/workspace\/mia-diff-demo\.txt" role="link" tabindex="0" title="\/Users\/jung\/Library\/Application Support\/Mia\/runtime\/engine-home\/workspace\/mia-diff-demo\.txt">mia-diff-demo\.txt<\/a>/);
  assert.doesNotMatch(html, /data-external-link/);
});

test("markdown renders angle-bracket local file links with line numbers", () => {
  const markdown = loadMarkdownHelpers();
  const html = markdown.renderMarkdown(
    "见 [index.tsx]\n(</Users/jung/GitHub/Premsir/apps/server/src/plugins/premsir-marketplace/dashboard/index.tsx:1794>)。"
  );

  assert.match(
    html,
    /<a class="message-link" data-local-file-path="\/Users\/jung\/GitHub\/Premsir\/apps\/server\/src\/plugins\/premsir-marketplace\/dashboard\/index\.tsx" data-local-file-line="1794" role="link" tabindex="0" title="\/Users\/jung\/GitHub\/Premsir\/apps\/server\/src\/plugins\/premsir-marketplace\/dashboard\/index\.tsx:1794">index\.tsx<\/a>/
  );
  assert.doesNotMatch(html, /&lt;\/Users\/jung\/GitHub\/Premsir/);
  assert.doesNotMatch(html, /data-local-file-path="[^"]*:1794"/);
});

test("markdown renders file URLs as local file links", () => {
  const markdown = loadMarkdownHelpers();
  const html = markdown.renderMarkdown("[demo](file:///Users/jung/Library/Application%20Support/Mia/demo.txt)");

  assert.match(html, /data-local-file-path="\/Users\/jung\/Library\/Application Support\/Mia\/demo\.txt"/);
  assert.match(html, />demo<\/a>/);
});

test("markdown auto-links bare https URLs while leaving inline code alone", () => {
  const markdown = loadMarkdownHelpers();
  const html = markdown.renderMarkdown("永久网址 → https://jungui-cle.pages.dev\n快照 `1df7f38a.jungui-cle.pages.dev`");

  assert.match(
    html,
    /<a class="message-link" data-external-link="https:\/\/jungui-cle\.pages\.dev" role="link" tabindex="0" title="https:\/\/jungui-cle\.pages\.dev">https:\/\/jungui-cle\.pages\.dev<\/a>/
  );
  assert.match(html, /<code class="inline-code" tabindex="0" title="点击复制">1df7f38a\.jungui-cle\.pages\.dev<\/code>/);
  assert.doesNotMatch(html, /data-external-link="https:\/\/1df7f38a\.jungui-cle\.pages\.dev"/);
});

test("markdown hides Mia path reference blocks from rendered chat text", () => {
  const markdown = loadMarkdownHelpers();
  const source = "请看 IMG1\n\n[[MIA_PATH_REFS_BEGIN]]\nIMG1: /var/folders/x/mia-clipboard/clipboard-1.png\n[[MIA_PATH_REFS_END]]";

  assert.equal(markdown.stripHiddenMarkdown(source), "请看 IMG1");
  assert.match(markdown.renderMarkdown(source), /class="composer-path-ref message-path-ref"/);
  assert.match(markdown.renderMarkdown(source), /data-path-ref-path="\/var\/folders\/x\/mia-clipboard\/clipboard-1\.png"/);
  assert.match(markdown.renderMarkdown(source), />IMG1<\/span>/);
  assert.equal(markdown.renderPreviewMarkdown(source), "请看 IMG1");
});

test("markdown keeps ordered list numbering across blank lines between items", () => {
  const markdown = loadMarkdownHelpers();
  const html = markdown.renderMarkdown("1. 第一项\n\n2. 第二项\n\n3. 第三项");
  const repeatedMarkerHtml = markdown.renderMarkdown("1. 第一项\n\n1. 第二项\n\n1. 第三项");

  assert.equal(html, "<ol><li>第一项</li><li>第二项</li><li>第三项</li></ol>");
  assert.equal(repeatedMarkerHtml, "<ol><li>第一项</li><li>第二项</li><li>第三项</li></ol>");
});
