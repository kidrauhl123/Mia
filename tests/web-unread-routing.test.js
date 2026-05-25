// Task 3.3 routing test: web must consume the shared/unread module for
// per-conversation count + total + truncation policy, not roll its own.
//
// We can't load src/web/app.js straight into vm (it touches `document`,
// `localStorage`, WebSocket, …), so this test asserts two narrower
// invariants instead:
//
//   1. src/web/index.html loads shared/unread.js before app.js (and the
//      build-cloud-release script copies the file into the web tree).
//   2. src/web/app.js no longer contains any inline `> 99 ? "99+"` style
//      truncation strings — the shared module owns that policy.
//
// Together with tests/shared-unread.test.js (which already covers
// behaviour for Map readState, etc.) this is enough to keep the web
// migration honest.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

test("src/web/index.html loads shared/unread.js before app.js", () => {
  const html = fs.readFileSync(path.join(ROOT, "src/web/index.html"), "utf8");
  const unreadIdx = html.indexOf("shared/unread.js");
  const appIdx = html.indexOf("./app.js");
  assert.ok(unreadIdx >= 0, "index.html must reference shared/unread.js");
  assert.ok(appIdx >= 0, "index.html must load app.js");
  assert.ok(
    unreadIdx < appIdx,
    "shared/unread.js must be loaded before app.js so window.aimashiUnread is defined when app.js runs"
  );
});

test("src/web/index.html includes private AI composer controls", () => {
  const html = fs.readFileSync(path.join(ROOT, "src/web/index.html"), "utf8");
  assert.match(html, /id="composerBottom"/);
  assert.match(html, /id="quickModelSelect"/);
  assert.match(html, /id="effortSelect"/);
  assert.match(html, /id="permissionMode"/);
});

test("src/web/index.html loads shared engine contracts before app.js", () => {
  const html = fs.readFileSync(path.join(ROOT, "src/web/index.html"), "utf8");
  const engineIdx = html.indexOf("shared/engine-contracts.js");
  const appIdx = html.indexOf("./app.js");
  assert.ok(engineIdx >= 0, "index.html must reference shared/engine-contracts.js");
  assert.ok(appIdx >= 0, "index.html must load app.js");
  assert.ok(engineIdx < appIdx, "engine contracts must be loaded before app.js");
});

test("scripts/build-cloud-release.js copies shared/unread.js into the web tree", () => {
  const build = fs.readFileSync(path.join(ROOT, "scripts/build-cloud-release.js"), "utf8");
  assert.match(
    build,
    /copyFile\(["']src\/shared\/unread\.js["'][^)]+["']shared["'][^)]+["']unread\.js["']\)/,
    "build-cloud-release must copy src/shared/unread.js to web/shared/unread.js"
  );
});

test("scripts/build-cloud-release.js copies shared/engine-contracts.js into the web tree", () => {
  const build = fs.readFileSync(path.join(ROOT, "scripts/build-cloud-release.js"), "utf8");
  assert.match(
    build,
    /copyFile\(["']src\/shared\/engine-contracts\.js["'][^)]+["']shared["'][^)]+["']engine-contracts\.js["']\)/,
    "build-cloud-release must copy src/shared/engine-contracts.js to web/shared/engine-contracts.js"
  );
});

test("src/web/app.js has no inline '> 99 ? 99+' truncation literals", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.equal(
    /> 99 \? ['"]99\+['"]/.test(source),
    false,
    "web/app.js must not duplicate the '99+' truncation; shared/unread owns it"
  );
});

test("src/web/app.js only shows private AI controls in fellow rooms", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.match(source, /function renderComposerControls\(room = null\)/);
  assert.match(source, /roomTypeForControls\(room\)\s*===\s*"fellow"/);
  assert.match(source, /composerBottom\?\.classList\.toggle\("hidden",\s*!show\)/);
  assert.match(source, /saveWebAiControl\("model"/);
  assert.match(source, /saveWebAiControl\("effort"/);
  assert.match(source, /saveWebAiControl\("permission"/);
});

test("src/web/app.js treats legacy fellow rooms as desktop-local runtime", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.match(source, /function runtimeKindForFellowRoom\(room, fellow\)[\s\S]*return runtimeKind \|\| "desktop-local";/);
  assert.doesNotMatch(source, /return runtimeKind \|\| "cloud-hermes";/);
  assert.match(source, /if\s*\(!fellowKey \|\| runtimeKind === "desktop-local"\)\s*\{[\s\S]*桌面端本地伙伴需要在桌面端切换模型设置/);
});

test("src/web/app.js adds clientOpId to PUT runtime writes", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.match(source, /method === "POST" \|\| method === "PUT" \|\| method === "PATCH" \|\| method === "DELETE"/);
  assert.match(source, /\/api\/me\/fellows\/\$\{encodeURIComponent\(fellowKey\)\}\/runtime[\s\S]*method:\s*"PUT"/);
});

test("src/web/styles.css carries desktop-style AI control switchers", () => {
  const css = fs.readFileSync(path.join(ROOT, "src/web/styles.css"), "utf8");
  assert.match(css, /\.model-switcher/);
  assert.match(css, /\.effort-switcher/);
  assert.match(css, /\.permission-switcher/);
  assert.match(css, /\.model-current-label/);
  assert.match(css, /\.permission-switcher\.yolo/);
});

test("src/web/app.js routes through window.aimashiUnread", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.match(
    source,
    /window\.aimashiUnread/,
    "web/app.js must destructure window.aimashiUnread"
  );
  assert.match(
    source,
    /computeUnreadForConversation\(/,
    "web/app.js must call computeUnreadForConversation for per-row badges"
  );
  assert.match(
    source,
    /totalUnreadFromConversations\(/,
    "web/app.js must call totalUnreadFromConversations for the rail badge"
  );
  assert.match(
    source,
    /unreadBadgeHtml\(/,
    "web/app.js must call unreadBadgeHtml so the '99+' policy stays in shared"
  );
});

test("src/web/app.js persists room readMarks as message seq, not timestamps", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.equal(
    /\[id\]:\s*Date\.now\(\)/.test(source),
    false,
    "readMarks are documented as last_seen_seq; web must not write Date.now() timestamps"
  );
  assert.match(
    source,
    /lastSeenSeqForConversation\(/,
    "web should route read-mark computation through a named helper"
  );
  assert.match(
    source,
    /readMarks:\s*\{\s*\[id\]:\s*lastSeenSeqForConversation\(id\)\s*\}/,
    "setActiveConversation should persist the room's cached max seq as the read mark"
  );
});
