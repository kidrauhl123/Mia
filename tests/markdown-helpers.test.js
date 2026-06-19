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
  assert.match(html, /<button type="button" class="message-code-copy" data-copy-code aria-label="复制 Shell 代码" title="复制 Shell 代码">Shell<\/button>/);
  assert.doesNotMatch(html, />⧉<\/button>/);
  assert.doesNotMatch(html, /<figcaption>[\s\S]*<span>Shell<\/span>/);
});

test("markdown renders bracketed absolute file paths as local file links", () => {
  const markdown = loadMarkdownHelpers();
  const html = markdown.renderMarkdown("[mia-diff-demo.txt]\n(/Users/jung/Library/Application%20Support/Mia/runtime/engine-home/workspace/mia-diff-demo.txt)");

  assert.match(html, /<a class="message-link" data-local-file-path="\/Users\/jung\/Library\/Application Support\/Mia\/runtime\/engine-home\/workspace\/mia-diff-demo\.txt" role="link" tabindex="0" title="\/Users\/jung\/Library\/Application Support\/Mia\/runtime\/engine-home\/workspace\/mia-diff-demo\.txt">mia-diff-demo\.txt<\/a>/);
  assert.doesNotMatch(html, /data-external-link/);
});

test("markdown renders file URLs as local file links", () => {
  const markdown = loadMarkdownHelpers();
  const html = markdown.renderMarkdown("[demo](file:///Users/jung/Library/Application%20Support/Mia/demo.txt)");

  assert.match(html, /data-local-file-path="\/Users\/jung\/Library\/Application Support\/Mia\/demo\.txt"/);
  assert.match(html, />demo<\/a>/);
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
