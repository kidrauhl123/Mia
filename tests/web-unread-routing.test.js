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

test("scripts/build-cloud-release.js copies shared/avatar-resolve.js into the web tree", () => {
  const build = fs.readFileSync(path.join(ROOT, "scripts/build-cloud-release.js"), "utf8");
  assert.match(
    build,
    /copyFile\(["']src\/shared\/avatar-resolve\.js["'][^)]+["']shared["'][^)]+["']avatar-resolve\.js["']\)/,
    "build-cloud-release must copy src/shared/avatar-resolve.js to web/shared/avatar-resolve.js"
  );
});

test("src/web/app/index.html loads shared/avatar-resolve.js before contact.js and app.js", () => {
  const html = fs.readFileSync(path.join(ROOT, "src/web/app/index.html"), "utf8");
  const resolveIdx = html.indexOf("shared/avatar-resolve.js");
  const contactIdx = html.indexOf("shared/contact.js");
  const appIdx = html.indexOf("../app.js");
  assert.ok(resolveIdx >= 0, "index.html must reference shared/avatar-resolve.js");
  assert.ok(contactIdx >= 0, "index.html must reference shared/contact.js");
  assert.ok(appIdx >= 0, "index.html must load app.js");
  assert.ok(
    resolveIdx < contactIdx,
    "shared/avatar-resolve.js must load before shared/contact.js so the identity-hash fallback is available when resolveContact runs"
  );
  assert.ok(
    resolveIdx < appIdx,
    "shared/avatar-resolve.js must load before app.js so window.miaAvatarResolve is defined when app.js evaluates"
  );
});

