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
  assert.match(html, /href="\.\/landing\.css\?v=20260528-role-avatars"/);
  assert.match(html, /src="\.\/landing\.js\?v=20260528-role-avatars" defer/);
  assert.match(html, /<h1[^>]*>\s*Mia AI 伙伴工作台\s*<\/h1>/);
  assert.match(html, /Mia Agent Workspace/);
  assert.match(html, /class="[^"]*\bproduct-scene\b[^"]*"/);
  assert.match(html, /class="[^"]*\bconversation-search\b[^"]*"/);
  assert.match(html, /class="[^"]*\bchat-transcript\b[^"]*"/);
  assert.match(html, /class="[^"]*\bcomposer-preview\b[^"]*"/);
  assert.match(html, /class="[^"]*\bpreview-gallery\b[^"]*"/);
  assert.match(html, /class="[^"]*\bgroup-window\b[^"]*"/);
  assert.match(html, /class="[^"]*\bprivate-window\b[^"]*"/);
  // role-based avatar classes replaced the persona ones — lock the migration
  assert.match(css, /\.avatar-(strategy|engineer|editor|assistant)\b/);
  assert.doesNotMatch(html, /\bavatar-(boy|cat|girl)\b/);
  assert.doesNotMatch(css, /\bavatar-(boy|cat|girl)\b/);
  // tablet width must stack the gallery to one column, not cram two
  assert.match(css, /@media \(max-width: 980px\)[\s\S]*\.preview-gallery\s*\{[\s\S]*?grid-template-columns:\s*1fr/);
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
  assert.match(html, /发布助理/);
  assert.match(html, /发布项目组/);
  assert.match(html, /群聊协作/);
  assert.match(html, /私聊跟进/);
  assert.match(html, /搜索/);
  assert.match(html, /内容策划、前端工程师、翻译编辑已就位/);
  assert.match(html, /内容策划/);
  assert.match(html, /前端工程师/);
  assert.match(html, /我负责卖点和页面节奏/);
  assert.match(html, /我负责代码和发布检查/);
  assert.match(html, /我先补一版中英文草稿/);
  assert.match(html, /需要本机命令，我会先弹出确认/);
  assert.match(html, /输入消息，Enter 发送/);
  assert.match(html, /Claude Code[\s\S]*Codex/);
  assert.match(html, /Hermes/);
  assert.doesNotMatch(html, /空铃：|Codex：|Hermes：/);
  assert.doesNotMatch(html, /<strong>空铃<\/strong>|<strong>Codex<\/strong>|<strong>Hermes<\/strong>|<strong>匠妹<\/strong>/);
  assert.doesNotMatch(html, /谁来跟/);
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
