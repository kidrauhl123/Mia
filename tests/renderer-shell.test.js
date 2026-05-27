const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");

test("renderer app shell loads state module before the entrypoint", () => {
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.match(html, /<script src="\.\/app-state\.js"><\/script>[\s\S]*<script src="\.\/app\.js"><\/script>/);
  assert.match(appSource, /window\.miaAppState\.createInitialState/);
  assert.doesNotMatch(appSource, /const state = \{/);
  assert.doesNotMatch(appSource, /const fallbackSlashCommands = \[/);
});

test("cloud room composer uses one social send path for dm and group rooms", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.match(appSource, /await window\.miaSocial\.sendInActiveRoom\(roomText\b/);
  assert.doesNotMatch(appSource, /sendInActiveGroupRoom\(roomText\)/);
});

test("cloud room send and render do not depend on activeKey being empty", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.doesNotMatch(appSource, /getActiveRoomId\?\.\(\) && !state\.activeKey/);
  assert.doesNotMatch(appSource, /activeRoomId && !state\.activeKey/);
});

test("logged-in active pane never falls back to local fellow sessions", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.match(appSource, /if\s*\(cloudSignedIn\)\s*\{\s*state\.activeKey = "";/);
  assert.match(appSource, /const active = cloudSignedIn\s*\?\s*null\s*:/);
  assert.match(appSource, /if\s*\(state\.runtime\?\.cloud\?\.enabled\)\s*\{[\s\S]*?els\.chat\.innerHTML = "";\s*return;\s*\}/);
  // Cloud-only: signed-out users get the login guide, never a local message list.
  assert.match(appSource, /els\.chat\.innerHTML = renderCloudLoginGuide\(\);/);
});

test("desktop cloud fellow rooms keep private AI composer controls visible", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.match(appSource, /activeCloudRoomType\s*===\s*"fellow"/);
  assert.match(appSource, /composerBottom\.classList\.toggle\("hidden",\s*!showPrivateAiControls\)/);
  assert.doesNotMatch(appSource, /if\s*\(composerBottom\)\s*composerBottom\.classList\.add\("hidden"\);/);
});

