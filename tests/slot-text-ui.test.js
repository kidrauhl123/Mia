const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function animatedIds(source) {
  const match = source.match(/const ANIMATED_TEXT_IDS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(match, "ANIMATED_TEXT_IDS should be declared");
  return new Set([...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]));
}

test("desktop and web shells load the shared slot-text runtime before app.js", () => {
  const desktopHtml = read("src/renderer/index.html");
  const webHtml = read("src/web/app/index.html");

  for (const html of [desktopHtml, webHtml]) {
    assert.match(html, /shared\/vendor\/slot-text\/style\.css/);
    assert.match(html, /shared\/slot-text-runtime\.js/);
    assert.match(html, /slot-text-runtime\.js[\s\S]*app\.js/);
  }
  assert.match(desktopHtml, /vendor\/slot-text\/style\.css[\s\S]*\.\/styles\.css/);
  assert.match(webHtml, /vendor\/slot-text\/style\.css[\s\S]*\.\.\/styles\.css/);
});

test("desktop status labels opt into slot text through the shared text helper", () => {
  const app = read("src/renderer/app.js");
  const modelSettings = read("src/renderer/settings/model-settings.js");
  const ids = animatedIds(app);

  assert.match(app, /function setAnimatedText\(/);
  assert.match(app, /function flashAnimatedText\(/);
  assert.deepEqual(
    [...ids].sort(),
    ["activeChatMeta", "currentSessionTitle", "modelSwitchStatus"].sort()
  );
  assert.match(app, /setAnimatedText\(els\.currentSessionTitle,\s*next/);
  assert.match(app, /setText\(metaEl,\s*tiles\.length \? `群聊 · \$\{tiles\.length\} 人` : "群聊"\)/);
  assert.doesNotMatch(app, /metaEl\.textContent = "私聊"/);
  assert.match(app, /flashAnimatedText\(button,\s*"已复制"/);
  assert.match(modelSettings, /setText\(els\.quickModelLabel,\s*selected\?\.textContent \|\| ""/);
});

test("web status labels and copy buttons use slot text helpers", () => {
  const app = read("src/web/app.js");
  const ids = animatedIds(app);

  assert.match(app, /function setAnimatedText\(/);
  assert.match(app, /function flashAnimatedText\(/);
  assert.match(app, /const staleRichText = el\.dataset\?\.slotTextValue === text[\s\S]*?!currentHtml\.includes\("char-slot"\)/);
  assert.deepEqual([...ids].sort(), ["activeMeta", "currentSessionTitle"].sort());
  assert.match(app, /setAnimatedText\(els\.currentSessionTitle,\s*next/);
  assert.match(app, /flashAnimatedText\(copyButton,\s*"已复制"/);
});

test("code copy buttons keep real text content for slot animation", () => {
  const markdown = read("src/renderer/helpers/markdown-helpers.js");
  const desktopChatCss = read("src/renderer/styles/chat.css");
  const webCss = read("src/web/styles.css");

  assert.match(markdown, /data-slot-copy-label/);
  assert.doesNotMatch(desktopChatCss, /\.message-code-copy\.copied::before/);
  assert.doesNotMatch(webCss, /\.message-code-copy\.copied::before/);
});

test("social UID copy button flashes through slot text", () => {
  const social = read("src/renderer/social/social.js");

  assert.match(social, /window\.miaSlotText\?\.flash/);
});
