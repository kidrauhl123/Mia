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
const rawReadFileSync = fs.readFileSync.bind(fs);

// These tests assert source text with line-oriented regexes. Normalize CRLF so
// a Windows checkout exercises the same assertions as macOS/Linux.
fs.readFileSync = function readFileSyncWithNormalizedText(file, options, ...args) {
  const value = rawReadFileSync(file, options, ...args);
  const encoding = typeof options === "string" ? options : options?.encoding;
  if (typeof value === "string" && /^utf-?8$/i.test(String(encoding || ""))) {
    return value.replace(/\r\n/g, "\n");
  }
  return value;
};

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

test("web composer stops cloud Claude Code runs through the cloud cancel route", () => {
  const app = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  const html = fs.readFileSync(path.join(ROOT, "src/web/app/index.html"), "utf8");
  const css = fs.readFileSync(path.join(ROOT, "src/web/styles.css"), "utf8");

  assert.match(html, /class="send-icon"/);
  assert.match(app, /function activeConversationRun\(\)/);
  assert.match(app, /function stopActiveCloudRun\(\)/);
  assert.match(app, /\/api\/conversations\/\$\{encodeURIComponent\(conversationId\)\}\/runs\/\$\{encodeURIComponent\(activeRun\.runId\)\}\/cancel/);
  assert.match(app, /els\.sendButton\.classList\.toggle\("stop", busy\);/);
  assert.doesNotMatch(app, /window\.mia\.stopChat/);
  assert.match(css, /\.send-button\.stop::before/);
});

test("web avatar display settings default off and do not hide group participants", () => {
  const appearance = fs.readFileSync(path.join(ROOT, "src/web/appearance.js"), "utf8");
  const app = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  const css = fs.readFileSync(path.join(ROOT, "src/web/styles.css"), "utf8");

  assert.match(appearance, /showUserAvatar:\s*false/);
  assert.match(appearance, /showAssistantAvatar:\s*false/);
  assert.match(app, /appearanceShowUserAvatar\)\s*els\.appearanceShowUserAvatar\.checked = ap\.showUserAvatar === true;/);
  assert.match(app, /const cls = `\$\{isOwn \? "message user" : "message assistant"\}\$\{isGroup \? " group-message" : ""\}`;/);
  assert.match(css, /:root\[data-show-assistant-avatar="off"\]\s+\.chat\s+\.message\.assistant:not\(\.group-message\)\s+\.avatar/);
});

test("src/web/app/index.html includes the desktop-style session history menu", () => {
  const html = fs.readFileSync(path.join(ROOT, "src/web/app/index.html"), "utf8");
  assert.match(html, /id="sessionMenuButton"/);
  assert.match(html, /id="currentSessionTitle"/);
  assert.match(html, /id="sessionMenu"/);
  assert.match(html, /id="sessionList"/);
  assert.match(html, /id="newSession"/);
  assert.match(html, />\s*会话记录\s*</);
  assert.doesNotMatch(html, /聊天记录/);
});

