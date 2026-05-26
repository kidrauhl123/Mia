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

  assert.match(appSource, /await window\.miaSocial\.sendInActiveRoom\(roomText\);/);
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
  assert.match(appSource, /if\s*\(state\.runtime\?\.cloud\?\.enabled\)\s*\{\s*els\.chat\.innerHTML = "";\s*return;\s*\}/);
  assert.match(appSource, /if\s*\(state\.runtime\?\.cloud\?\.enabled\)\s*return;/);
});

test("desktop cloud fellow rooms keep private AI composer controls visible", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.match(appSource, /activeCloudRoomType\s*===\s*"fellow"/);
  assert.match(appSource, /composerBottom\.classList\.toggle\("hidden",\s*!showPrivateAiControls\)/);
  assert.doesNotMatch(appSource, /if\s*\(composerBottom\)\s*composerBottom\.classList\.add\("hidden"\);/);
});

test("desktop cloud-Hermes fellow controls save through cloud runtime binding", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.match(appSource, /function runtimeKindForCloudFellowRoom\(room\)\s*\{[\s\S]*return String\(room\?\.decorations\?\.runtimeKind \|\| ""\)\.trim\(\) \|\| "desktop-local";/);
  assert.match(appSource, /async function saveActiveCloudFellowRuntimeConfig/);
  assert.match(appSource, /window\.mia\.social\.saveFellowRuntime\(context\.fellowKey/);
  assert.match(appSource, /if\s*\(await saveActiveCloudFellowRuntimeConfig\([\s\S]*\)\)\s*return;/);
  assert.match(appSource, /const cloudPersona = personas\.find[\s\S]*if \(cloudPersona\) return cloudPersona;\s*return null;/);
});

test("desktop cloud-Hermes model picker uses platform model catalog", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const preloadSource = fs.readFileSync(path.join(root, "src/preload.js"), "utf8");
  const socialApiSource = fs.readFileSync(path.join(root, "src/main/social/social-api.js"), "utf8");

  assert.match(appSource, /platformModelCatalog/);
  assert.match(appSource, /loadPlatformModelCatalog/);
  assert.match(appSource, /cloudHermesModelEntries\(\)/);
  assert.doesNotMatch(appSource, /return \[\{ id: "hermes-agent", label: "Hermes Agent" \}\];/);
  assert.match(preloadSource, /listPlatformModels/);
  assert.match(socialApiSource, /\/api\/me\/model-catalog/);
});

test("private chat async replies are anchored to the submit session", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.match(appSource, /const submitPersonaKey = state\.activeKey;/);
  assert.match(appSource, /const submitSessionId = session\.id;/);
  assert.match(appSource, /const liveSession = sessionForPersonaSession\(submitPersonaKey, submitSessionId\);/);
  assert.match(appSource, /appendChat\("assistant", answer,[\s\S]*session: liveSession/);
});

test("renderer no longer mirrors local sends through legacy cloud push", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const preloadSource = fs.readFileSync(path.join(root, "src/preload.js"), "utf8");
  const channelSource = fs.readFileSync(path.join(root, "src/shared/ipc-channels.js"), "utf8");

  assert.doesNotMatch(appSource, /pushCloudMessageQuietly|cloudPushMessage/);
  assert.doesNotMatch(preloadSource, /cloudPushMessage/);
  assert.doesNotMatch(channelSource, /CloudPushMessage/);
});

test("logged-in message list uses social rows instead of local fellow rows", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.match(appSource, /cloudSignedIn\s*\?\s*\[\]\s*:\s*visiblePersonas\.map/s);
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
  const fellowManagerSource = fs.readFileSync(path.join(root, "src/renderer/fellow/fellow-manager.js"), "utf8");
  const socialSource = fs.readFileSync(path.join(root, "src/renderer/social/social.js"), "utf8");

  assert.match(socialSource, /cloudOnly:\s*true/);
  assert.match(socialSource, /cloudOnly:\s*false/);
  assert.match(fellowManagerSource, /function allOwnedFellows\(\)/);
  assert.match(fellowManagerSource, /window\.miaSocial\?\._internalCtx\?\.adapterCtx\?\.\(\)\?\.fellows/);
  assert.match(fellowManagerSource, /const fellows = allOwnedFellows\(\);/);
  assert.match(fellowManagerSource, /云端伙伴/);
  assert.match(appSource, /const cloudFellowKeys = new Set/);
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

test("contact detail allows deleting owned cloud-only fellows", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const fellowManagerSource = fs.readFileSync(path.join(root, "src/renderer/fellow/fellow-manager.js"), "utf8");
  const preloadSource = fs.readFileSync(path.join(root, "src/preload.js"), "utf8");
  const channelSource = fs.readFileSync(path.join(root, "src/shared/ipc-channels.js"), "utf8");
  const socialApiSource = fs.readFileSync(path.join(root, "src/main/social/social-api.js"), "utf8");
  const socialIpcSource = fs.readFileSync(path.join(root, "src/main/social/social-ipc.js"), "utf8");

  assert.doesNotMatch(appSource, /if \(!fellow \|\| fellow\.key === "mia"\) return;/);
  assert.match(appSource, /if \(!fellow\.cloudOnly && fellow\.key === "mia"\) return;/);
  assert.match(appSource, /window\.mia\.social\.deleteFellow\(fellow\.key\)/);
  assert.match(fellowManagerSource, /const canDeleteFellow = fellow\.cloudOnly \|\| \(canEditLocalFellow && fellow\.key !== "mia"\);/);
  assert.match(channelSource, /SocialDeleteFellow/);
  assert.match(preloadSource, /deleteFellow: \(fellowId\) => ipcRenderer\.invoke\(IpcChannel\.SocialDeleteFellow, fellowId\)/);
  assert.match(socialApiSource, /async deleteFellow\(fellowId\)/);
  assert.match(socialIpcSource, /SocialDeleteFellow/);
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
