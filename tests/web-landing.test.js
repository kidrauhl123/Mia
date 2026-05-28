const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("web root is a landing page with download and app entry points", () => {
  const html = read("src/web/index.html");
  const css = read("src/web/landing.css");
  const js = read("src/web/landing.js");

  assert.match(html, /data-page="landing"/);
  assert.match(html, /href="\.\/landing\.css\?v=20260528-chat-copy"/);
  assert.match(html, /src="\.\/landing\.js\?v=20260528-chat-copy" defer/);
  assert.match(html, /<h1[^>]*>\s*Mia AI 伙伴工作台\s*<\/h1>/);
  assert.match(html, /Mia Workspace/);
  assert.match(html, /class="[^"]*\bproduct-scene\b[^"]*"/);
  assert.match(html, /class="[^"]*\bconversation-search\b[^"]*"/);
  assert.match(html, /class="[^"]*\bchat-transcript\b[^"]*"/);
  assert.match(html, /class="[^"]*\bcomposer-preview\b[^"]*"/);
  assert.doesNotMatch(html, /class="[^"]*\bpermission-sheet\b[^"]*"/);
  assert.doesNotMatch(html, /class="[^"]*\bvisual-strip\b[^"]*"/);
  assert.doesNotMatch(html, /class="[^"]*\bworkflow-section\b[^"]*"/);
  assert.doesNotMatch(html, /class="[^"]*\bfeature-grid\b[^"]*"/);
  assert.doesNotMatch(html, /class="[^"]*\btrust-list\b[^"]*"/);
  assert.doesNotMatch(html, /class="[^"]*\bdownload-cards\b[^"]*"/);
  assert.doesNotMatch(html, /class="[^"]*\bengine-dock\b[^"]*"/);
  assert.match(html, /assets\/engine-icons\/codex-color\.svg/);
  assert.match(css, /assets\/engine-icons\/claudecode\.svg/);
  assert.match(css, /assets\/engine-icons\/hermesagent\.svg/);
  assert.match(html, /class="landing-progress"/);
  assert.doesNotMatch(html, /data-scroll-stage="1"/);
  assert.doesNotMatch(html, /data-stage-target="approve"/);
  assert.match(html, /data-parallax/);
  assert.match(css, /overflow-y: auto/);
  assert.match(css, /--landing-scroll/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /#5e5ce6/);
  assert.match(css, /#30d158/);
  assert.doesNotMatch(css, /--amber|#ff8a1f|#f6851b|#e2761b/i);
  assert.match(js, /requestAnimationFrame/);
  assert.match(js, /IntersectionObserver/);
  assert.match(js, /prefers-reduced-motion: reduce/);
  assert.match(html, /href="\/downloads\/mia-macos-arm64-latest\.dmg"/);
  assert.match(html, /download="Mia-macOS-Apple-Silicon\.dmg"/);
  assert.match(html, /href="\/app\/"/);
  assert.match(html, />\s*打开 Mia Web\s*</);
  assert.match(html, /多个 Fellow/);
  assert.match(html, /舒服的聊天 GUI/);
  assert.match(html, /桌面与 Web 间同步/);
  assert.match(html, /匠妹/);
  assert.match(html, /搜索/);
  assert.match(html, /空铃写卖点，Codex 改代码，Hermes 出草稿/);
  assert.match(html, /需要本机命令时 Mia 会先确认权限/);
  assert.match(html, /输入消息，Enter 发送/);
  assert.match(html, /Claude Code[\s\S]*Codex/);
  assert.match(html, /Hermes/);
  assert.doesNotMatch(html, /配额已耗尽|运行失败|没能生成回复/);
  assert.doesNotMatch(html, /Permission request/);
  assert.match(html, /macOS Apple Silicon/);
  assert.doesNotMatch(html, /macOS Intel/);
  assert.doesNotMatch(html, /Windows/);
});

test("web app shell lives under /app and keeps parent-relative assets", () => {
  const html = read("src/web/app/index.html");

  assert.match(html, /data-auth="loading"/);
  assert.match(html, /id="loginForm"/);
  assert.match(html, /href="\.\.\/styles\.css"/);
  assert.match(html, /src="\.\.\/shared\/unread\.js/);
  assert.match(html, /src="\.\.\/helpers\/markdown-helpers\.js/);
  assert.match(html, /src="\.\.\/appearance\.js/);
  assert.match(html, /src="\.\.\/app\.js/);
  assert.doesNotMatch(html, /href="\.\/styles\.css"/);
  assert.doesNotMatch(html, /src="\.\/app\.js/);
});

test("cloud release builder can publish the Apple Silicon DMG as a web download", () => {
  const source = read("scripts/build-cloud-release.js");

  assert.match(source, /mia-macos-arm64-latest\.dmg/);
  assert.match(source, /Mia-\*-arm64-unsigned\.dmg/);
  assert.match(source, /copyDesktopDownloadArtifacts/);
  assert.match(source, /web\/landing\.css/);
  assert.match(source, /web\/landing\.js/);
});