test("desktop cloud fellow rooms expose the restored chat history menu", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const socialSource = fs.readFileSync(path.join(root, "src/renderer/social/social.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const preloadSource = fs.readFileSync(path.join(root, "src/preload.js"), "utf8");
  const socialApiSource = fs.readFileSync(path.join(root, "src/main/social/social-api.js"), "utf8");

  assert.match(html, /shared\/session-history\.js/);
  assert.match(appSource, /const sessionHistory = \(typeof window !== "undefined" && window\.miaSessionHistory\)/);
  assert.match(appSource, /if \(els\.sessionMenuButton\) els\.sessionMenuButton\.classList\.remove\("hidden"\);/);
  assert.match(appSource, /function renderCloudRoomSessionMenu\(activeRoom\)/);
  assert.match(appSource, /sessionHistory\.sessionRoomsForRoom/);
  assert.match(appSource, /sessionHistory\.createFellowSessionPayload/);
  assert.match(appSource, /sessionHistory\.fellowDisplayTitle/);
  assert.match(appSource, /function createNewCloudSessionForActive\(room\)/);
  assert.match(socialSource, /sessionHistoryShared\(\)\.sidebarRooms\(moduleState\.rooms/);
  assert.match(appSource, /window\.mia\.social\.ensureFellowSessionRoom/);
  assert.match(preloadSource, /ensureFellowSessionRoom: \(sessionId, body\) => ipcRenderer\.invoke\(IpcChannel\.SocialEnsureFellowSessionRoom, sessionId, body\)/);
  assert.match(socialApiSource, /async ensureFellowSessionRoom\(sessionId, body = \{\}\)/);
});

test("desktop fellow controls save through fellow runtime control adapter", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const commandsSource = fs.readFileSync(path.join(root, "src/renderer/fellow/fellow-commands.js"), "utf8");
  const quickControlSource = appSource.slice(
    appSource.indexOf("els.quickModelSelect?.addEventListener"),
    appSource.indexOf("els.modelSelect?.addEventListener")
  );

  assert.match(appSource, /function runtimeKindForFellowRoom\(room\)\s*\{[\s\S]*return sessionHistory\.runtimeKind\(room, "desktop-local"\);/);
  assert.match(appSource, /async function saveActiveFellowRuntimeControl/);
  assert.match(appSource, /window\.miaFellowCommands\.saveFellowRuntimeControl\(\{/);
  assert.match(appSource, /window\.miaFellowCommands\.getFellowRuntimeBinding\(\{/);
  assert.doesNotMatch(appSource, /window\.mia\.social\.saveFellowRuntime\(context\.fellowKey/);
  assert.doesNotMatch(appSource, /async function saveActiveCloudFellowRuntimeConfig/);
  assert.match(commandsSource, /async function saveFellowRuntimeControl/);
  assert.match(commandsSource, /async function saveDesktopLocalFellowRuntimeControl/);
  assert.match(quickControlSource, /saveActiveFellowRuntimeControl\(\s*"model"/);
  assert.match(quickControlSource, /saveActiveFellowRuntimeControl\(\s*"effortLevel"/);
  assert.match(quickControlSource, /saveActiveFellowRuntimeControl\(\s*"permissionMode"/);
  assert.doesNotMatch(quickControlSource, /window\.mia\.saveFellowEngine\(/);
  assert.doesNotMatch(quickControlSource, /window\.mia\.saveModel\(/);
  assert.doesNotMatch(quickControlSource, /window\.mia\.saveEffort\(/);
  assert.doesNotMatch(quickControlSource, /window\.mia\.savePermissions\(/);
  assert.match(appSource, /const roomPersona = personas\.find[\s\S]*if \(roomPersona\) return roomPersona;\s*return null;/);
});

test("desktop Hermes room model picker uses platform model catalog", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const preloadSource = fs.readFileSync(path.join(root, "src/preload.js"), "utf8");
  const socialApiSource = fs.readFileSync(path.join(root, "src/main/social/social-api.js"), "utf8");

  assert.match(appSource, /platformModelCatalog/);
  assert.match(appSource, /loadPlatformModelCatalog/);
  assert.match(appSource, /platformHermesModelEntries\(\)/);
  assert.doesNotMatch(appSource, /return \[\{ id: "hermes-agent", label: "Hermes Agent" \}\];/);
  assert.match(preloadSource, /listPlatformModels/);
  assert.match(socialApiSource, /\/api\/me\/model-catalog/);
});

test("desktop avatar picker supports video avatars with one trim row", () => {
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const dialogSource = fs.readFileSync(path.join(root, "src/renderer/fellow/fellow-dialog.js"), "utf8");
  const avatarSource = fs.readFileSync(path.join(root, "src/renderer/helpers/avatar-helpers.js"), "utf8");
  const styleSource = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");

  assert.match(html, /shared\/avatar-media\.js/);
  assert.match(html, /id="profileAvatarFile"[^>]+accept="image\/\*,video\/\*"/);
  assert.match(html, /id="fellowAvatarFile"[^>]+accept="image\/\*,video\/\*"/);
  assert.match(html, /id="avatarTrimControls"/);
  assert.match(html, /id="avatarTrimTimeline"/);
  assert.match(html, /id="avatarTrimFrames"/);
  assert.match(html, /id="avatarTrimPreview"/);
  assert.match(html, /data-avatar-trim-handle="start"/);
  assert.match(html, /data-avatar-trim-handle="end"/);
  assert.match(html, /id="avatarTrimStart"/);
  assert.match(html, /id="avatarTrimDuration"/);
  assert.match(appSource, /avatarTrimControls: document\.getElementById\("avatarTrimControls"\)/);
  assert.match(appSource, /avatarTrimTimeline: document\.getElementById\("avatarTrimTimeline"\)/);
  assert.match(appSource, /avatarTrimFrames: document\.getElementById\("avatarTrimFrames"\)/);
  assert.match(appSource, /beginAvatarTrimDrag/);
  assert.match(appSource, /avatarTrimStart\.addEventListener\("input"/);
  assert.match(dialogSource, /file\.type\?\.startsWith\("video\/"\)/);
  assert.match(dialogSource, /updateAvatarTrimControls/);
  assert.match(dialogSource, /renderAvatarTrimFrames/);
  assert.doesNotMatch(dialogSource, /Math\.abs\(els\.avatarTrimPreview\.currentTime - trim\.start\)/);
  assert.match(avatarSource, /applyAvatarMedia/);
  assert.match(avatarSource, /createAvatarImageElement/);
  assert.match(avatarSource, /updateAvatarImageElement/);
  assert.match(avatarSource, /createAvatarVideoElement/);
  assert.match(avatarSource, /updateAvatarVideoElement/);
  assert.match(avatarSource, /function hydrateAvatarMedia/);
  assert.match(avatarSource, /data-avatar-media="1"/);
  assert.doesNotMatch(avatarSource, /avatarVideoTargetTime/);
  assert.doesNotMatch(avatarSource, /avatarVideoLoopEpochs/);
  assert.doesNotMatch(avatarSource, /\bdrift\b/);
  assert.match(avatarSource, /classList\.add\("media-avatar"\)/);
  assert.match(avatarSource, /removeAvatarChildrenExcept\(el, video\)/);
  assert.match(avatarSource, /background-color:transparent/);
  assert.doesNotMatch(avatarSource, /const style = `background-color:\$\{escapeHtml\(color\)\};`/);
  assert.match(avatarSource, /video\.loop = true/);
  assert.doesNotMatch(styleSource, /\.avatar-video\.ready/);
  assert.match(styleSource, /\.avatar-image,/);
  assert.match(styleSource, /\.profile-avatar\.media-avatar/);
  assert.match(styleSource, /\.profile-avatar\.video-avatar/);
  assert.match(styleSource, /\.avatar,\n\.fellow-photo\s*\{[\s\S]*?border:\s*0;/);
  assert.match(styleSource, /\.contact-profile-avatar\s*\{[\s\S]*?border:\s*0;[\s\S]*?box-shadow:\s*none;/);
});

test("desktop avatar helpers tolerate null crop values", () => {
  const avatarSource = fs.readFileSync(path.join(root, "src/renderer/helpers/avatar-helpers.js"), "utf8");
  const context = vm.createContext({ window: {}, console });
  vm.runInContext(avatarSource, context);

  const crop = context.window.miaAvatar.normalizeCrop(null);
  assert.equal(crop.x, 50);
  assert.equal(crop.y, 50);
  assert.equal(crop.zoom, 1);
  assert.doesNotThrow(() => context.window.miaAvatar.avatarBackgroundStyle("data:image/gif;base64,abc", null, "#34c759"));
});

test("desktop avatar video crop updates do not restart playback unless trim changes", () => {
  const avatarSource = fs.readFileSync(path.join(root, "src/renderer/helpers/avatar-helpers.js"), "utf8");
  const mediaSource = fs.readFileSync(path.join(root, "src/shared/avatar-media.js"), "utf8");
  const context = vm.createContext({
    window: {},
    console,
    setTimeout
  });
  context.globalThis = context.window;
  vm.runInContext(mediaSource, context, { filename: "src/shared/avatar-media.js" });
  vm.runInContext(avatarSource, context, { filename: "src/renderer/helpers/avatar-helpers.js" });

  const seeks = [];
  const removed = [];
  let currentTime = 2.4;
  const video = {
    dataset: {},
    classList: {
      add() {},
      remove(name) { removed.push(name); }
    },
    attrs: {},
    readyState: 2,
    duration: 10,
    get currentTime() { return currentTime; },
    set currentTime(value) {
      seeks.push(value);
      currentTime = value;
    },
    getAttribute(name) { return this.attrs[name] || null; },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    removeAttribute(name) { delete this.attrs[name]; },
    addEventListener() {},
    play() { return { catch() {} }; }
  };
  const src = "data:video/mp4;base64,abc";

  context.window.miaAvatar.updateAvatarVideoElement(video, src, { x: 45, y: 55, zoom: 1.2, start: 1, duration: 2 });
  seeks.length = 0;
  removed.length = 0;

  context.window.miaAvatar.updateAvatarVideoElement(video, src, { x: 50, y: 40, zoom: 1.6, start: 1, duration: 2 });

  assert.deepEqual(seeks, []);
  assert.deepEqual(removed, []);
  assert.equal(video.dataset.avatarStart, "1");
  assert.equal(video.dataset.avatarDuration, "2");

  context.window.miaAvatar.updateAvatarVideoElement(video, src, { x: 50, y: 40, zoom: 1.6, start: 1.5, duration: 2 });

  assert.deepEqual(removed, []);
  assert.equal(seeks.length, 1);
  assert.equal(seeks[0], 1.5);
});

test("cloud-only: submit routes through the active cloud room, not a local session", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const start = appSource.indexOf('els.chatForm.addEventListener("submit"');
  const handler = appSource.slice(start, appSource.indexOf("\n});", start) + 4);

  assert.match(handler, /window\.miaSocial\.sendInActiveRoom\(/);
  // The local conversation send path is gone from the submit handler.
  assert.doesNotMatch(handler, /appendChat\(/);
  assert.doesNotMatch(handler, /window\.mia\.sendChat\(/);
});

test("renderer no longer mirrors local sends through legacy cloud push", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const preloadSource = fs.readFileSync(path.join(root, "src/preload.js"), "utf8");
  const channelSource = fs.readFileSync(path.join(root, "src/shared/ipc-channels.js"), "utf8");

  assert.doesNotMatch(appSource, /pushCloudMessageQuietly|cloudPushMessage/);
  assert.doesNotMatch(preloadSource, /cloudPushMessage/);
  assert.doesNotMatch(channelSource, /CloudPushMessage/);
});

test("cloud-only: the sidebar message list is built from social rows alone", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.match(appSource, /sortMessageCardsForSidebar\(socialRows\)/);
  // No local fellow personas feed the conversation list anymore.
  assert.doesNotMatch(appSource, /visiblePersonas\.map/);
});

test("fellow cloud rooms are not hidden from the sidebar", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.doesNotMatch(appSource, /if\s*\(\s*isFellow\s*\)\s*return\s+null/);
});

test("creating or messaging a fellow opens its conversation through the unified fellow route", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const fellowManagerSource = fs.readFileSync(path.join(root, "src/renderer/fellow/fellow-manager.js"), "utf8");

  assert.match(appSource, /async function openFellowConversation\(fellowKey\)/);
  assert.match(appSource, /window\.miaSocial\.ensureFellowRoom\(fellow\)/);
  assert.match(appSource, /window\.miaSocial\.setActiveRoomId\(room\.id\)/);
  assert.match(appSource, /if \(savedKey\) await openFellowConversation\(savedKey\);/);
  assert.match(fellowManagerSource, /window\.miaOpenFellowConversation\(fellowKey\)/);
});

test("contacts merge local fellows with owned cloud fellows", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const fellowDirectorySource = fs.readFileSync(path.join(root, "src/renderer/fellow/fellow-directory.js"), "utf8");
  const fellowManagerSource = fs.readFileSync(path.join(root, "src/renderer/fellow/fellow-manager.js"), "utf8");
  const socialSource = fs.readFileSync(path.join(root, "src/renderer/social/social.js"), "utf8");

  assert.match(html, /fellow\/fellow-directory\.js/);
  assert.match(fellowDirectorySource, /function listOwnedFellows/);
  assert.match(socialSource, /window\.miaFellowDirectory[\s\S]*listOwnedFellows/);
  assert.match(fellowManagerSource, /function allOwnedFellows\(\)/);
  assert.match(fellowManagerSource, /window\.miaFellowDirectory\.listOwnedFellows/);
  assert.match(fellowManagerSource, /const fellows = allOwnedFellows\(\);/);
  assert.doesNotMatch(fellowManagerSource, /cloudOnly/);
  assert.doesNotMatch(socialSource, /cloudOnly:\s*(true|false)/);
  assert.match(appSource, /const syncedFellowKeys = new Set/);
  assert.match(appSource, /const contactKeys = new Set/);
});

test("contact detail shows engine logo and fellow device label", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const fellowManagerSource = fs.readFileSync(path.join(root, "src/renderer/fellow/fellow-manager.js"), "utf8");
  const styleSource = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");

  assert.match(mainSource, /function localDeviceName\(\)/);
  assert.match(mainSource, /localDevice:\s*\{\s*name:\s*localDeviceName\(\)/);
  assert.match(fellowManagerSource, /function fellowDeviceLabel\(fellow = \{\}\)/);
  assert.match(fellowManagerSource, /function engineLogoHtml\(engine = ""\)/);
  assert.match(fellowManagerSource, /engine-row-logo contact-engine-logo/);
  assert.match(fellowManagerSource, /fellowDeviceLabel\(fellow\)/);
  assert.doesNotMatch(fellowManagerSource, /"本地伙伴"/);
  assert.match(styleSource, /\.contact-engine-badge \.contact-engine-logo/);
});

test("contact detail deletes fellows through runtime-backed ownership rules", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const fellowManagerSource = fs.readFileSync(path.join(root, "src/renderer/fellow/fellow-manager.js"), "utf8");
  const commandsSource = fs.readFileSync(path.join(root, "src/renderer/fellow/fellow-commands.js"), "utf8");
  const preloadSource = fs.readFileSync(path.join(root, "src/preload.js"), "utf8");
  const channelSource = fs.readFileSync(path.join(root, "src/shared/ipc-channels.js"), "utf8");
  const socialApiSource = fs.readFileSync(path.join(root, "src/main/social/social-api.js"), "utf8");
  const socialIpcSource = fs.readFileSync(path.join(root, "src/main/social/social-ipc.js"), "utf8");

  assert.doesNotMatch(appSource, /if \(!fellow \|\| fellow\.key === "mia"\) return;/);
  assert.match(appSource, /if \(fellow\.canDelete === false\) return;/);
  assert.match(appSource, /这会删除该 Fellow，并清理当前账号可管理的配置和会话。/);
  assert.match(appSource, /window\.miaFellowCommands\.deleteFellow\(\{/);
  assert.doesNotMatch(appSource, /window\.mia\.social\.deleteFellow\(fellow\.key\)/);
  assert.match(commandsSource, /async function deleteCloudHermesFellow/);
  assert.match(commandsSource, /api\.social\.deleteFellow\(key\)/);
  assert.match(commandsSource, /async function deleteDesktopLocalFellow/);
  assert.match(commandsSource, /api\.deleteFellow\(\{ key \}\)/);
  assert.match(fellowManagerSource, /const canDeleteFellow = fellow\.canDelete !== false;/);
  assert.match(channelSource, /SocialDeleteFellow/);
  assert.match(preloadSource, /deleteFellow: \(fellowId\) => ipcRenderer\.invoke\(IpcChannel\.SocialDeleteFellow, fellowId\)/);
  assert.match(socialApiSource, /async deleteFellow\(fellowId\)/);
  assert.match(socialIpcSource, /SocialDeleteFellow/);
});

test("fellow management copy avoids cloud/local split in user-facing language", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const contactCardSource = fs.readFileSync(path.join(root, "src/renderer/social/contact-card.js"), "utf8");

  assert.doesNotMatch(appSource, /云端联系人|本地会话记录/);
  assert.doesNotMatch(contactCardSource, /不在你的本地 fellow 列表里/);
  assert.match(contactCardSource, /不属于你/);
});

test("contact capability saves go through fellow command adapters", () => {
  const fellowManagerSource = fs.readFileSync(path.join(root, "src/renderer/fellow/fellow-manager.js"), "utf8");
  const commandsSource = fs.readFileSync(path.join(root, "src/renderer/fellow/fellow-commands.js"), "utf8");

  assert.match(fellowManagerSource, /window\.miaFellowCommands\.saveFellowCapabilities\(\{/);
  assert.doesNotMatch(fellowManagerSource, /window\.mia\.social\.saveFellowIdentity/);
  assert.doesNotMatch(fellowManagerSource, /window\.mia\.saveFellow\(\{/);
  assert.match(commandsSource, /async function saveCloudHermesFellowCapabilities/);
  assert.match(commandsSource, /async function saveDesktopLocalFellowCapabilities/);
});

test("social bootstrap delegates desktop-local fellow sync through fellow command adapters", () => {
  const socialSource = fs.readFileSync(path.join(root, "src/renderer/social/social.js"), "utf8");
  const commandsSource = fs.readFileSync(path.join(root, "src/renderer/fellow/fellow-commands.js"), "utf8");

  assert.match(socialSource, /window\.miaFellowCommands\.ensureDesktopLocalFellowRoom\(\{/);
  assert.match(socialSource, /window\.miaFellowCommands\.syncDesktopLocalFellowRuntimeBinding\(\{/);
  assert.doesNotMatch(socialSource, /api\.saveFellowRuntime\(fellowKey/);
  assert.doesNotMatch(socialSource, /api\.ensureFellowRoom\(fellow\.key,/);
  assert.match(commandsSource, /function desktopLocalRuntimeConfig/);
  assert.match(commandsSource, /async function ensureDesktopLocalFellowRoom/);
});

test("fellow creation dialog separates runtime location from agent engine", () => {
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const dialogSource = fs.readFileSync(path.join(root, "src/renderer/fellow/fellow-dialog.js"), "utf8");

  assert.match(html, /id="fellowRuntimeLocation"/);
  assert.match(html, /value="desktop-local"/);
  assert.match(html, /value="cloud-hermes"/);
  assert.match(appSource, /fellowRuntimeLocation:\s*document\.getElementById\("fellowRuntimeLocation"\)/);
  assert.match(dialogSource, /function renderFellowRuntimeLocationSelect/);
  assert.match(dialogSource, /state\.runtime\?\.cloud\?\.enabled/);
  assert.match(dialogSource, /els\.fellowAgentEngineField\?\.classList\.toggle\("hidden", runtimeKind === "cloud-hermes" \|\| !showField\)/);
});

test("fellow creation branches cloud-hermes without saving local manifest", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const commandsSource = fs.readFileSync(path.join(root, "src/renderer/fellow/fellow-commands.js"), "utf8");

  assert.match(html, /fellow\/fellow-commands\.js/);
  assert.match(appSource, /window\.miaFellowCommands\.saveFellow\(\{/);
  assert.doesNotMatch(appSource, /async function createCloudHermesFellow/);
  assert.doesNotMatch(appSource, /window\.mia\.social\.saveFellowIdentity\(key,/);
  assert.match(commandsSource, /async function saveCloudHermesFellow/);
  assert.match(commandsSource, /api\.social\.saveFellowIdentity\(key,/);
  assert.match(commandsSource, /runtimeKind:\s*"cloud-hermes"/);
  assert.match(commandsSource, /async function saveDesktopLocalFellow/);
  assert.match(commandsSource, /api\.saveFellow\(fellow\)/);
});

test("opening a fellow conversation preserves existing cloud runtime kind", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const socialSource = fs.readFileSync(path.join(root, "src/renderer/social/social.js"), "utf8");

  assert.match(socialSource, /function fellowRoomForKey\(fellowKey\)/);
  assert.match(appSource, /const existingRoom = window\.miaSocial\?\.fellowRoomForKey\?\.\(key\)/);
  assert.match(appSource, /if \(existingRoom\?\.id\)/);
  assert.match(appSource, /window\.miaSocial\.setActiveRoomId\(existingRoom\.id\)/);
});

test("renderer app state factory owns default mutable state", () => {
  const source = fs.readFileSync(path.join(root, "src/renderer/app-state.js"), "utf8");
  const localStorage = {
    getItem(key) {
      if (key === "mia.setupGuideDismissed.v2") return "1";
      if (key === "mia.onboardingStep") return "model";
      return "";
    }
  };
  const sandbox = {
    window: { miaAppState: null, innerWidth: 640, localStorage },
    localStorage,
    Set,
    Map
  };
  vm.runInNewContext(source, sandbox);

  const state = sandbox.window.miaAppState.createInitialState({
    localStorage,
    sidebarWidth: 300,
    windowWidth: 640
  });

  assert.equal(state.setupGuideDismissed, true);
  assert.equal(state.onboardingStep, "model");
  assert.equal(state.isNarrowWindow, true);
  assert.equal(state.sidebarWidth, 300);
  assert.equal(state.slashCommands[0].command, "/new");
  assert.notEqual(state.slashCommands, sandbox.window.miaAppState.fallbackSlashCommands);
});
