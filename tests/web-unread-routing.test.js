// Task 3.3 routing test: web must consume the shared/unread module for
// per-conversation count + total + truncation policy, not roll its own.
//
// We can't load src/web/app.js straight into vm (it touches `document`,
// `localStorage`, WebSocket, …), so this test asserts two narrower
// invariants instead:
//
//   1. src/web/app/index.html loads shared/unread.js before app.js (and the
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

function extractCreateMenuItems(html, menuId) {
  const menuMatch = html.match(new RegExp(`<div id="${menuId}"[^>]*>([\\s\\S]*?)</div>\\s*</header>`));
  assert.ok(menuMatch, `${menuId} menu must exist`);
  return [...menuMatch[1].matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((match) => {
    const body = match[2];
    const label = (body.match(/<span class="create-menu-label">([\s\S]*?)<\/span>/) || [])[1]?.trim() || "";
    const svg = (body.match(/<svg[\s\S]*?<\/svg>/) || [])[0]?.replace(/\s+/g, " ").trim() || "";
    return { label, svg };
  });
}

test("src/web/app/index.html loads shared/unread.js before app.js", () => {
  const html = fs.readFileSync(path.join(ROOT, "src/web/app/index.html"), "utf8");
  const unreadIdx = html.indexOf("shared/unread.js");
  const appIdx = html.indexOf("../app.js");
  assert.ok(unreadIdx >= 0, "index.html must reference shared/unread.js");
  assert.ok(appIdx >= 0, "index.html must load app.js");
  assert.ok(
    unreadIdx < appIdx,
    "shared/unread.js must be loaded before app.js so window.miaUnread is defined when app.js runs"
  );
});

test("src/web/app/index.html includes private AI composer controls", () => {
  const html = fs.readFileSync(path.join(ROOT, "src/web/app/index.html"), "utf8");
  assert.match(html, /id="composerBottom"/);
  assert.match(html, /id="quickModelAvatar"/);
  assert.match(html, /id="quickModelSelect"/);
  assert.match(html, /id="effortSelect"/);
  assert.match(html, /id="permissionMode"/);
});

test("src/web/app/index.html includes the desktop-style chat history menu", () => {
  const html = fs.readFileSync(path.join(ROOT, "src/web/app/index.html"), "utf8");
  assert.match(html, /id="sessionMenuButton"/);
  assert.match(html, /id="currentSessionTitle"/);
  assert.match(html, /id="sessionMenu"/);
  assert.match(html, /id="sessionList"/);
  assert.match(html, /id="newSession"/);
  assert.match(html, />\s*聊天记录\s*</);
});

test("src/web exposes cloud-only fellow creation from the sidebar plus menu", () => {
  const html = fs.readFileSync(path.join(ROOT, "src/web/app/index.html"), "utf8");
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");

  assert.match(html, /id="convMenuNewFellow"/);
  assert.match(html, />\s*创建智能体\s*</);
  assert.match(source, /convMenuNewFellow: document\.getElementById\("convMenuNewFellow"\)/);
  assert.match(source, /function openCreateFellowDialog\(\)/);
  assert.match(source, /function saveCloudOnlyFellowFromWeb\(/);
  assert.match(source, /runtimeKind:\s*"cloud-hermes"/);
  assert.match(source, /\/api\/me\/fellows\/\$\{encodeURIComponent\(key\)\}/);
  assert.match(source, /\/api\/me\/fellows\/\$\{encodeURIComponent\(key\)\}\/runtime/);
  assert.match(source, /\/api\/me\/fellows\/\$\{encodeURIComponent\(key\)\}\/conversation/);
  assert.match(source, /avatarImage:\s*draft\.avatarImage/);
  assert.match(source, /avatarCrop:\s*draft\.avatarCrop/);
  assert.doesNotMatch(source, /id="webFellowRuntimeLocation"/);
  assert.doesNotMatch(source, /desktop-local[\s\S]{0,160}openCreateFellowDialog/);
});

test("src/web sidebar plus menu matches the desktop menu order, labels, and icons", () => {
  const desktopHtml = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf8");
  const webHtml = fs.readFileSync(path.join(ROOT, "src/web/app/index.html"), "utf8");
  const desktopItems = extractCreateMenuItems(desktopHtml, "fellowCreateMenu");
  const webItems = extractCreateMenuItems(webHtml, "conversationCreateMenu");

  assert.deepEqual(
    webItems.map((item) => item.label),
    desktopItems.map((item) => item.label)
  );
  assert.deepEqual(
    webItems.map((item) => item.svg),
    desktopItems.map((item) => item.svg)
  );
});

test("src/web/app/index.html uses the signed-in user avatar in the rail", () => {
  const html = fs.readFileSync(path.join(ROOT, "src/web/app/index.html"), "utf8");
  assert.match(html, /id="userAvatar"/);
  assert.match(html, /class="[^"]*\brail-avatar\b/);
  assert.doesNotMatch(html, /<div class="rail-logo">A<\/div>/);
});

test("src/web/app/index.html loads shared engine contracts before app.js", () => {
  const html = fs.readFileSync(path.join(ROOT, "src/web/app/index.html"), "utf8");
  const engineIdx = html.indexOf("shared/engine-contracts.js");
  const appIdx = html.indexOf("../app.js");
  assert.ok(engineIdx >= 0, "index.html must reference shared/engine-contracts.js");
  assert.ok(appIdx >= 0, "index.html must load app.js");
  assert.ok(engineIdx < appIdx, "engine contracts must be loaded before app.js");
});

test("src/web/app/index.html loads shared session-history before app.js", () => {
  const html = fs.readFileSync(path.join(ROOT, "src/web/app/index.html"), "utf8");
  const historyIdx = html.indexOf("shared/session-history.js");
  const appIdx = html.indexOf("../app.js");
  assert.ok(historyIdx >= 0, "index.html must reference shared/session-history.js");
  assert.ok(appIdx >= 0, "index.html must load app.js");
  assert.ok(historyIdx < appIdx, "session-history must be loaded before app.js");
});

test("src/web/app/index.html loads shared fellow runtime control before app.js", () => {
  const html = fs.readFileSync(path.join(ROOT, "src/web/app/index.html"), "utf8");
  const controlIdx = html.indexOf("shared/fellow-runtime-control.js");
  const appIdx = html.indexOf("../app.js");
  assert.ok(controlIdx >= 0, "index.html must reference shared/fellow-runtime-control.js");
  assert.ok(appIdx >= 0, "index.html must load app.js");
  assert.ok(controlIdx < appIdx, "fellow runtime control must be loaded before app.js");
});

test("src/web/app/index.html loads desktop markdown helper before app.js", () => {
  const html = fs.readFileSync(path.join(ROOT, "src/web/app/index.html"), "utf8");
  const markdownIdx = html.indexOf("helpers/markdown-helpers.js");
  const appIdx = html.indexOf("../app.js");
  assert.ok(markdownIdx >= 0, "index.html must reference the shared desktop markdown helper");
  assert.ok(appIdx >= 0, "index.html must load app.js");
  assert.ok(markdownIdx < appIdx, "markdown helper must be loaded before app.js so web bubbles can render rich text");
});

test("src/web/app/index.html omits redundant status labels from the chat chrome", () => {
  const html = fs.readFileSync(path.join(ROOT, "src/web/app/index.html"), "utf8");
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.doesNotMatch(html, /id="statusText"/);
  assert.doesNotMatch(html, /id="modelSwitchStatus"/);
  assert.doesNotMatch(source, /statusText: document\.getElementById/);
  assert.doesNotMatch(source, /modelSwitchStatus: document\.getElementById/);
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

test("scripts/build-cloud-release.js copies shared/session-history.js into the web tree", () => {
  const build = fs.readFileSync(path.join(ROOT, "scripts/build-cloud-release.js"), "utf8");
  assert.match(
    build,
    /copyFile\(["']src\/shared\/session-history\.js["'][^)]+["']shared["'][^)]+["']session-history\.js["']\)/,
    "build-cloud-release must copy src/shared/session-history.js to web/shared/session-history.js"
  );
});

test("scripts/build-cloud-release.js copies cloud shared modules into the api tree", () => {
  const build = fs.readFileSync(path.join(ROOT, "scripts/build-cloud-release.js"), "utf8");
  assert.match(
    build,
    /copyFile\(["']src\/shared\/engine-contracts\.js["'],\s*path\.join\(apiDir,\s*["']src["'],\s*["']shared["'],\s*["']engine-contracts\.js["']\)\)/,
    "build-cloud-release must copy engine-contracts.js for api shared modules"
  );
  assert.match(
    build,
    /copyFile\(["']src\/shared\/conversation-kinds\.js["'],\s*path\.join\(apiDir,\s*["']src["'],\s*["']shared["'],\s*["']conversation-kinds\.js["']\)\)/,
    "build-cloud-release must copy conversation-kinds.js for api shared modules"
  );
  assert.match(
    build,
    /copyFile\(["']src\/shared\/group-fellow-routing\.js["'],\s*path\.join\(apiDir,\s*["']src["'],\s*["']shared["'],\s*["']group-fellow-routing\.js["']\)\)/,
    "build-cloud-release must copy group-fellow-routing.js for api cloud-agent modules"
  );
  assert.match(
    build,
    /copyFile\(["']src\/shared\/skill-safety\.js["'],\s*path\.join\(apiDir,\s*["']src["'],\s*["']shared["'],\s*["']skill-safety\.js["']\)\)/,
    "build-cloud-release must copy skill-safety.js for api skill package modules"
  );
  assert.match(build, /api\/src\/shared\/conversation-kinds\.js/);
  assert.match(build, /api\/src\/shared\/engine-contracts\.js/);
  assert.match(build, /api\/src\/shared\/group-fellow-routing\.js/);
  assert.match(build, /api\/src\/shared\/skill-safety\.js/);
});

test("cloud release and local web server expose desktop model icon assets", () => {
  const build = fs.readFileSync(path.join(ROOT, "scripts/build-cloud-release.js"), "utf8");
  const serveWeb = fs.readFileSync(path.join(ROOT, "scripts/serve-web.js"), "utf8");
  assert.match(build, /src\/renderer\/assets\/model-icons/);
  assert.match(build, /src\/renderer\/assets\/provider-icons/);
  assert.match(serveWeb, /target\.startsWith\("assets\/model-icons\/"\)/);
  assert.match(serveWeb, /target\.startsWith\("assets\/provider-icons\/"\)/);
  assert.match(serveWeb, /path\.join\(sourceRoot, "renderer", target\)/);
});

test("cloud release and local web server expose desktop markdown helper", () => {
  const build = fs.readFileSync(path.join(ROOT, "scripts/build-cloud-release.js"), "utf8");
  const serveWeb = fs.readFileSync(path.join(ROOT, "scripts/serve-web.js"), "utf8");
  assert.match(build, /src\/renderer\/helpers\/markdown-helpers\.js/);
  assert.match(build, /path\.join\(webDir, "helpers", "markdown-helpers\.js"\)/);
  assert.match(serveWeb, /target === "helpers\/markdown-helpers\.js"/);
  assert.match(serveWeb, /path\.join\(sourceRoot, "renderer", target\)/);
});

test("cloud release API package includes runtime dependencies required by server modules", () => {
  const build = fs.readFileSync(path.join(ROOT, "scripts/build-cloud-release.js"), "utf8");
  assert.match(build, /"adm-zip": rootPackage\.dependencies\?\.\["adm-zip"\]/);
  assert.match(build, /ws: rootPackage\.dependencies\?\.ws/);
});

test("src/web/app.js has no inline '> 99 ? 99+' truncation literals", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.equal(
    /> 99 \? ['"]99\+['"]/.test(source),
    false,
    "web/app.js must not duplicate the '99+' truncation; shared/unread owns it"
  );
});

test("src/web/app.js only shows private AI controls in fellow conversations", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.match(source, /function renderComposerControls\(conversation = null\)/);
  assert.match(source, /conversationTypeForControls\(conversation\)\s*===\s*"fellow"/);
  assert.match(source, /composerBottom\?\.classList\.toggle\("hidden",\s*!show\)/);
  assert.match(source, /saveWebAiControl\("model"/);
  assert.match(source, /saveWebAiControl\("effort"/);
  assert.match(source, /saveWebAiControl\("permission"/);
});

test("src/web/app.js uses platform model catalog for cloud fellow controls", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.match(source, /platformModels/);
  assert.match(source, /loadPlatformModels/);
  assert.match(source, /\/api\/me\/model-catalog/);
  assert.match(source, /selectEntriesForModel\(engine, runtimeKind, config = \{\}\)[\s\S]*state\.platformModels/);
  assert.doesNotMatch(source, /return \[\{ value: "hermes-agent", label: "Hermes Agent" \}\];/);
});

test("src/web/app.js mirrors desktop rail avatar and model icon behavior", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.match(source, /userAvatar: document\.getElementById\("userAvatar"\)/);
  assert.match(source, /function renderUserAvatar\(\)/);
  assert.match(source, /applyAvatarMedia\(els\.userAvatar, image, user\.avatarCrop/);
  assert.match(source, /quickModelAvatar: document\.getElementById\("quickModelAvatar"\)/);
  assert.match(source, /function modelIconSrc\(model = \{\}\)/);
  assert.match(source, /function setModelAvatar\(engine, entry = \{\}, config = \{\}\)/);
  assert.match(source, /setModelAvatar\(engine, selectedModelEntry, config\)/);
});

test("src/web avatar media does not use accent backgrounds or avatar borders", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  const css = fs.readFileSync(path.join(ROOT, "src/web/styles.css"), "utf8");

  assert.match(source, /avatarMedia\.isVideo\?\.\(image\)\) return "background-color:transparent;"/);
  assert.match(source, /style="background-color:transparent;">\$\{avatarVideoHtml/);
  assert.doesNotMatch(source, /style="background-color:\$\{escapeHtml\(color\)\};">\$\{avatarVideoHtml/);
  assert.doesNotMatch(source, /el\.style\.cssText = `background-color:\$\{color\};`/);
  assert.match(css, /\.rail-avatar\s*\{[\s\S]*?background-color:\s*transparent;/);
  assert.match(css, /\.rail-avatar:hover,[\s\S]*?box-shadow:\s*none;/);
  assert.match(css, /\.avatar,\n\.profile-avatar\s*\{[\s\S]*?border:\s*0;/);
  assert.match(css, /\.avatar,\n\.profile-avatar\s*\{[\s\S]*?background-color:\s*transparent;/);
  assert.match(css, /\.avatar-crop-preview\s*\{[\s\S]*?border:\s*0;[\s\S]*?background-color:\s*transparent;[\s\S]*?box-shadow:\s*none;/);
});

test("src/web/app.js renders web bubbles through desktop markdown", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.match(source, /function renderMarkdown\(value\)/);
  assert.match(source, /window\.miaMarkdown\?\.renderMarkdown/);
  assert.match(source, /<div class="bubble">\$\{renderMarkdown\(spec\.bodyMd\)\}<\/div>/);
  assert.match(source, /<div class="bubble">\$\{renderMarkdown\(run\.text\)\}<\/div>/);
  assert.doesNotMatch(source, /escapeHtml\(run\.text\)\.replace\(\/\\n\/g, "<br>"\)/);
  assert.doesNotMatch(source, /escapeHtml\(body\)\.replace\(\/&lt;br&gt;\/g, "<br>"\)/);
});

test("src/web/app.js supports desktop-style markdown links and code copy", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.match(source, /function copyTextToClipboard\(text\)/);
  assert.match(source, /function flashCopiedCode\(code\)/);
  assert.match(source, /data-copy-code/);
  assert.match(source, /a\.message-link\[data-external-link\]/);
  assert.match(source, /window\.open\(link\.dataset\.externalLink, "_blank", "noopener,noreferrer"\)/);
  assert.match(source, /\.bubble code\.inline-code/);
});

test("src/web/app.js lets web controls update desktop-local fellow runtime bindings", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.match(source, /function runtimeKindForFellowConversation\(conversation, fellow\)[\s\S]*return sessionHistory\.runtimeKind\(conversation, "desktop-local"\);/);
  assert.doesNotMatch(source, /return runtimeKind \|\| "cloud-hermes";/);
  assert.doesNotMatch(source, /runtimeKind === "desktop-local"\)\s*return null/);
  assert.doesNotMatch(source, /Desktop controls/);
  assert.doesNotMatch(source, /桌面端本地伙伴需要在桌面端切换模型设置/);
  assert.doesNotMatch(source, /Desktop Local/);
  assert.match(source, /function engineForRuntimeBinding\(runtimeKind, binding\)/);
  assert.match(source, /config\.agentEngine/);
  assert.match(source, /selectEntriesForModel\(engine, runtimeKind, config\)/);
  assert.match(source, /config\.modelEntries/);
  assert.match(source, /const editable = Boolean\(fellowKey\);/);
  assert.match(source, /window\.miaFellowRuntimeControl/);
  assert.match(source, /saveFellowRuntimeControl\(\{/);
  assert.doesNotMatch(source, /body:\s*\{ runtimeKind, enabled: true, config \}/);
});

test("shared fellow runtime control owns Web PUT runtime writes", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  const shared = fs.readFileSync(path.join(ROOT, "src/shared/fellow-runtime-control.js"), "utf8");
  assert.match(source, /method === "POST" \|\| method === "PUT" \|\| method === "PATCH" \|\| method === "DELETE"/);
  assert.match(shared, /\/api\/me\/fellows\/\$\{encodeURIComponent\(fellowKey\)\}\/runtime/);
  assert.match(shared, /method:\s*"PUT"/);
  assert.doesNotMatch(source, /\/api\/me\/fellows\/\$\{encodeURIComponent\(fellowKey\)\}\/runtime[\s\S]*method:\s*"PUT"/);
});

test("cloud release copies shared fellow runtime control into web assets", () => {
  const build = fs.readFileSync(path.join(ROOT, "scripts/build-cloud-release.js"), "utf8");
  assert.match(build, /src\/shared\/fellow-runtime-control\.js/);
  assert.match(build, /path\.join\(webDir, "shared", "fellow-runtime-control\.js"\)/);
  assert.match(build, /"web\/shared\/fellow-runtime-control\.js"/);
});

test("src/web/app.js switches conversations before awaiting network hydration", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  const match = source.match(/function setActiveConversation\(id\) \{([\s\S]*?)\n\}/);
  assert.ok(match, "setActiveConversation should be a synchronous optimistic renderer");
  const body = match[1];
  assert.doesNotMatch(body, /await ensureConversationMessages/);
  assert.doesNotMatch(body, /await ensureConversationMembers/);
  assert.match(source, /async function hydrateActiveConversation\(id\)/);
  assert.ok(
    body.indexOf("renderActiveChat();") >= 0 && body.indexOf("renderActiveChat();") < body.indexOf("hydrateActiveConversation(id);"),
    "active chat should render from cached state before background hydration starts"
  );
});

test("src/web/app.js restores the topbar chat history selector for fellow conversations", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.match(source, /const sessionHistory = window\.miaSessionHistory/);
  assert.match(source, /sessionMenuButton: document\.getElementById\("sessionMenuButton"\)/);
  assert.match(source, /function renderSessionMenu\(\)/);
  assert.match(source, /function sessionConversationsForConversation\(conversation\)/);
  assert.match(source, /sessionHistory\.sessionConversationsForConversation/);
  assert.match(source, /sessionHistory\.sidebarConversations\(state\.conversations/);
  assert.match(source, /sessionHistory\.fellowDisplayTitle\(conversation, state\.fellows, "对话"\)/);
  assert.match(source, /sessionHistory\.createFellowSessionPayload/);
  assert.match(source, /function createNewSessionForActive\(\)/);
  assert.match(source, /\/api\/me\/fellow-conversations\/\$\{encodeURIComponent\(payload\.sessionId\)\}/);
  assert.match(source, /sessionMenuOpen/);
  assert.match(source, /currentSessionTitle/);
  assert.match(source, /newSession\?\.classList\.toggle\("hidden", !canCreate\)/);
});

test("src/web/styles.css carries desktop-style AI control switchers", () => {
  const css = fs.readFileSync(path.join(ROOT, "src/web/styles.css"), "utf8");
  assert.match(css, /\.model-switcher/);
  assert.match(css, /\.effort-switcher/);
  assert.match(css, /\.permission-switcher/);
  assert.match(css, /\.model-current-label/);
  assert.match(css, /\.permission-switcher\.yolo/);
});

test("src/web/styles.css carries desktop-style chat history menu styling", () => {
  const css = fs.readFileSync(path.join(ROOT, "src/web/styles.css"), "utf8");
  assert.match(css, /\.session-trigger/);
  assert.match(css, /\.current-session-title/);
  assert.match(css, /\.session-menu/);
  assert.match(css, /\.session-menu-head/);
  assert.match(css, /\.session-row/);
});

test("src/web/styles.css carries desktop-style rich bubble formatting", () => {
  const css = fs.readFileSync(path.join(ROOT, "src/web/styles.css"), "utf8");
  assert.match(css, /\.bubble h1,/);
  assert.match(css, /\.bubble ul,/);
  assert.match(css, /\.bubble a\.message-link/);
  assert.match(css, /\.bubble code\.inline-code/);
  assert.match(css, /\.message-code-block/);
  assert.match(css, /\.syntax-keyword/);
});

test("src/web/app.js routes through window.miaUnread", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.match(
    source,
    /window\.miaUnread/,
    "web/app.js must destructure window.miaUnread"
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

test("src/web/app.js persists conversation readMarks as message seq, not timestamps", () => {
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
    "setActiveConversation should persist the conversation's cached max seq as the read mark"
  );
});
