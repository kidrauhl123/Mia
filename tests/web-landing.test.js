const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("web root is a promo landing page with download and app entry points", () => {
  const html = read("src/web/index.html");
  const css = read("src/web/assets/mia.css");
  const gradientCss = read("src/web/assets/mia-gradient.css");
  const scrollCss = read("src/web/assets/mia-scroll.css");
  const js = read("src/web/assets/mia.js");
  const scrollJs = read("src/web/assets/mia-scroll.js");

  assert.match(html, /Mia 把一群 AI 当同事用/);
  assert.match(html, /Multiple Intelligent Agents/);
  assert.match(html, /href="assets\/mia\.css\?v=20260608-downloads1"/);
  assert.match(html, /href="assets\/mia-gradient\.css\?v=20260608-downloads1"/);
  assert.match(html, /href="assets\/mia-scroll\.css\?v=20260608-downloads1"/);
  assert.match(html, /src="assets\/mia\.js\?v=20260608-downloads1"/);
  assert.match(html, /src="assets\/mia-scroll\.js\?v=20260608-downloads1"/);
  assert.match(html, /src="assets\/mia-logo\.png"/);
  assert.match(html, /class="[^"]*\bmiawin\b[^"]*"/);
  assert.match(html, /class="[^"]*\bmw-search\b[^"]*"/);
  assert.match(html, /class="[^"]*\bmw-chat\b[^"]*"/);
  assert.match(html, /class="[^"]*\bmw-composer\b[^"]*"/);
  assert.match(html, /class="[^"]*\bduo\b[^"]*"/);
  assert.match(html, /class="[^"]*\bcombo-row\b[^"]*"/);
  assert.doesNotMatch(html, /\bavatar-(boy|cat|girl)\b/);
  assert.doesNotMatch(css, /\bavatar-(boy|cat|girl)\b/);
  assert.match(css, /@media \(max-width: 940px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /#5e5ce6/);
  assert.match(css, /#30d158/);
  assert.match(gradientCss, /body\[data-palette="sunset"\]/);
  assert.match(scrollCss, /\.hero-track/);
  assert.match(scrollCss, /\.scrolly-grid/);
  assert.match(js, /requestAnimationFrame/);
  assert.match(js, /IntersectionObserver/);
  assert.match(js, /prefers-reduced-motion: reduce/);
  assert.match(scrollJs, /IntersectionObserver/);
  assert.match(scrollJs, /prefers-reduced-motion: reduce/);
  assert.match(html, /href="\/downloads\/mia-macos-apple-silicon-latest\.dmg"/);
  assert.match(html, /download="Mia-macOS-Apple-Silicon\.dmg"/);
  assert.match(html, /href="\/downloads\/mia-macos-intel-latest\.dmg"/);
  assert.match(html, /download="Mia-macOS-Intel\.dmg"/);
  assert.match(html, /href="\/downloads\/mia-windows-latest\.exe"/);
  assert.match(html, /download="Mia-Windows\.exe"/);
  assert.match(html, /href="\/downloads\/mia-android-latest\.apk"/);
  assert.match(html, /data-download-option="android"/);
  assert.match(html, /data-primary-download/);
  assert.match(html, /data-download-menu-button/);
  assert.match(html, /data-download-option="ios"/);
  assert.match(html, /iPhone \/ iPad/);
  assert.match(css, /\.download-menu/);
  assert.match(html, /href="\/app\/"/);
  assert.match(html, />\s*打开网页版\s*</);
  assert.match(html, /下载 macOS 版/);
  assert.match(js, /navigator\.userAgentData/);
  assert.match(js, /getHighEntropyValues\(\['architecture', 'platform'\]\)/);
  assert.match(js, /mac-intel/);
  assert.match(js, /android/);
  assert.match(js, /ios/);
  assert.match(html, /@ 谁就谁来/);
  assert.match(html, /多端同步/);
  assert.match(html, /账号、好友、群聊云端同步/);
  assert.match(html, /改版上线小组/);
  assert.match(html, /搜索/);
  assert.match(html, /工程/);
  assert.match(html, /调研/);
  assert.match(html, /写作/);
  assert.match(js, /帮我把新版落地页的测试跑一下/);
  assert.match(html, /Enter 发送/);
  assert.match(html, /Claude Code[\s\S]*Codex/);
  assert.match(html, /Hermes/);
  assert.doesNotMatch(html, /空铃：|Codex：|Hermes：/);
  assert.doesNotMatch(html, /<strong>空铃<\/strong>|<strong>Codex<\/strong>|<strong>Hermes<\/strong>|<strong>匠妹<\/strong>/);
  assert.doesNotMatch(html, /谁来跟/);
  assert.doesNotMatch(html, /配额已耗尽|运行失败|没能生成回复/);
  assert.doesNotMatch(html, /Permission request/);
  assert.match(html, /Mia-macOS-Apple-Silicon\.dmg/);
  assert.match(html, /macOS Intel/);
  assert.match(html, /Windows/);
});

test("web app shell lives under /app and keeps parent-relative assets", () => {
  const html = read("src/web/app/index.html");

  assert.match(html, /data-auth="loading"/);
  assert.match(html, /id="loginForm"/);
  assert.match(html, /href="\.\.\/styles\.css(?:\?[^"]*)?"/);
  assert.match(html, /src="\.\.\/shared\/unread\.js/);
  assert.match(html, /src="\.\.\/helpers\/markdown-helpers\.js/);
  assert.match(html, /src="\.\.\/appearance\.js/);
  assert.match(html, /src="\.\.\/app\.js/);
  assert.doesNotMatch(html, /href="\.\/styles\.css"/);
  assert.doesNotMatch(html, /src="\.\/app\.js/);
});

test("cloud release builder can publish Mac DMGs as web downloads", () => {
  const source = read("scripts/build-cloud-release.js");

  assert.match(source, /mia-macos-apple-silicon-latest\.dmg/);
  assert.match(source, /mia-macos-arm64-latest\.dmg/);
  assert.match(source, /mia-macos-intel-latest\.dmg/);
  assert.match(source, /mia-macos-x64-latest\.dmg/);
  assert.match(source, /Mia-\*-Apple-Silicon\.dmg/);
  assert.match(source, /Mia-\*-Intel\.dmg/);
  assert.match(source, /copyDesktopDownloadArtifacts/);
  assert.match(source, /web\/assets\/mia\.css/);
  assert.match(source, /web\/assets\/mia\.js/);
  assert.match(source, /web\/assets\/mia-gradient\.css/);
  assert.match(source, /web\/assets\/mia-scroll\.css/);
  assert.match(source, /web\/assets\/mia-scroll\.js/);
  assert.match(source, /web\/assets\/mia-logo\.png/);
  assert.match(source, /function shouldCopyReleaseEntry/);
  assert.match(source, /\.DS_Store/);
  assert.match(source, /filter: shouldCopyReleaseEntry/);
});