test("src/web exposes bot creation with a runtime target selector from the sidebar plus menu", () => {
  const html = fs.readFileSync(path.join(ROOT, "src/web/app/index.html"), "utf8");
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");

  assert.match(html, /id="convMenuNewBot"/);
  assert.match(html, />\s*创建智能体\s*</);
  assert.match(source, /convMenuNewBot: document\.getElementById\("convMenuNewBot"\)/);
  assert.match(source, /id="webCreateBotForm"/);
  assert.match(source, /id="webBotRuntimeTarget"/);
  assert.match(source, /#webBotAvatarPreview/);
  assert.match(source, /function openCreateBotDialog\(\)/);
  assert.match(source, /function saveBotFromWeb\(/);
  assert.match(source, /function webRuntimeTargetGroups\(\)/);
  assert.match(source, /\/api\/me\/bots\?compact=1/);
  assert.match(source, /runtimeKind:\s*"cloud-claude-code"/);
  assert.match(source, /runtimeKind,\s*\n\s*enabled: true,\s*\n\s*activate: true,/);
  assert.match(source, /\/api\/me\/bots\/\$\{encodeURIComponent\(key\)\}/);
  assert.match(source, /\/api\/me\/bots\/\$\{encodeURIComponent\(key\)\}\/runtime/);
  assert.match(source, /\/api\/me\/bot-conversations\/\$\{encodeURIComponent\(key\)\}/);
  assert.match(source, /avatarImage:\s*draft\.avatarImage/);
  assert.match(source, /avatarCrop:\s*draft\.avatarCrop/);
  assert.doesNotMatch(html, /id="convMenuNewFellow"/);
  assert.doesNotMatch(source, /convMenuNewFellow: document\.getElementById/);
  assert.doesNotMatch(source, /id="webCreateFellowForm"/);
  assert.doesNotMatch(source, /#webFellowAvatarPreview/);
  assert.doesNotMatch(source, /id="webBotRuntimeLocation"/);
  assert.doesNotMatch(source, /desktop-local[\s\S]{0,160}openCreateFellowDialog/);
});

test("src/web sidebar plus menu matches the desktop menu order, labels, and icons", () => {
  const desktopHtml = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf8");
  const webHtml = fs.readFileSync(path.join(ROOT, "src/web/app/index.html"), "utf8");
  const desktopItems = extractCreateMenuItems(desktopHtml, "botCreateMenu");
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
  const policyIdx = html.indexOf("shared/agent-engine-policy.js");
  const appIdx = html.indexOf("../app.js");
  assert.ok(engineIdx >= 0, "index.html must reference shared/engine-contracts.js");
  assert.ok(policyIdx >= 0, "index.html must reference shared/agent-engine-policy.js");
  assert.ok(appIdx >= 0, "index.html must load app.js");
  assert.ok(engineIdx < appIdx, "engine contracts must be loaded before app.js");
  assert.ok(engineIdx < policyIdx, "engine contracts must load before agent-engine-policy.js");
  assert.ok(policyIdx < appIdx, "agent engine policy must be loaded before app.js");
});

test("src/web/app/index.html loads shared session-history before app.js", () => {
  const html = fs.readFileSync(path.join(ROOT, "src/web/app/index.html"), "utf8");
  const historyIdx = html.indexOf("shared/session-history.js");
  const appIdx = html.indexOf("../app.js");
  assert.ok(historyIdx >= 0, "index.html must reference shared/session-history.js");
  assert.ok(appIdx >= 0, "index.html must load app.js");
  assert.ok(historyIdx < appIdx, "session-history must be loaded before app.js");
});

test("src/web/app/index.html loads shared conversation tags before app.js", () => {
  const html = fs.readFileSync(path.join(ROOT, "src/web/app/index.html"), "utf8");
  const tagsIdx = html.indexOf("shared/conversation-tags.js");
  const appIdx = html.indexOf("../app.js");
  assert.ok(tagsIdx >= 0, "index.html must reference shared/conversation-tags.js");
  assert.ok(appIdx >= 0, "index.html must load app.js");
  assert.ok(tagsIdx < appIdx, "conversation tags must be loaded before app.js");
});

test("src/web/app.js renders and searches conversation tags from settings", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.match(source, /const conversationTagsApi = window\.miaConversationTags/);
  assert.match(source, /function conversationTagsFor\(conversationId\)/);
  assert.match(source, /tags:\s*conversationTagsFor\(r\.id\)/);
  assert.match(source, /function tagChipsHtml\(tags\)/);
  assert.match(source, /data-conv-action="tags"/);
  assert.match(source, /setConversationTagNames\(conversation\.id,\s*names\)/);
  assert.match(source, /tag\.name[\s\S]{0,120}includes\(query\)/);
});

test("src/web groups conversations by runtime device in collapsible sections", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  const css = fs.readFileSync(path.join(ROOT, "src/web/styles.css"), "utf8");

  assert.match(source, /function conversationDeviceGroupFor\(conversation, bot = null\)/);
  assert.match(source, /label: "Mia Cloud"/);
  assert.match(source, /label: "未分配设备"/);
  assert.match(source, /label: "社交聊天"/);
  assert.match(source, /targetDeviceId/);
  assert.match(source, /function conversationDeviceGroups\(items\)/);
  assert.match(source, /data-device-group-toggle/);
  assert.match(source, /toggleConversationDeviceGroup\(groupToggle\.dataset\.deviceGroupToggle \|\| ""\)/);
  assert.match(source, /conversationDeviceGroups\(items\)\.map\(conversationDeviceGroupHtml\)/);
  assert.match(css, /\.conversation-device-group-header/);
  assert.match(css, /\.conversation-device-group\.collapsed \.conversation-device-group-items/);
});

test("src/web bot avatars use shared bot identity instead of bare bot key", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");

  assert.match(source, /function botAvatarIdentityId\(botKey, bot = \{\}, member = null\)/);
  assert.match(source, /const sharedIdentityId = window\.miaContact\?\.botAvatarIdentityId;/);
  assert.match(source, /const avatarId = botAvatarIdentityId\(wanted, owned \|\| fallbackBot, member \|\| null\);/);
  assert.doesNotMatch(source, /resolveAvatarForContact\(\{\s*id:\s*wanted\b/);
});

test("src/web/app/index.html loads shared bot runtime control before app.js", () => {
  const html = fs.readFileSync(path.join(ROOT, "src/web/app/index.html"), "utf8");
  const controlIdx = html.indexOf("shared/bot-runtime-control.js");
  const appIdx = html.indexOf("../app.js");
  assert.ok(controlIdx >= 0, "index.html must reference shared/bot-runtime-control.js");
  assert.ok(appIdx >= 0, "index.html must load app.js");
  assert.ok(controlIdx < appIdx, "bot runtime control must be loaded before app.js");
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
    /copyFile\(["']packages\/shared\/unread\.js["'][^)]+["']shared["'][^)]+["']unread\.js["']\)/,
    "build-cloud-release must copy packages/shared/unread.js to web/shared/unread.js"
  );
});

test("scripts/build-cloud-release.js copies package-owned send pipeline and cloud client into the web tree", () => {
  const build = fs.readFileSync(path.join(ROOT, "scripts/build-cloud-release.js"), "utf8");
  assert.match(
    build,
    /copyFile\(["']packages\/shared\/send-pipeline\.js["'][^)]+["']shared["'][^)]+["']send-pipeline\.js["']\)/,
    "build-cloud-release must copy packages/shared/send-pipeline.js to web/shared/send-pipeline.js"
  );
  assert.match(
    build,
    /copyFile\(["']packages\/shared\/cloud-client\.js["'][^)]+["']shared["'][^)]+["']cloud-client\.js["']\)/,
    "build-cloud-release must copy packages/shared/cloud-client.js to web/shared/cloud-client.js"
  );
});

test("scripts/build-cloud-release.js copies shared/avatar-resolve.js into the web tree", () => {
  const build = fs.readFileSync(path.join(ROOT, "scripts/build-cloud-release.js"), "utf8");
  assert.match(
    build,
    /copyFile\(["']packages\/shared\/avatar\.js["'][^)]+["']shared["'][^)]+["']avatar-resolve\.js["']\)/,
    "build-cloud-release must copy packages/shared/avatar.js to web/shared/avatar-resolve.js"
  );
});

test("scripts/build-cloud-release.js copies shared/member-color.js for web avatar fallback colors", () => {
  const build = fs.readFileSync(path.join(ROOT, "scripts/build-cloud-release.js"), "utf8");
  assert.match(
    build,
    /copyFile\(["']packages\/shared\/avatar\.js["'][^)]+["']shared["'][^)]+["']member-color\.js["']\)/,
    "build-cloud-release must copy packages/shared/avatar.js to web/shared/member-color.js"
  );
  assert.match(
    build,
    /["']web\/shared\/member-color\.js["']/,
    "verifyRelease must assert web/shared/member-color.js exists instead of allowing nginx to serve HTML fallback"
  );
});

test("scripts/build-cloud-release.js copies shared/avatar-media.js from package avatar", () => {
  const build = fs.readFileSync(path.join(ROOT, "scripts/build-cloud-release.js"), "utf8");
  assert.match(
    build,
    /copyFile\(["']packages\/shared\/avatar\.js["'][^)]+["']shared["'][^)]+["']avatar-media\.js["']\)/,
    "build-cloud-release must copy packages/shared/avatar.js to web/shared/avatar-media.js"
  );
  assert.match(
    build,
    /["']web\/shared\/avatar-media\.js["']/,
    "verifyRelease must assert web/shared/avatar-media.js exists instead of allowing nginx to serve HTML fallback"
  );
});

test("scripts/build-cloud-release.js copies shared conversation tags into api and web trees", () => {
  const build = fs.readFileSync(path.join(ROOT, "scripts/build-cloud-release.js"), "utf8");
  assert.match(
    build,
    /copyFile\(["']src\/shared\/conversation-tags\.js["'][^)]+["']src["'][^)]+["']shared["'][^)]+["']conversation-tags\.js["']\)/,
    "build-cloud-release must copy src/shared/conversation-tags.js to api/src/shared/conversation-tags.js"
  );
  assert.match(
    build,
    /copyFile\(["']src\/shared\/conversation-tags\.js["'][^)]+["']shared["'][^)]+["']conversation-tags\.js["']\)/,
    "build-cloud-release must copy src/shared/conversation-tags.js to web/shared/conversation-tags.js"
  );
  assert.match(build, /["']api\/src\/shared\/conversation-tags\.js["']/);
  assert.match(build, /["']web\/shared\/conversation-tags\.js["']/);
});

test("scripts/build-cloud-release.js ships package-owned contact as the web shared contact module", () => {
  const build = fs.readFileSync(path.join(ROOT, "scripts/build-cloud-release.js"), "utf8");
  assert.match(
    build,
    /copyFile\(["']packages\/shared\/contact\.js["'][^)]+["']shared["'][^)]+["']contact\.js["']\)/,
    "build-cloud-release must copy packages/shared/contact.js to web/shared/contact.js"
  );
  assert.match(
    build,
    /["']web\/shared\/contact\.js["']/,
    "verifyRelease must assert web/shared/contact.js exists instead of allowing nginx to serve HTML fallback"
  );
});

test("scripts/build-cloud-release.js ships package-owned group tiles as the web shared group module", () => {
  const build = fs.readFileSync(path.join(ROOT, "scripts/build-cloud-release.js"), "utf8");
  assert.match(
    build,
    /copyFile\(["']packages\/shared\/group-tiles\.js["'][^)]+["']shared["'][^)]+["']group-tiles\.js["']\)/,
    "build-cloud-release must copy packages/shared/group-tiles.js to web/shared/group-tiles.js"
  );
  assert.match(
    build,
    /["']web\/shared\/group-tiles\.js["']/,
    "verifyRelease must assert web/shared/group-tiles.js exists instead of allowing nginx to serve HTML fallback"
  );
});

test("scripts/build-cloud-release.js ships shared untyped id helpers to web and api packages", () => {
  const build = fs.readFileSync(path.join(ROOT, "scripts/build-cloud-release.js"), "utf8");
  assert.match(
    build,
    /copyFile\(["']src\/shared\/ids\.js["'][^)]+["']src["'][^)]+["']shared["'][^)]+["']ids\.js["']\)/,
    "cloud release must copy src/shared/ids.js into api/src/shared/ids.js"
  );
  assert.match(
    build,
    /copyFile\(["']src\/shared\/ids\.js["'][^)]+["']shared["'][^)]+["']ids\.js["']\)/,
    "cloud release must copy src/shared/ids.js into web/shared/ids.js"
  );
  assert.match(build, /["']api\/src\/shared\/ids\.js["']/);
  assert.match(build, /["']web\/shared\/ids\.js["']/);
});

test("src/web/app/index.html loads shared ids before app.js", () => {
  const html = fs.readFileSync(path.join(ROOT, "src/web/app/index.html"), "utf8");
  const idsIdx = html.indexOf("shared/ids.js");
  const appIdx = html.indexOf("../app.js");
  assert.ok(idsIdx >= 0, "index.html must reference shared/ids.js");
  assert.ok(appIdx >= 0, "index.html must load app.js");
  assert.ok(idsIdx < appIdx, "shared/ids.js must load before app.js creates bot ids");
});

test("src/web/app/index.html loads shared/avatar-resolve.js before contact.js and app.js", () => {
  const html = fs.readFileSync(path.join(ROOT, "src/web/app/index.html"), "utf8");
  const memberColorIdx = html.indexOf("shared/member-color.js");
  const resolveIdx = html.indexOf("shared/avatar-resolve.js");
  const contactIdx = html.indexOf("shared/contact.js");
  const appIdx = html.indexOf("../app.js");
  assert.ok(memberColorIdx >= 0, "index.html must reference shared/member-color.js");
  assert.ok(resolveIdx >= 0, "index.html must reference shared/avatar-resolve.js");
  assert.ok(contactIdx >= 0, "index.html must reference shared/contact.js");
  assert.ok(appIdx >= 0, "index.html must load app.js");
  assert.ok(
    memberColorIdx < resolveIdx,
    "shared/member-color.js must load before avatar-resolve.js so fallback colors are stable"
  );
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
  // same way the previous bot avatars used to.
  const setterMatch = source.match(/function setModelAvatar\([\s\S]*?\n\}/);
  assert.ok(setterMatch, "setModelAvatar must exist");
  assert.match(
    setterMatch[0],
    /normalizeAvatarUrl\(/,
    "setModelAvatar must route the icon path through normalizeAvatarUrl so /app/ resolves /assets/... correctly"
  );
  assert.match(
    setterMatch[0],
    /applyComposerModelAvatar\(els\.quickModelAvatar,\s*icon\)/,
    "setModelAvatar still sends the normalized URL into the composer avatar renderer"
  );
  const helperMatch = source.match(/function applyComposerModelAvatar\([\s\S]*?\n\}/);
  assert.ok(helperMatch, "applyComposerModelAvatar must exist");
  assert.match(
    helperMatch[0],
    /style\.backgroundImage\s*=\s*icon\s*\?/,
    "applyComposerModelAvatar still assigns the normalized URL to backgroundImage"
  );
});

test("desktop and web composer render Mia Auto as transparent model art", () => {
  const desktopSource = fs.readFileSync(path.join(ROOT, "src/renderer/app.js"), "utf8");
  const desktopCss = fs.readFileSync(path.join(ROOT, "src/renderer/styles.css"), "utf8");
  const webSource = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  const webCss = fs.readFileSync(path.join(ROOT, "src/web/styles.css"), "utf8");

  for (const source of [desktopSource, webSource]) {
    assert.match(source, /function isMiaModelIcon\(/);
    assert.match(source, /classList\.toggle\("model-avatar--transparent",\s*isMiaModelIcon\(icon\)\)/);
  }
  for (const css of [desktopCss, webCss]) {
    assert.match(css, /\.model-avatar\.model-avatar--transparent\s*\{[\s\S]*background-color:\s*transparent/);
    assert.match(css, /\.model-avatar\.model-avatar--transparent\s*\{[\s\S]*background-size:\s*16px 16px/);
  }
});

test("src/renderer/index.html loads package avatar before helpers/avatar-helpers.js", () => {
  const html = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf8");
  const resolveIdx = html.indexOf("packages/shared/avatar.js");
  const thumbnailIdx = html.indexOf("helpers/avatar-thumbnail.js");
  const helpersIdx = html.indexOf("helpers/avatar-helpers.js");
  assert.ok(resolveIdx >= 0, "renderer must reference packages/shared/avatar.js");
  assert.ok(thumbnailIdx >= 0, "renderer must reference helpers/avatar-thumbnail.js");
  assert.ok(helpersIdx >= 0, "renderer must reference helpers/avatar-helpers.js");
  assert.ok(
    resolveIdx < helpersIdx,
    "packages/shared/avatar.js must load before helpers/avatar-helpers.js so the renderer's preset aliases resolve at module-eval time"
  );
  assert.ok(
    thumbnailIdx < helpersIdx,
    "avatar-thumbnail.js must load before avatar-helpers.js so every painted still avatar can use the shared thumbnail cache"
  );
});

test("scripts/build-cloud-release.js copies shared/engine-contracts.js into the web tree", () => {
  const build = fs.readFileSync(path.join(ROOT, "scripts/build-cloud-release.js"), "utf8");
  assert.match(
    build,
    /copyFile\(["']src\/shared\/engine-contracts\.js["'][^)]+["']shared["'][^)]+["']engine-contracts\.js["']\)/,
    "build-cloud-release must copy src/shared/engine-contracts.js to web/shared/engine-contracts.js"
  );
  assert.match(
    build,
    /copyFile\(["']src\/shared\/agent-engine-policy\.js["'][^)]+["']shared["'][^)]+["']agent-engine-policy\.js["']\)/,
    "build-cloud-release must copy src/shared/agent-engine-policy.js to web/shared/agent-engine-policy.js"
  );
  assert.match(build, /"web\/shared\/agent-engine-policy\.js"/);
});

test("scripts/build-cloud-release.js copies shared/session-history.js into the web tree", () => {
  const build = fs.readFileSync(path.join(ROOT, "scripts/build-cloud-release.js"), "utf8");
  assert.match(
    build,
    /copyFile\(["']packages\/shared\/session-history\.js["'][^)]+["']shared["'][^)]+["']session-history\.js["']\)/,
    "build-cloud-release must copy packages/shared/session-history.js to web/shared/session-history.js"
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
    /copyFile\(["']src\/shared\/cloud-events\.js["'],\s*path\.join\(apiDir,\s*["']src["'],\s*["']shared["'],\s*["']cloud-events\.js["']\)\)/,
    "build-cloud-release must copy cloud-events.js because cloud-agent dispatcher imports it"
  );
  assert.match(
    build,
    /copyFile\(["']src\/shared\/assistant-content-blocks\.js["'],\s*path\.join\(apiDir,\s*["']src["'],\s*["']shared["'],\s*["']assistant-content-blocks\.js["']\)\)/,
    "build-cloud-release must copy assistant-content-blocks.js because cloud messages-store imports it"
  );
  assert.doesNotMatch(
    build,
    /copyFile\(["']src\/shared\/group-bot-routing\.js["']/,
    "build-cloud-release must not ship unused legacy group-bot-routing.js"
  );
  assert.match(
    build,
    /copyFile\(["']src\/shared\/skill-safety\.js["'],\s*path\.join\(apiDir,\s*["']src["'],\s*["']shared["'],\s*["']skill-safety\.js["']\)\)/,
    "build-cloud-release must copy skill-safety.js for api skill package modules"
  );
  assert.match(
    build,
    /copyFile\(["']src\/shared\/scheduled-task-mode\.js["'],\s*path\.join\(apiDir,\s*["']src["'],\s*["']shared["'],\s*["']scheduled-task-mode\.js["']\)\)/,
    "build-cloud-release must copy scheduled-task-mode.js because cloud tasks-store imports it"
  );
  assert.match(
    build,
    /copyFile\(["']src\/shared\/schedule-expression\.js["'],\s*path\.join\(apiDir,\s*["']src["'],\s*["']shared["'],\s*["']schedule-expression\.js["']\)\)/,
    "build-cloud-release must copy schedule-expression.js because cloud tasks-store imports it"
  );
  assert.match(
    build,
    /copyFile\(["']src\/shared\/avatar-resolve\.js["'],\s*path\.join\(apiDir,\s*["']src["'],\s*["']shared["'],\s*["']avatar-resolve\.js["']\)\)/,
    "build-cloud-release must copy the avatar-resolve compatibility entry because api/server.js resolves member identities"
  );
  assert.match(
    build,
    /copyFile\(["']src\/shared\/member-color\.js["'],\s*path\.join\(apiDir,\s*["']src["'],\s*["']shared["'],\s*["']member-color\.js["']\)\)/,
    "build-cloud-release must copy the member-color compatibility entry for API shared modules"
  );
  assert.match(
    build,
    /copyFile\(["']src\/shared\/avatar-media\.js["'],\s*path\.join\(apiDir,\s*["']src["'],\s*["']shared["'],\s*["']avatar-media\.js["']\)\)/,
    "build-cloud-release must copy the avatar-media compatibility entry for API shared modules"
  );
  assert.match(
    build,
    /copyFile\(["']packages\/shared\/avatar\.js["'],\s*path\.join\(apiDir,\s*["']packages["'],\s*["']shared["'],\s*["']avatar\.js["']\)\)/,
    "build-cloud-release must copy packages/shared/avatar.js because API compatibility entries require it"
  );
  assert.match(
    build,
    /copyFile\(["']src\/shared\/bot-identity\.js["'],\s*path\.join\(apiDir,\s*["']src["'],\s*["']shared["'],\s*["']bot-identity\.js["']\)\)/,
    "build-cloud-release must copy src/shared/bot-identity.js for API bot identity helpers"
  );
  assert.match(
    build,
    /copyFile\(["']src\/shared\/identity\.js["'],\s*path\.join\(apiDir,\s*["']src["'],\s*["']shared["'],\s*["']identity\.js["']\)\)/,
    "build-cloud-release must copy src/shared/identity.js because cloud stores require it"
  );
  assert.match(
    build,
    /copyFile\(["']packages\/shared\/bot-identity\.js["'],\s*path\.join\(apiDir,\s*["']packages["'],\s*["']shared["'],\s*["']bot-identity\.js["']\)\)/,
    "build-cloud-release must copy packages/shared/bot-identity.js for API bot identity helpers"
  );
  assert.match(
    build,
    /copyFile\(["']packages\/shared\/identity\.js["'],\s*path\.join\(apiDir,\s*["']packages["'],\s*["']shared["'],\s*["']identity\.js["']\)\)/,
    "build-cloud-release must copy packages/shared/identity.js because bot-identity.js requires it"
  );
  assert.match(build, /api\/src\/shared\/conversation-kinds\.js/);
  assert.match(build, /api\/src\/shared\/cloud-events\.js/);
  assert.match(build, /api\/src\/shared\/engine-contracts\.js/);
  assert.match(build, /api\/src\/shared\/member-color\.js/);
  assert.match(build, /api\/src\/shared\/avatar-media\.js/);
  assert.match(build, /api\/src\/cloud\/memory-store\.js/);
  assert.match(build, /api\/packages\/shared\/avatar\.js/);
  assert.match(build, /api\/src\/shared\/bot-identity\.js/);
  assert.match(build, /api\/src\/shared\/identity\.js/);
  assert.match(build, /api\/packages\/shared\/bot-identity\.js/);
  assert.match(build, /api\/packages\/shared\/identity\.js/);
  assert.doesNotMatch(build, /fellow-identity\.js/);
  assert.doesNotMatch(build, /api\/src\/shared\/group-bot-routing\.js/);
  assert.doesNotMatch(build, /api\/src\/cloud-agent\/default-bot\.js/);
  assert.doesNotMatch(build, /api\/src\/cloud-agent\/default-fellow\.js/);
  assert.match(build, /api\/src\/shared\/skill-safety\.js/);
  assert.match(build, /api\/src\/shared\/scheduled-task-mode\.js/);
  assert.match(build, /api\/src\/shared\/schedule-expression\.js/);
  assert.match(build, /api\/src\/shared\/avatar-resolve\.js/);
});

test("cloud release runtime does not import legacy group bot routing", () => {
  const runtimeFiles = [
    "scripts/serve-cloud.js",
    ...fs.readdirSync(path.join(ROOT, "src/cloud-agent"))
      .filter((file) => file.endsWith(".js"))
      .map((file) => `src/cloud-agent/${file}`)
  ];

  for (const file of runtimeFiles) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.doesNotMatch(source, /group-bot-routing/, `${file} must not import legacy group-bot-routing.js`);
  }
});

test("legacy group bot routing module is removed from source", () => {
  assert.equal(
    fs.existsSync(path.join(ROOT, "src/shared/group-bot-routing.js")),
    false,
    "src/shared/group-bot-routing.js is retired; group bot orchestration lives in src/cloud-agent/group-orchestrator.js"
  );
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
    /api\/skills\/pdf\/SKILL\.md/,
    "release verifier must fail if seeded marketplace skills are missing"
  );
});

test("cloud release and local web server expose desktop model icon assets", () => {
  const build = fs.readFileSync(path.join(ROOT, "scripts/build-cloud-release.js"), "utf8");
  const serveWeb = fs.readFileSync(path.join(ROOT, "scripts/serve-web.js"), "utf8");
  assert.match(build, /src\/renderer\/assets\/model-icons/);
  assert.match(build, /src\/renderer\/assets\/provider-icons/);
  assert.match(build, /src\/renderer\/assets\/lottie/);
  assert.match(build, /src\/renderer\/assets\/status-badges/);
  assert.match(serveWeb, /target\.startsWith\("assets\/model-icons\/"\)/);
  assert.match(serveWeb, /target\.startsWith\("assets\/provider-icons\/"\)/);
  assert.match(serveWeb, /target\.startsWith\("assets\/lottie\/"\)/);
  assert.match(serveWeb, /target\.startsWith\("assets\/status-badges\/"\)/);
  assert.match(serveWeb, /path\.join\(sourceRoot, "renderer", target\)/);
});

test("web app loads lottie player and renders status badge lotties from cloud assets", () => {
  const html = fs.readFileSync(path.join(ROOT, "src/web/app/index.html"), "utf8");
  const app = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  const styles = fs.readFileSync(path.join(ROOT, "src/web/styles.css"), "utf8");
  const build = fs.readFileSync(path.join(ROOT, "scripts/build-cloud-release.js"), "utf8");
  const lottieIdx = html.indexOf("assets/lottie/lottie_light.min.js");
  const catalogIdx = html.indexOf("../shared/status-badge-assets.js");
  const appIdx = html.indexOf("../app.js");
  assert.ok(lottieIdx >= 0, "web app must load lottie-web before app.js");
  assert.ok(lottieIdx < appIdx, "lottie player must load before app.js initializes badge animations");
  assert.ok(catalogIdx >= 0 && catalogIdx < appIdx, "status badge catalog must load before app.js");
  assert.match(app, /function renderNameWithBadgeHtml/);
  assert.match(app, /miaStatusBadgeAssets/);
  assert.match(app, /function initStatusBadgeLotties/);
  assert.match(app, /function emojiAvatarHtml/);
  assert.match(app, /avatarResolve\.emojiAvatarGlyph/);
  assert.doesNotMatch(app, /function lottieAvatarHtml/);
  assert.doesNotMatch(app, /function initAvatarLotties/);
  assert.doesNotMatch(app, /data-avatar-lottie=/);
  assert.match(styles, /--name-badge-size:\s*max\(20px,\s*1\.12em\)/);
  assert.match(styles, /\.avatar-emoji\s*\{[^}]*display:\s*grid;[^}]*place-items:\s*center;[^}]*font-size:\s*28px;/);
  assert.doesNotMatch(styles, /\.avatar-lottie/);
  assert.match(styles, /--name-badge-gap:\s*0px/);
  assert.match(styles, /--name-badge-shift-x:\s*2px/);
  assert.match(styles, /--name-badge-shift-y:\s*-1px/);
  assert.match(styles, /padding-left:\s*var\(--name-badge-shift-x\)/);
  assert.match(styles, /\.name-with-badge-badge\s*\{[^}]*overflow:\s*visible;/);
  assert.match(styles, /\.name-with-badge-badge\s*\{[^}]*transform:\s*translateY\(var\(--name-badge-shift-y\)\)/);
  assert.match(fs.readFileSync(path.join(ROOT, "packages/shared/status-badge-assets.js"), "utf8"), /surprised-cat/);
  assert.match(build, /packages\/shared\/status-badge-assets\.js/);
});

test("cloud release ships the shared label lottie used by conversation tags", () => {
  const build = fs.readFileSync(path.join(ROOT, "scripts/build-cloud-release.js"), "utf8");
  const labelAsset = fs.readFileSync(path.join(ROOT, "src/renderer/assets/lottie/label.json"), "utf8");

  assert.match(build, /["']web\/assets\/lottie\/label\.json["']/);
  assert.match(labelAsset, /"nm":\s*"system-regular-146-label"/);
});

test("web settings exposes a status badge profile control", () => {
  const html = fs.readFileSync(path.join(ROOT, "src/web/app/index.html"), "utf8");
  const app = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");

  assert.match(html, /id="profileNameText"/);
  assert.match(html, /id="profileStatusBadge"/);
  assert.match(html, /id="profileStatusBadgeDetails"/);
  assert.match(html, /id="profileStatusBadgeTrigger"/);
  assert.match(app, /function renderProfileStatusBadgeChoices/);
  assert.doesNotMatch(html, /profileStatusBadgePreview/);
  assert.match(app, /saveProfilePatch\(\{ displayName \}/);
  assert.match(app, /saveProfilePatch\(\{ statusBadge \}/);
  assert.match(app, /function statusBadgeForPreset/);
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
  assert.match(build, /qrcode: rootPackage\.dependencies\?\.qrcode/);
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

test("src/web/app.js only shows private AI controls in bot conversations", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.match(source, /function renderComposerControls\(conversation = null\)/);
  assert.match(source, /conversationTypeForControls\(conversation\)\s*===\s*"bot"/);
  assert.match(source, /composerBottom\?\.classList\.toggle\("hidden",\s*!show\)/);
  assert.match(source, /saveWebAiControl\("model"/);
  assert.match(source, /saveWebAiControl\("effort"/);
  assert.match(source, /saveWebAiControl\("permission"/);
});

test("src/web/app.js uses platform model catalog for cloud bot controls", () => {
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
  assert.match(source, /avatarVideoHtml\(image, crop \|\| \{\}\)/);
  assert.match(source, /muted loop autoplay playsinline/);
  assert.doesNotMatch(source, /avatarPendingTrimSeek|parkedAvatarVideos|function hydrateAvatarMedia\(root = document\)/);
  assert.doesNotMatch(source, /style="background-color:\$\{escapeHtml\(color\)\};">\$\{avatarVideoHtml/);
  assert.doesNotMatch(source, /el\.style\.cssText = `background-color:\$\{color\};`/);
  assert.match(css, /\.rail-avatar\s*\{[\s\S]*?background-color:\s*transparent;/);
  assert.match(css, /\.rail-avatar:hover\s*\{[\s\S]*?box-shadow:\s*none;/);
  assert.match(css, /\.avatar,\n\.profile-avatar\s*\{[\s\S]*?border:\s*0;/);
  assert.match(css, /\.avatar,\n\.profile-avatar\s*\{[\s\S]*?background-color:\s*transparent;/);
  assert.match(css, /\.avatar-crop-preview\s*\{[\s\S]*?border:\s*0;[\s\S]*?background-color:\s*transparent;[\s\S]*?box-shadow:\s*none;/);
});

test("src/web/app.js renders web bubbles through desktop markdown", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.match(source, /function renderMarkdown\(value\)/);
  assert.match(source, /window\.miaMarkdown\?\.renderMarkdown/);
  assert.match(source, /<div class="bubble">\$\{senderTitleHtml\}\$\{highlightedBody\}<\/div>/);
  assert.match(source, /<div class="bubble">\$\{renderMarkdown\(displayText\)\}<\/div>/);
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

test("src/web/app.js lets web controls update desktop-local bot runtime bindings", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.match(source, /function runtimeKindForBotConversation\(conversation, bot\)/);
  assert.match(source, /const defaultRuntimeKind = sessionHistory\.runtimeKind\(conversation, "desktop-local"\);/);
  assert.match(source, /const botRuntimeKind = sessionHistory\.runtimeKind\(bot, ""\);/);
  assert.match(source, /return defaultRuntimeKind === "desktop-local" && botRuntimeKind/);
  assert.doesNotMatch(source, /return runtimeKind \|\| "cloud-claude-code";/);
  assert.doesNotMatch(source, /runtimeKind === "desktop-local"\)\s*return null/);
  assert.doesNotMatch(source, /Desktop controls/);
  assert.doesNotMatch(source, /Desktop Local/);
  assert.match(source, /function engineForRuntimeBinding\(runtimeKind, binding\)/);
  assert.match(source, /config\.agentEngine/);
  assert.match(source, /selectEntriesForModel\(engine, runtimeKind, config\)/);
  assert.match(source, /config\.modelEntries/);
  assert.match(source, /const editable = Boolean\(botKey\);/);
  assert.match(source, /window\.miaBotRuntimeControl/);
  assert.match(source, /saveBotRuntimeControl\(\{/);
  assert.match(source, /function isDesktopExternalRuntime\(engine, runtimeKind\)/);
  assert.match(source, /kind === "permission" && isDesktopExternalRuntime\(engine, runtimeKind\)/);
  assert.match(source, /if \(!isExternalAgentEngine\(engine\) && permissionEntries\[0\]\?\.value\) config\.permissionMode = permissionEntries\[0\]\.value;/);
  assert.doesNotMatch(source, /config\.permissionMode = "ask";/);
  assert.doesNotMatch(source, /permissionMode: engine === "hermes" \? "ask" : "default"/);
  assert.doesNotMatch(source, /body:\s*\{ runtimeKind, enabled: true, config \}/);
});

test("src/web/app.js resolves providerless saved desktop model bindings from modelProfileId", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  const helper = source.slice(
    source.indexOf("function runtimeConfigModelProvider"),
    source.indexOf("function setSelectOptions", source.indexOf("function runtimeConfigModelProvider"))
  );
  const body = source.slice(
    source.indexOf("const savedModel ="),
    source.indexOf("const modelLabel =", source.indexOf("const savedModel ="))
  );

  assert.match(helper, /runtimeConfigModelProfileId/);
  assert.match(helper, /config\.providerConnectionId/);
  assert.match(helper, /split\(":"\)/);
  assert.match(body, /savedRuntimeModelEntry/);
});

test("shared bot runtime control owns Web PUT runtime writes", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  const shared = fs.readFileSync(path.join(ROOT, "src/shared/bot-runtime-control.js"), "utf8");
  assert.match(source, /method === "POST" \|\| method === "PUT" \|\| method === "PATCH" \|\| method === "DELETE"/);
  assert.match(shared, /\/api\/me\/bots\/\$\{encodeURIComponent\(botKey\)\}\/runtime/);
  assert.match(shared, /method:\s*"PUT"/);
  assert.match(shared, /controlIntent/);
  assert.doesNotMatch(shared, /saveBotRuntimeConfig/);
  assert.doesNotMatch(shared, /body\.config/);
  assert.doesNotMatch(source, /\/api\/me\/bots\/\$\{encodeURIComponent\(botKey\)\}\/runtime[\s\S]*method:\s*"PUT"/);
});

test("cloud release copies shared bot runtime control into web assets", () => {
  const build = fs.readFileSync(path.join(ROOT, "scripts/build-cloud-release.js"), "utf8");
  assert.match(build, /src\/shared\/bot-runtime-control\.js/);
  assert.match(build, /path\.join\(webDir, "shared", "bot-runtime-control\.js"\)/);
  assert.match(build, /"web\/shared\/bot-runtime-control\.js"/);
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

test("src/web/app.js restores the topbar chat history selector for bot conversations", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.match(source, /const sessionHistory = window\.miaSessionHistory/);
  assert.match(source, /sessionMenuButton: document\.getElementById\("sessionMenuButton"\)/);
  assert.match(source, /function renderSessionMenu\(\)/);
  assert.match(source, /function sessionConversationsForConversation\(conversation\)/);
  assert.match(source, /sessionHistory\.sessionConversationsForConversation/);
  assert.match(source, /sessionHistory\.sidebarConversations\(state\.conversations/);
  assert.match(source, /sessionHistory\.botDisplayTitle\(conversation, state\.bots, "对话"\)/);
  assert.match(source, /sessionHistory\.createBotSessionPayload/);
  assert.match(source, /function createNewSessionForActive\(\)/);
  assert.match(source, /\/api\/me\/bot-conversations\/\$\{encodeURIComponent\(payload\.sessionId\)\}/);
  assert.match(source, /sessionMenuOpen/);
  assert.match(source, /currentSessionTitle/);
  assert.match(source, /newSession\?\.classList\.toggle\("hidden", !canCreate\)/);
});

test("src/web/app.js handles bot cloud events and bot message source context", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");

  assert.match(source, /type === "bot\.upserted"/);
  assert.match(source, /type === "bot\.runtime_updated"/);
  assert.match(source, /type === "bot\.deleted"/);
  assert.doesNotMatch(source, /type === "fellow\.upserted"/);
  assert.doesNotMatch(source, /type === "fellow\.runtime_updated"/);
  assert.doesNotMatch(source, /type === "fellow\.deleted"/);
  assert.match(source, /const ctx = \{ self: state\.user, friends: state\.friends, bots: state\.bots \}/);
  assert.doesNotMatch(source, /const ctx = \{ self: state\.user, friends: state\.friends, fellows: state\.fellows \}/);
  assert.match(source, /sender_kind:\s*"bot"/);
  assert.doesNotMatch(source, /sender_kind:\s*"fellow"/);
});

test("src/web/app.js clears cloud-agent streaming on persisted bot replies", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  const handlerMatch = source.match(/type === "conversation\.message_appended"[\s\S]*?renderRailUnreadBadge\(\);/);
  assert.ok(handlerMatch, "conversation.message_appended handler must exist");
  assert.match(
    handlerMatch[0],
    /msg\.sender_kind === SenderKind\.Bot/,
    "final bot messages must clear transient cloud-agent streaming rows"
  );
  assert.doesNotMatch(
    handlerMatch[0],
    /msg\.sender_kind === SenderKind\.Fellow/,
    "web must not wait for legacy fellow sender kind to clear bot streams"
  );
});

test("src/web/app.js uses bot members for bot avatar fallback and web group creation", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  const helperMatch = source.match(/function botAvatarFor\(conversation, botKey\)\s*\{[\s\S]*?\n\}\n/);
  assert.ok(helperMatch, "botAvatarFor body must be defined");
  assert.match(helperMatch[0], /m\.member_kind === MemberKind\.Bot/);
  assert.doesNotMatch(helperMatch[0], /m\.member_kind === MemberKind\.Fellow/);
  assert.match(source, /memberBots:\s*\[\]/);
  assert.doesNotMatch(source, /memberFellows:\s*\[\]/);
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
  assert.doesNotMatch(css, /data:image\/svg\+xml/);
  assert.match(css, /\.bubble\s*\{[\s\S]*?cursor:\s*default;[\s\S]*?user-select:\s*text;/);
  assert.match(css, /\.bubble\.text-hit\s*\{[\s\S]*?cursor:\s*text;/);
  assert.doesNotMatch(css, /cursor:\s*var\(--message-text-cursor\)/);
  assert.match(css, /\.bubble a\.message-link\s*\{[\s\S]*?color:\s*var\(--accent\);[\s\S]*?text-decoration:\s*none;[\s\S]*?text-decoration-color:\s*var\(--accent\);[\s\S]*?text-decoration-thickness:\s*1px;[\s\S]*?cursor:\s*pointer;/);
  assert.match(css, /\.bubble a\.message-link \.message-link-site-icon\s*\{/);
  assert.match(css, /\.bubble a\.message-link \.message-link-site-icon-image\s*\{/);
  assert.match(css, /\.bubble a\.message-link \.message-link-site-icon-fallback\s*\{/);
  assert.match(css, /\.bubble a\.message-link \.message-link-label\s*\{/);
  assert.match(css, /\.bubble a\.message-link:hover\s*\{[\s\S]*?text-decoration:\s*underline;[\s\S]*?text-decoration-color:\s*var\(--accent\);[\s\S]*?text-decoration-thickness:\s*1px;/);
  assert.doesNotMatch(css, /\.message\.user \.bubble a\.message-link\s*\{/);
  assert.match(css, /\.bubble code\.inline-code\s*\{[\s\S]*?cursor:\s*default;/);
});

test("message text cursor script loads before app.js and uses caret hit testing", () => {
  const webHtml = fs.readFileSync(path.join(ROOT, "src/web/app/index.html"), "utf8");
  const desktopHtml = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf8");
  const source = fs.readFileSync(path.join(ROOT, "src/shared/message-text-cursor.js"), "utf8");
  const build = fs.readFileSync(path.join(ROOT, "scripts/build-cloud-release.js"), "utf8");
  const webCursorIdx = webHtml.indexOf("shared/message-text-cursor.js");
  const webAppIdx = webHtml.indexOf("../app.js");
  const desktopCursorIdx = desktopHtml.indexOf("../shared/message-text-cursor.js");
  const desktopAppIdx = desktopHtml.indexOf("./app.js");

  assert.ok(webCursorIdx >= 0, "web app must load message text cursor hit testing");
  assert.ok(webCursorIdx < webAppIdx, "web cursor hit testing must load before app.js");
  assert.ok(desktopCursorIdx >= 0, "desktop renderer must load message text cursor hit testing");
  assert.ok(desktopCursorIdx < desktopAppIdx, "desktop cursor hit testing must load before app.js");
  assert.match(source, /caretPositionFromPoint|caretRangeFromPoint/);
  assert.match(source, /pointHitsTextNode/);
  assert.match(source, /TEXT_HIT_CLASS\s*=\s*"text-hit"/);
  assert.match(build, /src\/shared\/message-text-cursor\.js/);
  assert.match(build, /web\/shared\/message-text-cursor\.js/);
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

test("src/web/app.js resolves bot avatars via conversationMembersCache when the bot isn't owned", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.match(
    source,
    /function botAvatarFor\(/,
    "web/app.js must expose a botAvatarFor helper so cross-owner bot avatars don't fall back to single-letter bubbles"
  );
  // Conversation list path must use the new helper.
  assert.match(
    source,
    /botAvatarFor\(r,\s*botKey\)/,
    "conversation list must route bot avatar lookup through botAvatarFor"
  );
  // Active chat header path must use the new helper.
  assert.match(
    source,
    /botAvatarFor\(conversation,\s*botKeyForConversation\(conversation\)\)/,
    "active chat header must route bot avatar lookup through botAvatarFor"
  );
  // The helper must consult conversationMembersCache for enriched bot_avatar_image.
  const helperMatch = source.match(/function botAvatarFor\(conversation, botKey\)\s*\{[\s\S]*?\n\}\n/);
  assert.ok(helperMatch, "botAvatarFor body must be defined");
  assert.match(
    helperMatch[0],
    /state\.conversationMembersCache/,
    "botAvatarFor must consult conversationMembersCache for cross-owner bots"
  );
  assert.match(
    helperMatch[0],
    /hasAvatarIdentityFields/,
    "botAvatarFor must distinguish compact owned bot rows from explicit empty avatar rows"
  );
  assert.match(
    helperMatch[0],
    /bot_avatar_image/,
    "botAvatarFor must read the server-enriched bot_avatar_image field"
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

test("src/web/app.js renders empty avatars through the shared generated avatar image", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  const generatedHelper = source.match(/function generatedAvatarStyle\(color[\s\S]*?\n\}/);
  assert.ok(generatedHelper, "generatedAvatarStyle body must be extractable");
  assert.match(
    generatedHelper[0],
    /generatedAvatarDataUri/,
    "generatedAvatarStyle must use the shared generated SVG for missing avatars"
  );

  const htmlHelper = source.match(/function avatarHtml\(\{[\s\S]*?\n\}/);
  assert.ok(htmlHelper, "avatarHtml body must be extractable");
  assert.match(
    htmlHelper[0],
    /generatedAvatarStyle\(color, text\)/,
    "avatarHtml must use the shared generated avatar style for missing avatars"
  );
  assert.doesNotMatch(
    htmlHelper[0],
    /escapeHtml\(text \|\| ""\)/,
    "avatarHtml must not render missing-avatar initials as DOM text"
  );

  const applyHelper = source.match(/function applyAvatarMedia\(el,[\s\S]*?\n\}/);
  assert.ok(applyHelper, "applyAvatarMedia body must be extractable");
  assert.match(
    applyHelper[0],
    /generatedAvatarStyle\(color, text\)/,
    "applyAvatarMedia must use the shared generated avatar style for missing avatars"
  );
  assert.doesNotMatch(
    applyHelper[0],
    /textContent = text \|\| ""/,
    "applyAvatarMedia must not render missing-avatar initials as DOM text"
  );
});

test("src/web/app.js uses the resolved self avatar color for own message avatars", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  const helper = source.match(/function buildConversationMessageArticle\(msg, conversation\) \{[\s\S]*?\n\}/);
  assert.ok(helper, "buildConversationMessageArticle body must be extractable");
  assert.match(
    helper[0],
    /const avatarColor = senderColor;/,
    "own message avatars must use the canonical MessageSpec avatar color"
  );
  assert.doesNotMatch(
    helper[0],
    /isOwn\s*\?\s*["']#0162db["']\s*:\s*senderColor/,
    "own message avatars must not be hardcoded to the bubble blue"
  );
});

test("src/web/app.js animates only newly appended tail messages near the bottom", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  const helper = source.match(/function buildConversationMessageArticle\(msg, conversation\) \{[\s\S]*?\n\}/);
  assert.ok(helper, "buildConversationMessageArticle body must be extractable");
  assert.match(helper[0], /data-message-id="\$\{escapeHtml\(messageStableId\(msg\)\)\}"/);
  assert.match(source, /function animateMessageTailEnter\(/, "web must define the tail message reveal helper");
  assert.match(source, /function animateChatTailToBottom\(/, "web must define the smooth bottom-follow helper");
  assert.match(source, /function isChatPinnedToBottom\(/, "web must track whether the user is still pinned to the bottom");
  assert.match(
    source,
    /const nearBottom = isChatPinnedToBottom\(els\.chat\);/,
    "renderActiveChat must not treat a small upward user scroll as bottom-pinned"
  );
  assert.match(
    source,
    /const tailMessageIds = shouldAnimateTail[\s\S]*?tailMessageIdsAddedToEnd/,
    "renderActiveChat must compute tail-only appended message ids"
  );
  assert.match(
    source,
    /if \(shouldAnimateTail && tailMessageIds\.length\) \{[\s\S]*?animateRenderedTailMessages/,
    "renderActiveChat must animate only the newly appended tail messages"
  );
  assert.doesNotMatch(
    source,
    /if \(messages\.length \|\| streaming\) els\.chat\.scrollTop = els\.chat\.scrollHeight;/,
    "renderActiveChat must not unconditionally pull history readers to the bottom"
  );
});

test("src/web/app/index.html loads shared/trace-blocks.js before app.js", () => {
  const html = fs.readFileSync(path.join(ROOT, "src/web/app/index.html"), "utf8");
  const contentBlocksIdx = html.indexOf("shared/assistant-content-blocks.js");
  const traceIdx = html.indexOf("shared/trace-blocks.js");
  const appIdx = html.indexOf("../app.js");
  assert.ok(contentBlocksIdx >= 0, "index.html must include shared/assistant-content-blocks.js so ordered assistant blocks can normalize");
  assert.ok(traceIdx >= 0, "index.html must include shared/trace-blocks.js so window.miaTraceBlocks is defined");
  assert.ok(contentBlocksIdx < traceIdx, "assistant-content-blocks.js must load before trace-blocks.js");
  assert.ok(traceIdx < appIdx, "shared/trace-blocks.js must load before app.js");
});

test("scripts/build-cloud-release.js copies shared assistant block render dependencies into the web tree", () => {
  const source = fs.readFileSync(path.join(ROOT, "scripts/build-cloud-release.js"), "utf8");
  assert.match(
    source,
    /copyFile\("src\/shared\/assistant-content-blocks\.js",\s*path\.join\(webDir,\s*"shared",\s*"assistant-content-blocks\.js"\)\)/,
    "build-cloud-release.js must copy src/shared/assistant-content-blocks.js to the web bundle"
  );
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

test("src/web/app.js renders persisted ordered assistant content blocks before trace fallback", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.match(
    source,
    /buildConversationMessageArticle[\s\S]*?contentBlocksFromMessage\(msg\)/,
    "buildConversationMessageArticle must normalize msg.content_blocks_json through contentBlocksFromMessage"
  );
  assert.match(
    source,
    /function contentBlocksFromMessage\(msg\)[\s\S]*?contentBlocksWithFinalText/,
    "contentBlocksFromMessage must append final body text for legacy ordered block payloads"
  );
  assert.match(
    source,
    /buildConversationMessageArticle[\s\S]*?renderAssistantContentBlocks/,
    "buildConversationMessageArticle must render ordered assistant content blocks"
  );
  assert.match(
    source,
    /orderedBlocksHtml[\s\S]*?\?\s*""[\s\S]*?:\s*parseTraceJson\(msg\.trace_json/,
    "trace_json rendering must be skipped when ordered blocks render"
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

test("src/web/app.js streams ordered assistant content blocks inside cloud agent runs", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.match(
    source,
    /createAssistantContentBlockCollector/,
    "cloud agent run state must create an ordered content block collector"
  );
  assert.match(
    source,
    /buildCloudAgentStreamingArticle[\s\S]*?run\.contentBlocks[\s\S]*?renderAssistantContentBlocks/,
    "streaming article must render run.contentBlocks in order"
  );
});

test("src/web/app.js preserves transient ordered file edits when final bot messages arrive", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.match(
    source,
    /function messageWithFallbackRunContentBlocks\(/,
    "web must merge streaming contentBlocks into final bot messages before clearing the run"
  );
  const handlerMatch = source.match(/type === "conversation\.message_appended"[\s\S]*?renderRailUnreadBadge\(\);/);
  assert.ok(handlerMatch, "conversation.message_appended handler must exist");
  assert.match(
    handlerMatch[0],
    /const cachedMsg = messageWithFallbackRunContentBlocks\(conversationId,\s*msg\)/,
    "message_appended must cache the merged final bot message"
  );
  assert.match(
    handlerMatch[0],
    /mergeWebMessageWindow\(conversationId, \[cachedMsg\]\)/,
    "message_appended must merge cachedMsg rather than the raw persisted msg"
  );
  assert.match(
    handlerMatch[0],
    /cachedMsg\.sender_kind === SenderKind\.Bot[\s\S]*?state\.cloudAgentRunsByConversation\.delete\(conversationId\)/,
    "the streaming run must be cleared only after contentBlocks can be copied"
  );
});

test("src/web/app.js delegates trace row toggles to state.openTraceKeys", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.match(source, /openTraceKeys:\s*new Set\(\)/, "state must hold a Set for trace open keys");
  assert.match(
    source,
    /els\.chat\.addEventListener\("toggle"[\s\S]*?details\.trace-row\[data-trace-key\][\s\S]*?openTraceKeys\.add/,
    "chat container must remember trace expansion via openTraceKeys"
  );
  assert.match(
    source,
    /els\.chat\.addEventListener\("toggle"[\s\S]*?hydrateTraceRow[\s\S]*?releaseTraceRow/,
    "web trace toggles must hydrate collapsed process bodies and release them again"
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

test("src/web/app.js hydrates the newest message window and paginates backward", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.match(source, /messages\?latest=1&limit=200/);
  assert.match(source, /messages\?before_seq=\$\{entry\.minSeq\}&limit=100/);
  assert.match(source, /mergeWebMessageWindow\(conversationId, incoming\)/);
  assert.match(source, /entry\.messages = \[\.\.\.byId\.values\(\)\]\.sort/);
  assert.match(source, /scrollTop = previousTop \+ Math\.max\(0, els\.chat\.scrollHeight - previousHeight\)/);
});

test("web event resume cursor advances per delivered event, never to events_ready.serverSeq", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  const start = source.indexOf('socket.addEventListener("message"');
  const end = source.indexOf('socket.addEventListener("close"', start);
  assert.ok(start >= 0 && end > start, "websocket message handler must exist");
  const handler = source.slice(start, end);
  assert.match(handler, /saveLastEventSeq\(deliveredSeq\)/);
  assert.match(handler, /saveLastEventSeq\(envelope\.resetTo\)/);
  assert.doesNotMatch(handler, /saveLastEventSeq\(envelope\.serverSeq\)/);
  assert.ok(
    handler.indexOf("handleCloudEvent(envelope)") < handler.indexOf("saveLastEventSeq(deliveredSeq)"),
    "the cursor must advance only after the event handler succeeds"
  );
});

test("web retries a failed message with the same turn, op id, and mentions", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
  assert.match(source, /failedSendsByConversation:\s*new Map\(\)/);
  assert.match(source, /let prepared = state\.failedSendsByConversation\.get\(id\) \|\| null/);
  assert.match(source, /turnId:\s*prepared\.clientTraceId/);
  assert.match(source, /clientOpId:\s*prepared\.clientOpId/);
  assert.match(source, /mentions:\s*prepared\.mentions/);
  assert.match(source, /state\.failedSendsByConversation\.set\(id, prepared\)/);
});
