const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("desktop renderer builds a production React bundle before dev start and packaging", () => {
  const pkg = JSON.parse(read("package.json"));
  const build = read("scripts/build-renderer-react.js");
  const start = read("scripts/start-dev.js");
  const prepare = read("scripts/prepare-desktop-package.js");
  const html = read("src/renderer/index.html");

  assert.equal(pkg.scripts["renderer:build"], "node scripts/build-renderer-react.js");
  assert.match(pkg.scripts.check, /renderer:build[\s\S]*renderer:typecheck/);
  assert.equal(pkg.build.beforePack, "./scripts/prepare-desktop-package.js");
  assert.match(build, /minify:\s*options\.minify !== false/);
  assert.match(build, /"process\.env\.NODE_ENV": JSON\.stringify\("production"\)/);
  assert.match(build, /MAX_RENDERER_BUNDLE_BYTES\s*=\s*256 \* 1024/);
  assert.match(build, /bundleBytes > MAX_RENDERER_BUNDLE_BYTES/);
  assert.match(start, /build-renderer-react\.js/);
  assert.match(prepare, /buildRendererReact\(\{\s*minify:\s*true/);
  assert.ok(
    html.indexOf("./react-dist/renderer.js") < html.indexOf("./app.js"),
    "React must synchronously create compatibility elements before app.js caches them"
  );
});

test("React owns navigation controls while the shell keeps synchronous layout geometry", () => {
  const html = read("src/renderer/index.html");
  const main = read("src/renderer/react/main.tsx");
  const navigation = read("src/renderer/react/components/Navigation.tsx");
  const tabs = read("src/renderer/react/components/SectionTabs.tsx");
  const folders = read("src/renderer/react/components/ConversationFolderTabs.tsx");
  const folderStore = read("src/renderer/react/stores/conversation-folders.ts");
  const app = read("src/renderer/app.js");

  for (const rootId of [
    "reactNavigationRoot",
    "sidebarBottomNav",
    "reactContactsExploreTabsRoot",
    "reactExploreTabsRoot",
    "reactTaskTabsRoot",
    "reactSettingsSidebarTabsRoot",
    "reactSettingsWorkspaceTabsRoot"
  ]) {
    assert.match(html, new RegExp(`id="${rootId}"`));
    assert.match(main, new RegExp(`getElementById\\("${rootId}"\\)`));
  }
  assert.match(navigation, /useRendererShell\(\)/);
  assert.match(app, /els\.chatView\?\.classList\.toggle\("hidden", state\.activeView !== "chat"\)/);
  assert.match(app, /els\.appShell\?\.setAttribute\("data-active-view", state\.activeView\)/);
  assert.match(app, /els\.appShell\?\.setAttribute\("data-layout", legacyGridLayoutForView\(state\.activeView\)\)/);
  assert.match(app, /els\.appShell\?\.setAttribute\("data-shell-layout", state\.shellLayout\)/);
  assert.match(tabs, /bridge\.invoke\("selectExploreView"/);
  assert.match(tabs, /export function DiscoverModeToggle\(\)/);
  assert.match(tabs, /snapshot\.contactsUnread/);
  assert.match(main, /getElementById\("discoverModeToggle"\), <DiscoverModeToggle \/>/);
  assert.match(html, /id="discoverModeToggle"[^>]+data-react-root="discover-mode"/);
  assert.doesNotMatch(app, /function renderDiscoverModeToggle\(\)/);
  assert.match(html, /id="personaTagFilters"[^>]+data-react-root="conversation-folders"/);
  assert.match(main, /getElementById\("personaTagFilters"\), <ConversationFolderTabs \/>/);
  assert.match(folders, /useConversationFolders\(\)/);
  assert.match(folders, /window\.addEventListener\("pointermove"/);
  assert.match(folderStore, /flushSync\(\(\) => \{/);
  assert.match(app, /window\.miaReactConversationFolders\.publish\(\{/);
  assert.doesNotMatch(app, /personaTagFilters\.innerHTML/);
  assert.match(tabs, /bridge\.invoke\("selectTaskMode"/);
  assert.match(tabs, /bridge\.invoke\("selectSettingsTab"/);
  assert.doesNotMatch(app, /document\.querySelectorAll\("\[data-settings-tab\]"\)\.forEach\(\(button\) => \{\s*button\.addEventListener/);
});

test("production app entry refuses to run without the React renderer contract", () => {
  const app = read("src/renderer/app.js");
  assert.match(app, /^function assertReactRendererReady\(\)/);
  for (const globalName of [
    "miaReactRenderer",
    "miaReactBridge",
    "miaReactSurface",
    "miaReactMessageList",
    "miaReactConversationList",
    "miaReactConversationFolders"
  ]) {
    assert.match(app, new RegExp(`"${globalName}"`));
  }
  assert.match(app, /framework === "react"/);
  assert.match(app, /assertReactRendererReady\(\);/);
});

test("React owns the composer event lifecycle while preserving the rich-editor adapter", () => {
  const html = read("src/renderer/index.html");
  const composerInput = read("src/renderer/react/components/ComposerInput.tsx");
  const bridge = read("src/renderer/react/bridge.ts");
  const app = read("src/renderer/app.js");
  const composer = read("src/renderer/chat/composer.js");

  assert.match(html, /id="reactComposerInputRoot"[\s\S]*data-react-root="composer-input"/);
  for (const action of [
    "composerBlur",
    "composerClick",
    "composerCompositionEnd",
    "composerCompositionStart",
    "composerContextMenu",
    "composerInput",
    "composerKeyDown",
    "composerPaste"
  ]) {
    assert.match(composerInput, new RegExp(`bridge\\.invoke\\("${action}"`));
    assert.match(bridge, new RegExp(`${action}:`));
    assert.match(app, new RegExp(`${action}:\\s*handle`));
  }
  assert.doesNotMatch(app, /chatInput\.addEventListener\("(?:input|keydown|paste|compositionstart|compositionend)"/);
  assert.match(composer, /Object\.defineProperty\(input, "value"/);
});

test("React reconciles conversation cards and messages by stable keys", () => {
  const html = read("src/renderer/index.html");
  const app = read("src/renderer/app.js");
  const social = read("src/renderer/social/social.js");
  const conversationList = read("src/renderer/react/components/ConversationList.tsx");
  const conversationStore = read("src/renderer/react/stores/conversation-list.ts");
  const messageList = read("src/renderer/react/components/MessageList.tsx");
  const messageStore = read("src/renderer/react/stores/message-list.ts");

  assert.match(html, /id="personaList" class="persona-list" data-react-root="conversation-list"/);
  assert.match(html, /id="chat" class="chat" data-react-root="message-list"/);
  assert.match(app, /window\.miaReactConversationList\.publish\(\{/);
  assert.match(app, /key:\s*conversationListEntryKey\(spec, index\)/);
  assert.match(conversationList, /<LegacyConversationCard[\s\S]*key=\{entry\.key\}/);
  assert.match(conversationStore, /rows:\s*payload\.entries\.map\(\(\{ active, key, signature \}\)/);

  assert.match(social, /function renderConversationChatWithReact\(/);
  assert.match(social, /key:\s*`message:\$\{conversationId\}:\$\{stableId\}`/);
  assert.match(social, /reactList\.render\(\{\s*conversationId,\s*entries\s*\}\)/);
  assert.match(messageList, /previous\.entry\.key === next\.entry\.key/);
  assert.match(messageList, /previous\.entry\.signature === next\.entry\.signature/);
  assert.match(messageStore, /flushSync\(\(\) => \{/);
});

test("React owns the chat header, composer interaction, and explicit compatibility islands", () => {
  const html = read("src/renderer/index.html");
  const main = read("src/renderer/react/main.tsx");
  const header = read("src/renderer/react/components/ChatHeader.tsx");
  const surface = read("src/renderer/react/components/LegacySurface.tsx");
  const surfaceStore = read("src/renderer/react/stores/legacy-surface.ts");
  const composer = read("src/renderer/chat/composer.js");
  const composerContent = read("src/renderer/react/components/ComposerContent.tsx");
  const composerMenus = read("src/renderer/react/components/ComposerMenus.tsx");
  const composerSelect = read("src/renderer/react/components/ComposerSelectMenu.tsx");
  const permissionBanner = read("src/renderer/react/components/PermissionBanner.tsx");
  const tasks = read("src/renderer/tasks/tasks-panel.js");
  const skills = read("src/renderer/skills/skill-library.js");
  const contacts = read("src/renderer/bot/bot-manager.js");

  assert.match(html, /id="reactChatHeaderRoot"[\s\S]*data-react-root="chat-header"/);
  assert.match(main, /getElementById\("reactChatHeaderRoot"\), <ChatHeader \/>/);
  assert.match(header, /<LegacySurface id="chatConversationList" \/>/);
  assert.match(header, /<LegacySurface id="sessionList" \/>/);

  for (const id of [
    "contactList",
    "contactDetail",
    "skillCardGrid",
    "botStoreGrid",
    "tasksContent",
    "connectedProviderList"
  ]) {
    assert.match(main, new RegExp(`"${id}"`), `${id} should remain an explicit compatibility island`);
  }

  assert.match(main, /getElementById\("composerAttachments"\), <ComposerAttachments \/>/);
  assert.match(main, /getElementById\("slashCommandMenu"\), <SlashCommandMenu \/>/);
  assert.match(main, /getElementById\("mentionMenu"\), <MentionMenu \/>/);
  assert.match(main, /getElementById\("agentPermissionBanner"\), <PermissionBanner \/>/);
  assert.match(surfaceStore, /flushSync\(commit\)/);
  assert.match(surfaceStore, /if \(previous\.fingerprint === next\.fingerprint/);
  assert.match(surface, /target\.replaceChildren\(\.\.\.Array\.from\(source\.childNodes\)\)/);
  assert.match(composer, /miaReactComposerMenus\.publishSlash/);
  assert.match(composer, /miaReactComposerMenus\.publishMention/);
  assert.match(composer, /miaReactComposerContent\.publishAttachments/);
  assert.doesNotMatch(composer, /renderComposerSurface/);
  assert.match(composerContent, /function ComposerAttachments/);
  assert.match(composerMenus, /function SlashCommandMenu/);
  assert.match(composerSelect, /function ComposerSelectMenu/);
  assert.match(permissionBanner, /function PermissionBanner/);
  assert.match(tasks, /miaReactSurface\?\.renderHtml/);
  assert.match(skills, /miaReactSurface\?\.renderHtml/);
  assert.match(contacts, /miaReactSurface\?\.renderNodes/);
});
