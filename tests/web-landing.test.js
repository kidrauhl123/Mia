const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const packageJson = require("../package.json");

const ROOT = path.join(__dirname, "..");
const APP_VERSION = packageJson.version;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

  assert.match(html, /<title>Mia — 每个人的 Agent 之家<\/title>/);
  assert.match(html, /每个人的 Agent 之家/);
  assert.match(html, /学习、创作、求职和日程推进下去/);
  assert.match(html, /href="assets\/mia\.css\?v=20260630-squad-stack-24"/);
  assert.match(html, /href="assets\/mia-gradient\.css\?v=20260630-squad-stack-24"/);
  assert.match(html, /href="assets\/mia-scroll\.css\?v=20260630-squad-stack-24"/);
  assert.match(html, /href="assets\/mia-feature\.css\?v=20260630-squad-stack-24"/);
  assert.match(html, /href="assets\/mia-mobile\.css\?v=20260630-squad-stack-24"/);
  assert.match(html, /href="assets\/mia-cta\.css\?v=20260630-squad-stack-24"/);
  assert.match(html, /src="assets\/vendor\/gsap\.min\.js\?v=20260630-squad-stack-24"/);
  assert.match(html, /src="assets\/vendor\/CustomEase\.min\.js\?v=20260630-squad-stack-24"/);
  assert.match(html, /src="assets\/vendor\/ScrollTrigger\.min\.js\?v=20260630-squad-stack-24"/);
  assert.match(html, /src="assets\/programmatic-sky\.js\?v=20260630-squad-stack-24"/);
  assert.match(html, /src="assets\/mia\.js\?v=20260709-download-0144"/);
  assert.match(html, /src="assets\/mia-scroll\.js\?v=20260630-squad-stack-24"/);
  assert.match(html, /src="assets\/mia-logo\.png"/);
  assert.match(html, /class="[^"]*\bmiawin\b[^"]*"/);
  assert.match(html, /class="[^"]*\bmw-search\b[^"]*"/);
  assert.match(html, /class="[^"]*\bmw-chat\b[^"]*"/);
  assert.match(html, /class="[^"]*\bmw-composer\b[^"]*"/);
  assert.match(html, /class="[^"]*\bduo\b[^"]*"/);
  assert.match(html, /class="[^"]*\bcombo-row\b[^"]*"/);
  assert.match(html, /data-programmatic-sky/);
  assert.match(html, /class="[^"]*\bsquad-stack\b[^"]*"/);
  assert.match(html, /class="[^"]*\bgsap-large-button\b[^"]*"/);
  assert.doesNotMatch(html, /\bavatar-(boy|cat|girl)\b/);
  assert.doesNotMatch(css, /\bavatar-(boy|cat|girl)\b/);
  assert.match(css, /@media \(max-width: 940px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /\.mw-body\s*\{[\s\S]*overflow-y:\s*auto/);
  assert.match(css, /\.mw-msg\s*\{[^}]*flex:\s*0 0 auto/);
  assert.match(css, /--mia-sidebar-width:\s*320px/);
  assert.match(css, /--mia-window-width:\s*980px/);
  assert.match(css, /--mia-window-height:\s*700px/);
  assert.match(css, /\.miawin-grid\s*\{[\s\S]*grid-template-columns:\s*var\(--mia-sidebar-width\) minmax\(0,\s*1fr\)/);
  assert.match(css, /\.mw-rail\s*\{[\s\S]*display:\s*none/);
  assert.match(css, /\.mw-msg\.me\s*\{[^}]*align-self:\s*stretch[^}]*justify-content:\s*flex-start/);
  assert.match(css, /\.mw-msg\.me \.mw-bubble\s*\{[^}]*calc\(100% - 8px\)/);
  assert.match(css, /\.mw-body\s*\{[\s\S]*padding:\s*8px 10px/);
  assert.doesNotMatch(scrollCss, /--hero-product-scale/);
  assert.doesNotMatch(scrollCss, /transform:\s*scale\(var\(--hero-product-scale\)\)/);
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
  assert.match(html, new RegExp(`download="Mia-${escapeRegExp(APP_VERSION)}-Apple-Silicon\\.dmg"`));
  assert.match(html, /href="\/downloads\/mia-macos-intel-latest\.dmg"/);
  assert.match(html, /download="Mia-[0-9.]+-Intel\.dmg"/);
  assert.match(html, /href="\/downloads\/mia-windows-latest\.exe"/);
  assert.match(html, /download="Mia-[0-9.]+-Setup\.exe"/);
  assert.match(html, /href="\/downloads\/mia-android-latest\.apk"/);
  assert.match(html, /data-download-option="android"/);
  assert.match(html, /data-primary-download/);
  assert.match(html, /data-download-menu-button/);
  assert.match(html, /data-download-option="ios"/);
  assert.match(html, /<a class="nav-cta" data-primary-download [^>]*>下载<\/a>/);
  assert.doesNotMatch(html, /class="nav-cta"[^>]*data-download-label/);
  assert.match(html, /iPhone \/ iPad/);
  assert.match(css, /\.download-menu/);
  assert.match(html, /href="\/app\/"/);
  assert.match(html, /使用网页版/);
  assert.match(js, /打开网页版/);
  assert.match(html, /下载 macOS 版/);
  assert.match(js, /navigator\.userAgentData/);
  assert.match(js, /getHighEntropyValues\(\['architecture', 'platform'\]\)/);
  assert.match(js, /mac-intel/);
  assert.match(js, /android/);
  assert.match(js, /ios/);
  // Android download link is patched at runtime from the in-app update manifest
  // so the site never serves a stale/missing -latest.apk alias.
  assert.match(js, /downloads\/mia-mobile-update\.json/);
  assert.match(js, /DOWNLOADS\.android\.href = apkUrl/);
  assert.match(html, /@ 谁就谁来/);
  assert.match(html, /多端同步/);
  assert.match(html, /对话、资料和任务云端同步/);
  assert.match(html, /展示准备小组/);
  assert.match(html, /搜索/);
  assert.match(html, /学习/);
  assert.match(html, /资料/);
  assert.match(html, /求职/);
  assert.match(html, /写作/);
  assert.doesNotMatch(js, /展示准备包/);
  assert.doesNotMatch(js, /mw-result/);
  assert.match(html, /Enter 发送/);
  assert.match(html, /Claude Code[\s\S]*Codex/);
  assert.match(html, /Hermes/);
  assert.doesNotMatch(html, /OpenClaw/);
  assert.doesNotMatch(html, /assets\/icons\/openclaw\.svg/);
  assert.doesNotMatch(html, /Permission request/);
  assert.match(html, /多模型可选/);
  assert.match(html, /创建提醒: 明晚 22:00 复习展示稿/);
  assert.match(html, new RegExp(`Mia-${escapeRegExp(APP_VERSION)}-Apple-Silicon\\.dmg`));
  assert.match(js, new RegExp(`download: 'Mia-${escapeRegExp(APP_VERSION)}-Apple-Silicon\\.dmg'`));
  assert.match(js, /download: 'Mia-[0-9.]+-Intel\.dmg'/);
  assert.match(js, /download: 'Mia-[0-9.]+-Setup\.exe'/);
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

test("web root includes the site verification txt file", () => {
  assert.equal(
    read("src/web/5a371047c22c89872f93f00c7d8af123.txt").trim(),
    "24dd5141e8f881adf83372da5cd9d6f1f60f2b32"
  );
});

test("cloud release builder can publish desktop installers as web downloads", () => {
  const source = read("scripts/build-cloud-release.js");

  assert.match(source, /mia-macos-apple-silicon-latest\.dmg/);
  assert.match(source, /mia-macos-arm64-latest\.dmg/);
  assert.match(source, /mia-macos-intel-latest\.dmg/);
  assert.match(source, /mia-macos-x64-latest\.dmg/);
  assert.match(source, /mia-windows-latest\.exe/);
  assert.match(source, /mia-windows-x64-latest\.exe/);
  assert.match(source, /Mia-\*-Apple-Silicon\.dmg/);
  assert.match(source, /Mia-\*-Intel\.dmg/);
  assert.match(source, /Mia-\*-Setup\.exe/);
  assert.match(source, /downloadNamePatterns: \[\/Mia-macOS-Apple-Silicon\\\.dmg\/g/);
  assert.match(source, /const fileName = path\.basename\(artifact\)/);
  assert.match(source, /copyDesktopDownloadArtifacts/);
  assert.match(source, /rewriteWebDownloadLinks/);
  assert.match(source, /\/downloads\/\$\{download\.fileName\}/);
  assert.match(source, /verifyVersionedWebDownloadLinks/);
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
