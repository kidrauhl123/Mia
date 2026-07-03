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
    /<a class="message-link" data-external-link="https:\/\/jungui-cle\.pages\.dev" role="link" tabindex="0" title="https:\/\/jungui-cle\.pages\.dev"><span class="message-link-site-icon"[^>]*><img class="message-link-site-icon-image" src="https:\/\/jungui-cle\.pages\.dev\/favicon\.ico"[^>]*><span class="message-link-site-icon-fallback"[^>]*><\/span><\/span><span class="message-link-label">https:\/\/jungui-cle\.pages\.dev<\/span><\/a>/
  );
  assert.match(html, /<code class="inline-code" tabindex="0" title="点击复制">1df7f38a\.jungui-cle\.pages\.dev<\/code>/);
  assert.doesNotMatch(html, /data-external-link="https:\/\/1df7f38a\.jungui-cle\.pages\.dev"/);
});

test("markdown keeps closing bold markers outside bare URL links", () => {
  const markdown = loadMarkdownHelpers();
  const html = markdown.renderMarkdown("**localhost 还活着，你可以自己点：http://localhost:3001/zh**");

  assert.match(html, /^<p><strong>localhost 还活着，你可以自己点：/);
  assert.match(html, /<a class="message-link" data-external-link="http:\/\/localhost:3001\/zh" role="link" tabindex="0" title="http:\/\/localhost:3001\/zh"><span class="message-link-site-icon"[^>]*><img class="message-link-site-icon-image" src="https:\/\/localhost\/favicon\.ico"[^>]*><span class="message-link-site-icon-fallback"[^>]*><\/span><\/span><span class="message-link-label">http:\/\/localhost:3001\/zh<\/span><\/a>/);
  assert.match(html, /<\/strong><\/p>$/);
});

test("markdown keeps bold and following prose outside bare URL links", () => {
  const markdown = loadMarkdownHelpers();
  const html = markdown.renderMarkdown("**localhost 还活着，你可以自己点：http://localhost:3001/zh**（夜间模式是我截图时强切的）。");

  assert.match(html, /^<p><strong>localhost 还活着，你可以自己点：/);
  assert.match(html, /<span class="message-link-label">http:\/\/localhost:3001\/zh<\/span><\/a><\/strong>（夜间模式是我截图时强切的）。<\/p>$/);
});

test("markdown renders multiline bold text around bare URL links", () => {
  const markdown = loadMarkdownHelpers();
  const html = markdown.renderMarkdown("**localhost 还活着，\n你可以自己点：http://localhost:3001/zh**（夜间模式是我截图时强切的）。");

  assert.match(html, /^<p><strong>localhost 还活着，<br>你可以自己点：/);
  assert.match(html, /<span class="message-link-label">http:\/\/localhost:3001\/zh<\/span><\/a><\/strong>（夜间模式是我截图时强切的）。<\/p>$/);
});

test("markdown keeps closing bold markers outside markdown links", () => {
  const markdown = loadMarkdownHelpers();
  const html = markdown.renderMarkdown("**自己点：[Mia](/Users/jung/GitHub/Mia)**");

  assert.equal(
    html,
    '<p><strong>自己点：<a class="message-link" data-local-file-path="/Users/jung/GitHub/Mia" role="link" tabindex="0" title="/Users/jung/GitHub/Mia">Mia</a></strong></p>'
  );
});

test("markdown renders inline-code URLs as links while keeping code styling", () => {
  const markdown = loadMarkdownHelpers();
  const html = markdown.renderMarkdown("后端在 `https://premsir.com/shop-api`。");

  assert.equal(
    html,
    '<p>后端在 <a class="message-link inline-code-link" data-external-link="https://premsir.com/shop-api" role="link" tabindex="0" title="https://premsir.com/shop-api"><code class="inline-code">https://premsir.com/shop-api</code></a>。</p>'
  );
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

test("markdown renders greater-than quote lines as blockquotes", () => {
  const markdown = loadMarkdownHelpers();
  const html = markdown.renderMarkdown("前一段\n> 想保留一点暖对比的话，也可以留 `dev` page 的橘红\n后一段");

  assert.equal(
    html,
    '<p>前一段</p><blockquote>想保留一点暖对比的话，也可以留 <code class="inline-code" tabindex="0" title="点击复制">dev</code> page 的橘红</blockquote><p>后一段</p>'
  );
});