test("src/web/app.js stopped maintaining its own copy of the avatar preset table", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.doesNotMatch(
    source,
    /const AVATAR_PRESETS\s*=\s*\{/,
    "web/app.js must not declare its own AVATAR_PRESETS object — drift between renderer and web is exactly what we just consolidated"
  );
  assert.doesNotMatch(
    source,
    /const WEB_AVATAR_PRESET_GROUPS\s*=\s*\{[\s\S]*?human:\s*\[[\s\S]{200,}/,
    "web/app.js must not define its own preset list — pull from window.miaAvatarResolve instead"
  );
});

test("src/web/app.js paints group chat headers as a mosaic, not a single-letter circle", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  // renderActiveChat must build the same stacked tiles for groups that the
  // sidebar paints via miaGroupTiles. Without this the chat header for a
  // group conversation falls through to a single-letter bubble.
  const fn = source.match(/function renderActiveChat\([\s\S]*?\n\}/);
  assert.ok(fn, "renderActiveChat must exist");
  assert.match(
    fn[0],
    /miaGroupTiles\.resolveGroupMemberTiles/,
    "renderActiveChat must resolve group member tiles for group conversations"
  );
  assert.match(
    fn[0],
    /els\.activeAvatar\.className\s*=\s*["']avatar group-avatar["']/,
    "renderActiveChat must promote els.activeAvatar to a group-avatar mosaic when the active conversation is a group"
  );
  assert.match(
    fn[0],
    /els\.activeAvatar\.setAttribute\(["']data-count["']/,
    "renderActiveChat must stamp data-count on the group avatar element (CSS layout reads it)"
  );
});

test("src/web/app.js hydrates missing group members before leaving group avatars blank", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  const ensureMatch = source.match(/async function ensureConversationMembers\(conversationId, options = \{\}\)\s*\{[\s\S]*?\n\}/);
  assert.ok(ensureMatch, "ensureConversationMembers must accept render options");
  assert.match(
    ensureMatch[0],
    /pendingConversationMemberFetches/,
    "missing group member fetches must be deduped while a render loop is active"
  );
  assert.match(
    ensureMatch[0],
    /options\.renderOnHydrate[\s\S]*renderConversationList\(\)/,
    "member hydration must repaint the sidebar once group avatar tiles are available"
  );
  assert.match(
    ensureMatch[0],
    /state\.activeConversationId === conversationId[\s\S]*renderActiveChat\(\)/,
    "member hydration must repaint the active group header too"
  );
  assert.match(
    source,
    /ensureConversationMembers\(r\.id,\s*\{\s*renderOnHydrate:\s*true\s*\}\)/,
    "conversation list rendering must trigger hydration for group rows whose member cache is missing"
  );
  assert.match(
    source,
    /ensureConversationMembers\(conversation\.id,\s*\{\s*renderOnHydrate:\s*true\s*\}\)/,
    "active group rendering must trigger hydration for headers whose member cache is missing"
  );
});

test("src/web/app.js normalizes model + provider icon URLs through the same boundary as avatars", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  // setModelAvatar must hand the looked-up icon path through
  // normalizeAvatarUrl before assigning background-image — otherwise the
  // "./assets/model-icons/..." form 404s under the /app/ SPA fallback the
  // same way the fellow avatars used to.
  const setterMatch = source.match(/function setModelAvatar\([\s\S]*?\n\}/);
  assert.ok(setterMatch, "setModelAvatar must exist");
  assert.match(
    setterMatch[0],
    /normalizeAvatarUrl\(/,
    "setModelAvatar must route the icon path through normalizeAvatarUrl so /app/ resolves /assets/... correctly"
  );
  assert.match(
    setterMatch[0],
    /style\.backgroundImage\s*=\s*icon\s*\?/,
    "setModelAvatar still assigns the normalized URL to backgroundImage"
  );
});

test("src/renderer/index.html loads shared/avatar-resolve.js before helpers/avatar-helpers.js", () => {
  const html = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf8");
  const resolveIdx = html.indexOf("shared/avatar-resolve.js");
  const helpersIdx = html.indexOf("helpers/avatar-helpers.js");
  assert.ok(resolveIdx >= 0, "renderer must reference shared/avatar-resolve.js");
  assert.ok(helpersIdx >= 0, "renderer must reference helpers/avatar-helpers.js");
  assert.ok(
    resolveIdx < helpersIdx,
    "shared/avatar-resolve.js must load before helpers/avatar-helpers.js so the renderer's preset aliases resolve at module-eval time"
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
  assert.match(
    build,
    /copyFile\(["']src\/shared\/avatar-resolve\.js["'],\s*path\.join\(apiDir,\s*["']src["'],\s*["']shared["'],\s*["']avatar-resolve\.js["']\)\)/,
    "build-cloud-release must copy avatar-resolve.js because api/server.js resolves member identities"
  );
  assert.match(build, /api\/src\/shared\/conversation-kinds\.js/);
  assert.match(build, /api\/src\/shared\/engine-contracts\.js/);
  assert.match(build, /api\/src\/shared\/group-fellow-routing\.js/);
  assert.match(build, /api\/src\/shared\/skill-safety\.js/);
  assert.match(build, /api\/src\/shared\/avatar-resolve\.js/);
});

test("scripts/build-cloud-release.js ships the git-versioned skill catalog", () => {
  const build = fs.readFileSync(path.join(ROOT, "scripts/build-cloud-release.js"), "utf8");
  assert.match(
    build,
    /copyDir\(["']skills["'],\s*path\.join\(apiDir,\s*["']skills["']\)\)/,
    "cloud release must include top-level skills/ so fresh DB seeding is not empty"
  );
  assert.match(
    build,
    /api\/skills\/commit-craft\/SKILL\.md/,
    "release verifier must fail if seeded marketplace skills are missing"
  );
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
  assert.match(source, /avatarResolve\.resolveAvatarForContact\(\{[\s\S]*displayName[\s\S]*avatarImage: user\.avatarImage/);
  assert.match(source, /applyAvatarMedia\(els\.userAvatar, avatar\.image, avatar\.crop, avatar\.color, avatar\.text\)/);
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
  assert.match(source, /<div class="bubble">\$\{senderTitleHtml\}\$\{highlightedBody\}<\/div>/);
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

test("src/web/app.js reconciles state.unread when another device pushes readMarks", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.match(
    source,
    /function reconcileUnreadFromReadMarks\(/,
    "web/app.js must expose a reconcileUnreadFromReadMarks helper so cross-device read state clears local badges"
  );
  const handlerMatch = source.match(/type === "user_settings\.updated"[\s\S]{0,600}?\}\s*\}/);
  assert.ok(handlerMatch, "user_settings.updated handler must exist");
  assert.match(
    handlerMatch[0],
    /reconcileUnreadFromReadMarks\(/,
    "user_settings.updated must call reconcileUnreadFromReadMarks so desktop-side read state clears web badges"
  );
  assert.match(
    handlerMatch[0],
    /renderRailUnreadBadge\(/,
    "user_settings.updated must refresh the rail badge after reconciling unread"
  );
});

test("src/web/app.js skips unread bump when readMark already covers the replayed message", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  const handlerMatch = source.match(/type === "conversation\.message_appended"[\s\S]*?renderRailUnreadBadge\(\);/);
  assert.ok(handlerMatch, "conversation.message_appended handler must exist");
  assert.match(
    handlerMatch[0],
    /state\.settings\?\.readMarks\?\.\[conversationId\]/,
    "message_appended must consult readMarks before bumping unread (covers WS replay after another device marked read)"
  );
  assert.match(
    handlerMatch[0],
    /msgSeq\s*>\s*readMark/,
    "message_appended must compare msg.seq against the existing readMark"
  );
});

test("src/web/app.js resolves fellow avatars via conversationMembersCache when the fellow isn't owned", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.match(
    source,
    /function fellowAvatarFor\(/,
    "web/app.js must expose a fellowAvatarFor helper so cross-owner fellow avatars don't fall back to single-letter bubbles"
  );
  // Conversation list path must use the new helper.
  assert.match(
    source,
    /fellowAvatarFor\(r,\s*fellowKey\)/,
    "conversation list must route fellow avatar lookup through fellowAvatarFor"
  );
  // Active chat header path must use the new helper.
  assert.match(
    source,
    /fellowAvatarFor\(conversation,\s*fellowKeyForConversation\(conversation\)\)/,
    "active chat header must route fellow avatar lookup through fellowAvatarFor"
  );
  // The helper must consult conversationMembersCache for enriched fellow_avatar_image.
  const helperMatch = source.match(/function fellowAvatarFor\(conversation, fellowKey\)\s*\{[\s\S]*?\n\}\n/);
  assert.ok(helperMatch, "fellowAvatarFor body must be defined");
  assert.match(
    helperMatch[0],
    /state\.conversationMembersCache/,
    "fellowAvatarFor must consult conversationMembersCache for cross-owner fellows"
  );
  assert.match(
    helperMatch[0],
    /hasAvatarIdentityFields/,
    "fellowAvatarFor must distinguish compact owned fellow rows from explicit empty avatar rows"
  );
  assert.match(
    helperMatch[0],
    /fellow_avatar_image/,
    "fellowAvatarFor must read the server-enriched fellow_avatar_image field"
  );
});

test("src/web/app.js normalizes cloud-stored avatar URLs so root-served assets resolve correctly under /app/", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.match(
    source,
    /function normalizeAvatarUrl\(/,
    "web/app.js must define normalizeAvatarUrl so './assets/...' paths don't 404 under /app/'s SPA fallback"
  );
  // Extract the helper body and exercise it by eval so we catch behavior
  // regressions, not just presence.
  const helperMatch = source.match(/function normalizeAvatarUrl\(value\) \{[\s\S]*?\n\}/);
  assert.ok(helperMatch, "normalizeAvatarUrl body must be extractable for behavior assertions");
  // eslint-disable-next-line no-new-func
  const normalizeAvatarUrl = new Function(`
    const window = { miaAvatarResolve: { normalizeAvatarImage(value) {
      const src = String(value || "").trim();
      return /(^|\\/)assets\\/(avatars|avatars-pet|avatar-thumbs|avatar-thumbs-pet|avatar-icons)\\/\\d{2}\\.png$/i.test(src.replace(/^\\.\\//, "").replace(/^\\//, "")) ? "" : src;
    } } };
    ${helperMatch[0]};
    return normalizeAvatarUrl;
  `)();
  assert.equal(normalizeAvatarUrl(""), "", "empty input → empty");
  assert.equal(normalizeAvatarUrl(null), "", "null → empty");
  assert.equal(normalizeAvatarUrl("./assets/avatars/12.png"), "", "former preset path → empty");
  assert.equal(normalizeAvatarUrl("/assets/avatars/12.png"), "", "root former preset path → empty");
  assert.equal(normalizeAvatarUrl("assets/avatars/12.png"), "", "bare former preset path → empty");
  assert.equal(normalizeAvatarUrl("./assets/model-icons/gpt-5.png"), "/assets/model-icons/gpt-5.png", "non-avatar assets still normalize to /assets");
  assert.equal(normalizeAvatarUrl("https://cdn.example.com/x.png"), "https://cdn.example.com/x.png", "absolute https passes through");
  assert.equal(normalizeAvatarUrl("data:image/png;base64,AAAA"), "data:image/png;base64,AAAA", "data URL passes through");
  assert.equal(normalizeAvatarUrl("//cdn.example.com/x.png"), "//cdn.example.com/x.png", "protocol-relative passes through");
  // Both leaf rendering helpers must consume normalizeAvatarUrl, otherwise
  // future changes could swap in a path that bypasses it.
  assert.match(
    source,
    /function avatarBackgroundStyle[\s\S]*?normalizeAvatarUrl\(/,
    "avatarBackgroundStyle must route the image through normalizeAvatarUrl"
  );
  assert.match(
    source,
    /function avatarVideoHtml[\s\S]*?normalizeAvatarUrl\(/,
    "avatarVideoHtml must route the src through normalizeAvatarUrl"
  );
});

test("src/web/app/index.html loads shared/trace-blocks.js before app.js", () => {
  const html = fs.readFileSync(path.join(ROOT, "src/web/app/index.html"), "utf8");
  const traceIdx = html.indexOf("shared/trace-blocks.js");
  const appIdx = html.indexOf("../app.js");
  assert.ok(traceIdx >= 0, "index.html must include shared/trace-blocks.js so window.miaTraceBlocks is defined");
  assert.ok(traceIdx < appIdx, "shared/trace-blocks.js must load before app.js");
});

test("scripts/build-cloud-release.js copies shared/trace-blocks.js into the web tree", () => {
  const source = fs.readFileSync(path.join(ROOT, "scripts/build-cloud-release.js"), "utf8");
  assert.match(
    source,
    /copyFile\("src\/shared\/trace-blocks\.js",\s*path\.join\(webDir,\s*"shared",\s*"trace-blocks\.js"\)\)/,
    "build-cloud-release.js must copy src/shared/trace-blocks.js to the web bundle"
  );
});

test("src/web/app.js wires reasoning + tool trace events into the cloud agent run", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.match(source, /reasoning:\s*""/, "cloudRunFor must seed run.reasoning");
  assert.match(source, /toolsById:\s*new Map\(\)/, "cloudRunFor must seed toolsById map");
  assert.match(source, /reasoning\.available|reasoning_delta/, "WS handler must accept reasoning events");
  assert.match(source, /tool\.delta|tool_call_delta/, "WS handler must accept tool.delta events");
  assert.match(source, /addRunTool\(run/, "tool.started must go through addRunTool");
});

test("src/web/app.js parses persisted trace_json + renders trace blocks for assistant messages", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.match(source, /function parseTraceJson\(/, "web must define a parseTraceJson helper");
  assert.match(
    source,
    /buildConversationMessageArticle[\s\S]*?parseTraceJson\(msg\.trace_json/,
    "buildConversationMessageArticle must parse msg.trace_json"
  );
  assert.match(
    source,
    /buildConversationMessageArticle[\s\S]*?window\.miaTraceBlocks\.renderTraceBlocks/,
    "buildConversationMessageArticle must call renderTraceBlocks for persisted assistant messages"
  );
});

test("src/web/app.js streams trace blocks instead of the 3-chip placeholder", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.match(
    source,
    /buildCloudAgentStreamingArticle[\s\S]*?window\.miaTraceBlocks\.renderTraceBlocks/,
    "buildCloudAgentStreamingArticle must render the streaming run through miaTraceBlocks"
  );
  const streamingMatch = source.match(/function buildCloudAgentStreamingArticle[\s\S]*?\n\}\n/);
  assert.ok(streamingMatch, "buildCloudAgentStreamingArticle should be locatable");
  assert.doesNotMatch(streamingMatch[0], /run\.tools\.slice\(-3\)/, "streaming must not fall back to the 3-chip preview");
});

test("src/web/app.js delegates trace row toggles to state.openTraceKeys", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.match(source, /openTraceKeys:\s*new Set\(\)/, "state must hold a Set for trace open keys");
  assert.match(
    source,
    /els\.chat\.addEventListener\("toggle"[\s\S]*?details\.trace-row\[data-trace-key\][\s\S]*?openTraceKeys\.add/,
    "chat container must remember trace expansion via openTraceKeys"
  );
});

test("src/web/app.js initialises miaTraceBlocks with the web state on bootstrap", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.match(
    source,
    /window\.miaTraceBlocks[\s\S]{0,200}?initTraceBlocks\(\{\s*state\s*\}\)/,
    "app.js must call miaTraceBlocks.initTraceBlocks({state}) once at init"
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
