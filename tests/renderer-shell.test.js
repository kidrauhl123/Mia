const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const rawReadFileSync = fs.readFileSync.bind(fs);

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

fs.readFileSync = function readFileSyncWithNormalizedText(file, options, ...args) {
  const value = rawReadFileSync(file, options, ...args);
  const encoding = typeof options === "string" ? options : options?.encoding;
  if (typeof value === "string" && /^utf-?8$/i.test(String(encoding || ""))) {
    return value.replace(/\r\n/g, "\n");
  }
  return value;
};

function extractFunctionSource(source, functionName) {
  const start = source.indexOf(`function ${functionName}`);
  assert.notEqual(start, -1, `${functionName} should exist`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Could not extract ${functionName}`);
}

test("renderer app shell loads state module before the entrypoint", () => {
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.match(html, /<script src="\.\/app-state\.js"><\/script>[\s\S]*<script src="\.\/app\.js"><\/script>/);
  assert.ok(html.indexOf("../shared/ids.js") >= 0, "renderer shell must load shared ids.js");
  assert.ok(
    html.indexOf("../shared/ids.js") < html.indexOf("./bot/bot-commands.js"),
    "shared ids.js must load before bot commands create cloud bot ids"
  );
  assert.match(appSource, /window\.miaAppState\.createInitialState/);
  assert.doesNotMatch(appSource, /const state = \{/);
  assert.doesNotMatch(appSource, /const fallbackSlashCommands = \[/);
});

test("cloud conversation composer uses one social send path for dm and group conversations", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.match(appSource, /await window\.miaSocial\.sendInActiveConversation\(conversationText\b/);
  assert.doesNotMatch(appSource, /sendInActiveGroupConversation\(conversationText\)/);
});

test("cloud conversation composer sends pending attachments and clears the tray", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.doesNotMatch(appSource, /pathPasteAttachmentsForSend/);
  assert.match(appSource, /const pendingAttachments = \[\.\.\.state\.pendingAttachments\]\.slice\(0, 20\);/);
  assert.match(appSource, /if \(!conversationText\.trim\(\) && !pendingAttachments\.length\) return;/);
  assert.match(appSource, /sendInActiveConversation\(conversationText,\s*\{[\s\S]*attachments: pendingAttachments/);
  assert.match(appSource, /state\.pendingAttachments = \[\];/);
  assert.match(appSource, /window\.miaComposer\.renderComposerAttachments\(\);/);
});

test("cloud conversation composer keeps accepting sends even while the active run is busy", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const submitStart = appSource.indexOf('els.chatForm.addEventListener("submit"');
  const submitEnd = appSource.indexOf("// Cloud-only:", submitStart);
  const submitBody = appSource.slice(submitStart, submitEnd);
  const clearDraft = submitBody.indexOf('els.chatInput.value = "";');

  assert.ok(submitStart >= 0, "chat submit handler should exist");
  assert.ok(submitEnd > submitStart, "cloud conversation branch should be extractable");
  assert.ok(clearDraft >= 0, "cloud conversation branch should clear the draft after accepting a send");
  assert.doesNotMatch(submitBody, /if \(isActiveConversationBusy\(\)\) \{[\s\S]*?return;[\s\S]*?\}/);
});

test("active conversation stop passes the conversation id through preload to main", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const preloadSource = fs.readFileSync(path.join(root, "src/preload.js"), "utf8");
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const clickStart = appSource.indexOf('els.sendChat.addEventListener("click"');
  const clickEnd = appSource.indexOf('els.chat.addEventListener("click"', clickStart);
  const clickBody = appSource.slice(clickStart, clickEnd);

  assert.match(appSource, /function isActiveConversationBusy\(\)/);
  assert.match(appSource, /return status === "running" \|\| status === "cancelling";/);
  assert.match(clickBody, /const activeRun = window\.miaSocial\?\.activeConversationRun\?\.\(\);/);
  assert.match(clickBody, /window\.mia\.stopChat\?\.\(\{\s*conversationId:\s*window\.miaSocial\?\.getActiveConversationId\?\.\(\)/);
  assert.match(clickBody, /runId:\s*activeRun\?\.runId \|\| ""/);
  assert.match(clickBody, /turnId:\s*activeRun\?\.turnId \|\| ""/);
  assert.match(preloadSource, /stopChat:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\(IpcChannel\.ChatStop,\s*payload\)/);
  assert.match(mainSource, /ipcMain\.handle\(IpcChannel\.ChatStop,\s*\(_event,\s*payload\)\s*=>\s*stopChat\(payload\s*\|\|\s*\{\}\)\)/);
  // stopChat's implementation now lives in the shared bot-execution-core Module
  // (extracted from main.js so Mia Core drives the same stop path — no fork).
  const botExecSource = fs.readFileSync(path.join(root, "src/main/bot-execution-core.js"), "utf8");
  assert.match(botExecSource, /localBotResponder\?\.stopActiveConversationRun\?\.\(payload\)/);
});

test("foreground active conversation stop delegates to the Mia Core owner", () => {
  // The stop path moved into bot-execution-core.js; main.js delegates to it.
  const botExecSource = fs.readFileSync(path.join(root, "src/main/bot-execution-core.js"), "utf8");
  const stopStart = botExecSource.indexOf("async function stopChat");
  const stopEnd = botExecSource.indexOf("return {", stopStart);
  const stopBody = botExecSource.slice(stopStart, stopEnd);

  assert.ok(stopStart >= 0, "stopChat should be async because Mia Core forwarding is async");
  assert.match(stopBody, /!isDaemon\(\)/);
  assert.match(stopBody, /daemonTasksClient\?\.call\?\.\("\/api\/chat\/stop"/);
  assert.match(stopBody, /body:\s*JSON\.stringify\(payload\s*\|\|\s*\{\}\)/);
});

test("composer pending attachments are thumbnail-first and open the image editor", () => {
  const composerSource = fs.readFileSync(path.join(root, "src/renderer/chat/composer.js"), "utf8");
  const styleSource = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");

  assert.match(composerSource, /data-attachment-preview/);
  assert.match(composerSource, /classList\?\.toggle\("has-attachments", attachments\.length > 0\)/);
  assert.doesNotMatch(composerSource, /composer-attachment-name/);
  assert.doesNotMatch(composerSource, /composer-attachment-size/);
  assert.match(styleSource, /\.composer-card\.has-attachments\s*\{/);
  assert.match(styleSource, /@keyframes composerAttachmentsOpen/);
  assert.match(styleSource, /\.composer-attachment\.image\s*\{[\s\S]*?width:\s*136px;[\s\S]*?height:\s*86px;/);
  assert.match(styleSource, /\.composer-attachment-thumb\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%;/);
});

test("image preview is an svg-icon editing window with crop draw and save actions", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.match(appSource, /className = "image-preview-overlay image-editor-overlay"/);
  assert.match(appSource, /data-image-editor-action="crop"/);
  assert.match(appSource, /data-image-editor-action="draw"/);
  assert.match(appSource, /data-image-editor-action="save"/);
  assert.match(appSource, /<canvas class="image-editor-canvas"/);
  assert.match(appSource, /<svg viewBox="0 0 24 24"/);
  assert.doesNotMatch(appSource, />\s*(剪裁|涂鸦|保存)\s*</);
});

test("message path reference chips reuse the image preview", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.match(appSource, /function openPathRefPreviewFromChip/);
  assert.match(appSource, /fetchFileAttachment\?\.\(\{ path: filePath \}\)/);
  assert.match(appSource, /openImagePreview\(src, attachment\?\.name \|\| filePath\)/);
  assert.match(appSource, /closest\("\[data-path-ref-path\]"\)/);
});

test("settings exposes manual update checks through the preload bridge", () => {
  const htmlSource = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const preloadSource = fs.readFileSync(path.join(root, "src/preload.js"), "utf8");
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const appUpdateOverlayTag = htmlSource.match(/<section id="appUpdateOverlay"[^>]*>/)?.[0] || "";

  assert.match(htmlSource, /id="checkUpdates"/);
  assert.match(htmlSource, /id="appUpdateHint"/);
  assert.match(htmlSource, /id="appUpdateOverlay"/);
  assert.match(htmlSource, /id="appUpdateReleaseNotes"/);
  assert.match(htmlSource, /id="appUpdateProgressFill"/);
  assert.match(appSource, /window\.mia\.checkForUpdates\(\)/);
  assert.match(appSource, /window\.mia\.onUpdateEvent\?\.\(\(payload\) => handleAppUpdateEvent/);
  assert.match(appSource, /function appUpdateReleaseNoteLines\(payload = \{\}\)/);
  assert.match(appSource, /function renderAppUpdateReleaseNotes\(payload = \{\}\)/);
  assert.match(appSource, /item\.textContent = note/);
  assert.doesNotMatch(appSource, /setAppShellUpdateLocked/);
  assert.doesNotMatch(appSource, /\.inert\s*=/);
  assert.doesNotMatch(appUpdateOverlayTag, /aria-modal="true"/);
  assert.match(appUpdateOverlayTag, /role="status"/);
  assert.match(appUpdateOverlayTag, /aria-live="polite"/);
  assert.match(htmlSource, /class="app-update-notes" hidden/);
  assert.match(preloadSource, /checkForUpdates:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(IpcChannel\.UpdateCheck\)/);
  assert.match(preloadSource, /onUpdateEvent:\s*\(callback\) => \{/);
  assert.match(preloadSource, /ipcRenderer\.on\(IpcChannel\.UpdateEvent, handler\)/);
  assert.match(mainSource, /ipcMain\.handle\(IpcChannel\.UpdateCheck,\s*\(\)\s*=>\s*autoUpdateService\.checkForUpdates\(\)\)/);
  assert.match(mainSource, /sendUpdateEvent:\s*\(payload\) => broadcastRendererEvent\(IpcChannel\.UpdateEvent, payload\)/);
  assert.match(mainSource, /prepareForUpdateInstall:\s*async\s*\([^)]*\)\s*=>\s*\{\s*await stopDaemonService\(\);?\s*\}/);
});

test("runtime refresh re-renders the daemon status card from observed daemon state", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.match(
    appSource,
    /async function refreshRuntime\(\)[\s\S]*renderDaemonStatus\(runtime\.daemon\s*\|\|\s*\{\}\)/,
    "refreshRuntime should push observed daemon status into the settings card so auto-start updates the UI"
  );
});

test("bot composer shows Mia Core startup progress through the right-side status slot", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const appStateSource = fs.readFileSync(path.join(root, "src/renderer/app-state.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");

  assert.match(appStateSource, /coreStartup:\s*\{\s*active:\s*false,\s*mode:\s*"",\s*percent:\s*0,\s*nudgeTick:\s*0\s*\}/);
  assert.match(appSource, /function coreStartupStatusText\(\)\s*\{/);
  assert.match(appSource, /return `Mia Core \$\{mode === "restart" \? "重启" : "启动"\}中 \$\{percent\}%`;/);
  assert.match(appSource, /function setModelSwitchStatusText\(value\)\s*\{/);
  assert.match(appSource, /const showCoreStartupStatus = isCoreStartupStatusVisible\(\);/);
  assert.match(appSource, /els\.modelSwitchStatus\?\.classList\.toggle\("core-starting",\s*showCoreStartupStatus\)/);
  assert.match(appSource, /runFirstRunBackgroundServices\(\)[\s\S]*?beginCoreStartupProgress\("start"\)/);
  assert.match(appSource, /els\.daemonRestart\?\.addEventListener\("click", async \(\) => \{[\s\S]*?beginCoreStartupProgress\(/);
  assert.match(css, /\.model-switch-status\.core-starting\s*\{/);
  assert.match(css, /\.model-switch-status\.core-starting\.is-nudging\s*\{/);
});

test("only bot conversations block sends while Mia Core startup is in progress", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");
  const clickStart = appSource.indexOf('els.sendChat.addEventListener("click"');
  const clickEnd = appSource.indexOf('els.chat.addEventListener("click"', clickStart);
  const clickBody = appSource.slice(clickStart, clickEnd);
  const submitStart = appSource.indexOf('els.chatForm.addEventListener("submit"');
  const submitEnd = appSource.indexOf("// Cloud-only:", submitStart);
  const submitBody = appSource.slice(submitStart, submitEnd);

  assert.match(appSource, /function isCoreStartupSendBlocked\(\)\s*\{\s*return Boolean\(state\.coreStartup\?\.active && activeConversationBotContext\(\)\);\s*\}/);
  assert.match(appSource, /function nudgeCoreStartupStatus\(\)\s*\{/);
  assert.match(appSource, /els\.sendChat\.classList\.toggle\("core-blocked",\s*blockedByCoreStartup\)/);
  assert.match(clickBody, /if \(isCoreStartupSendBlocked\(\)\) \{[\s\S]*?nudgeCoreStartupStatus\(\);[\s\S]*?return;\s*\}/);
  assert.match(submitBody, /if \(isCoreStartupSendBlocked\(\)\) \{[\s\S]*?nudgeCoreStartupStatus\(\);[\s\S]*?return;\s*\}/);
  assert.match(css, /\.send-button\.core-blocked\s*\{/);
  assert.match(css, /@keyframes\s+composerCoreStartupNudge\s*\{/);
});

test("cloud conversation send and render do not depend on activeKey being empty", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.doesNotMatch(appSource, /getActiveConversationId\?\.\(\) && !state\.activeKey/);
  assert.doesNotMatch(appSource, /activeConversationId && !state\.activeKey/);
});

test("desktop window controls use frameless Windows chrome off macOS", () => {
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const preloadSource = fs.readFileSync(path.join(root, "src/preload.js"), "utf8");
  const windowIpcSource = fs.readFileSync(path.join(root, "src/main/ipc/window-ipc.js"), "utf8");
  const channelSource = fs.readFileSync(path.join(root, "src/shared/ipc-channels.js"), "utf8");
  const titleBarSource = fs.readFileSync(path.join(root, "src/main/windows-title-bar.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");
  const botStoreCss = fs.readFileSync(path.join(root, "src/renderer/styles/bot-store.css"), "utf8");

  assert.match(html, /id="windowControls"[\s\S]*data-action="minimize"[\s\S]*data-action="green"[\s\S]*data-action="close"[\s\S]*<aside class="nav-rail"/);
  assert.match(html, /<div class="traffic-spacer" id="trafficSpacer" aria-hidden="true"><\/div>/);
  assert.match(html, /class="window-drag-strip"/);
  assert.match(mainSource, /process\.platform === "win32"[\s\S]*frame:\s*false[\s\S]*thickFrame:\s*true/);
  assert.match(titleBarSource, /const WINDOWS_TITLE_BAR_HEIGHT = 32;/);
  assert.match(titleBarSource, /const WINDOWS_TITLE_BAR_OVERLAY_HEIGHT = WINDOWS_TITLE_BAR_HEIGHT;/);
  assert.match(titleBarSource, /const WINDOWS_LIGHT_TITLE_BAR_COLOR = "#f2f4f7";/);
  assert.match(titleBarSource, /const WINDOWS_DARK_TITLE_BAR_COLOR = "#20232a";/);
  assert.doesNotMatch(titleBarSource, /workspaceBackgroundColor/);
  assert.match(titleBarSource, /height:\s*WINDOWS_TITLE_BAR_OVERLAY_HEIGHT/);
  assert.match(titleBarSource, /symbolColor:\s*theme === "dark" \? WINDOWS_DARK_SYMBOL_COLOR : WINDOWS_LIGHT_SYMBOL_COLOR/);
  assert.doesNotMatch(titleBarSource, /setTitleBarOverlay/);
  assert.match(mainSource, /transparent:\s*process\.platform === "darwin"/);
  assert.match(mainSource, /backgroundColor:\s*onboarding[\s\S]*\?\s*"#ffffff"[\s\S]*initialWindowsTitleBarOverlay\.color/);
  assert.match(mainSource, /autoHideMenuBar:\s*process\.platform !== "darwin"/);
  assert.match(mainSource, /process\.platform !== "darwin"[\s\S]*win\.setMenuBarVisibility\(false\)/);
  assert.match(appSource, /document\.body\.classList\.toggle\("platform-win32",\s*rendererPlatform === "win32"\)/);
  assert.match(appSource, /document\.body\.classList\.toggle\("platform-darwin",\s*rendererPlatform === "darwin"\)/);
  assert.match(appSource, /document\.body\.classList\.toggle\("window-fullscreen",\s*Boolean\(fullscreen\)\)/);
  assert.match(appSource, /const controls = document\.getElementById\("windowControls"\)/);
  assert.match(appSource, /const controlRoot = controls \|\| spacer/);
  assert.match(appSource, /closest\("\.window-control, \.traffic-light"\)/);
  assert.match(appSource, /const task = isWindows \? \(api\.maximize\?\.\(\) \|\| api\.green\(\)\) : api\.green\(\);/);
  assert.match(preloadSource, /maximize:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(IpcChannel\.WindowMaximize\)/);
  assert.match(preloadSource, /setTitleBarTheme:\s*\(appearance\)\s*=>\s*ipcRenderer\.invoke\(IpcChannel\.WindowTitleBarTheme,\s*appearance \|\| \{\}\)/);
  assert.match(channelSource, /WindowTitleBarTheme:\s*"window:title-bar-theme"/);
  assert.match(windowIpcSource, /if \(process\.platform !== "darwin"\) return toggleMaximized\(w\);/);
  assert.match(windowIpcSource, /applyWindowsTitleBarOverlay\(w,\s*\{ theme:\s*"light" \}\)/);
  assert.match(windowIpcSource, /setBackgroundColor\(process\.platform === "darwin"\s*\?\s*"#00000000"\s*:\s*"#f0f0f3"\)/);
  assert.match(windowIpcSource, /setMacNativeControlsVisible\(w,\s*true\)/);
  assert.match(windowIpcSource, /IpcChannel\.WindowTitleBarTheme[\s\S]*applyWindowsTitleBarOverlay\(BrowserWindow\.fromWebContents\(event\.sender\),\s*appearance\)/);
  assert.match(css, /\.window-controls\s*\{\s*display:\s*none;/);
  assert.match(css, /body\.platform-win32 \.traffic-spacer \.traffic-light\s*\{\s*display:\s*none;/);
  assert.match(css, /body\.platform-win32 \.window-controls\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?right:\s*0;[\s\S]*?grid-template-columns:\s*repeat\(3,\s*46px\);/);
  assert.match(css, /body\.platform-win32 \.window-controls::after\s*\{[\s\S]*?bottom:\s*0;[\s\S]*?height:\s*1px;[\s\S]*?background:\s*var\(--win-panel-border\);/);
  assert.match(css, /body\.platform-win32 \.window-control\s*\{[\s\S]*?display:\s*grid;[\s\S]*?width:\s*46px;[\s\S]*?background-image:\s*none;/);
  assert.match(css, /body\.platform-win32 \.window-control\.minimize::before[\s\S]*?body\.platform-win32 \.window-control\.green::before[\s\S]*?body\.platform-win32 \.window-control\.close::before/);
  assert.match(css, /body\.platform-darwin \.traffic-spacer \.traffic-light\s*\{\s*display:\s*none;/);
  assert.match(css, /--traffic-spacer-height:\s*52px;/);
  assert.match(css, /--mac-traffic-spacer-height:\s*44px;/);
  assert.match(css, /--win-titlebar-height:\s*32px;/);
  assert.match(css, /--win-titlebar-control-width:\s*138px;/);
  assert.match(css, /--win-titlebar-bg:\s*#f2f4f7;/);
  assert.match(css, /--win-rail-column-width:\s*70px;/);
  assert.match(css, /--win-rail-bg:\s*#f2f4f7;/);
  assert.match(css, /:root\[data-theme="dark"\]\s*\{[\s\S]*?--win-titlebar-bg:\s*#20232a;/);
  assert.match(css, /:root\[data-theme="dark"\]\s*\{[\s\S]*?--win-rail-bg:\s*#20232a;/);
  assert.match(css, /body\.platform-win32\s*\{[\s\S]*?--rail-column-width:\s*var\(--win-rail-column-width\);[\s\S]*?--traffic-spacer-height:\s*12px;/);
  assert.match(css, /body\.platform-win32 \.app-shell\s*\{[\s\S]*?padding:\s*var\(--win-titlebar-height\) 0 0;/);
  assert.match(css, /body\.platform-win32 \.app-shell::before\s*\{[\s\S]*?top:\s*calc\(var\(--win-titlebar-height\) - 1px\);[\s\S]*?height:\s*1px;[\s\S]*?background:\s*var\(--win-panel-border\);[\s\S]*?pointer-events:\s*none;/);
  assert.match(css, /body\.platform-win32 \.window-drag-strip\s*\{[\s\S]*?right:\s*var\(--win-titlebar-control-width\);[\s\S]*?background:\s*var\(--win-titlebar-bg\);[\s\S]*?-webkit-app-region:\s*drag;/);
  assert.match(css, /body\.platform-win32 \.nav-rail\s*\{[\s\S]*?margin:\s*calc\(-1 \* var\(--win-titlebar-height\)\) 0 0;[\s\S]*?padding:\s*calc\(var\(--win-titlebar-height\) \+ 8px\) 0 12px;[\s\S]*?border-right:\s*1px solid var\(--win-panel-border\);[\s\S]*?border-radius:\s*0;[\s\S]*?background:\s*var\(--win-rail-bg\);[\s\S]*?box-shadow:\s*none;[\s\S]*?backdrop-filter:\s*none;/);
  assert.match(css, /body\.platform-win32 \.conversation-sidebar,[\s\S]*?body\.platform-win32 \.app-shell\[data-layout="index-workspace"\] \.sidebar\s*\{[\s\S]*?margin:\s*0;[\s\S]*?border-right:\s*1px solid var\(--win-panel-border\);[\s\S]*?border-radius:\s*0;[\s\S]*?background:\s*var\(--win-sidebar-bg\);[\s\S]*?box-shadow:\s*none;[\s\S]*?backdrop-filter:\s*none;/);
  assert.match(css, /body\.platform-win32 \.app-shell:not\(\[data-nav-layout="sidebar-bottom"\]\) \.settings-layout\s*\{[\s\S]*?grid-template-columns:\s*var\(--sidebar-width\) minmax\(0,\s*1fr\);[\s\S]*?gap:\s*0;[\s\S]*?padding:\s*0;/);
  assert.match(css, /body\.platform-win32 \.app-shell:not\(\[data-nav-layout="sidebar-bottom"\]\) \.settings-tabs\s*\{[\s\S]*?width:\s*100%;[\s\S]*?border-right:\s*1px solid var\(--win-panel-border\);[\s\S]*?border-radius:\s*0;[\s\S]*?background:\s*var\(--win-sidebar-bg\);[\s\S]*?box-shadow:\s*none;[\s\S]*?backdrop-filter:\s*none;/);
  assert.match(css, /body\.platform-win32 \.app-shell\[data-nav-layout="sidebar-bottom"\]\[data-active-view="settings"\] \.settings-sidebar\s*\{[\s\S]*?margin:\s*0;[\s\S]*?border-right:\s*1px solid var\(--win-panel-border\);[\s\S]*?border-radius:\s*0;[\s\S]*?background:\s*var\(--win-sidebar-bg\);[\s\S]*?box-shadow:\s*none;[\s\S]*?backdrop-filter:\s*none;/);
  assert.match(css, /body\.platform-win32 \.app-shell\[data-nav-layout="sidebar-bottom"\]\[data-active-view="settings"\] \.sidebar-bottom-nav\s*\{[\s\S]*?left:\s*0;[\s\S]*?bottom:\s*0;[\s\S]*?width:\s*var\(--sidebar-width\);[\s\S]*?border-right:\s*1px solid var\(--win-panel-border\);[\s\S]*?border-radius:\s*0;[\s\S]*?background:\s*var\(--win-sidebar-bg\);[\s\S]*?box-shadow:\s*none;[\s\S]*?backdrop-filter:\s*none;/);
  assert.match(css, /body\.platform-win32 \[class~="sidebar-tools"\]\s*\{[\s\S]*?background:\s*var\(--win-sidebar-bg\);[\s\S]*?border-bottom:\s*1px solid var\(--win-panel-border\);/);
  assert.match(css, /body\.platform-win32 \.conversation-sidebar \.sidebar-tools\.has-tag-filters\s*\{[\s\S]*?border-bottom:\s*0;/);
  assert.match(css, /body\.platform-win32 \.persona\s*\{[\s\S]*?width:\s*calc\(100% - 12px\);[\s\S]*?margin:\s*0 6px;[\s\S]*?border-radius:\s*8px;/);
  assert.match(botStoreCss, /body\.platform-win32 \.app-shell\[data-active-view="contacts"\] \.discover-top-bar,[\s\S]*?body\.platform-win32 \.app-shell\[data-active-view="bot-store"\] \.discover-top-bar\s*\{[\s\S]*?top:\s*var\(--win-titlebar-height\);[\s\S]*?height:\s*70px;[\s\S]*?padding-top:\s*12px;/);
  assert.match(botStoreCss, /body\.platform-win32 \.app-shell\[data-active-view="contacts"\] \.contacts-sidebar\s*\{[\s\S]*?margin:\s*calc\(var\(--win-titlebar-height\) \+ 58px\) 8px 10px 0;[\s\S]*?border:\s*1px solid var\(--win-panel-border\);[\s\S]*?border-radius:\s*8px;[\s\S]*?box-shadow:\s*var\(--rail-expanded-shadow\);/);
  assert.match(css, /--mac-rail-column-width:\s*82px;/);
  assert.match(css, /body\.platform-darwin\s*\{[\s\S]*?--rail-column-width:\s*var\(--mac-rail-column-width\);[\s\S]*?--traffic-spacer-height:\s*var\(--mac-traffic-spacer-height\);/);
  assert.match(css, /body\.platform-darwin \.app-shell\s*\{[\s\S]*?border-radius:\s*var\(--window-corner-radius\);/);
  assert.match(css, /body\.platform-darwin\.window-maximized \.app-shell,[\s\S]*?body\.platform-darwin\.window-fullscreen \.app-shell\s*\{[\s\S]*?border-radius:\s*0;/);
  assert.match(css, /body\.platform-win32 \.window-controls\[data-fullscreen="true"\]\s*\{\s*display:\s*none;/);
  assert.doesNotMatch(css, /body\.platform-win32 \.topbar\s*\{\s*padding-right:\s*150px;/);
});

test("desktop message notifications are wired through preload and main IPC", () => {
  const channelSource = fs.readFileSync(path.join(root, "src/shared/ipc-channels.js"), "utf8");
  const preloadSource = fs.readFileSync(path.join(root, "src/preload.js"), "utf8");
  const windowIpcSource = fs.readFileSync(path.join(root, "src/main/ipc/window-ipc.js"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const socialSource = fs.readFileSync(path.join(root, "src/renderer/social/social.js"), "utf8");

  assert.match(channelSource, /DesktopNotificationShow:\s*"desktop-notification:show"/);
  assert.match(channelSource, /DesktopNotificationClick:\s*"desktop-notification:click"/);
  assert.match(preloadSource, /showDesktopNotification:\s*\(payload\) => ipcRenderer\.invoke\(IpcChannel\.DesktopNotificationShow,\s*payload\)/);
  assert.match(preloadSource, /onDesktopNotificationClick:\s*\(handler\) => \{/);
  assert.match(windowIpcSource, /ipcMain\.handle\(IpcChannel\.DesktopNotificationShow/);
  assert.match(windowIpcSource, /new Notification\(\{/);
  assert.match(windowIpcSource, /webContents\?\.send\(IpcChannel\.DesktopNotificationClick/);
  assert.match(appSource, /window\.mia\.onDesktopNotificationClick\?\.\(openDesktopNotificationConversation\)/);
  assert.match(appSource, /showDesktopMessageNotification:\s*\(payload\) => window\.mia\.showDesktopNotification\?\.\(payload\)/);
  assert.match(socialSource, /function maybeNotifyDesktopMessage/);
  assert.match(socialSource, /isConversationMuted\(conversationId\)/);
});

test("desktop shell uses optional middle pane by active view", () => {
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const appStateSource = fs.readFileSync(path.join(root, "src/renderer/app-state.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");

  assert.match(appSource, /function shellLayoutForView\(view\)/);
  assert.match(appSource, /function viewHasIndexPane\(view = state\.activeView\)/);
  assert.match(appSource, /return view === "chat" \|\| view === "contacts" \|\| view === "settings";/);
  assert.match(appSource, /function normalizeNarrowPaneForView\(view = state\.activeView\)/);
  assert.match(appSource, /if \(state\.isNarrowWindow\) return "single";/);
  assert.match(appSource, /return viewHasIndexPane\(view\) \? "dual" : "workspace"/);
  assert.match(appSource, /setAttribute\("data-layout", legacyGridLayoutForView\(state\.activeView\)\)/);
  assert.match(appSource, /setAttribute\("data-shell-layout", state\.shellLayout\)/);
  assert.match(appSource, /function syncSidebarCollapseState\(\)/);
  assert.match(appSource, /function sidebarCollapseSupported\(view = state\.activeView\)\s*\{\s*return state\.navLayout !== "sidebar-bottom" && !state\.isNarrowWindow && view === "chat";\s*\}/);
  assert.match(appSource, /let shellLayoutTransitionTimer = 0;/);
  assert.match(appSource, /function triggerResponsiveShellTransition\(direction\)/);
  assert.match(appSource, /setAttribute\("data-responsive-transition", direction\)/);
  assert.match(appSource, /const transitionDirection = wasNarrow === isNarrow \? "" : isNarrow \? "collapse" : "expand";/);
  assert.match(appSource, /setAttribute\("data-sidebar-state", collapsed \? "collapsed" : "expanded"\)/);
  assert.match(appSource, /localStorage\.setItem\("mia\.sidebarCollapsed\.v1", state\.sidebarCollapsed \? "1" : "0"\)/);
  assert.match(appSource, /if \(state\.isNarrowWindow && viewHasIndexPane\(state\.activeView\)\) \{\s*showNarrowSidebar\(\);/);
  assert.match(appSource, /state\.discoverSectionView \|\| "bot-store"/);
  assert.match(appStateSource, /discoverSectionView:\s*"bot-store"/);
  assert.match(appStateSource, /shellLayout:\s*windowWidth <= 720 \? "single" : "dual"/);
  assert.match(appStateSource, /sidebarCollapsed:\s*options\.sidebarCollapsed \?\? readLocal\(storage, "mia\.sidebarCollapsed\.v1"\) === "1"/);
  assert.doesNotMatch(appStateSource, /skillPickerPluginId/);
  assert.match(html, /id="sidebarCollapseToggle" class="sidebar-collapse-toggle"[\s\S]*?aria-controls="conversationSidebar"[\s\S]*?aria-expanded="true"[\s\S]*?<\/button>\s*<div class="sidebar-title">消息<\/div>/);
  assert.match(
    html,
    /id="sidebarCollapseToggle" class="sidebar-collapse-toggle"[^>]*\bhidden\b/,
    "sidebar collapse toggle should default hidden until JS confirms a collapsible desktop layout"
  );
  assert.match(html, /id="sidebarRailHoverBridge" class="sidebar-rail-hover-bridge" aria-hidden="true"><\/div>\s*<button id="sidebarRailToggle"/);
  assert.match(html, /id="sidebarRailToggle" class="sidebar-rail-toggle sidebar-expand-toggle"[\s\S]*?aria-controls="conversationSidebar"[\s\S]*?aria-expanded="false"[\s\S]*?<rect x="3" y="4" width="18" height="16" rx="2\.5"/);
  assert.match(css, /--rail-column-width:\s*78px;/);
  assert.match(css, /\.app-shell\[data-layout="index-workspace"\]\s*\{[\s\S]*?grid-template-columns:\s*var\(--rail-column-width\) var\(--sidebar-width\) 0 minmax\(0,\s*1fr\);/);
  assert.match(css, /\.app-shell\[data-layout="index-workspace"\]\[data-sidebar-state="collapsed"\]\s*\{[\s\S]*?grid-template-columns:\s*var\(--rail-column-width\) 0 0 minmax\(0,\s*1fr\);/);
  assert.match(css, /\.app-shell\[data-layout="workspace"\]\s*\{[\s\S]*?grid-template-columns:\s*var\(--rail-column-width\) minmax\(0,\s*1fr\);/);
  assert.match(html, /id="settingsView" class="workspace settings-workspace hidden"/);
  assert.doesNotMatch(html, /id="settingsView" class="settings-modal/);
  assert.doesNotMatch(html, /class="settings-dialog"/);
  assert.doesNotMatch(html, /id="closeSettings"/);
  assert.doesNotMatch(html, /settings-topbar/);
  assert.match(html, /class="settings-tabs"[\s\S]*?class="settings-tabs-title">设置</);
  assert.match(appSource, /els\.settingsView\?\.classList\.toggle\("hidden", state\.activeView !== "settings"\)/);
  assert.match(appSource, /state\.activeView = "settings";/);
  assert.doesNotMatch(appSource, /state\.settingsOpen/);
  assert.doesNotMatch(appSource, /syncSettingsDrawerVisibility/);
  assert.match(css, /#chatView\s*\{[\s\S]*?grid-column:\s*4;[\s\S]*?grid-row:\s*1;/);
  assert.match(css, /--rail-glass-bg:\s*color-mix\(in srgb,\s*var\(--surface-layer\)\s*82%,\s*transparent\);/);
  assert.match(css, /\.nav-rail\s*\{[\s\S]*?grid-template-rows:\s*var\(--traffic-spacer-height\) 44px 1px repeat\(4,\s*56px\) minmax\(0,\s*1fr\) 44px;[\s\S]*?margin:\s*8px 8px 10px 8px;[\s\S]*?border-radius:\s*var\(--rail-corner-radius\);[\s\S]*?background:\s*var\(--rail-glass-bg\);[\s\S]*?backdrop-filter:\s*blur\(24px\) saturate\(1\.16\);/);
  assert.match(css, /:root\[data-theme="dark"\] \.nav-rail\s*\{[\s\S]*?background:\s*var\(--rail-glass-bg\);[\s\S]*?backdrop-filter:\s*none;/);
  assert.match(css, /body:not\(\.platform-win32\) \.app-shell\[data-active-view="chat"\]\[data-layout="index-workspace"\] \.nav-rail\s*\{[\s\S]*?margin:\s*8px 0 10px 8px;[\s\S]*?border-radius:\s*var\(--rail-corner-radius\) 0 0 var\(--rail-corner-radius\);[\s\S]*?background:\s*var\(--surface-layer\);[\s\S]*?box-shadow:\s*none;[\s\S]*?backdrop-filter:\s*none;/);
  assert.match(css, /body:not\(\.platform-win32\) \.app-shell\[data-active-view="chat"\]\[data-layout="index-workspace"\] \.nav-rail::after\s*\{[\s\S]*?top:\s*22px;[\s\S]*?bottom:\s*22px;[\s\S]*?width:\s*1px;[\s\S]*?background:\s*var\(--line\);/);
  assert.match(css, /body:not\(\.platform-win32\) \.app-shell\[data-active-view="chat"\]\[data-layout="index-workspace"\]\[data-sidebar-state="collapsed"\] \.nav-rail\s*\{[\s\S]*?margin:\s*8px 8px 10px 8px;[\s\S]*?border-radius:\s*var\(--rail-corner-radius\);/);
  assert.match(css, /body:not\(\.platform-win32\) \.app-shell\[data-active-view="chat"\]\[data-layout="index-workspace"\]\[data-sidebar-state="collapsed"\] \.nav-rail::after\s*\{[\s\S]*?display:\s*none;/);
  assert.match(css, /body:not\(\.platform-win32\) \.app-shell\[data-active-view="chat"\]\[data-layout="index-workspace"\]\[data-shell-layout="single"\]\[data-narrow-pane="content"\] \.nav-rail\s*\{[\s\S]*?margin:\s*8px 8px 10px 8px;[\s\S]*?border-radius:\s*var\(--rail-corner-radius\);/);
  assert.match(css, /body:not\(\.platform-win32\) \.app-shell\[data-active-view="chat"\]\[data-layout="index-workspace"\]\[data-shell-layout="single"\]\[data-narrow-pane="content"\] \.nav-rail::after\s*\{[\s\S]*?display:\s*none;/);
  assert.match(css, /body:not\(\.platform-win32\) \.app-shell:not\(\[data-nav-layout="sidebar-bottom"\]\)\[data-active-view="settings"\]\[data-layout="index-workspace"\] \.nav-rail\s*\{[\s\S]*?margin:\s*8px 0 10px 8px;[\s\S]*?border-radius:\s*var\(--rail-corner-radius\) 0 0 var\(--rail-corner-radius\);[\s\S]*?background:\s*var\(--surface-layer\);[\s\S]*?box-shadow:\s*none;[\s\S]*?backdrop-filter:\s*none;/);
  assert.match(css, /body:not\(\.platform-win32\) \.app-shell:not\(\[data-nav-layout="sidebar-bottom"\]\)\[data-active-view="settings"\]\[data-layout="index-workspace"\] \.nav-rail::after\s*\{[\s\S]*?top:\s*22px;[\s\S]*?bottom:\s*22px;[\s\S]*?width:\s*1px;[\s\S]*?background:\s*var\(--line\);/);
  assert.match(css, /body:not\(\.platform-win32\) \.app-shell:not\(\[data-nav-layout="sidebar-bottom"\]\)\[data-active-view="settings"\]\[data-layout="index-workspace"\]\[data-shell-layout="single"\]\[data-narrow-pane="content"\] \.nav-rail\s*\{[\s\S]*?margin:\s*8px 8px 10px 8px;[\s\S]*?border-radius:\s*var\(--rail-corner-radius\);/);
  assert.match(css, /body:not\(\.platform-win32\) \.app-shell:not\(\[data-nav-layout="sidebar-bottom"\]\)\[data-active-view="settings"\]\[data-layout="index-workspace"\]\[data-shell-layout="single"\]\[data-narrow-pane="content"\] \.nav-rail::after\s*\{[\s\S]*?display:\s*none;/);
  assert.match(css, /\.traffic-spacer\s*\{[\s\S]*?height:\s*var\(--traffic-spacer-height\);/);
  assert.match(css, /\.app-shell\[data-layout="index-workspace"\] \.sidebar\s*\{[\s\S]*?margin:\s*8px 8px 10px 0;[\s\S]*?border-radius:\s*var\(--rail-corner-radius\);[\s\S]*?background:\s*var\(--surface-layer\);[\s\S]*?box-shadow:\s*var\(--rail-expanded-shadow\);/);
  assert.match(css, /body:not\(\.platform-win32\) \.app-shell\[data-active-view="chat"\]\[data-layout="index-workspace"\] \.conversation-sidebar\s*\{[\s\S]*?border-radius:\s*0 var\(--rail-corner-radius\) var\(--rail-corner-radius\) 0;[\s\S]*?box-shadow:\s*none;[\s\S]*?backdrop-filter:\s*none;/);
  assert.match(css, /body:not\(\.platform-win32\) \.app-shell:not\(\[data-nav-layout="sidebar-bottom"\]\)\[data-active-view="settings"\]\[data-layout="index-workspace"\] \.settings-sidebar\s*\{[\s\S]*?border-radius:\s*0 var\(--rail-corner-radius\) var\(--rail-corner-radius\) 0;[\s\S]*?box-shadow:\s*none;[\s\S]*?backdrop-filter:\s*none;/);
  assert.match(css, /\.app-shell:not\(\[data-nav-layout="sidebar-bottom"\]\)\[data-active-view="settings"\]\[data-layout="index-workspace"\] #settingsView\s*\{[\s\S]*?grid-column:\s*4;[\s\S]*?grid-row:\s*1;/);
  assert.match(css, /@media\s*\(min-width:\s*721px\)\s*\{[\s\S]*?\.app-shell:not\(\[data-nav-layout="sidebar-bottom"\]\)\[data-active-view="settings"\]\[data-layout="index-workspace"\] \.settings-layout\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);[\s\S]*?padding:\s*0;/);
  assert.match(css, /@media\s*\(min-width:\s*721px\)\s*\{[\s\S]*?\.app-shell:not\(\[data-nav-layout="sidebar-bottom"\]\)\[data-active-view="settings"\]\[data-layout="index-workspace"\] \.settings-tabs\s*\{[\s\S]*?display:\s*none;/);
  assert.match(css, /@media\s*\(max-width:\s*1200px\)\s*\{[\s\S]*?\.app-shell:not\(\[data-nav-layout="sidebar-bottom"\]\)\[data-active-view="settings"\]\[data-layout="index-workspace"\]\s*\{[\s\S]*?grid-template-columns:\s*var\(--rail-column-width\) 0 0 minmax\(0,\s*1fr\);/);
  assert.match(css, /@media\s*\(max-width:\s*1200px\)\s*\{[\s\S]*?\.app-shell:not\(\[data-nav-layout="sidebar-bottom"\]\)\[data-active-view="settings"\]\[data-layout="index-workspace"\] \.settings-sidebar\s*\{[\s\S]*?display:\s*none !important;/);
  assert.match(css, /@media\s*\(max-width:\s*1200px\)\s*\{[\s\S]*?\.app-shell:not\(\[data-nav-layout="sidebar-bottom"\]\)\[data-active-view="settings"\]\[data-layout="index-workspace"\] \.settings-tabs\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*row;/);
  assert.match(css, /@media\s*\(max-width:\s*1200px\)\s*\{[\s\S]*?body\.platform-darwin \.app-shell:not\(\[data-nav-layout="sidebar-bottom"\]\)\[data-active-view="settings"\]\[data-layout="index-workspace"\] \.settings-layout\s*\{[\s\S]*?padding-top:\s*30px;/);
  assert.match(css, /@media\s*\(max-width:\s*1200px\)\s*\{[\s\S]*?\.app-shell:not\(\[data-nav-layout="sidebar-bottom"\]\)\[data-active-view="settings"\]\[data-layout="index-workspace"\] \.settings-tabs-title\s*\{[\s\S]*?display:\s*none;/);
  assert.match(css, /@media\s*\(max-width:\s*1200px\)\s*\{[\s\S]*?\.app-shell:not\(\[data-nav-layout="sidebar-bottom"\]\)\[data-active-view="settings"\]\[data-layout="index-workspace"\] \.settings-tab\s*\{[\s\S]*?min-height:\s*34px;[\s\S]*?border-radius:\s*14px;/);
  assert.match(css, /@media\s*\(max-width:\s*1200px\)\s*\{[\s\S]*?\.app-shell:not\(\[data-nav-layout="sidebar-bottom"\]\)\[data-active-view="settings"\]\[data-layout="index-workspace"\] \.nav-layout-preview\s*\{[\s\S]*?height:\s*124px;/);
  assert.match(css, /\.rail-button\[data-view\]\s*\{[\s\S]*?grid-template-rows:\s*24px 13px;[\s\S]*?width:\s*56px;[\s\S]*?height:\s*56px;/);
  assert.match(css, /\.rail-button-label\s*\{[\s\S]*?font-size:\s*10\.5px;[\s\S]*?line-height:\s*12px;[\s\S]*?white-space:\s*nowrap;/);
  assert.match(appSource, /sidebarCollapseToggle:\s*document\.getElementById\("sidebarCollapseToggle"\)/);
  assert.match(appSource, /els\.sidebarCollapseToggle\?\.addEventListener\("click",\s*\(\) => \{[\s\S]*?setSidebarCollapsed\(true,\s*true\);/);
  assert.match(appSource, /els\.sidebarRailToggle\?\.addEventListener\("click",\s*\(\) => \{[\s\S]*?setSidebarCollapsed\(false,\s*true\);/);
  assert.match(appSource, /function setConversationSidebarActionHover\(active\)/);
  assert.match(appSource, /function pointerIsInsideConversationSidebar\(event\)[\s\S]*?getBoundingClientRect\(\)/);
  assert.match(appSource, /function updateConversationSidebarActionHoverFromPointer\(event\)[\s\S]*?pointerIsInsideConversationSidebar\(event\)/);
  assert.match(appSource, /els\.conversationSidebar\?\.addEventListener\("pointerenter",\s*\(\) => setConversationSidebarActionHover\(true\)\)/);
  assert.match(appSource, /els\.conversationSidebar\?\.addEventListener\("pointermove",\s*updateConversationSidebarActionHoverFromPointer\)/);
  assert.match(appSource, /els\.conversationSidebar\?\.addEventListener\("pointerleave",\s*\(event\) => \{[\s\S]*?if \(!pointerIsInsideConversationSidebar\(event\)\) setConversationSidebarActionHover\(false\);[\s\S]*?\}\)/);
  assert.match(appSource, /document\.addEventListener\("pointermove",\s*\(event\) => \{[\s\S]*?updateConversationSidebarActionHoverFromPointer\(event\);[\s\S]*?\}\)/);
  assert.match(css, /\.sidebar-title-row\s*\{[\s\S]*?display:\s*flex;[\s\S]*?align-items:\s*center;[\s\S]*?-webkit-app-region:\s*no-drag;/);
  assert.match(css, /\.sidebar-collapse-toggle\s*\{[\s\S]*?width:\s*0;[\s\S]*?opacity:\s*0;[\s\S]*?overflow:\s*hidden;[\s\S]*?-webkit-app-region:\s*no-drag;/);
  assert.match(css, /\.conversation-sidebar:hover \.sidebar-collapse-toggle,[\s\S]*?\.conversation-sidebar\.sidebar-action-hover \.sidebar-collapse-toggle,[\s\S]*?\.conversation-sidebar \.sidebar-tools:focus-within \.sidebar-collapse-toggle\s*\{[\s\S]*?width:\s*28px;[\s\S]*?opacity:\s*1;/);
  assert.match(css, /\.sidebar-collapse-toggle\[hidden\],[\s\S]*?\.app-shell\[data-sidebar-toggle="hidden"\] \.sidebar-collapse-toggle,[\s\S]*?\.app-shell\[data-shell-layout="single"\] \.sidebar-collapse-toggle,[\s\S]*?\.app-shell\[data-nav-layout="sidebar-bottom"\] \.sidebar-collapse-toggle\s*\{[\s\S]*?display:\s*none;/);
  assert.doesNotMatch(css, /\.sidebar-collapse-toggle:focus-visible[^{]*\{[^}]*(?:outline|box-shadow):/);
  assert.doesNotMatch(css, /\.sidebar-rail-toggle:focus-visible[^{]*\{[^}]*(?:outline|box-shadow):/);
  assert.match(css, /\.sidebar-rail-hover-bridge\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?top:\s*0;[\s\S]*?bottom:\s*0;[\s\S]*?left:\s*var\(--rail-column-width\);[\s\S]*?width:\s*64px;[\s\S]*?display:\s*none;[\s\S]*?background:\s*transparent;[\s\S]*?-webkit-app-region:\s*no-drag;/);
  assert.doesNotMatch(css, /\.sidebar-rail-hover-bridge\s*\{[\s\S]*?left:\s*0;[\s\S]*?width:\s*calc\(var\(--rail-column-width\) \+ 64px\);/);
  assert.match(css, /\.app-shell\[data-sidebar-state="collapsed"\]\[data-sidebar-toggle="available"\] \.sidebar-rail-hover-bridge\s*\{[\s\S]*?display:\s*block;/);
  assert.match(css, /\.sidebar-rail-toggle\s*\{[\s\S]*?top:\s*50%;[\s\S]*?left:\s*calc\(var\(--rail-column-width\) - 6px\);[\s\S]*?width:\s*32px;[\s\S]*?height:\s*44px;[\s\S]*?background:\s*rgba\(15,\s*23,\s*42,\s*0\.10\);[\s\S]*?color:\s*var\(--muted\);[\s\S]*?box-shadow:\s*0 6px 18px rgba\(15,\s*23,\s*42,\s*0\.08\);[\s\S]*?opacity:\s*0;[\s\S]*?transform:\s*translateY\(-50%\);[\s\S]*?pointer-events:\s*none;/);
  assert.match(css, /\.sidebar-rail-toggle:hover\s*\{[\s\S]*?background:\s*rgba\(15,\s*23,\s*42,\s*0\.14\);/);
  assert.match(css, /\.app-shell\[data-sidebar-state="collapsed"\] \.nav-rail:hover ~ \.sidebar-rail-toggle,[\s\S]*?\.app-shell\[data-sidebar-state="collapsed"\] \.sidebar-rail-hover-bridge:hover ~ \.sidebar-rail-toggle,[\s\S]*?\.app-shell\[data-sidebar-state="collapsed"\] \.sidebar-rail-toggle:hover,[\s\S]*?\.app-shell\[data-sidebar-state="collapsed"\] \.sidebar-rail-toggle:focus-visible\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?pointer-events:\s*auto;/);
  assert.match(css, /\.app-shell\[data-layout="workspace"\] \.sidebar,[\s\S]*?\.app-shell\[data-layout="workspace"\] \.sidebar-resize-handle,[\s\S]*?\.app-shell\[data-layout="workspace"\] \.sidebar-rail-hover-bridge,[\s\S]*?\.app-shell\[data-layout="workspace"\] \.sidebar-rail-toggle\s*\{[\s\S]*?display:\s*none;/);
  assert.match(css, /\.app-shell\[data-sidebar-state="collapsed"\]\[data-sidebar-toggle="available"\]\[data-auth-state="signed-out"\] \.sidebar-rail-hover-bridge,[\s\S]*?\.app-shell\[data-sidebar-state="collapsed"\]\[data-sidebar-toggle="available"\]\[data-layout="workspace"\] \.sidebar-rail-hover-bridge,[\s\S]*?\.app-shell\[data-sidebar-state="collapsed"\]\[data-sidebar-toggle="available"\]\[data-shell-layout="single"\] \.sidebar-rail-hover-bridge,[\s\S]*?\.app-shell\[data-sidebar-state="collapsed"\]\[data-sidebar-toggle="available"\]\[data-nav-layout="sidebar-bottom"\] \.sidebar-rail-hover-bridge\s*\{[\s\S]*?display:\s*none;/);
});

test("single-pane rail pages do not render meaningless narrow back buttons", () => {
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");

  assert.match(html, /title="返回消息栏"/);
  assert.match(html, /title="返回联系人"/);
  assert.doesNotMatch(html, /title="返回能力库"/);
  assert.doesNotMatch(html, /title="返回任务"/);
});

test("sidebar-bottom navigation mode keeps the rail path and exposes four primary entries", () => {
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const appStateSource = fs.readFileSync(path.join(root, "src/renderer/app-state.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");
  const botStoreCss = fs.readFileSync(path.join(root, "src/renderer/styles/bot-store.css"), "utf8");
  const skillsCss = fs.readFileSync(path.join(root, "src/renderer/styles/skills.css"), "utf8");
  const tasksCss = fs.readFileSync(path.join(root, "src/renderer/styles/tasks.css"), "utf8");
  const sidebarBottomNav = html.match(/<nav id="sidebarBottomNav"[\s\S]*?<\/nav>/)?.[0] || "";
  const contactsSidebar = html.match(/<aside id="contactsSidebar"[\s\S]*?<aside id="exploreSidebar"/)?.[0] || "";
  const settingsSidebar = html.match(/<aside id="settingsSidebar"[\s\S]*?<div id="sidebarResizeHandle"/)?.[0] || "";

  assert.match(html, /<aside class="nav-rail" aria-label="主导航">/, "old rail must stay available");
  assert.match(html, /class="sidebar-bottom-nav"[\s\S]*aria-label="主导航"/);
  assert.match(html, /data-primary-nav="chat"[\s\S]*aria-label="聊天"/);
  assert.match(html, /data-primary-nav="explore"[\s\S]*aria-label="探索"/);
  assert.match(html, /data-primary-nav="tasks"[\s\S]*aria-label="任务"/);
  assert.match(html, /data-primary-nav="me"[\s\S]*aria-label="我"/);
  assert.doesNotMatch(sidebarBottomNav, /aria-label="设置"/);
  assert.doesNotMatch(sidebarBottomNav, /data-lottie=/);
  assert.match(sidebarBottomNav, /data-sidebar-bottom-icon="chat"[\s\S]*data-sidebar-bottom-icon="explore"[\s\S]*data-sidebar-bottom-icon="tasks"/);
  assert.match(sidebarBottomNav, /sidebar-bottom-icon-regular[\s\S]*sidebar-bottom-icon-fill/);
  assert.match(sidebarBottomNav, /class="sidebar-bottom-label"[^>]*>聊天<\/span>[\s\S]*class="sidebar-bottom-label"[^>]*>探索<\/span>[\s\S]*class="sidebar-bottom-label"[^>]*>任务<\/span>/);
  assert.doesNotMatch(sidebarBottomNav, /class="sidebar-bottom-label"[^>]*>我<\/span>/);
  assert.match(contactsSidebar, /class="explore-sidebar-tabs contacts-explore-tabs"[\s\S]*data-explore-view="contacts"[\s\S]*data-explore-view="bot-store"[\s\S]*data-explore-view="skills"/);
  assert.match(settingsSidebar, /class="settings-sidebar-tabs"[\s\S]*data-settings-tab="account"[\s\S]*data-settings-tab="appearance"[\s\S]*data-settings-tab="model"/);
  assert.match(html, /<div class="settings-section-label">导航栏位置<\/div>[\s\S]*<section class="settings-row nav-layout-settings-row">/);
  assert.doesNotMatch(html, /<strong>导航栏位置<\/strong>|选择四入口在左栏底部或保留左侧导航。/);
  assert.match(html, /class="nav-layout-choice-grid" role="radiogroup" aria-label="导航栏位置"/);
  assert.match(html, /data-nav-layout-choice="sidebar-bottom"[\s\S]*位于底部[\s\S]*data-nav-layout-choice="rail"[\s\S]*位于左侧/);
  assert.match(html, /class="nav-layout-preview nav-layout-preview-bottom"[\s\S]*class="np-content"[\s\S]*class="np-toolbar"[\s\S]*class="np-row"[\s\S]*class="np-avatar"[\s\S]*class="np-nav np-nav-bottom"[\s\S]*class="np-tab np-tab-active"/);
  assert.match(html, /class="nav-layout-preview nav-layout-preview-rail"[\s\S]*class="np-nav np-nav-rail"[\s\S]*class="np-tab np-tab-active"[\s\S]*class="np-content"[\s\S]*class="np-toolbar"/);
  assert.doesNotMatch(html, /id="appearanceSidebarBottomNav"/);
  assert.doesNotMatch(html, /沿用现有发现、联系人和能力库内容|沿用现有任务卡片/);

  assert.match(appStateSource, /navLayout:\s*readLocal\(storage,\s*"mia\.navLayout\.v1",\s*"rail"\)/);
  assert.match(appStateSource, /exploreSectionView:\s*"bot-store"/);
  assert.match(appSource, /navLayoutChoices:\s*document\.querySelectorAll\("\[data-nav-layout-choice\]"\)/);
  assert.match(appSource, /function setNavLayout\(layout,\s*persist = false\)/);
  assert.match(appSource, /const layout = state\.navLayout === "sidebar-bottom" \? "sidebar-bottom" : "rail"/);
  assert.match(appSource, /const nativeControlsLayout = layout === "sidebar-bottom" \? "default" : "rail"/);
  assert.match(appSource, /window\.mia\?\.window\?\.setNativeControlsLayout\?\.\(nativeControlsLayout\)/);
  assert.match(appSource, /setAttribute\("data-nav-layout",\s*layout\)/);
  assert.match(appSource, /localStorage\.setItem\("mia\.navLayout\.v1",\s*state\.navLayout\)/);
  assert.match(appSource, /els\.navLayoutChoices\?\.forEach\(\(button\) => \{[\s\S]*?button\.classList\.toggle\("active", active\);[\s\S]*?button\.setAttribute\("aria-checked", active \? "true" : "false"\);/);
  assert.match(appSource, /els\.navLayoutChoices\?\.forEach\(\(button\) => \{[\s\S]*?button\.addEventListener\("click", \(\) => \{[\s\S]*?setNavLayout\(button\.dataset\.navLayoutChoice, true\);[\s\S]*?renderView\(\);/);
  assert.match(appSource, /document\.querySelectorAll\("\[data-primary-nav\]"\)/);
  assert.match(
    appSource,
    /document\.querySelectorAll\("\[data-view\]"\)\.forEach\(\(button\) => \{[\s\S]*?const nextView =[\s\S]*?if \(nextView === "chat"\) setPersonaSearchOpen\(false\);[\s\S]*?state\.activeView = nextView;/,
    "clicking the chat rail entry should exit conversation search before showing messages"
  );
  assert.match(appSource, /settingsSidebar:\s*document\.getElementById\("settingsSidebar"\)/);
  assert.match(appSource, /state\.activeView = state\.exploreSectionView \|\| "bot-store"/);
  assert.match(appSource, /state\.activeView = "settings";/);
  assert.match(appSource, /els\.settingsSidebar\?\.classList\.toggle\("hidden",\s*state\.activeView !== "settings"\)/);

  assert.match(css, /--sidebar-bottom-nav-clearance:\s*84px;/);
  assert.match(css, /--sidebar-bottom-nav-bg:\s*color-mix\(in srgb,\s*var\(--surface\) 58%,\s*transparent\);/);
  assert.match(css, /\.nav-layout-settings-row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);[\s\S]*?min-height:\s*222px;[\s\S]*?padding:\s*20px 30px 24px;/);
  assert.match(css, /\.nav-layout-choice-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);[\s\S]*?justify-self:\s*center;[\s\S]*?width:\s*min\(680px,\s*100%\);/);
  assert.match(css, /\.nav-layout-choice\s*\{[\s\S]*?padding:\s*0;[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;/);
  assert.match(css, /\.nav-layout-choice\.active\s*\{[\s\S]*?color:\s*var\(--accent\);[\s\S]*?\}/);
  assert.match(css, /\.nav-layout-choice\.active \.nav-layout-preview\s*\{[\s\S]*?border-color:\s*var\(--accent\);/);
  assert.match(css, /\.nav-layout-preview\s*\{[\s\S]*?display:\s*flex;[\s\S]*?height:\s*168px;/);
  assert.match(css, /\.nav-layout-preview-bottom\s*\{[\s\S]*?flex-direction:\s*column;/);
  assert.match(css, /\.np-content\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;/);
  assert.match(css, /\.np-avatar\s*\{[\s\S]*?width:\s*26px;[\s\S]*?height:\s*26px;[\s\S]*?border-radius:\s*999px;/);
  assert.match(css, /\.np-nav-bottom\s*\{[\s\S]*?height:\s*30px;[\s\S]*?border-top:\s*1px solid/);
  assert.match(css, /\.np-tab-active\s*\{[\s\S]*?background:\s*var\(--accent\);/);
  assert.match(css, /\.np-nav-rail\s*\{[\s\S]*?flex-direction:\s*column;[\s\S]*?width:\s*46px;/);
  assert.match(css, /\.app-shell\[data-nav-layout="sidebar-bottom"\]\s*\{[\s\S]*?grid-template-columns:\s*var\(--sidebar-width\) minmax\(0,\s*1fr\);/);
  assert.match(css, /\.app-shell\[data-nav-layout="sidebar-bottom"\] \.nav-rail\s*\{[\s\S]*?display:\s*none;/);
  assert.match(css, /\.app-shell\[data-nav-layout="sidebar-bottom"\] \.sidebar-bottom-nav\s*\{[\s\S]*?left:\s*8px;[\s\S]*?bottom:\s*10px;[\s\S]*?display:\s*grid;[\s\S]*?width:\s*calc\(var\(--sidebar-width\) - 8px\);[\s\S]*?border-top:\s*1px solid var\(--line\);[\s\S]*?border-radius:\s*0 0 var\(--rail-corner-radius\) var\(--rail-corner-radius\);[\s\S]*?background:\s*color-mix\(in srgb, var\(--surface-layer\) 92%, transparent\);/);
  assert.match(css, /\.app-shell\[data-nav-layout="sidebar-bottom"\] \.sidebar-bottom-nav\s*\{[\s\S]*?padding:\s*6px 14px calc\(8px \+ env\(safe-area-inset-bottom\)\);/);
  assert.match(css, /\.sidebar-bottom-nav-button\s*\{[\s\S]*?grid-template-rows:\s*27px 10px;[\s\S]*?width:\s*100%;[\s\S]*?height:\s*42px;[\s\S]*?background:\s*transparent;[\s\S]*?cursor:\s*default;[\s\S]*?justify-self:\s*center;[\s\S]*?isolation:\s*isolate;/);
  assert.match(css, /\.sidebar-bottom-nav-button\.active\s*\{[\s\S]*?color:\s*var\(--accent\);/);
  assert.match(css, /\.sidebar-bottom-nav-button\.active::before\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?box-shadow:\s*none;[\s\S]*?opacity:\s*0;/);
  assert.match(css, /\.sidebar-bottom-icon\s*\{[\s\S]*?width:\s*25px;[\s\S]*?height:\s*25px;/);
  assert.match(css, /\.sidebar-bottom-label\s*\{[\s\S]*?font-size:\s*9px;[\s\S]*?font-weight:\s*430;[\s\S]*?white-space:\s*nowrap;/);
  assert.match(css, /\.sidebar-bottom-icon-regular,[\s\S]*?\.sidebar-bottom-icon-fill\s*\{[\s\S]*?fill:\s*currentColor;[\s\S]*?stroke:\s*none;/);
  assert.match(css, /\.sidebar-bottom-icon-fill\s*\{[\s\S]*?display:\s*none;/);
  assert.match(css, /\.sidebar-bottom-nav-button\.active \.sidebar-bottom-icon-regular\s*\{[\s\S]*?display:\s*none;/);
  assert.match(css, /\.sidebar-bottom-nav-button\.active \.sidebar-bottom-icon-fill\s*\{[\s\S]*?display:\s*block;/);
  assert.match(css, /\.sidebar-bottom-avatar-button\.active::before,[\s\S]*?\.sidebar-bottom-avatar-button\.active:hover::before\s*\{[\s\S]*?content:\s*none;[\s\S]*?display:\s*none;[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;[\s\S]*?box-shadow:\s*none;[\s\S]*?opacity:\s*0;/);
  assert.match(css, /\.sidebar-bottom-avatar\s*\{[\s\S]*?width:\s*30px !important;[\s\S]*?height:\s*30px !important;/);
  assert.match(css, /\.sidebar-bottom-avatar-button\.active \.sidebar-bottom-avatar::after\s*\{[\s\S]*?border:\s*1px solid var\(--accent\);[\s\S]*?box-shadow:\s*none;/);
  assert.match(css, /\.sidebar-bottom-avatar-button\.active \.sidebar-bottom-avatar\s*\{[\s\S]*?background:\s*transparent !important;[\s\S]*?background-image:\s*none !important;[\s\S]*?background-color:\s*transparent !important;/);
  assert.match(css, /\.sidebar-bottom-avatar-button\.active \.sidebar-bottom-avatar \.avatar-image,[\s\S]*?\.sidebar-bottom-avatar-button\.active \.sidebar-bottom-avatar \.avatar-video\s*\{[\s\S]*?inset:\s*3px;[\s\S]*?width:\s*calc\(100% - 6px\);[\s\S]*?height:\s*calc\(100% - 6px\);/);
  assert.match(css, /\.app-shell\[data-nav-layout="sidebar-bottom"\] \.explore-sidebar:not\(\.hidden\),[\s\S]*?\.app-shell\[data-nav-layout="sidebar-bottom"\] \.task-sidebar:not\(\.hidden\),[\s\S]*?\.app-shell\[data-nav-layout="sidebar-bottom"\] \.settings-sidebar:not\(\.hidden\)\s*\{[\s\S]*?display:\s*grid;/);
  assert.match(css, /\.explore-sidebar-tabs button,[\s\S]*?\.task-sidebar-tabs button,[\s\S]*?\.settings-sidebar-tabs \.settings-tab\s*\{[\s\S]*?cursor:\s*default;/);
  assert.match(css, /\.app-shell\[data-nav-layout="sidebar-bottom"\] \.contacts-sidebar\s*\{[\s\S]*?grid-template-rows:\s*auto auto minmax\(0,\s*1fr\);/);
  assert.match(css, /\.app-shell\[data-nav-layout="sidebar-bottom"\] \.sidebar-tools\s*\{[\s\S]*?min-height:\s*52px;[\s\S]*?padding:\s*9px 12px 8px;/);
  assert.match(css, /\.app-shell\[data-nav-layout="sidebar-bottom"\] \.conversation-sidebar \.sidebar-title\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?left:\s*78px;[\s\S]*?right:\s*78px;[\s\S]*?justify-content:\s*center;/);
  assert.match(css, /\.app-shell\[data-nav-layout="sidebar-bottom"\] \.explore-sidebar \.sidebar-title,[\s\S]*?\.app-shell\[data-nav-layout="sidebar-bottom"\] \.task-sidebar \.sidebar-title,[\s\S]*?\.app-shell\[data-nav-layout="sidebar-bottom"\] \.settings-sidebar \.sidebar-title\s*\{[\s\S]*?justify-self:\s*center;[\s\S]*?justify-content:\s*center;/);
  assert.match(css, /\.app-shell\[data-nav-layout="sidebar-bottom"\] #chatView,[\s\S]*?\.app-shell\[data-nav-layout="sidebar-bottom"\] #settingsView\s*\{[\s\S]*?grid-column:\s*2 \/ -1;/);
  assert.match(css, /\.app-shell\[data-nav-layout="sidebar-bottom"\] \.sidebar-resize-handle\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?left:\s*calc\(var\(--sidebar-width\) - 4px\);[\s\S]*?display:\s*block;/);
  assert.match(css, /\.app-shell\[data-nav-layout="sidebar-bottom"\] \.sidebar-resize-handle::before\s*\{[\s\S]*?display:\s*none;/);
  assert.match(css, /\.app-shell\[data-nav-layout="sidebar-bottom"\] \.settings-tabs\s*\{[\s\S]*?display:\s*none;/);
  assert.match(botStoreCss, /\.app-shell\[data-nav-layout="sidebar-bottom"\]\[data-active-view="contacts"\] \.contacts-explore-tabs\s*\{[\s\S]*?display:\s*grid;/);
  assert.match(botStoreCss, /\.app-shell\[data-nav-layout="sidebar-bottom"\]\[data-active-view="contacts"\] #contactsView,[\s\S]*?\.app-shell\[data-nav-layout="sidebar-bottom"\]\[data-active-view="bot-store"\] #botStoreView\s*\{[\s\S]*?grid-column:\s*2 \/ -1;/);
  assert.match(botStoreCss, /\.app-shell\[data-nav-layout="sidebar-bottom"\]\[data-active-view="contacts"\] #sidebarResizeHandle,[\s\S]*?\.app-shell\[data-nav-layout="sidebar-bottom"\]\[data-active-view="bot-store"\] #sidebarResizeHandle\s*\{[\s\S]*?display:\s*block;/);
  assert.match(botStoreCss, /\.app-shell\[data-nav-layout="sidebar-bottom"\]\[data-active-view="contacts"\] \.contacts-sidebar\s*\{[\s\S]*?margin:\s*8px 0 10px 8px;/);
  assert.match(css, /\.app-shell\[data-nav-layout="sidebar-bottom"\] \.conversation-sidebar,[\s\S]*?\.app-shell\[data-nav-layout="sidebar-bottom"\] \.settings-sidebar\s*\{[\s\S]*?margin:\s*8px 0 10px 8px;[\s\S]*?padding-bottom:\s*0;/);
  assert.match(css, /\.app-shell\[data-nav-layout="sidebar-bottom"\] \.persona-list\s*\{[\s\S]*?padding-bottom:\s*var\(--sidebar-bottom-nav-clearance\);/);
  assert.match(css, /\.app-shell\[data-nav-layout="sidebar-bottom"\] \.contact-list\s*\{[\s\S]*?padding-bottom:\s*var\(--sidebar-bottom-nav-clearance\);/);
  assert.match(css, /\.app-shell\[data-nav-layout="sidebar-bottom"\] \.explore-sidebar-section,[\s\S]*?\.app-shell\[data-nav-layout="sidebar-bottom"\] \.settings-sidebar-section\s*\{[\s\S]*?padding-bottom:\s*var\(--sidebar-bottom-nav-clearance\);/);
  assert.match(css, /\.app-shell\[data-nav-layout="sidebar-bottom"\] \.sidebar-resize-handle::before\s*\{[\s\S]*?display:\s*none;/);
  assert.match(css, /\.app-shell\[data-nav-layout="sidebar-bottom"\] \.sidebar-resize-handle\s*\{[\s\S]*?width:\s*8px;/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.app-shell\[data-nav-layout="sidebar-bottom"\],[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.app-shell\[data-nav-layout="sidebar-bottom"\] \.sidebar,[\s\S]*?\.app-shell\[data-nav-layout="sidebar-bottom"\] #settingsView\s*\{[\s\S]*?grid-column:\s*1 \/ -1;/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.app-shell\[data-nav-layout="sidebar-bottom"\]\[data-shell-layout="single"\]\[data-narrow-pane="content"\] \.sidebar\s*\{[\s\S]*?display:\s*none !important;/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.app-shell\[data-nav-layout="sidebar-bottom"\] \.sidebar-bottom-nav\s*\{[\s\S]*?left:\s*22px;[\s\S]*?right:\s*22px;[\s\S]*?width:\s*auto;[\s\S]*?max-width:\s*360px;[\s\S]*?border-radius:\s*999px;[\s\S]*?backdrop-filter:\s*blur\(28px\) saturate\(1\.42\) brightness\(1\.04\);[\s\S]*?transform:\s*none;/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.app-shell\[data-nav-layout="sidebar-bottom"\] \.sidebar-bottom-nav-button\s*\{[\s\S]*?width:\s*46px;[\s\S]*?height:\s*43px;/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.app-shell\[data-nav-layout="sidebar-bottom"\]\[data-active-view="settings"\] \.settings-layout\s*\{[\s\S]*?grid-template-rows:\s*auto minmax\(0,\s*1fr\);[\s\S]*?padding:\s*12px 22px 0;/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?body\.platform-darwin \.app-shell\[data-nav-layout="sidebar-bottom"\]\[data-active-view="settings"\] \.settings-layout\s*\{[\s\S]*?padding-top:\s*64px;/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.app-shell\[data-nav-layout="sidebar-bottom"\]\[data-active-view="settings"\] \.settings-tabs\s*\{[\s\S]*?display:\s*flex;[\s\S]*?justify-self:\s*center;[\s\S]*?width:\s*min\(100%,\s*820px\);[\s\S]*?border:\s*1px solid var\(--sidebar-bottom-nav-border\);[\s\S]*?background:[\s\S]*?var\(--sidebar-bottom-nav-bg\);[\s\S]*?backdrop-filter:\s*blur\(28px\) saturate\(1\.42\) brightness\(1\.04\);/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.app-shell\[data-nav-layout="sidebar-bottom"\]\[data-active-view="settings"\] \.settings-tabs-title\s*\{[\s\S]*?display:\s*none;/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.app-shell\[data-nav-layout="sidebar-bottom"\]\[data-active-view="settings"\] \.settings-content\s*\{[\s\S]*?padding:\s*16px 0 calc\(var\(--sidebar-bottom-nav-clearance\) \+ 20px\);[\s\S]*?background:\s*transparent;/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.app-shell\[data-nav-layout="sidebar-bottom"\]\[data-active-view="settings"\] \.settings-panel\s*\{[\s\S]*?margin-right:\s*auto;[\s\S]*?margin-left:\s*auto;/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.app-shell\[data-nav-layout="sidebar-bottom"\]\[data-active-view="chat"\]\[data-narrow-pane="content"\] \.sidebar-bottom-nav,[\s\S]*?\.app-shell\[data-nav-layout="sidebar-bottom"\]\[data-active-view="contacts"\]\[data-narrow-pane="content"\] \.sidebar-bottom-nav\s*\{[\s\S]*?display:\s*none;/);
  assert.match(css, /@media\s*\(max-width:\s*500px\)\s*\{[\s\S]*?\.nav-layout-settings-row\s*\{[\s\S]*?min-height:\s*126px;[\s\S]*?padding:\s*14px 16px 16px;[\s\S]*?\.nav-layout-choice-grid\s*\{[\s\S]*?gap:\s*14px;[\s\S]*?justify-self:\s*stretch;[\s\S]*?width:\s*100%;[\s\S]*?\.nav-layout-preview\s*\{[\s\S]*?height:\s*76px;/);
  assert.match(tasksCss, /\.app-shell\[data-nav-layout="sidebar-bottom"\]\[data-active-view="tasks"\] \.tasks-topbar-title\s*\{[\s\S]*?display:\s*none;/);
  assert.match(botStoreCss, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.app-shell\[data-nav-layout="sidebar-bottom"\]\[data-active-view="contacts"\] #contactsView,[\s\S]*?\.app-shell\[data-nav-layout="sidebar-bottom"\]\[data-active-view="bot-store"\] #botStoreView\s*\{[\s\S]*?grid-column:\s*1 \/ -1;/);
  assert.match(skillsCss, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.app-shell\[data-nav-layout="sidebar-bottom"\]\[data-active-view="skills"\] #skillsView,[\s\S]*?\.app-shell\[data-nav-layout="sidebar-bottom"\]\[data-active-view="skills"\] \.explore-sidebar\s*\{[\s\S]*?grid-column:\s*1 \/ -1;/);
  assert.match(tasksCss, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.app-shell\[data-nav-layout="sidebar-bottom"\]\[data-active-view="tasks"\] #tasksView,[\s\S]*?\.app-shell\[data-nav-layout="sidebar-bottom"\]\[data-active-view="tasks"\] \.task-sidebar\s*\{[\s\S]*?grid-column:\s*1 \/ -1;/);
});

test("narrow desktop shell collapses the expanded rail into one content column", () => {
  const css = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");
  const chatCss = fs.readFileSync(path.join(root, "src/renderer/styles/chat.css"), "utf8");

  assert.match(
    css,
    /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.app-shell,\s*\.app-shell\[data-layout="index-workspace"\],\s*\.app-shell\[data-layout="workspace"\],\s*\.app-shell\[data-shell-layout="single"\]\s*\{[\s\S]*?grid-template-columns:\s*var\(--rail-column-width\) 0 0 minmax\(0,\s*1fr\);/,
    "narrow layout must keep the desktop track count so the middle pane can animate closed"
  );
  assert.match(css, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.sidebar,\s*\.workspace\s*\{[\s\S]*?grid-column:\s*4 \/ -1;/);
  assert.match(css, /\.app-shell\[data-shell-layout="single"\]\[data-narrow-pane="content"\] \.sidebar\s*\{[\s\S]*?display:\s*none !important;/);
  assert.match(css, /\.app-shell\[data-shell-layout="single"\]\[data-narrow-pane="index"\] \.workspace\s*\{[\s\S]*?display:\s*none !important;/);
  assert.match(css, /@keyframes\s+miaPanePushIn\s*\{[\s\S]*?translateX\(26px\)/);
  assert.match(css, /@keyframes\s+miaPanePopIn\s*\{[\s\S]*?translateX\(-22px\)/);
  assert.match(css, /@keyframes\s+miaSidebarCollapseOut\s*\{[\s\S]*?translateX\(-10px\)/);
  assert.match(css, /\.app-shell\[data-responsive-transition="collapse"\] \.sidebar:not\(\.hidden\)\s*\{[\s\S]*?animation:\s*miaSidebarCollapseOut 190ms/);
  assert.match(css, /\.app-shell\[data-responsive-transition="expand"\] \.sidebar:not\(\.hidden\)\s*\{[\s\S]*?animation:\s*miaPanePopIn 190ms/);
  assert.match(css, /\.app-shell\[data-responsive-transition="collapse"\]\[data-shell-layout="single"\]\[data-narrow-pane="content"\] \.sidebar:not\(\.hidden\)\s*\{[\s\S]*?grid-column:\s*2;[\s\S]*?display:\s*grid !important;/);
  assert.match(css, /\.app-shell\[data-shell-layout="single"\]\[data-narrow-pane="content"\] \.workspace:not\(\.hidden\)\s*\{[\s\S]*?animation:\s*miaPanePushIn 190ms/);
  assert.match(css, /\.app-shell\[data-shell-layout="single"\]\[data-narrow-pane="index"\] \.sidebar:not\(\.hidden\)\s*\{[\s\S]*?animation:\s*miaPanePopIn 190ms/);
  assert.match(css, /\.app-shell\[data-shell-layout="single"\] \.persona\.active,[\s\S]*?\.app-shell\[data-shell-layout="single"\] \.contact-row\.active\s*\{[\s\S]*?background:\s*transparent;/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?#chatView\.workspace\s*\{[\s\S]*?grid-column:\s*4 \/ -1;[\s\S]*?margin:\s*0;[\s\S]*?border-radius:\s*0;/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?#chatView \.session-menu-wrap\s*\{[\s\S]*?display:\s*block;/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?#chatView \.top-actions\s*\{[\s\S]*?display:\s*flex;[\s\S]*?min-height:\s*38px;/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.composer\s*\{[\s\S]*?padding:\s*8px 12px 14px;/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.model-switcher\s*\{[\s\S]*?max-width:\s*112px;/);
  assert.match(chatCss, /\.bubble\s*\{[\s\S]*?max-width:\s*min\(calc\(100% - 32px\), 450px\);/);
  assert.match(chatCss, /\.message-stack\s*\{[\s\S]*?max-width:\s*min\(calc\(100% - 32px\), 450px\);/);
  assert.match(chatCss, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.bubble,\s*\.message-stack\s*\{[\s\S]*?max-width:\s*min\(calc\(100% - 24px\), 450px\);/);
  assert.match(chatCss, /@media\s*\(max-width:\s*520px\)\s*\{[\s\S]*?\.bubble,\s*\.message-stack\s*\{[\s\S]*?max-width:\s*min\(calc\(100% - 20px\), 450px\);/);
  assert.match(chatCss, /@media\s*\(max-width:\s*520px\)\s*\{[\s\S]*?\.message:not\(\.group-message\)\s+\.avatar\s*\{[\s\S]*?display:\s*none;/);
});

test("narrow navigation and composer send use static svg icons", () => {
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");

  assert.match(html, /class="narrow-back-icon"[\s\S]*?stroke-linecap="square"[\s\S]*?stroke-linejoin="miter"[\s\S]*?<path d="M15 18L9 12L15 6"/);
  assert.match(html, /class="send-icon"[\s\S]*?<path d="M3\.8 20\.2L21 12L3\.8 3\.8L6\.95 10\.85L14\.1 12L6\.95 13\.15L3\.8 20\.2Z" fill="currentColor"/);
  assert.doesNotMatch(html, /send-lottie/);
  assert.doesNotMatch(html, /data-lottie="send"/);
  assert.doesNotMatch(html, />‹</);
  assert.match(css, /\.narrow-back-button\s*\{[\s\S]*?font-size:\s*0;/);
  assert.match(css, /\.send-icon\s*\{[\s\S]*?width:\s*22px;[\s\S]*?height:\s*22px;/);
  assert.match(css, /\.send-button\.stop \.send-icon\s*\{[\s\S]*?display:\s*none;/);
});

test("chat composer floats on the chat floor instead of owning a bottom panel", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const styleSource = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");
  const chatStyleSource = fs.readFileSync(path.join(root, "src/renderer/styles/chat.css"), "utf8");

  assert.match(chatStyleSource, /\.chat-layout\s*\{[\s\S]*?grid-template-rows:\s*minmax\(0,\s*1fr\);[\s\S]*?position:\s*relative;/);
  assert.match(chatStyleSource, /--chat-header-overlay-height:\s*70px;/);
  assert.match(chatStyleSource, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.chat-layout\s*\{[\s\S]*?--chat-header-overlay-height:\s*48px;/);
  assert.match(chatStyleSource, /\.chat\s*\{[\s\S]*?padding:\s*calc\(var\(--chat-header-overlay-height\) \+ 12px\) 10px calc\(var\(--composer-overlay-height\) \+ 18px\);/);
  assert.match(chatStyleSource, /\.message\s*\{[\s\S]*?padding:\s*3px 2px;/);
  assert.match(styleSource, /\.composer\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?bottom:\s*0;[\s\S]*?background:\s*transparent;/);
  assert.match(appSource, /function syncComposerOverlayHeight\(\)/);
  assert.match(appSource, /new ResizeObserver\(schedule\)/);
  assert.match(appSource, /--composer-overlay-height/);
});

test("chat header is a floating card layer rather than a layout topbar", () => {
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const appStateSource = fs.readFileSync(path.join(root, "src/renderer/app-state.js"), "utf8");
  const styleSource = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");

  assert.match(html, /<div class="group-title">[\s\S]*?<button class="narrow-back-button"[\s\S]*?data-narrow-back[\s\S]*?<\/button>[\s\S]*?<div id="activeConversationMenuButton"[\s\S]*?role="button"[\s\S]*?aria-controls="chatConversationMenu"[\s\S]*?<div id="activeChatAvatar"/);
  assert.match(html, /<div id="chatConversationMenu" class="chat-conversation-menu hidden" role="listbox" aria-label="切换对话">[\s\S]*?<div id="chatConversationList" class="chat-conversation-list"><\/div>/);
  assert.match(appStateSource, /chatConversationMenuOpen:\s*false/);
  assert.match(appSource, /function renderChatConversationMenu\(rows = \[\], personas = \[\]\)/);
  assert.match(appSource, /let chatConversationMenuRenderSignature = "";/);
  assert.match(appSource, /function syncChatConversationMenuActiveState\(specs\)/);
  assert.match(appSource, /const compactConversationRows = cloudReady \? window\.miaBotManager\.sortMessageCardsForSidebar\(socialRows\) : \[\];[\s\S]*?renderChatConversationMenu\(compactConversationRows, personas\);/);
  assert.match(appSource, /const signature = safeRenderSignature\(\{\s*rows: compactSpecs\.map\(sidebarCardRenderSignature\)\s*\}\);/);
  assert.match(appSource, /if \(chatConversationMenuRenderSignature === signature\) \{[\s\S]*?syncChatConversationMenuActiveState\(compactSpecs\);[\s\S]*?return;/);
  assert.match(appSource, /state\.chatConversationMenuOpen = false;[\s\S]*?onClick\?\.\(\);/);
  assert.match(appSource, /els\.activeConversationMenuButton\?\.addEventListener\("click",[\s\S]*?state\.chatConversationMenuOpen = !state\.chatConversationMenuOpen;/);
  assert.match(styleSource, /#chatView\s*\{[\s\S]*?position:\s*relative;[\s\S]*?grid-template-rows:\s*minmax\(0,\s*1fr\);/);
  assert.match(styleSource, /#chatView \.topbar\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?top:\s*16px;[\s\S]*?background:\s*transparent;[\s\S]*?pointer-events:\s*none;/);
  assert.match(styleSource, /#chatView \.topbar > \*\s*\{[\s\S]*?pointer-events:\s*auto;/);
  assert.match(styleSource, /#chatView \.group-title\s*\{[\s\S]*?position:\s*relative;[\s\S]*?min-height:\s*38px;[\s\S]*?padding:\s*3px 12px 3px 5px;[\s\S]*?border-radius:\s*19px;[\s\S]*?background:\s*color-mix\(in srgb, var\(--surface\) 94%, transparent\);/);
  assert.match(styleSource, /\.active-conversation-menu-button\s*\{[\s\S]*?grid-template-columns:\s*32px minmax\(0,\s*1fr\);[\s\S]*?cursor:\s*default;[\s\S]*?-webkit-app-region:\s*no-drag;/);
  assert.match(styleSource, /\.chat-conversation-menu\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?top:\s*calc\(100% \+ 8px\);[\s\S]*?width:\s*min\(270px,\s*calc\(100vw - 86px\)\);[\s\S]*?background:\s*color-mix\(in srgb, var\(--surface\) 98%, #fff 2%\);[\s\S]*?backdrop-filter:\s*blur\(18px\) saturate\(1\.18\);[\s\S]*?animation:\s*chatConversationMenuIn[\s\S]*?-webkit-app-region:\s*no-drag;/);
  assert.match(styleSource, /\.chat-conversation-menu-row\.persona:hover:not\(\.active\)\s*\{[\s\S]*?background:\s*color-mix\(in srgb, var\(--text\) 8%, transparent\);/);
  assert.match(styleSource, /\.chat-conversation-menu-row\.persona\s*\{[\s\S]*?grid-template-columns:\s*34px minmax\(0,\s*1fr\);[\s\S]*?min-height:\s*44px;/);
  assert.match(styleSource, /#chatView \.group-title \.narrow-back-button\s*\{[\s\S]*?width:\s*32px;[\s\S]*?height:\s*32px;[\s\S]*?border-radius:\s*16px;/);
  assert.match(styleSource, /#chatView #activeChatAvatar\s*\{[\s\S]*?width:\s*32px;[\s\S]*?height:\s*32px;/);
  assert.match(styleSource, /#chatView \.group-title-copy\s*\{[\s\S]*?display:\s*grid;[\s\S]*?align-content:\s*center;[\s\S]*?gap:\s*0;/);
  assert.match(styleSource, /#chatView \.group-title h1\s*\{[\s\S]*?font-size:\s*14px;[\s\S]*?line-height:\s*17px;/);
  assert.match(styleSource, /#chatView \.topbar p\s*\{[\s\S]*?margin-top:\s*-1px;[\s\S]*?font-size:\s*11px;[\s\S]*?line-height:\s*13px;/);
  assert.match(styleSource, /#chatView \.top-actions\s*\{[\s\S]*?min-height:\s*38px;[\s\S]*?padding:\s*0;[\s\S]*?background:\s*transparent;/);
  assert.match(styleSource, /#chatView \.session-trigger\s*\{[\s\S]*?grid-template-columns:\s*16px minmax\(56px,\s*142px\);[\s\S]*?height:\s*38px;[\s\S]*?border-radius:\s*19px;[\s\S]*?background:\s*color-mix\(in srgb, var\(--surface\) 94%, transparent\);/);
  assert.match(styleSource, /\.session-trigger-icon\s*\{[\s\S]*?width:\s*16px;[\s\S]*?height:\s*16px;/);
  assert.match(styleSource, /\.session-menu\s*\{[\s\S]*?background:\s*var\(--surface\);[\s\S]*?-webkit-backdrop-filter:\s*none;[\s\S]*?backdrop-filter:\s*none;/);
  assert.match(styleSource, /:root\[data-theme="dark"\] \.session-menu\s*\{[\s\S]*?background:\s*var\(--surface\);/);
  assert.match(styleSource, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?#chatView \.topbar\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\) auto;[\s\S]*?min-height:\s*38px;[\s\S]*?padding:\s*0;[\s\S]*?background:\s*transparent;[\s\S]*?pointer-events:\s*none;/);
  assert.match(styleSource, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?body\.platform-darwin \.app-shell\[data-nav-layout="sidebar-bottom"\]\[data-shell-layout="single"\]\[data-narrow-pane="content"\] #chatView \.topbar\s*\{[\s\S]*?left:\s*86px;/);
  assert.match(styleSource, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?#chatView \.group-title\s*\{[\s\S]*?min-height:\s*38px;[\s\S]*?padding:\s*3px 10px 3px 4px;[\s\S]*?border-radius:\s*19px;[\s\S]*?background:\s*color-mix\(in srgb, var\(--surface\) 94%, transparent\);[\s\S]*?backdrop-filter:\s*blur\(24px\) saturate\(1\.14\);/);
  assert.match(styleSource, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?#chatView \.session-trigger\s*\{[\s\S]*?grid-template-columns:\s*16px minmax\(0,\s*82px\);[\s\S]*?height:\s*38px;[\s\S]*?max-width:\s*118px;[\s\S]*?border-radius:\s*19px;/);
  assert.match(styleSource, /@media\s*\(max-width:\s*520px\)\s*\{[\s\S]*?#chatView \.session-trigger\s*\{[\s\S]*?grid-template-columns:\s*16px;[\s\S]*?width:\s*38px;[\s\S]*?#chatView \.session-trigger \.current-session-title\s*\{[\s\S]*?display:\s*none;/);
});

test("session history trigger uses a compact icon pill", () => {
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const trigger = html.match(/<button id="sessionMenuButton"[\s\S]*?<\/button>/)?.[0] || "";

  assert.match(trigger, /title="会话记录"/);
  assert.match(trigger, /aria-label="会话记录"/);
  assert.match(trigger, /session-trigger-icon/);
  assert.match(trigger, /<svg viewBox="0 0 48 48"/);
  assert.match(trigger, /id="currentSessionTitle"/);
  assert.doesNotMatch(html, /聊天记录/);
});

test("chat scrollbar overlay stops at the composer top edge", () => {
  const scrollbarSource = fs.readFileSync(path.join(root, "src/renderer/helpers/scrollbar-overlay.js"), "utf8");

  assert.match(scrollbarSource, /function scrollbarOverlayTrackRect\(target\)/);
  assert.match(scrollbarSource, /target\.id === "chat"/);
  assert.match(scrollbarSource, /document\.querySelector\("#chatView \.composer-card"\)/);
  assert.match(scrollbarSource, /trackBottom = Math\.min\(trackBottom,\s*composerRect\.top\);/);
  assert.match(scrollbarSource, /trackRect\.height - trackInset \* 2/);
});

test("custom scrollbar overlay track stays on rounded right edge straights", () => {
  const scrollbarSource = fs.readFileSync(path.join(root, "src/renderer/helpers/scrollbar-overlay.js"), "utf8");

  class MockElement {
    constructor(rect, style = {}) {
      this.rect = rect;
      this.style = style;
      this.parentElement = null;
      this.id = "";
      this.scrollHeight = 1200;
      this.clientHeight = rect.height;
    }

    getBoundingClientRect() {
      return this.rect;
    }

    addEventListener() {}
  }

  const body = new MockElement({ top: 0, right: 500, bottom: 600, left: 0, width: 500, height: 600 });
  const documentElement = new MockElement({ top: 0, right: 500, bottom: 600, left: 0, width: 500, height: 600 });
  const shell = new MockElement(
    { top: 0, right: 500, bottom: 600, left: 0, width: 500, height: 600 },
    { borderTopRightRadius: "28px", borderBottomRightRadius: "28px", overflow: "hidden" }
  );
  const workspace = new MockElement(
    { top: 0, right: 498, bottom: 600, left: 0, width: 498, height: 600 },
    { borderTopRightRadius: "14px", borderBottomRightRadius: "14px", overflow: "hidden" }
  );
  const target = new MockElement(
    { top: 0, right: 498, bottom: 600, left: 0, width: 498, height: 600 },
    { overflowY: "auto" }
  );

  shell.parentElement = body;
  workspace.parentElement = shell;
  target.parentElement = workspace;

  const sandbox = {
    Element: MockElement,
    document: {
      body,
      documentElement,
      createElement: () => new MockElement({ top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 }),
      querySelector: () => null
    },
    window: {
      getComputedStyle: (element) => element.style || {},
      addEventListener() {},
      clearTimeout() {},
      setTimeout() { return 1; },
      requestAnimationFrame(callback) { callback(); return 1; }
    }
  };
  vm.runInNewContext(scrollbarSource, sandbox, { filename: "scrollbar-overlay.js" });

  const trackRect = sandbox.window.miaScrollbarOverlay.scrollbarOverlayTrackRect(target);

  assert.equal(trackRect.top, 28);
  assert.equal(trackRect.bottom, 572);
  assert.equal(trackRect.height, 544);
});

test("custom scrollbar overlay aligns the narrower thumb to the right edge", () => {
  const scrollbarSource = fs.readFileSync(path.join(root, "src/renderer/helpers/scrollbar-overlay.js"), "utf8");

  assert.match(scrollbarSource, /const thumbLeft = rect\.right - 8;/);
  assert.doesNotMatch(scrollbarSource, /const thumbLeft = rect\.right - 10;/);
});

test("custom scrollbar overlay appears on scroll, not pointer hover", () => {
  const scrollbarSource = fs.readFileSync(path.join(root, "src/renderer/helpers/scrollbar-overlay.js"), "utf8");

  class MockElement {
    constructor(rect, style = {}) {
      this.rect = rect;
      this.style = {};
      this.computedStyle = style;
      this.parentElement = null;
      this.children = [];
      this.id = "";
      this.isConnected = true;
      this.scrollHeight = 1200;
      this.clientHeight = rect.height;
      this.scrollTop = 0;
      this.className = "";
      this.classList = {
        add: (...names) => {
          const classes = new Set(String(this.className || "").split(/\s+/).filter(Boolean));
          for (const name of names) classes.add(name);
          this.className = Array.from(classes).join(" ");
        },
        remove: (...names) => {
          const remove = new Set(names);
          this.className = String(this.className || "").split(/\s+/).filter((name) => name && !remove.has(name)).join(" ");
        },
        contains: (name) => String(this.className || "").split(/\s+/).includes(name)
      };
    }

    getBoundingClientRect() { return this.rect; }
    addEventListener() {}
    appendChild(child) { this.children.push(child); child.parentElement = this; return child; }
    contains(node) { return node === this || this.children.includes(node); }
    matches() { return false; }
    closest(selector) {
      if (selector === ".hidden, [hidden]") return null;
      if (selector === ".sidebar" || selector === ".workspace" || selector === ".app-shell" || selector === ".sidebar-tag-filter-strip") return null;
      return null;
    }
  }

  const body = new MockElement({ top: 0, right: 420, bottom: 600, left: 0, width: 420, height: 600 });
  const documentElement = new MockElement({ top: 0, right: 420, bottom: 600, left: 0, width: 420, height: 600 });
  const target = new MockElement(
    { top: 0, right: 400, bottom: 600, left: 0, width: 400, height: 600 },
    { overflowY: "auto", display: "block", visibility: "visible" }
  );
  target.parentElement = body;

  const sandbox = {
    Element: MockElement,
    document: {
      body,
      documentElement,
      createElement: () => new MockElement({ top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 }),
      querySelector: () => null
    },
    window: {
      getComputedStyle: (element) => element.computedStyle || {},
      addEventListener() {},
      clearTimeout() {},
      setTimeout() { return 1; },
      requestAnimationFrame(callback) { callback(); return 1; }
    }
  };
  vm.runInNewContext(scrollbarSource, sandbox, { filename: "scrollbar-overlay.js" });

  sandbox.window.miaScrollbarOverlay.maybeShowScrollbarForPointer({
    target,
    clientX: 397
  });

  assert.equal(target.classList.contains("scrollbar-visible"), false);
  assert.equal(target.classList.contains("scrollbar-active"), false);
  assert.equal(sandbox.window.miaScrollbarOverlay.getScrollbarOverlayTarget(), null);

  sandbox.window.miaScrollbarOverlay.showScrollingScrollbar(target);

  assert.equal(target.classList.contains("scrollbar-visible"), true);
  assert.equal(target.classList.contains("scrollbar-active"), true);
  assert.strictEqual(sandbox.window.miaScrollbarOverlay.getScrollbarOverlayTarget(), target);
});

test("custom scrollbar overlay is invalidated when panes hide", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const scrollbarSource = fs.readFileSync(path.join(root, "src/renderer/helpers/scrollbar-overlay.js"), "utf8");

  assert.match(scrollbarSource, /function isScrollbarTargetUsable\(target\)/);
  assert.match(scrollbarSource, /target\.closest\("\.hidden, \[hidden\]"\)/);
  assert.doesNotMatch(scrollbarSource, /settings-closing/);
  assert.match(scrollbarSource, /shell\.dataset\.sidebarState === "collapsed" && target\.closest\("\.sidebar"\)/);
  assert.match(scrollbarSource, /shell\.dataset\.narrowPane === "content" && target\.closest\("\.sidebar"\)/);
  assert.match(scrollbarSource, /hideScrollbarOverlay\(target,\s*true\)/);
  assert.doesNotMatch(scrollbarSource, /target\.matches\(":hover"\)/);
  assert.doesNotMatch(appSource, /maybeShowScrollbarForPointer\(event\)/);
  assert.doesNotMatch(appSource, /cancelScrollbarHide\(target\);[\s\S]*?target\.classList\.add\("scrollbar-visible"\)/);
  assert.match(scrollbarSource, /new MutationObserver\(\(records\) => \{/);
  assert.match(scrollbarSource, /validateScrollbarOverlay/);
  assert.match(appSource, /window\.miaScrollbarOverlay\?\.validateScrollbarOverlay\?\.\(\);/);
});

test("sidebar active conversation color changes with a fast transition", () => {
  const css = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");

  assert.match(css, /\.persona\s*\{[\s\S]*?transition:\s*background 120ms cubic-bezier\(0\.2,\s*0\.7,\s*0\.2,\s*1\),\s*box-shadow 120ms cubic-bezier\(0\.2,\s*0\.7,\s*0\.2,\s*1\);/);
  assert.match(css, /\.persona-name,[\s\S]*?\.persona-key,[\s\S]*?\.persona-time,[\s\S]*?\.persona-pin\s*\{[\s\S]*?transition:\s*color 120ms cubic-bezier\(0\.2,\s*0\.7,\s*0\.2,\s*1\);/);
});

test("composer skill picker is a compact flat skill list", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const composerSource = fs.readFileSync(path.join(root, "src/renderer/chat/composer.js"), "utf8");
  const styleSource = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");

  assert.doesNotMatch(appSource, /data-skill-picker-plugin/);
  assert.doesNotMatch(composerSource, /data-skill-picker-plugin/);
  assert.doesNotMatch(composerSource, /skillPickerPluginId/);
  assert.match(styleSource, /\.skill-picker\s*\{[\s\S]*?width:\s*320px;[\s\S]*?min-width:\s*260px;/);
  assert.match(styleSource, /\.skill-picker-body\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);/);
  assert.match(styleSource, /\.skill-picker-plugins\s*\{[\s\S]*?display:\s*none;/);
  assert.match(styleSource, /\.skill-picker-skills\s*\{[\s\S]*?grid-template-rows:\s*minmax\(0,\s*1fr\);/);
  assert.match(styleSource, /@media\s*\(max-width:\s*860px\)\s*\{[\s\S]*?\.skill-picker\s*\{[\s\S]*?width:\s*min\(320px, calc\(100% - 16px\)\);/);
});

test("rail pages use one continuous workspace floor", () => {
  const baseCss = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");
  const chatCss = fs.readFileSync(path.join(root, "src/renderer/styles/chat.css"), "utf8");
  const skillsCss = fs.readFileSync(path.join(root, "src/renderer/styles/skills.css"), "utf8");
  const tasksCss = fs.readFileSync(path.join(root, "src/renderer/styles/tasks.css"), "utf8");
  const botStoreCss = fs.readFileSync(path.join(root, "src/renderer/styles/bot-store.css"), "utf8");

  assert.match(baseCss, /--workspace-floor:\s*#f0f0f3;/);
  assert.match(baseCss, /--workspace-floor-image:\s*none;/);
  assert.match(baseCss, /--chat-background:\s*var\(--workspace-floor\);/);
  assert.match(baseCss, /\.app-shell\s*\{[\s\S]*?background:\s*var\(--workspace-floor-image\),\s*var\(--workspace-floor\);[\s\S]*?background-size:\s*cover;[\s\S]*?background-position:\s*center;[\s\S]*?background-repeat:\s*no-repeat;/);
  assert.match(baseCss, /\.workspace\s*\{[\s\S]*?background:\s*transparent;/);
  assert.match(baseCss, /#chatView\s*\{[\s\S]*?background:\s*transparent;/);
  assert.match(baseCss, /\.topbar\s*\{[\s\S]*?background:\s*transparent;/);
  assert.match(baseCss, /\.contacts-layout\s*\{[\s\S]*?background:\s*transparent;/);
  assert.match(chatCss, /\.chat-layout\s*\{[\s\S]*?background:\s*transparent;/);
  assert.match(skillsCss, /\.skills-topbar\s*\{[\s\S]*?background:\s*transparent;/);
  assert.match(skillsCss, /\.skills-layout\s*\{[\s\S]*?background:\s*transparent;/);
  assert.match(tasksCss, /\.tasks-topbar\s*\{[\s\S]*?background:\s*transparent;/);
  assert.match(tasksCss, /\.tasks-layout\s*\{[\s\S]*?background:\s*transparent;/);
  assert.match(botStoreCss, /\.discover-top-bar[\s\S]*?background:\s*transparent;/);
  assert.match(botStoreCss, /\.bot-store-layout\s*\{[\s\S]*?background:\s*transparent;/);
});

test("custom select menu opens away from the viewport edge", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const positionSource = extractFunctionSource(appSource, "positionComposerSelectMenu");
  const sandbox = {
    window: {
      innerWidth: 500,
      innerHeight: 360
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(`${positionSource}; this.positionComposerSelectMenu = positionComposerSelectMenu;`, sandbox);

  const menu = {
    scrollWidth: 220,
    scrollHeight: 240,
    style: {},
    dataset: {}
  };
  const trigger = {
    getBoundingClientRect: () => ({
      left: 24,
      top: 314,
      bottom: 344,
      width: 160
    })
  };

  sandbox.positionComposerSelectMenu(menu, trigger);

  assert.equal(menu.dataset.placement, "above");
  assert.equal(menu.style.top, "");
  assert.equal(menu.style.bottom, "52px");
  assert.equal(menu.style.maxHeight, "300px");
});

test("main renderer does not initialize the removed onboarding wizard", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const indexHtml = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");

  assert.doesNotMatch(indexHtml, /onboarding-wizard\.js/);
  assert.doesNotMatch(appSource, /miaOnboardingWizard/);
  assert.match(appSource, /requestSignedOutOnboardingWindow/);
});

test("standalone onboarding completion marks onboarding done in the promoted main app", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  // Without this handoff, a first-run user is bounced into the legacy setup
  // guide right after finishing the standalone onboarding window.
  assert.match(mainSource, /onboarding:\s*"complete"/);
  assert.match(appSource, /get\("onboarding"\)\s*===\s*"complete"/);
  assert.match(appSource, /state\.onboardingStep = "done"/);
});

test("promoted onboarding window keeps native macOS traffic lights visible", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const promoteSource = extractFunctionSource(mainSource, "promoteOnboardingWindowToMain");

  assert.match(promoteSource, /setMacNativeControlsVisible\(win,\s*true\)/);
  assert.doesNotMatch(promoteSource, /setMacNativeControlsVisible\(win,\s*false\)/);
});

test("logged-in active pane never falls back to local bot sessions", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.match(appSource, /if\s*\(cloudSignedIn\)\s*\{\s*state\.activeKey = "";/);
  assert.match(appSource, /const active = cloudSignedIn\s*\?\s*null\s*:/);
  assert.match(appSource, /if\s*\(state\.runtime\?\.cloud\?\.enabled\)\s*\{[\s\S]*?els\.chat\.innerHTML = "";\s*return;\s*\}/);
  // Cloud-only: signed-out users leave the main renderer for the standalone onboarding window.
  assert.match(appSource, /requestSignedOutOnboardingWindow\(\);[\s\S]*?els\.chat\.innerHTML = "";/);
  assert.doesNotMatch(appSource, /function renderCloudLoginGuide/);
});

test("renderer chat uses setup guide and supports no-agent continuation", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const htmlSource = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const stylesSource = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");
  const noAgentGuideSource = appSource.slice(
    appSource.indexOf("function renderNoAgentGuide()"),
    appSource.indexOf("function renderChat()")
  );

  assert.match(appSource, /window\.miaSetupGuide\?\.shouldShowSetupGuide/);
  // Onboarding window sizing is centralized in setOnboardingWindow, which both
  // toggles the body class and drives the compact/main window size.
  assert.match(appSource, /setOnboardingWindow\(true\)/);
  assert.match(appSource, /setOnboardingWindow\(false\)/);
  assert.match(appSource, /classList\.toggle\("onboarding-window", on\)/);
  assert.match(appSource, /window\.mia\.window\?\.onboarding\?\.\(\)/);
  assert.match(appSource, /window\.miaLottieIcons\?\.init\?\.\(els\.chat\)/);
  assert.match(appSource, /renderNoAgentGuide/);
  assert.match(appSource, /finish-agent-scan/);
  assert.doesNotMatch(noAgentGuideSource, /data-action="cloud-login"/);
  assert.match(appSource, /AGENT_SETUP_SKIPPED_KEY/);
  assert.match(appSource, /engineRowOpenClaw/);
  assert.match(htmlSource, /id="engineRowOpenClaw"/);
  assert.match(htmlSource, /assets\/engine-icons\/hermesagent\.svg/);
  assert.match(htmlSource, /assets\/engine-icons\/claudecode\.svg/);
  assert.match(htmlSource, /assets\/engine-icons\/codex-color\.svg/);
  assert.match(htmlSource, /assets\/provider-icons\/openclaw-color\.svg/);
  assert.match(stylesSource, /engine-row-logo\.openclaw/);
  assert.match(stylesSource, /body\.onboarding-window \.setup-guide \{[\s\S]*?border:\s*0;/);
  assert.match(stylesSource, /body\.onboarding-window \.setup-guide \{[\s\S]*?-webkit-app-region:\s*drag;/);
  assert.match(stylesSource, /body\.onboarding-window \.setup-engine-row \{[\s\S]*?border:\s*0;/);
  assert.match(stylesSource, /body\.onboarding-window \.setup-engine-list[\s\S]*?-webkit-app-region:\s*no-drag;/);
  assert.match(stylesSource, /\.setup-scan-lottie/);
  assert.match(stylesSource, /body\.onboarding-window \.setup-engine-row \{[\s\S]*?grid-template-columns:\s*28px minmax\(0,\s*1fr\);/);
  assert.match(stylesSource, /\.setup-engine-row\.unavailable \{[\s\S]*?opacity:\s*1;/);
  assert.match(appSource, /setTimeout\(refreshRuntime,\s*120\)/);
});

test("chat rail icon keeps playback without the thicker forum animation asset", () => {
  const htmlSource = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const groupsIcon = JSON.parse(fs.readFileSync(path.join(root, "src/renderer/assets/lottie/groups.json"), "utf8"));

  const chatButton = htmlSource.match(/<button class="rail-button active"[\s\S]*?data-view="chat"[\s\S]*?<\/button>/)?.[0] || "";
  assert.match(chatButton, /data-lottie="chat"/);
  assert.match(chatButton, /class="rail-button-label"[^>]*>消息<\/span>/);
  assert.match(chatButton, /data-lottie-rest="60"/);
  assert.match(chatButton, /data-lottie-play="70,130"/);
  assert.doesNotMatch(chatButton, /data-lottie-trigger="static"/);
  assert.doesNotMatch(chatButton, /data-lottie="forum"/);

  const contactsButton = htmlSource.match(/<button class="rail-button"[\s\S]*?data-view="contacts"[\s\S]*?<\/button>/)?.[0] || "";
  assert.match(contactsButton, /data-lottie="groups"/);
  assert.match(contactsButton, /class="rail-button-label"[^>]*>联系人<\/span>/);
  assert.doesNotMatch(contactsButton, /data-lottie="contacts"/);
  assert.equal(groupsIcon.nm, "system-regular-96-groups");
  assert.deepEqual(groupsIcon.markers?.map((marker) => marker.cm), ["in-groups", "default:hover-groups", "morph-group-single"]);

  const skillsButton = htmlSource.match(/<button class="rail-button"[\s\S]*?data-view="skills"[\s\S]*?<\/button>/)?.[0] || "";
  assert.match(skillsButton, /title="技能"/);
  assert.match(skillsButton, /aria-label="技能"/);
  assert.match(skillsButton, /class="rail-button-label"[^>]*>技能<\/span>/);

  const tasksButton = htmlSource.match(/<button class="rail-button"[\s\S]*?data-view="tasks"[\s\S]*?<\/button>/)?.[0] || "";
  assert.match(tasksButton, /class="rail-button-label"[^>]*>任务<\/span>/);

  for (const name of ["groups", "extension", "checklist", "settings"]) {
    const pattern = new RegExp(`data-lottie="${name}"[^>]*data-lottie-rest="60"[^>]*data-lottie-play="70,130"`);
    assert.match(htmlSource, pattern, `${name} rail icon should keep its existing playback attributes`);
    assert.doesNotMatch(
      htmlSource.match(new RegExp(`<span class="rail-lottie"[^>]*data-lottie="${name}"[^>]*>`))?.[0] || "",
      /data-lottie-trigger="static"/,
      `${name} rail icon must not be made static with the chat icon`
    );
  }
});

test("lottie icons support autoplaying loop animations for scanning state", () => {
  const lottieSource = fs.readFileSync(path.join(root, "src/renderer/lottie-icons.js"), "utf8");

  assert.match(lottieSource, /triggerMode === "loop"/);
  assert.match(lottieSource, /loop:\s*entry\.triggerMode === "loop"/);
  assert.match(lottieSource, /autoplay:\s*entry\.triggerMode === "loop"/);
});

test("conversation tag editor is inline on the sidebar card and uses the label asset", () => {
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const socialSource = fs.readFileSync(path.join(root, "src/renderer/social/social.js"), "utf8");
  const markdownSource = fs.readFileSync(path.join(root, "src/renderer/helpers/markdown-helpers.js"), "utf8");
  const sidebarSource = fs.readFileSync(path.join(root, "src/renderer/sidebar-card-renderer.js"), "utf8");
  const stylesSource = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");
  const labelAsset = fs.readFileSync(path.join(root, "src/renderer/assets/lottie/label.json"), "utf8");

  assert.doesNotMatch(html, /social\/conversation-tags-dialog\.js/);
  assert.match(appSource, /editConversationTags\?\.\(conversation\.id,\s*name,\s*render,\s*\{ anchor: \{ x, y \} \}\)/);
  assert.match(appSource, /function focusedSidebarTagInput\(\)/);
  assert.match(appSource, /holdSidebarForTagInput/);
  assert.doesNotMatch(socialSource, /miaConversationTagsDialog/);
  assert.match(socialSource, /function conversationTagEditorFor\(conversationId\)/);
  assert.match(socialSource, /maxTags:\s*3/);
  assert.match(sidebarSource, /persona-tag-row/);
  assert.match(sidebarSource, /data-tag-input/);
  assert.match(sidebarSource, /data-tag-mode/);
  assert.match(sidebarSource, /data-tag-target-name/);
  assert.match(sidebarSource, /data-tag-suggestions/);
  assert.match(sidebarSource, /data-tag-menu/);
  assert.match(sidebarSource, /data-tag-pick/);
  assert.match(sidebarSource, /onCommit/);
  assert.match(sidebarSource, /tagCommitDetails/);
  assert.match(sidebarSource, /onOpenMenu/);
  assert.match(sidebarSource, /onDraft/);
  assert.match(html, /id="personaTagFilters"/);
  assert.match(html, /id="openPersonaSearch"/);
  assert.match(html, /id="openPersonaSearch"[^>]+hidden/);
  assert.match(html, /class="search-box conversation-search-box"/);
  assert.match(html, /class="search-box-label"[^>]*>搜索<\/span>/);
  assert.doesNotMatch(html, /搜索 \(⌘ \+ K\)/);
  assert.match(html, /id="personaSearch"[^>]+aria-label="搜索会话记录"/);
  assert.doesNotMatch(html, /class="search-box hidden"/);
  assert.match(html, /id="personaSearchClear"[^>]+title="关闭搜索"/);
  assert.match(html, /id="closePersonaSearch"[^>]+hidden/);
  assert.match(appSource, /function renderConversationSearchTools\(cloudReady\)/);
  assert.match(appSource, /searchBox\?\.classList\.toggle\("has-query", Boolean\(searchValue\)\);/);
  assert.match(appSource, /els\.personaSearchClear\?\.classList\.toggle\("hidden", !\(searchOpen \|\| searchValue\)\);/);
  assert.match(
    appSource,
    /els\.personaSearchClear\?\.addEventListener\("click",\s*\(event\)\s*=>\s*\{[\s\S]*?setPersonaSearchOpen\(false\);/,
    "conversation search close control should exit search mode instead of only clearing and refocusing"
  );
  assert.match(appSource, /function conversationRowsFromMessageSearch\(results,\s*query\)/);
  assert.match(appSource, /async function searchConversationMessages\(query,\s*limit = 80\)/);
  assert.match(appSource, /function isMissingSearchIpcHandlerError\(error\)/);
  assert.match(appSource, /function isRemoteSearchUnavailableEnvelope\(res\)/);
  assert.match(appSource, /not a member of this conversation/i);
  assert.match(appSource, /moduleState\?\.messageCache/);
  assert.match(appSource, /async function searchConversationMessagesViaExistingIpc\(query,\s*limit = 80\)/);
  assert.match(appSource, /searchResult:\s*true/);
  assert.match(appSource, /searchMessageId/);
  assert.match(appSource, /function setPersonaSearchOpen\(open/);
  assert.match(appSource, /personaSearchOpen/);
  assert.match(
    appSource,
    /els\.personaSearch\.addEventListener\("focus",\s*\(\)\s*=>\s*\{[\s\S]*?setPersonaSearchOpen\(true\);/,
    "focusing the always-visible conversation search field should enter the existing search-results mode"
  );
  assert.match(appSource, /data-sidebar-tag-filter/);
  assert.doesNotMatch(appSource, /data-sidebar-tag-clear/);
  assert.match(sidebarSource, /spec\.searchResult/);
  assert.match(sidebarSource, /search-result/);
  const focusoutBody = sidebarSource.match(/function handleTagInputFocusout\(btn, spec\) \{([\s\S]*?)\n  \}/)?.[1] || "";
  assert.doesNotMatch(focusoutBody, /onCancel/, "empty tag input blur should not collapse the editor");
  assert.doesNotMatch(sidebarSource, /data-tag-remove|showTagInput|hideTagInput/);
  assert.match(socialSource, /function startConversationTagRename\(conversationId,\s*name\)/);
  assert.match(socialSource, /function setConversationTagFilter\(name\)/);
  assert.match(socialSource, /function conversationTagFilters\(\)/);
  assert.match(socialSource, /function getConversationTagFilter\(\)/);
  assert.match(sidebarSource, /has-tags/);
  assert.match(sidebarSource, /document\.createElement\("div"\)/);
  assert.match(sidebarSource, /setAttribute\("role",\s*"button"\)/);
  assert.ok(!sidebarSource.includes("${tagChipsHtml(spec.tags)}${previewHtml"), "tags should render on their own row");
  assert.match(fs.readFileSync(path.join(root, "src/renderer/conversation-context-menu.js"), "utf8"), /openConversationTagMenu/);
  assert.match(stylesSource, /\.persona\.has-tags \.persona-main/);
  assert.match(stylesSource, /\.persona-tag-row/);
  assert.match(stylesSource, /\.persona-tag-suggestions/);
  assert.match(stylesSource, /\.persona-tag-input-wrap/);
  assert.match(stylesSource, /\.sidebar-tag-filters/);
  assert.match(stylesSource, /\.conversation-sidebar \.search-box:focus-within \.search-box-icon/);
  assert.match(stylesSource, /\.conversation-sidebar \.search-box:focus-within input/);
  assert.doesNotMatch(stylesSource, /\.sidebar-tools\.search-active \.sidebar-title-row,[\s\S]*?display:\s*none;/);
  assert.match(stylesSource, /\.sidebar-tag-filter\.active/);
  assert.match(stylesSource, /\.persona\.search-result/);
  assert.doesNotMatch(stylesSource, /\.sidebar-tag-filter-clear/);
  assert.match(stylesSource, /\.search-clear/);
  assert.match(html, /id="personaSearchClear"[\s\S]*?<svg viewBox="0 0 24 24"/);
  assert.match(html, /id="closePersonaSearch"[\s\S]*?<svg viewBox="0 0 24 24"/);
  assert.match(stylesSource, /@keyframes tagInputOpen/);
  assert.match(stylesSource, /@keyframes tagChipRemove/);
  assert.doesNotMatch(stylesSource, /\.persona-tag-add|\.persona-tag-remove-mark/);
  assert.doesNotMatch(stylesSource, /\.conversation-tags-popover/);
  assert.match(markdownSource, /tag:\s*\{ name:\s*"label"/);
  assert.match(labelAsset, /"nm":\s*"system-regular-146-label"/);
});

test("conversation tag filters render as persistent chat folder tabs", () => {
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const searchToolsSource = extractFunctionSource(appSource, "renderConversationSearchTools");
  const cardSignatureSource = extractFunctionSource(appSource, "sidebarCardRenderSignature");
  const tagFilterClickStart = appSource.indexOf('els.personaTagFilters?.addEventListener("click"');
  const tagFilterClickEnd = appSource.indexOf("els.contactSearch?.addEventListener", tagFilterClickStart);
  const tagFilterClickSource = appSource.slice(tagFilterClickStart, tagFilterClickEnd);

  assert.match(html, /id="personaTagFilters"[^>]+aria-label="对话分组"/);
  assert.match(appSource, /function sidebarAllConversationFilterHtml\(active\)/);
  assert.match(appSource, /CONVERSATION_FOLDER_ORDER_KEY = "mia\.conversationFolderOrder\.v1"/);
  assert.match(appSource, /function rememberConversationFolderMotion\(nextName\)/);
  assert.match(appSource, /function updateSidebarTagIndicator\(\)/);
  assert.match(appSource, /function syncSidebarTagFilterSelection\(activeName\)/);
  assert.match(appSource, /function orderedConversationFolderItems\(filters,\s*activeFilterName\)/);
  assert.match(appSource, /function conversationFolderItemStorageKey\(tag = \{\}\)/);
  assert.match(appSource, /function conversationFilterValue\(tag = \{\}\)/);
  assert.match(appSource, /function conversationFolderLabelForFilter\(filterValue\)/);
  assert.match(appSource, /function beginConversationFolderDrag\(event\)/);
  assert.match(appSource, /function saveConversationFolderDomOrder\(\)/);
  assert.match(appSource, /function conversationFolderTrack\(strip = null\)/);
  assert.match(appSource, /function setConversationFolderScrollLeft\(strip,\s*value\)/);
  assert.match(appSource, /function ensureActiveConversationFolderVisible\(options = \{\}\)/);
  assert.match(appSource, /function handleConversationFolderWheel\(event\)/);
  assert.match(appSource, /OTHER_DEVICE_CONVERSATION_FILTER/);
  assert.match(appSource, /conversationRunsOnOtherDevice\?\.\(row\?\.conversation\)/);
  assert.match(appSource, /function syncPersonaListActiveState\(specs\)/);
  assert.match(appSource, /function renderPersonaListIfChanged\(specs,\s*emptyText,\s*activeTagFilterName\)/);
  assert.doesNotMatch(cardSignatureSource, /active:\s*Boolean\(spec\?\.active\)/);
  assert.match(searchToolsSource, /const showFilters = cloudReady && \(filters\.length > 0 \|\| activeFilterName\);/);
  assert.match(searchToolsSource, /dataset\.renderSignature !== signature/);
  assert.match(searchToolsSource, /const folderItems = orderedConversationFolderItems\(filters,\s*activeFilterName\);/);
  assert.match(searchToolsSource, /sidebarAllConversationFilterHtml\(!activeFilterName\)/);
  assert.match(searchToolsSource, /role="tablist" aria-label="对话分组"/);
  assert.match(searchToolsSource, /folderItems\.map\(\(item\) => item\.type === "all" \? sidebarAllConversationFilterHtml\(!activeFilterName\) : sidebarTagFilterHtml\(item\.tag\)\)\.join\(""\)/);
  assert.match(searchToolsSource, /sidebar-tag-filter-indicator/);
  assert.match(searchToolsSource, /syncSidebarTagFilterSelection\(activeFilterName\);/);
  assert.match(appSource, /animatePersonaListFolderPage\(activeTagFilterName\);/);
  assert.match(appSource, /if \(personaListRenderSignature === signature\) \{[\s\S]*?syncPersonaListActiveState\(specs\);[\s\S]*?return;/);
  assert.match(appSource, /renderPersonaListIfChanged\(sidebarSpecs,\s*emptyText,\s*activeTagFilterName\);/);
  assert.match(appSource, /els\.personaTagFilters\?\.addEventListener\("pointerdown", beginConversationFolderDrag\);/);
  assert.match(appSource, /els\.personaTagFilters\?\.addEventListener\("wheel", handleConversationFolderWheel, \{ passive: false \}\);/);
  assert.match(appSource, /document\.addEventListener\("pointermove", moveConversationFolderDrag, \{ passive: false \}\);/);
  assert.match(appSource, /const x = active\.offsetLeft - conversationFolderScrollLeft\(strip\);/);
  assert.match(appSource, /const activeCenter = active\.offsetLeft \+ active\.offsetWidth \/ 2;/);
  assert.match(appSource, /let nextLeft = activeCenter - strip\.clientWidth \/ 2;/);
  assert.match(appSource, /track\.style\.setProperty\("--tag-scroll-x", `\$\{nextLeft\}px`\);/);
  assert.match(appSource, /syncSidebarTagFilterSelection\(activeFilterName\);\s*ensureActiveConversationFolderVisible\(\);\s*scheduleSidebarTagIndicator\(\);/);
  assert.match(appSource, /const primaryDelta = Math\.abs\(event\.deltaX\) > Math\.abs\(event\.deltaY\) \? event\.deltaX : event\.deltaY;/);
  assert.match(appSource, /event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*setConversationFolderScrollLeft\(strip,\s*conversationFolderScrollLeft\(strip\) \+ primaryDelta \* unit\);/);
  assert.match(searchToolsSource, /<div class="sidebar-tag-filter-track">[\s\S]*?<\/div>\s*<span class="sidebar-tag-filter-indicator" aria-hidden="true"><\/span>/);
  assert.match(appSource, /const filterValue = String\(tag\?\.filterValue \|\| name\)\.trim\(\);/);
  assert.match(appSource, /const folderKey = String\(tag\?\.storageKey \|\| conversationFolderStorageKey\(filterValue \|\| name\)\)\.trim\(\);/);
  assert.match(appSource, /data-tag-name="\$\{window\.miaMarkdown\.escapeHtml\(filterValue\)\}"/);
  assert.match(appSource, /data-folder-key="\$\{window\.miaMarkdown\.escapeHtml\(folderKey\)\}"/);
  assert.match(appSource, /const activeTagFilterLabel = conversationFolderLabelForFilter\(activeTagFilterName\);/);
  assert.match(appSource, /activeTagFilterLabel \? `「\$\{activeTagFilterLabel\}」分组暂无对话`/);
  assert.match(tagFilterClickSource, /const nextName = chip\.dataset\.tagName \|\| "";/);
  assert.match(tagFilterClickSource, /if \(conversationFolderSuppressClick\) return;/);
  assert.match(tagFilterClickSource, /if \(!rememberConversationFolderMotion\(nextName\)\) \{[\s\S]*?ensureActiveConversationFolderVisible\(\);[\s\S]*?return;[\s\S]*?\}/);
  assert.doesNotMatch(tagFilterClickSource, /personaSearchOpen\s*=\s*true/);
});

test("other-device bot conversations are hidden by default and exposed as a last folder tab only when non-empty", () => {
  const socialSource = fs.readFileSync(path.join(root, "src/renderer/social/social.js"), "utf8");
  const tagFiltersSource = extractFunctionSource(socialSource, "conversationTagFilters");

  assert.match(socialSource, /const OTHER_DEVICE_CONVERSATION_FILTER = "__mia_other_devices__"/);
  assert.match(socialSource, /const OTHER_DEVICE_CONVERSATION_LABEL = "其他设备"/);
  assert.match(socialSource, /function conversationRunsOnOtherDevice\(conversation = \{\}\)/);
  assert.match(socialSource, /global\.miaBotManager\?\.botRunsOnOtherDevice\?\.\(bot\)/);
  assert.match(socialSource, /function visibleSocialConversations\(conversations,\s*options = \{\}\)[\s\S]*?const otherDeviceOnly = isOtherDeviceConversationFilter\(filterName\);/);
  assert.match(socialSource, /function visibleSocialConversations\(conversations,\s*options = \{\}\)[\s\S]*?if \(otherDeviceOnly\) return otherDevice;/);
  assert.match(socialSource, /function visibleSocialConversations\(conversations,\s*options = \{\}\)[\s\S]*?if \(otherDevice && options\.includeOtherDevice !== true\) return false;/);
  assert.match(tagFiltersSource, /const otherDeviceCount = sessionHistoryShared\(\)\.sidebarConversations/);
  assert.match(tagFiltersSource, /if \(otherDeviceCount > 0\) \{[\s\S]*?tagFilters\.push\(\{/);
  assert.doesNotMatch(tagFiltersSource, /otherDeviceCount > 0 \|\| otherDeviceActive/);
  assert.match(tagFiltersSource, /name:\s*OTHER_DEVICE_CONVERSATION_LABEL/);
  assert.match(tagFiltersSource, /filterValue:\s*OTHER_DEVICE_CONVERSATION_FILTER/);
  assert.match(tagFiltersSource, /storageKey:\s*"other-devices"/);
  assert.match(socialSource, /OTHER_DEVICE_CONVERSATION_FILTER,[\s\S]*?OTHER_DEVICE_CONVERSATION_LABEL,[\s\S]*?initSocialModule/);
  assert.match(socialSource, /conversationTagsFor,[\s\S]*?conversationRunsOnOtherDevice,[\s\S]*?conversationTagFilters/);
});

test("desktop lottie badges can load local TGS assets in the renderer with a preload bridge fallback", () => {
  const channelSource = fs.readFileSync(path.join(root, "src/shared/ipc-channels.js"), "utf8");
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const preloadSource = fs.readFileSync(path.join(root, "src/preload.js"), "utf8");
  const lottieSource = fs.readFileSync(path.join(root, "src/renderer/lottie-icons.js"), "utf8");
  const nameBadgeSource = fs.readFileSync(path.join(root, "src/renderer/name-with-badge.js"), "utf8");

  assert.match(channelSource, /StatusBadgeAssetLoad:\s*"status-badge:asset-load"/);
  assert.match(preloadSource, /loadStatusBadgeAsset:\s*\(assetId\) => ipcRenderer\.invoke\(IpcChannel\.StatusBadgeAssetLoad, assetId\)/);
  assert.match(mainSource, /zlib\.gunzipSync\(raw\)/);
  assert.match(mainSource, /ipcMain\.handle\(IpcChannel\.StatusBadgeAssetLoad/);
  assert.match(lottieSource, /dataSet\.lottieFormat|dataset\.lottieFormat/);
  assert.match(lottieSource, /fetchTgsAnimationData/);
  assert.match(lottieSource, /fetch\(animationPath\)/);
  assert.match(lottieSource, /loadStatusBadgeAsset\(name\)/);
  assert.match(lottieSource, /shouldDeferMount/);
  assert.match(lottieSource, /addEventListener\("toggle"/);
  assert.doesNotMatch(lottieSource, /lottie-load-failed/);
  assert.match(nameBadgeSource, /miaStatusBadgeAssets/);
  assert.match(nameBadgeSource, /shouldUseLocalAsset/);
  assert.match(nameBadgeSource, /data-lottie-format", "tgs"/);
  assert.doesNotMatch(nameBadgeSource, /data-lottie-fallback/);
});

test("refreshRuntime bootstraps social when cloud status arrives after startup", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const refreshRuntime = extractFunctionSource(appSource, "refreshRuntime");
  const maybeBootstrap = extractFunctionSource(appSource, "maybeBootstrapSocialAfterRuntime");

  assert.match(refreshRuntime, /maybeBootstrapSocialAfterRuntime\(runtime\)/);
  assert.match(refreshRuntime, /renderBotRuntimeTargetSelect/);
  assert.match(maybeBootstrap, /runtime\?\.cloud\?\.enabled/);
  assert.match(maybeBootstrap, /window\.miaSocial\.isBootstrapped/);
  assert.match(maybeBootstrap, /socialBootstrapInFlight/);
  assert.match(maybeBootstrap, /window\.miaSocial\.bootstrapAfterLogin\(\)/);
});

test("first-run startup overlay is wired to the welcome Lottie animation", () => {
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.match(html, /<link rel="stylesheet" href="\.\/styles\/startup\.css">/);
  assert.match(html, /id="startupOverlay"/);
  assert.match(html, /class="startup-loader"/);
  assert.match(html, /data-lottie="welcome"/);
  assert.match(html, /data-lottie-trigger="loop"/);
  assert.match(html, /<script src="\.\/startup\/startup-overlay\.js"><\/script>[\s\S]*<script src="\.\/app\.js"><\/script>/);
  assert.match(appSource, /window\.miaStartupOverlay\?\.init\?\.\(\{ firstRun: agentSetupLaunch \}\)/);
  assert.match(appSource, /window\.miaStartupOverlay\?\.isBlocking\?\.\(\)/);
  assert.match(appSource, /trackStartupTask\("启动 Mia Core",\s*\(\) => window\.mia\.startupBackgroundServices\(\)\)/);
  assert.match(appSource, /window\.miaStartupOverlay\?\.setWelcome\?\.\(\)/);
  assert.match(appSource, /window\.miaStartupOverlay\?\.finish\?\.\(\)/);
});

test("renderer exposes official Hermes install actions without private install wording", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.match(appSource, /install-hermes/);
  assert.match(appSource, /repair-hermes/);
  assert.match(appSource, /retry-install-hermes/);
  assert.match(appSource, /runHermesSetupAction/);
});

test("bot dialogs use filled controls instead of legacy bordered fields", () => {
  const stylesSource = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");

  assert.match(stylesSource, /\.bot-form \{[\s\S]*?border:\s*0;/);
  assert.match(stylesSource, /\.pet-generate-card \{[\s\S]*?border:\s*0;/);
  assert.match(stylesSource, /\.bot-form input,[\s\S]*?\.pet-generate-card select \{[\s\S]*?border:\s*0;[\s\S]*?background-color:\s*var\(--field\);/);
  assert.match(stylesSource, /\.persona-details \{[\s\S]*?border:\s*0;[\s\S]*?background:\s*var\(--field\);/);
  assert.match(stylesSource, /\.avatar-drop \{[\s\S]*?border:\s*0;[\s\S]*?background:\s*var\(--field\);/);
  assert.match(stylesSource, /\.pet-reference-empty \{[\s\S]*?border:\s*0;[\s\S]*?background:\s*var\(--field\);/);
});

test("pet dialog consumes bot-named generation job fields", () => {
  const petDialogSource = fs.readFileSync(path.join(root, "src/renderer/bot/pet-dialog.js"), "utf8");

  assert.match(petDialogSource, /job\.botName \|\| job\.petId/);
  assert.doesNotMatch(petDialogSource, /job\[[\s\S]*?Name[\s\S]*?\]/);
  assert.doesNotMatch(petDialogSource, /fellow\s*\+|Fellow\s*\+|\[\s*["']fellow|\[\s*["']Fellow/);
});

test("pet dialog renderers skip work before dependency injection", () => {
  const petDialogSource = fs.readFileSync(path.join(root, "src/renderer/bot/pet-dialog.js"), "utf8");
  const sandbox = { window: {}, console };
  vm.runInNewContext(petDialogSource, sandbox, { filename: "pet-dialog.js" });

  assert.doesNotThrow(() => sandbox.window.miaPetDialog.renderPetGenerateDialog());
  assert.doesNotThrow(() => sandbox.window.miaPetDialog.renderPetJobs());
});

test("engine detection renderer preserves legacy runtime status fallbacks", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const renderSource = appSource.slice(
    appSource.indexOf("function agentInventoryById(runtime)"),
    appSource.indexOf("function renderSessionMenu()")
  );
  const sandbox = {
    els: {
      engineRowHermes: { textContent: "" },
      engineRowClaude: { textContent: "" },
      engineRowCodex: { textContent: "" },
      engineRowOpenClaw: { textContent: "" }
    }
  };
  vm.runInNewContext(`${renderSource}; this.renderEngineDetection = renderEngineDetection;`, sandbox);

  sandbox.renderEngineDetection({
    engineSource: "bundled",
    engineRunning: true,
    agentEngines: {
      claudeCode: { available: true, path: "/usr/local/bin/claude", version: "1.2.3 build" },
      codex: { available: true, path: "/usr/local/bin/codex", version: "4.5.6 build" },
      openClaw: { available: true, detectionOnly: true }
    }
  });

  assert.equal(sandbox.els.engineRowHermes.textContent, "已接入 Mia");
  assert.equal(sandbox.els.engineRowClaude.textContent, "/usr/local/bin/claude · 1.2.3 build");
  assert.equal(sandbox.els.engineRowCodex.textContent, "/usr/local/bin/codex · 4.5.6 build");
  assert.equal(sandbox.els.engineRowOpenClaw.textContent, "已就绪");

  sandbox.renderEngineDetection({
    engineSource: "managed",
    engineRunning: false,
    agentEngines: {}
  });

  assert.equal(sandbox.els.engineRowHermes.textContent, "已接入 Mia");

  sandbox.renderEngineDetection({
    engineSource: "local-source",
    engineRunning: true,
    agentEngines: {}
  });

  assert.equal(sandbox.els.engineRowHermes.textContent, "已接入 Mia");

  sandbox.renderEngineDetection({
    engineSource: "system",
    engineRunning: false,
    agentEngines: {}
  });

  assert.equal(sandbox.els.engineRowHermes.textContent, "已接入 Mia");

  sandbox.renderEngineDetection({
    engineInstalled: true,
    engineRunning: true,
    agentEngines: {}
  });

  assert.equal(sandbox.els.engineRowHermes.textContent, "已接入 Mia");
});

test("engine detection renderer surfaces install progress and failures in settings", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const renderSource = appSource.slice(
    appSource.indexOf("function agentInventoryById(runtime)"),
    appSource.indexOf("function renderSessionMenu()")
  );
  const sandbox = {
    state: {
      agentSetupInstallInFlight: true,
      agentSetupInstallEngine: "hermes",
      agentSetupInstallMessage: "Downloading Hermes runtime...",
      agentSetupInstallPercent: 42,
      agentSetupInstallErrors: {},
      hermesInstallError: ""
    },
    window: { miaMarkdown: { escapeHtml: (value) => String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;") } },
    els: {
      engineRowHermes: { textContent: "" },
      engineRowClaude: { textContent: "" },
      engineRowCodex: { textContent: "" },
      engineRowOpenClaw: { textContent: "" },
      engineRowHermesActions: { innerHTML: "" },
      engineRowClaudeActions: { innerHTML: "" },
      engineRowCodexActions: { innerHTML: "" },
      engineRowOpenClawActions: { innerHTML: "" },
      engineInstallActions: {
        classList: { add: () => {}, toggle: () => {} },
        innerHTML: ""
      }
    }
  };
  vm.runInNewContext(`${renderSource}; this.renderEngineDetection = renderEngineDetection;`, sandbox);

  const runtime = {
    agentInventory: {
      agents: [
        { id: "hermes", label: "Hermes", installed: false, usableInMia: false, installable: true, installAction: "install-hermes", health: "missing", source: "missing" }
      ]
    },
    agentEngines: {}
  };
  sandbox.renderEngineDetection(runtime);

  assert.equal(sandbox.els.engineRowHermes.textContent, "Downloading Hermes runtime...");
  assert.equal(sandbox.els.engineInstallActions.innerHTML, "");
  assert.match(sandbox.els.engineRowHermesActions.innerHTML, /disabled/);
  assert.match(sandbox.els.engineRowHermesActions.innerHTML, /42%/);

  sandbox.state.agentSetupInstallInFlight = false;
  sandbox.state.agentSetupInstallEngine = "";
  sandbox.state.agentSetupInstallErrors = { hermes: "官方 Hermes 安装失败：installer finished, but Mia still cannot detect Hermes" };
  sandbox.renderEngineDetection(runtime);

  assert.match(sandbox.els.engineRowHermes.textContent, /still cannot detect Hermes/);
});

test("signed-out desktop shell is a login gate without default Boss identity", () => {
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const styleSource = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");
  const avatarSource = fs.readFileSync(path.join(root, "src/renderer/helpers/avatar-helpers.js"), "utf8");
  const dialogSource = fs.readFileSync(path.join(root, "src/renderer/bot/bot-dialog.js"), "utf8");
  const settingsSource = fs.readFileSync(path.join(root, "src/main/settings-store.js"), "utf8");

  for (const source of [html, appSource, avatarSource, dialogSource, settingsSource]) {
    assert.doesNotMatch(source, /\bBoss\b/);
  }
  assert.match(html, /<main class="app-shell" data-auth-state="signed-out">/);
  assert.match(appSource, /function runtimeUserIdentity\(runtime = state\.runtime\)/);
  assert.match(appSource, /runtime\?\.cloud\?\.enabled[\s\S]*runtime\?\.cloud\?\.user/);
  assert.match(appSource, /setAttribute\("data-auth-state", cloudSignedIn \? "signed-in" : "signed-out"\)/);
  assert.match(styleSource, /\.app-shell\[data-auth-state="signed-out"\] \.nav-rail/);
  assert.match(styleSource, /\.app-shell\[data-auth-state="signed-out"\] \.composer/);
  assert.match(styleSource, /\.app-shell\[data-auth-state="signed-out"\] #chatView/);
});

test("desktop cloud bot conversations keep private AI composer controls visible", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.match(appSource, /activeCloudConversationType\s*===\s*"bot"/);
  assert.match(appSource, /composerBottom\.classList\.toggle\("hidden",\s*!showPrivateAiControls\)/);
  assert.doesNotMatch(appSource, /if\s*\(composerBottom\)\s*composerBottom\.classList\.add\("hidden"\);/);
});

test("desktop cloud bot conversations expose the restored chat history menu", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const socialSource = fs.readFileSync(path.join(root, "src/renderer/social/social.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const preloadSource = fs.readFileSync(path.join(root, "src/preload.js"), "utf8");
  const socialApiSource = fs.readFileSync(path.join(root, "src/main/social/social-api.js"), "utf8");
  const channelSource = fs.readFileSync(path.join(root, "src/shared/ipc-channels.js"), "utf8");

  assert.match(html, /packages\/shared\/session-history\.js/);
  assert.match(appSource, /const sessionHistory = \(typeof window !== "undefined" && window\.miaSessionHistory\)/);
  assert.match(appSource, /if \(els\.sessionMenuButton\) els\.sessionMenuButton\.classList\.remove\("hidden"\);/);
  assert.match(appSource, /function renderCloudConversationSessionMenu\(activeConversation\)/);
  assert.match(appSource, /sessionHistory\.sessionConversationsForConversation/);
  assert.match(appSource, /sessionHistory\.createBotSessionPayload/);
  assert.match(appSource, /sessionHistory\.botDisplayTitle/);
  assert.match(appSource, /function createNewCloudSessionForActive\(conversation\)/);
  assert.match(socialSource, /sessionHistoryShared\(\)\.sidebarConversations\(visibleSocialConversations\(moduleState\.conversations,\s*\{/);
  assert.match(channelSource, /SocialEnsureBotSessionConversation/);
  assert.doesNotMatch(channelSource, /SocialEnsureFellowSessionConversation/);
  assert.match(preloadSource, /ensureBotSessionConversation: \(sessionId, body\) => ipcRenderer\.invoke\(IpcChannel\.SocialEnsureBotSessionConversation, sessionId, body\)/);
  assert.doesNotMatch(preloadSource, /ensureFellowSessionConversation/);
  assert.match(socialApiSource, /async ensureBotSessionConversation\(sessionId, body = \{\}\)/);
  assert.doesNotMatch(socialApiSource, /ensureFellowSessionConversation/);
});

test("desktop renderer direct bot protocol branches do not key off legacy sender/member kinds", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const composerSource = fs.readFileSync(path.join(root, "src/renderer/chat/composer.js"), "utf8");
  const contactCardSource = fs.readFileSync(path.join(root, "src/renderer/social/contact-card.js"), "utf8");

  assert.match(contactCardSource, /kind === MemberKind\.Bot/);
  assert.doesNotMatch(contactCardSource, /kind === MemberKind\.Fellow\s*\?/);

  assert.match(composerSource, /member\.member_kind === MemberKind\.Bot/);
  assert.match(composerSource, /member\.member_kind === MemberKind\.Bot \? "Bot" : "User"/);
  assert.doesNotMatch(composerSource, /member\.member_kind === MemberKind\.Fellow \? "Fellow" : "User"/);

  assert.match(appSource, /message\.sender_kind === SenderKind\.Bot\s*\?\s*"assistant"/);
  assert.match(appSource, /const hasBot = msgs\.some\(\(message\) => message\.sender_kind === SenderKind\.Bot\)/);
  assert.doesNotMatch(appSource, /const hasFellow = msgs\.some\(\(message\) => message\.sender_kind === SenderKind\.Fellow\)/);
});

test("local assistant bubble avatars render with bot sender kind for contact cards", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const renderMessageHtml = eval(`(
    function () {
      const state = { runtime: { cloud: { user: { id: "user_me" } } }, tasks: [] };
      const ICON_PARK_PIN_SVG = "";
      const window = {
        miaMarkdown: {
          escapeHtml: (value) => String(value ?? ""),
          renderMarkdown: (value) => String(value ?? "")
        },
        miaAvatarResolve: {
          resolveAvatarForContact: (input) => ({ image: input.avatarImage || "", crop: input.avatarCrop || null, color: "#5e5ce6", text: input.displayName || input.id || "?" })
        },
        miaTraceBlocks: { renderTraceBlocks: () => "" },
        miaMessageHelpers: { replyQuoteHtml: () => "" },
        miaMessageMenu: { translationHtml: () => "" },
        miaAvatar: {
          avatarHtml: ({ attrs }) => '<span class="avatar message-avatar" ' + attrs + '></span>'
        }
      };
      function botAvatarIdentityId(ref) { return ref; }
      function formatRunTime() { return ""; }
      function renderMessageTime() { return ""; }
      function renderCommandResultHtml() { return ""; }
      function generatedAttachmentsForMessage() { return []; }
      function hydrateAttachmentPreview(value) { return value; }
      function renderAttachmentChips() { return ""; }
      function renderStandaloneAttachmentBlock(attachmentHtml = "", attrs = "") {
        if (!attachmentHtml) return "";
        const extraAttrs = String(attrs || "").trim();
        return attachmentHtml.replace(
          '<div class="message-attachments"',
          '<div class="message-attachments standalone"' + (extraAttrs ? " " + extraAttrs : "")
        );
      }
      ${extractFunctionSource(appSource, "renderMessageHtml")}
      return renderMessageHtml;
    }
  )()`);

  const html = renderMessageHtml(
    { role: "assistant", content: "hello", createdAt: "now" },
    { messageIndex: 0, user: { id: "user_me", displayName: "Me" }, persona: { key: "codex", name: "Codex" } }
  );

  assert.match(html, /data-sender-kind="bot"/);
  assert.doesNotMatch(html, /data-sender-kind="fellow"/);
});

test("local assistant attachments render after message text while user attachments stay before", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const renderMessageHtml = eval(`(
    function () {
      const state = { runtime: { cloud: { user: { id: "user_me" } } }, tasks: [] };
      const ICON_PARK_PIN_SVG = "";
      const window = {
        miaMarkdown: {
          escapeHtml: (value) => String(value ?? ""),
          renderMarkdown: (value) => String(value ?? "")
        },
        miaAvatarResolve: {
          resolveAvatarForContact: (input) => ({ image: input.avatarImage || "", crop: input.avatarCrop || null, color: "#5e5ce6", text: input.displayName || input.id || "?" })
        },
        miaTraceBlocks: { renderTraceBlocks: () => "" },
        miaMessageHelpers: { replyQuoteHtml: () => "" },
        miaMessageMenu: { translationHtml: () => "" },
        miaAvatar: {
          avatarHtml: ({ attrs }) => '<span class="avatar message-avatar" ' + attrs + '></span>'
        }
      };
      function botAvatarIdentityId(ref) { return ref; }
      function formatRunTime() { return ""; }
      function renderMessageTime() { return ""; }
      function renderCommandResultHtml() { return ""; }
      function generatedAttachmentsForMessage() { return []; }
      function hydrateAttachmentPreview(value) { return value; }
      function renderAttachmentChips(items = []) { return items.length ? '<div class="message-attachments">ATTACH</div>' : ""; }
      function renderStandaloneAttachmentBlock(attachmentHtml = "", attrs = "") {
        if (!attachmentHtml) return "";
        const extraAttrs = String(attrs || "").trim();
        return attachmentHtml.replace(
          '<div class="message-attachments"',
          '<div class="message-attachments standalone"' + (extraAttrs ? " " + extraAttrs : "")
        );
      }
      ${extractFunctionSource(appSource, "renderMessageHtml")}
      return renderMessageHtml;
    }
  )()`);

  const assistantHtml = renderMessageHtml(
    {
      role: "assistant",
      content: "assistant body",
      attachments: [{ name: "artifact.txt" }],
      createdAt: "now"
    },
    { messageIndex: 0, user: { id: "user_me", displayName: "Me" }, persona: { key: "codex", name: "Codex" } }
  );
  assert.ok(assistantHtml.indexOf("assistant body") < assistantHtml.indexOf("message-attachments"));

  const userHtml = renderMessageHtml(
    {
      role: "user",
      content: "user body",
      attachments: [{ name: "note.txt" }],
      createdAt: "now"
    },
    { messageIndex: 1, user: { id: "user_me", displayName: "Me" }, persona: { key: "codex", name: "Codex" } }
  );
  assert.ok(userHtml.indexOf("message-attachments") < userHtml.indexOf("user body"));

  const attachmentOnlyHtml = renderMessageHtml(
    {
      role: "assistant",
      content: "",
      attachments: [{ name: "artifact.txt" }],
      createdAt: "later"
    },
    { messageIndex: 2, user: { id: "user_me", displayName: "Me" }, persona: { key: "codex", name: "Codex" } }
  );
  assert.match(attachmentOnlyHtml, /class="message-attachments standalone" data-message-index="2"/);
  assert.doesNotMatch(attachmentOnlyHtml, /<div class="bubble/);
});

test("desktop attachment chips render non-image files as typed attachment cards", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const chatCss = fs.readFileSync(path.join(root, "src/renderer", "styles", "chat.css"), "utf8");
  assert.match(appSource, /function renderAttachmentFileIcon\(attachment = \{\}, assetRoot = "\.\/assets\/file-type-icons"\)/);
  assert.match(appSource, /class="message-attachment file-card type-\$\{window\.miaMarkdown\.escapeHtml\(window\.miaFormat\.attachmentVisualType\(attachment\)\)\}"/);
  assert.match(appSource, /data-local-file-path="\$\{window\.miaMarkdown\.escapeHtml\(attachment\.path \|\| ""\)\}"/);
  assert.match(appSource, /data-download-href="\$\{window\.miaMarkdown\.escapeHtml\(href\)\}"/);
  assert.match(appSource, /data-download-name="\$\{window\.miaMarkdown\.escapeHtml\(attachment\.name \|\| "attachment"\)\}"/);
  assert.match(appSource, /class="message-attachment-icon-image"/);
  assert.match(appSource, /src="\$\{window\.miaMarkdown\.escapeHtml\(assetRoot\)\}\/\$\{window\.miaMarkdown\.escapeHtml\(window\.miaFormat\.attachmentIconName\(attachment\)\)\}\.png"/);
  assert.match(appSource, /class="message-attachment-meta"/);
  assert.match(chatCss, /\.message-attachment\.file-card\s*\{[\s\S]*background:\s*rgba\(37,\s*42,\s*51,\s*0\.34\)/);
  assert.match(chatCss, /\.message-attachment\.file-card\s*\{[\s\S]*backdrop-filter:\s*blur\(10px\)\s+saturate\(125%\)/);
  assert.doesNotMatch(chatCss, /--message-attachment-accent:\s*#f06a35/);
});

test("desktop chat context menu can target standalone attachment carriers", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  assert.match(appSource, /closest\("\.bubble\[data-message-index\], \.message-attachments\[data-message-index\]"\)/);
  assert.match(appSource, /const attachmentEl = event\.target\.closest\("\.message-attachment"\);/);
  assert.match(appSource, /openAttachmentContextMenu\(attachmentEl,\s*event\.clientX,\s*event\.clientY\)/);
  assert.match(appSource, /label:\s*"下载"/);
  assert.match(appSource, /label:\s*"打开文件夹"/);
  assert.match(appSource, /window\.mia\?\.revealLocalFile\?\.\(/);
});

test("desktop attachment clicks open the same menu as right click", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  assert.match(appSource, /const fileCard = event\.target\.closest\("\.message-attachment\.file-card"\);/);
  assert.match(appSource, /if \(fileCard && els\.chat\.contains\(fileCard\)\) \{/);
  assert.match(appSource, /openAttachmentContextMenu\(fileCard,\s*event\.clientX,\s*event\.clientY\)/);
  assert.doesNotMatch(appSource, /if \(fileCard\.dataset\.localFilePath\) \{[\s\S]*window\.mia\?\.openLocalFile\?\.\(fileCard\.dataset\.localFilePath\)/);
});

test("desktop attachment downloads save cloud files locally before later opens", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.match(appSource, /function attachmentCloudFileUrl\(attachmentEl\)/);
  assert.match(appSource, /window\.mia\?\.saveAttachment\?\.\(\{/);
  assert.match(appSource, /url:\s*attachmentCloudFileUrl\(attachmentEl\)/);
  assert.match(appSource, /attachmentEl\.dataset\.localFilePath = saved\.path/);
  assert.match(appSource, /state\.generatedFiles\.set\(cloudUrl,\s*\{\s*status:\s*"ready",\s*attachment:\s*\{\s*\.\.\.saved,\s*url:\s*cloudUrl\s*\}\s*\}\)/);
  assert.match(appSource, /if \(action === "download"\) \{[\s\S]*await downloadAttachmentFromElement\(attachmentEl\);/);
});

test("composer attachment tray is inside the composer card before the input row", () => {
  const htmlSource = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const cardIndex = htmlSource.indexOf('<div class="composer-card">');
  const attachmentsIndex = htmlSource.indexOf('id="composerAttachments"');
  const topRowIndex = htmlSource.indexOf('<div class="composer-top-row">');

  assert.ok(cardIndex >= 0, "composer card exists");
  assert.ok(attachmentsIndex >= 0, "composer attachment tray exists");
  assert.ok(topRowIndex >= 0, "composer top row exists");
  assert.ok(cardIndex < attachmentsIndex, "attachment tray is inside composer card");
  assert.ok(attachmentsIndex < topRowIndex, "attachment tray appears above the input row");
});

test("local assistant messages render ordered content blocks before trace fallback", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const renderMessageHtml = eval(`(
    function () {
      const state = { runtime: { cloud: { user: { id: "user_me" } } }, tasks: [] };
      const ICON_PARK_PIN_SVG = "";
      const window = {
        miaMarkdown: {
          escapeHtml: (value) => String(value ?? ""),
          renderMarkdown: (value) => String(value ?? "")
        },
        miaAvatarResolve: {
          resolveAvatarForContact: (input) => ({ image: input.avatarImage || "", crop: input.avatarCrop || null, color: "#5e5ce6", text: input.displayName || input.id || "?" })
        },
        miaTraceBlocks: {
          renderAssistantContentBlocks({ blocks, renderTextBlock }) {
            return blocks.map((block) => {
              if (block.type === "text") return renderTextBlock(block);
              if (block.type === "thinking") return '<div class="ordered-thinking">' + block.text + '</div>';
              if (block.type === "tool") return '<div class="ordered-tool">' + block.name + '</div>';
              return "";
            }).join("");
          },
          renderTraceBlocks: () => '<div class="legacy-trace">legacy</div>'
        },
        miaAssistantContentBlocks: require("../src/shared/assistant-content-blocks.js"),
        miaMessageHelpers: { replyQuoteHtml: () => "" },
        miaMessageMenu: { translationHtml: () => "" },
        miaAvatar: {
          avatarHtml: ({ attrs }) => '<span class="avatar message-avatar" ' + attrs + '></span>'
        }
      };
      function botAvatarIdentityId(ref) { return ref; }
      function formatRunTime() { return ""; }
      function renderMessageTime() { return ""; }
      function renderCommandResultHtml() { return ""; }
      function generatedAttachmentsForMessage() { return []; }
      function hydrateAttachmentPreview(value) { return value; }
      function renderAttachmentChips(items = []) { return items.length ? '<div class="message-attachments">ATTACH</div>' : ""; }
      function renderStandaloneAttachmentBlock(attachmentHtml = "", attrs = "") {
        if (!attachmentHtml) return "";
        const extraAttrs = String(attrs || "").trim();
        return attachmentHtml.replace(
          '<div class="message-attachments"',
          '<div class="message-attachments standalone"' + (extraAttrs ? " " + extraAttrs : "")
        );
      }
      ${extractFunctionSource(appSource, "renderMessageHtml")}
      return renderMessageHtml;
    }
  )()`);

  const html = renderMessageHtml(
    {
      role: "assistant",
      content: "我先看目录。\n\n结论是已确认。",
      attachments: [{ name: "artifact.txt" }],
      reasoning: "legacy",
      tools: [{ name: "legacy-tool", status: "completed" }],
      contentBlocks: [
        { type: "thinking", id: "think_1", text: "检查上下文", status: "completed" },
        { type: "text", id: "text_1", text: "我先看目录。" },
        { type: "tool", id: "tool_1", name: "shell", preview: "pwd", status: "completed" },
        { type: "text", id: "text_2", text: "结论是已确认。" }
      ],
      createdAt: "now"
    },
    { messageIndex: 0, user: { id: "user_me", displayName: "Me" }, persona: { key: "codex", name: "Codex" } }
  );

  assert.ok(html.indexOf("检查上下文") < html.indexOf("我先看目录。"));
  assert.ok(html.indexOf("我先看目录。") < html.indexOf("shell"));
  assert.ok(html.indexOf("shell") < html.indexOf("结论是已确认。"));
  assert.ok(html.indexOf("结论是已确认。") < html.indexOf("message-attachments"));
  assert.doesNotMatch(html, /legacy-trace/);
  assert.doesNotMatch(html, /legacy-tool/);

  const legacyHtml = renderMessageHtml(
    {
      role: "assistant",
      content: "最终结论。",
      contentBlocks: [
        { type: "text", id: "text_1", text: "我先检查。" },
        { type: "tool", id: "tool_1", name: "shell", preview: "pwd", status: "completed" }
      ],
      createdAt: "later"
    },
    { messageIndex: 1, user: { id: "user_me", displayName: "Me" }, persona: { key: "codex", name: "Codex" } }
  );

  assert.ok(legacyHtml.indexOf("我先检查。") < legacyHtml.indexOf("shell"));
  assert.ok(legacyHtml.indexOf("shell") < legacyHtml.indexOf("最终结论。"));
});

test("sidebar card specs carry identity status badges when available", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const conversationCardSpecFromRow = eval(`(
    function () {
      const state = {};
      const MemberKind = { Bot: "bot" };
      const runByConversation = new Map([
        ["botc_u_me_mia", { status: "running", botId: "mia" }],
        ["g_badge", { status: "running", botId: "mia" }]
      ]);
      const window = {
        miaSocial: {
          getActiveConversationId: () => "",
          isConversationPinned: () => false,
          isConversationMuted: () => false,
          getUnreadForConversation: () => 0,
          conversationRun: (conversationId) => runByConversation.get(conversationId) || null,
          getConversationMembers: () => [{ member_kind: "bot", member_ref: "mia", bot_name: "Mia" }],
          setActiveConversationId() {}
        },
        miaContact: {
          IdentityKind: { Bot: "bot" },
          resolveContact: () => ({ avatar: {} })
        },
        miaAvatarResolve: { resolveAvatarForContact: () => ({}) },
        miaConversationContextMenu: {
          openPrivateConversationMenu() {},
          openGroupConversationMenu() {}
        },
        miaGroupTiles: { resolveGroupMemberTiles: () => [] }
      };
      const sessionHistory = {
        botId: (conversation) => conversation.decorations?.botId || "mia",
        botDisplayTitle: () => "Mia"
      };
      const ownedBots = [{ kind: "bot", key: "mia", id: "mia", name: "Mia", displayName: "Mia", statusBadge: { kind: "emoji", emoji: "⭐", label: "Premium" } }];
      function allOwnedBotsForIdentity() { return ownedBots; }
      function botAvatarIdentityId() { return "bot_global"; }
      function botMemberForConversation() { return null; }
      function botAvatarForConversation() { return {}; }
      function formatConversationTime() { return ""; }
      function groupTilesCtx() { return {}; }
      function showNarrowContent() {}
      function render() {}
      function conversationRunForSidebarPreview(social, conversation) {
        const run = social?.conversationRun?.(conversation?.id);
        return run?.status === "running" ? run : null;
      }
      function typingLabelForConversationRun(social, conversation, run = null) {
        const activeRun = run || conversationRunForSidebarPreview(social, conversation);
        const botId = activeRun?.botId || "";
        if (!botId || conversation?.type !== "group") return "";
        const member = (social?.getConversationMembers?.(conversation.id) || [])
          .find((m) => m.member_kind === MemberKind.Bot && m.member_ref === botId);
        return member?.bot_name || botId;
      }
      ${extractFunctionSource(appSource, "firstNonEmpty")}
      ${extractFunctionSource(appSource, "hasOwn")}
      ${extractFunctionSource(appSource, "statusBadgeFrom")}
      ${extractFunctionSource(appSource, "nameBadgeIdentity")}
      ${extractFunctionSource(appSource, "conversationCardSpecFromRow")}
      return conversationCardSpecFromRow;
    }
  )()`);
  const badge = { kind: "emoji", emoji: "⭐", label: "Premium" };

  const privateSpec = conversationCardSpecFromRow({
    type: "private-conversation",
    updatedAt: "",
    conversation: { id: "botc_u_me_mia", type: "bot", name: "Mia", decorations: { botId: "mia" } }
  }, []);
  const groupSpec = conversationCardSpecFromRow({
    type: "group-conversation",
    updatedAt: "",
    conversation: { id: "g_badge", type: "group", name: "Squad", statusBadge: badge }
  }, []);

  assert.equal(privateSpec.identity.kind, "bot");
  assert.equal(privateSpec.identity.id, "mia");
  assert.equal(privateSpec.identity.displayName, "Mia");
  assert.deepEqual(privateSpec.statusBadge, badge);
  assert.equal(privateSpec.typing, true);
  assert.equal(privateSpec.typingLabel, "");
  assert.deepEqual(groupSpec.statusBadge, badge);
  assert.equal(groupSpec.typing, true);
  assert.equal(groupSpec.typingLabel, "Mia");
});

test("bot private conversation delete uses the bot delete path", async () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const harness = eval(`(
    function () {
      const state = {};
      const calls = [];
      let privateActions = null;
      const window = {
        miaSocial: {
          getActiveConversationId: () => "",
          isConversationPinned: () => false,
          isConversationMuted: () => false,
          getUnreadForConversation: () => 0,
          conversationRun: () => null,
          getConversationMembers: () => [{ member_kind: "bot", member_ref: "mia", bot_name: "Mia" }],
          setActiveConversationId() {},
          setConversationPinned() {},
          setConversationManuallyUnread() {},
          markConversationRead() {},
          setConversationMuted() {},
          deleteCloudConversation: async (conversationId) => {
            calls.push(["deleteConversation", conversationId]);
            return { ok: true };
          }
        },
        miaContact: {
          IdentityKind: { Bot: "bot" },
          resolveContact: () => ({ avatar: {} })
        },
        miaAvatarResolve: { resolveAvatarForContact: () => ({}) },
        miaConversationContextMenu: {
          openPrivateConversationMenu(meta, actions) {
            calls.push(["menu", meta.id]);
            privateActions = actions;
          },
          openGroupConversationMenu() {}
        },
        miaGroupTiles: { resolveGroupMemberTiles: () => [] }
      };
      const sessionHistory = {
        botId: (conversation) => conversation.decorations?.botId || "mia",
        botDisplayTitle: () => "Mia"
      };
      const ownedBots = [{ kind: "bot", key: "mia", id: "mia", name: "Mia", displayName: "Mia" }];
      function allOwnedBotsForIdentity() { return ownedBots; }
      function botAvatarIdentityId() { return "bot_global"; }
      function botMemberForConversation() { return null; }
      function botAvatarForConversation() { return {}; }
      function formatConversationTime() { return ""; }
      function groupTilesCtx() { return {}; }
      function showNarrowContent() {}
      function render() {}
      function openEditBotDialog() {}
      function openConversationSearchResult() { return false; }
      function confirm() { calls.push(["confirm"]); return true; }
      function alert(message) { calls.push(["alert", message]); }
      async function deleteBot(botKey) {
        calls.push(["deleteBot", botKey]);
        return { ok: true };
      }
      function conversationRunForSidebarPreview(social, conversation) {
        const run = social?.conversationRun?.(conversation?.id);
        return run?.status === "running" ? run : null;
      }
      function typingLabelForConversationRun() { return ""; }
      ${extractFunctionSource(appSource, "firstNonEmpty")}
      ${extractFunctionSource(appSource, "hasOwn")}
      ${extractFunctionSource(appSource, "statusBadgeFrom")}
      ${extractFunctionSource(appSource, "nameBadgeIdentity")}
      ${extractFunctionSource(appSource, "conversationCardSpecFromRow")}
      return { conversationCardSpecFromRow, calls, getPrivateActions: () => privateActions };
    }
  )()`);

  const spec = harness.conversationCardSpecFromRow({
    type: "private-conversation",
    updatedAt: "",
    conversation: { id: "botc_u_me_mia", type: "bot", name: "Mia", decorations: { botId: "mia" } }
  }, []);
  spec.onContextMenu(12, 34);
  await harness.getPrivateActions().remove();

  assert.deepEqual(harness.calls.filter(([kind]) => kind === "deleteBot"), [["deleteBot", "mia"]]);
  assert.equal(harness.calls.some(([kind]) => kind === "deleteConversation"), false);
});

test("desktop cloud human and group conversations hide the chat history session selector", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.match(appSource, /const activeIsGroup = activeCloudConversationType === "group";/);
  assert.match(appSource, /const activeIsHumanDm = activeCloudConversationType === "dm";/);
  assert.match(appSource, /const hideSessionSelector = activeIsGroup \|\| activeIsHumanDm;/);
  assert.match(appSource, /if \(hideSessionSelector\) state\.sessionMenuOpen = false;/);
  assert.match(appSource, /sessionMenuButton\.classList\.toggle\("hidden",\s*hideSessionSelector\)/);
});

test("active chat meta text helper clears stale typing rich text even when slot value is unchanged", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const helperStart = appSource.indexOf("function animatedTextOptions");
  const helperEnd = appSource.indexOf("function flashAnimatedText");
  const setTextStart = appSource.indexOf("function setText");
  const setTextEnd = appSource.indexOf("function firstNonEmpty");
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "animated text helper block should be extractable");
  assert.ok(setTextStart >= 0 && setTextEnd > setTextStart, "setText helper should be extractable");
  const context = vm.createContext({
    window: {
      miaSlotText: {
        set(el, value) {
          const text = String(value ?? "");
          if (el.dataset?.slotTextValue === text) return;
          el.textContent = text;
          el.dataset.slotTextValue = text;
        },
        destroy(el) {
          delete el.dataset.slotTextValue;
        }
      }
    }
  });
  vm.runInContext(`
    const ANIMATED_TEXT_IDS = new Set(["activeChatMeta"]);
    ${appSource.slice(helperStart, helperEnd)}
    ${appSource.slice(setTextStart, setTextEnd)}
    this.setText = setText;
  `, context);

  let html = "私聊";
  let text = "私聊";
  const el = {
    id: "activeChatMeta",
    dataset: { slotTextValue: "私聊" },
    get innerHTML() { return html; },
    set innerHTML(value) {
      html = String(value ?? "");
      text = html.replace(/<[^>]+>/g, "");
    },
    get textContent() { return text; },
    set textContent(value) {
      text = String(value ?? "");
      html = text;
    }
  };
  el.innerHTML = '<span class="typing-status">正在输入<span class="typing-dots"><i></i><i></i><i></i></span></span>';

  context.setText(el, "私聊");

  assert.equal(el.innerHTML, "私聊");
  assert.equal(el.textContent, "私聊");
  assert.equal(el.dataset.slotTextValue, "私聊");
});

test("cloud-only renderer and preload do not expose local chat session CRUD", () => {
  const preloadSource = fs.readFileSync(path.join(root, "src/preload.js"), "utf8");
  const tasksSource = fs.readFileSync(path.join(root, "src/renderer/tasks/tasks-panel.js"), "utf8");
  const stateSource = fs.readFileSync(path.join(root, "src/renderer/app-state.js"), "utf8");

  for (const source of [preloadSource, tasksSource, stateSource]) {
    assert.doesNotMatch(source, /loadChatSessions|saveChatSession|saveChatReadState|createChatSession|renameChatSession/);
  }
  assert.doesNotMatch(tasksSource, /state\.chatStore|activeSessionIdByPersona/);
  assert.match(tasksSource, /ensureBotConversation/);
  assert.match(tasksSource, /conversationId/);
});

test("main window accepts the first mouse click after regaining focus", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const preloadSource = fs.readFileSync(path.join(root, "src/preload.js"), "utf8");
  const ipcSource = fs.readFileSync(path.join(root, "src/shared/ipc-channels.js"), "utf8");
  const windowIpcSource = fs.readFileSync(path.join(root, "src/main/ipc/window-ipc.js"), "utf8");
  const onboardingBoundsSource = fs.readFileSync(path.join(root, "src/main/onboarding-window-bounds.js"), "utf8");
  const macWindowControlsSource = fs.readFileSync(path.join(root, "src/main/mac-window-controls.js"), "utf8");
  const { macNativeChromeMetrics } = require(path.join(root, "src/main/mac-window-controls.js"));

  assert.match(mainSource, /acceptFirstMouse:\s*true/);
  assert.match(mainSource, /function shouldOpenAgentSetupWindow/);
  assert.doesNotMatch(mainSource, /fellows\.length === 0/);
  assert.match(onboardingBoundsSource, /const onboardingWindowBounds = Object\.freeze/);
  assert.match(onboardingBoundsSource, /width:/);
  assert.match(onboardingBoundsSource, /height:/);
  assert.match(onboardingBoundsSource, /minWidth:/);
  assert.match(onboardingBoundsSource, /minHeight:/);
  assert.match(mainSource, /onboardingWindowBounds\.width/);
  assert.match(mainSource, /onboardingWindowBounds\.height/);
  // Signed-out users get a dedicated lightweight onboarding window (separate
  // HTML), not the full app — and finishing promotes that window to the app.
  assert.match(mainSource, /onboarding[\s\S]{0,40}onboarding\.html/);
  assert.match(mainSource, /function promoteOnboardingWindowToMain/);
  assert.match(mainSource, /function showSignedOutOnboardingWindow/);
  assert.match(mainSource, /ipcMain\.handle\(IpcChannel\.CloudLogout,[\s\S]*?showSignedOutOnboardingWindow\(win\)/);
  assert.match(mainSource, /ipcMain\.handle\(IpcChannel\.WindowSignedOutOnboarding,[\s\S]*?showSignedOutOnboardingWindow/);
  assert.match(mainSource, /if\s*\(!cloudStatus\(false\)\.enabled\)\s*\{[\s\S]*?showSignedOutOnboardingWindow\(win\)/);
  assert.match(ipcSource, /OnboardingComplete:\s*"onboarding:complete"/);
  assert.match(preloadSource, /onboardingComplete:\s*\(\)\s*=>/);
  assert.match(mainSource, /const minWindowWidth = onboarding \? onboardingWindowBounds\.minWidth : 360;/);
  assert.match(mainSource, /const minWindowHeight = onboarding \? onboardingWindowBounds\.minHeight : 560;/);
  assert.match(mainSource, /getRuntimeStatus\(created,\s*\{\s*scanAgents:\s*false\s*\}\)/);
  assert.match(ipcSource, /WindowShowMain:\s*"window:show-main"/);
  assert.match(ipcSource, /WindowOnboarding:\s*"window:onboarding"/);
  assert.match(ipcSource, /WindowSignedOutOnboarding:\s*"window:signed-out-onboarding"/);
  assert.match(ipcSource, /WindowNativeControlsVisible:\s*"window:native-controls-visible"/);
  assert.match(ipcSource, /WindowNativeControlsLayout:\s*"window:native-controls-layout"/);
  assert.match(ipcSource, /WindowTitleBarTheme:\s*"window:title-bar-theme"/);
  assert.match(preloadSource, /showMain: \(\) => ipcRenderer\.invoke\(IpcChannel\.WindowShowMain\)/);
  assert.match(preloadSource, /onboarding: \(\) => ipcRenderer\.invoke\(IpcChannel\.WindowOnboarding\)/);
  assert.match(preloadSource, /signedOutOnboarding: \(\) => ipcRenderer\.invoke\(IpcChannel\.WindowSignedOutOnboarding\)/);
  assert.match(preloadSource, /setNativeControlsVisible: \(visible\) => ipcRenderer\.invoke\(IpcChannel\.WindowNativeControlsVisible,\s*Boolean\(visible\)\)/);
  assert.match(preloadSource, /setNativeControlsLayout: \(layout\) => ipcRenderer\.invoke\(IpcChannel\.WindowNativeControlsLayout,\s*layout === "default" \? "default" : "rail"\)/);
  assert.match(preloadSource, /setTitleBarTheme: \(appearance\) => ipcRenderer\.invoke\(IpcChannel\.WindowTitleBarTheme,\s*appearance \|\| \{\}\)/);
  assert.match(windowIpcSource, /setMinimumSize\(360,\s*560\)/);
  assert.match(windowIpcSource, /setSize\(1040,\s*700\)/);
  // Compact onboarding window driven from the renderer.
  assert.match(windowIpcSource, /IpcChannel\.WindowOnboarding/);
  assert.match(windowIpcSource, /onboardingWindowBounds\.minWidth/);
  assert.match(windowIpcSource, /onboardingWindowBounds\.width/);
  assert.match(windowIpcSource, /IpcChannel\.WindowNativeControlsVisible/);
  assert.match(windowIpcSource, /IpcChannel\.WindowNativeControlsLayout/);
  assert.match(windowIpcSource, /IpcChannel\.WindowTitleBarTheme/);
  assert.match(windowIpcSource, /setMacNativeControlsVisible\(w,\s*visible\)/);
  assert.match(windowIpcSource, /setMacNativeControlsLayout\(w,\s*layout === "default" \? "default" : "rail"\)/);
  assert.deepEqual(macNativeChromeMetrics.defaultTrafficLightPosition, { x: 18, y: 18 });
  assert.deepEqual(macNativeChromeMetrics.railTrafficLightPosition, { x: 10, y: 18 });
  assert.deepEqual(macNativeChromeMetrics.trafficLightPosition, { x: 10, y: 18 });
  assert.deepEqual(macNativeChromeMetrics.hiddenTrafficLightPosition, { x: -120, y: -120 });
  assert.equal(macNativeChromeMetrics.railSafeAreaHeight, 64);
  assert.match(macWindowControlsSource, /function macNativeControlsPositionForLayout\(layout = "rail"\)/);
  assert.match(macWindowControlsSource, /layout === "default"[\s\S]*?\? macNativeChromeMetrics\.defaultTrafficLightPosition[\s\S]*?: macNativeChromeMetrics\.railTrafficLightPosition/);
  assert.match(macWindowControlsSource, /setWindowButtonVisibility\(show\)/);
  assert.doesNotMatch(macWindowControlsSource, /nativeTrafficLightPosition = \{\s*x:\s*12,\s*y:\s*18\s*\}/);
  assert.match(macWindowControlsSource, /const targetPosition = show[\s\S]*?\? macNativeControlsPositionForLayout\(layout\)[\s\S]*?: macNativeChromeMetrics\.hiddenTrafficLightPosition;/);
  assert.match(macWindowControlsSource, /setWindowButtonPosition\(targetPosition\)/);
});

test("agent setup completion does not force first bot creation", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const appStateSource = fs.readFileSync(path.join(root, "src/renderer/app-state.js"), "utf8");

  assert.match(appStateSource, /readLocal\(storage, "mia\.onboardingStep", ""\)/);
  assert.match(appSource, /agentSetupLaunch/);
  assert.match(appSource, /function completeAgentSetup/);
  assert.match(appSource, /window\.mia\.window\?\.showMain\?\.\(\)/);
  assert.doesNotMatch(appSource, /advanceOnboarding\("create-fellow"\)/);
});

test("first-run onboarding cannot enter Mia while an engine install is running", () => {
  const standaloneSource = fs.readFileSync(path.join(root, "src/renderer/onboarding/onboarding-window.js"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const indexHtml = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const standaloneHtml = fs.readFileSync(path.join(root, "src/renderer/onboarding/onboarding.html"), "utf8");
  const standaloneStyles = fs.readFileSync(path.join(root, "src/renderer/onboarding/onboarding.css"), "utf8");
  const appStyles = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");

  assert.match(standaloneSource, /function hasActiveInstall\(\)/);
  assert.match(standaloneSource, /data-action="finish"[^`]*\$\{hasActiveInstall\(\) \? " disabled" : ""\}/);
  assert.match(standaloneSource, /else if\s*\(action === "finish"\)\s*\{[\s\S]*?if\s*\(hasActiveInstall\(\)\)\s*return;[\s\S]*?mia\.onboardingComplete\?\.\(\);[\s\S]*?\}/);

  assert.match(appSource, /state\.agentSetupInstallInFlight = true;/);
  assert.match(appSource, /state\.agentSetupInstallInFlight = false;/);
  assert.match(appSource, /if\s*\(state\.agentSetupInstallInFlight\)\s*return true;/);
  assert.doesNotMatch(indexHtml, /onboarding-wizard\.js/);
  assert.doesNotMatch(appSource, /miaOnboardingWizard/);
  assert.match(standaloneSource, /wechatIconSvg/);
  assert.match(standaloneSource, /wechat-login-cta/);
  assert.match(standaloneSource, /data-action="back"/);
  assert.match(standaloneSource, /setNativeControlsVisible/);
  assert.match(standaloneSource, /classList\.toggle\("platform-win32",\s*rendererPlatform === "win32"\)/);
  assert.match(standaloneSource, /function wireWindowControls\(\)/);
  assert.match(standaloneSource, /data-window-action/);
  assert.match(standaloneHtml, /id="onbWindowControls"/);
  assert.match(standaloneHtml, /data-window-action="maximize"/);
  assert.match(standaloneStyles, /\.onb\[data-step="done"\]/);
  assert.match(standaloneStyles, /body\.platform-win32 \.onb-window-controls\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*46px\);/);
  assert.match(standaloneSource, /action:\s*"start"/);
  assert.match(standaloneSource, /action:\s*"complete"/);
  assert.match(standaloneSource, /onb-qr-card/);
  assert.match(standaloneStyles, /\.wechat-login-cta/);
  assert.match(standaloneStyles, /\.onb-wechat-login/);
  assert.match(standaloneStyles, /\.onb-qr-card/);
  assert.doesNotMatch(appStyles, /\.setup-cta\.wechat-login-cta/);
  assert.doesNotMatch(appStyles, /\.onb-login-qr-card/);
});

test("first-run onboarding keeps install errors compact with full detail available", () => {
  const standaloneSource = fs.readFileSync(path.join(root, "src/renderer/onboarding/onboarding-window.js"), "utf8");
  const standaloneStyles = fs.readFileSync(path.join(root, "src/renderer/onboarding/onboarding.css"), "utf8");
  const rowStateBlock = standaloneStyles.match(/\.onb-row\.installing,[\s\S]*?\.onb-row\.error \{[\s\S]*?\}/)?.[0] || "";
  const detailBlock = standaloneStyles.match(/\.onb-row-detail \{[\s\S]*?\}/)?.[0] || "";

  assert.match(standaloneSource, /const INSTALL_MESSAGE_MAX = 72;/);
  assert.match(standaloneSource, /title="\$\{esc\(install\.message\)\}"/);
  assert.match(rowStateBlock, /min-height:\s*76px;/);
  assert.doesNotMatch(rowStateBlock, /height:\s*108px;/);
  assert.match(detailBlock, /-webkit-line-clamp:\s*2;/);
  assert.match(detailBlock, /max-height:\s*32px;/);
});

test("first-run onboarding clears install failure state when rescan finds the agent", () => {
  const standaloneSource = fs.readFileSync(path.join(root, "src/renderer/onboarding/onboarding-window.js"), "utf8");
  const installSource = extractFunctionSource(standaloneSource, "installAgent");

  assert.match(standaloneSource, /function isAgentReady\(id\)/);
  assert.match(installSource, /if\s*\(isAgentReady\(id\)\)\s*delete installStates\[id\];/);
  assert.match(installSource, /catch\s*\(error\)\s*\{[\s\S]*?scanAgents\?\.\(\)[\s\S]*?if\s*\(isAgentReady\(id\)\)\s*delete installStates\[id\];[\s\S]*?else installStates\[id\] = \{ status: "error"/);
});

test("chat code blocks use a right-aligned language copy button without code frame borders", () => {
  const chatCss = fs.readFileSync(path.join(root, "src/renderer/styles/chat.css"), "utf8");
  const webCss = fs.readFileSync(path.join(root, "src/web/styles.css"), "utf8");
  const cssBlock = (css, selector) => {
    const start = css.indexOf(`${selector} {`);
    assert.notEqual(start, -1, `${selector} block exists`);
    const end = css.indexOf("}", start);
    return css.slice(start, end + 1);
  };

  for (const css of [chatCss, webCss]) {
    const block = cssBlock(css, ".message-code-block");
    const darkBlock = cssBlock(css, ':root[data-theme="dark"] .message-code-block');
    const caption = cssBlock(css, ".message-code-block figcaption");
    const button = cssBlock(css, ".message-code-copy");
    const hover = cssBlock(css, ".message-code-copy:hover");
    const copied = cssBlock(css, ".message-code-copy.copied");
    assert.doesNotMatch(block, /border:/);
    assert.doesNotMatch(darkBlock, /border-color:/);
    assert.match(block, /background:/);
    assert.match(caption, /position:\s*absolute;/);
    assert.match(caption, /justify-content:\s*flex-end;/);
    assert.match(caption, /min-height:\s*0;/);
    assert.match(button, /width:\s*auto;/);
    assert.match(button, /font-size:\s*11px;/);
    assert.match(button, /font-weight:\s*500;/);
    assert.match(button, /opacity:\s*0\.72;/);
    assert.match(hover, /background:\s*rgba\(0,\s*0,\s*0,\s*0\.06\);/);
    assert.doesNotMatch(hover, /accent/);
    assert.doesNotMatch(copied, /accent/);
    assert.doesNotMatch(cssBlock(css, ".message-code-block figcaption"), /border-bottom:/);
    assert.match(cssBlock(css, ".message-code-block pre"), /padding:\s*12px;/);
  }
});

test("desktop renderer routes markdown local file links through preload", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.match(appSource, /a\.message-link\[data-external-link\],\s*a\.message-link\[data-local-file-path\]/);
  assert.match(appSource, /window\.mia\?\.openLocalFile\?\.\(link\.dataset\.localFilePath\)/);
  assert.match(appSource, /window\.mia\?\.openExternal\?\.\(link\.dataset\.externalLink\)/);
});

test("desktop OAuth device login renders clickable and copyable auth details", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");

  assert.match(appSource, /function codexAuthDetailsMarkdown\(auth = \{\}\)/);
  assert.match(appSource, /if \(auth\.codexStarting && verificationUrl\) lines\.push/);
  assert.match(appSource, /const codexMarkdown = codexAuthDetailsMarkdown\(auth\);[\s\S]*els\.codexCode\.innerHTML = window\.miaMarkdown\.renderMarkdown\(codexMarkdown\)/);
  assert.match(appSource, /els\.codexInlineAuth\?\.addEventListener\("click", async \(event\)/);
  assert.ok(
    appSource.indexOf("const messageLinkSelector") < appSource.indexOf("els.codexInlineAuth?.addEventListener"),
    "shared message link selector should be initialized before OAuth click handling"
  );
  assert.match(appSource, /if \(link && els\.codexInlineAuth\.contains\(link\)\) \{/);
  assert.match(appSource, /openMessageLink\(link\)/);
  assert.match(appSource, /copyTextToClipboard\(code\.textContent\)/);
  assert.match(css, /\.inline-auth :where\(\.auth-code, \.auth-code \*, pre\)\s*\{[\s\S]*?user-select:\s*text;/);
});

test("trace links require the platform modifier before opening", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const webAppSource = fs.readFileSync(path.join(root, "src/web/app.js"), "utf8");

  assert.match(appSource, /const TRACE_LINK_MODIFIER_CLASS = "trace-link-modifier-active";/);
  assert.match(appSource, /return traceLinkUsesAppleModifier\(\) \? Boolean\(event\.metaKey\) : Boolean\(event\.ctrlKey\);/);
  assert.match(appSource, /return !isTraceLink\(link\) \|\| isTraceLinkModifierPressed\(event\);/);
  assert.match(appSource, /if \(!shouldOpenMessageLink\(link, event\)\) return;/);
  assert.match(webAppSource, /link\.dataset\.traceLink === "true" && !isTraceLinkModifierPressed\(event\)/);
});

test("agent permission banner uses a glass card and keeps allow buttons compact", () => {
  const css = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");
  const cssBlock = (selector) => {
    const start = css.indexOf(`${selector} {`);
    assert.notEqual(start, -1, `${selector} style exists`);
    const end = css.indexOf("}", start);
    return css.slice(start, end + 1);
  };
  const block = cssBlock(".agent-permission-banner");
  const allowButtons = cssBlock(".agent-permission-allow-actions .agent-permission-button");
  const primary = cssBlock(".agent-permission-button.primary");

  assert.match(block, /border:\s*1px solid color-mix\(in srgb, var\(--line\) 64%, transparent\);/);
  assert.match(block, /border-radius:\s*14px;/);
  assert.match(block, /background:\s*color-mix\(in srgb, var\(--surface\) 94%, transparent\);/);
  assert.match(block, /box-shadow:\s*0 1px 2px rgba\(16,\s*20,\s*39,\s*0\.05\),\s*0 12px 28px rgba\(16,\s*20,\s*39,\s*0\.08\);/);
  assert.match(block, /backdrop-filter:\s*blur\(22px\) saturate\(1\.14\);/);
  assert.match(block, /overflow:\s*hidden;/);
  assert.match(block, /isolation:\s*isolate;/);
  assert.match(block, /gap:\s*8px;/);
  assert.match(block, /padding:\s*10px 12px 12px;/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.agent-permission-banner\s*\{[\s\S]*?background:\s*color-mix\(in srgb, var\(--surface-soft\) 78%, transparent\);[\s\S]*?-webkit-backdrop-filter:\s*none;[\s\S]*?backdrop-filter:\s*none;/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?:root\[data-theme="dark"\] \.agent-permission-banner\s*\{[\s\S]*?background:\s*color-mix\(in srgb, var\(--surface\) 86%, transparent\);/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.agent-permission-actions\s*\{[\s\S]*?flex-wrap:\s*nowrap;[\s\S]*?gap:\s*6px;/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.agent-permission-allow-actions\s*\{[\s\S]*?flex:\s*0 1 auto;[\s\S]*?margin-left:\s*auto;/);
  assert.match(allowButtons, /width:\s*64px;/);
  assert.match(allowButtons, /min-height:\s*26px;/);
  assert.doesNotMatch(primary, /min-width:/);
});

test("muted conversation list indicators stay grey in active desktop and narrow states", () => {
  const css = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");

  assert.match(css, /\.persona-muted-icon\s*\{[\s\S]*?width:\s*13px;[\s\S]*?color:\s*var\(--faint\);/);
  assert.match(css, /\.persona-unread\.muted\s*\{[\s\S]*?background:\s*#b3b8c2;/);
  assert.doesNotMatch(css, /:root\[data-selection-style="solid"\]/);
});

test("desktop bot controls save through bot runtime control adapter", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const commandsSource = fs.readFileSync(path.join(root, "src/renderer/bot/bot-commands.js"), "utf8");
  const quickControlSource = appSource.slice(
    appSource.indexOf("els.quickModelSelect?.addEventListener"),
    appSource.indexOf("els.modelSelect?.addEventListener")
  );

  assert.match(appSource, /function runtimeKindForBotConversation\(conversation\)\s*\{[\s\S]*return sessionHistory\.runtimeKind\(conversation, "desktop-local"\);/);
  assert.match(appSource, /async function saveActiveBotRuntimeControl/);
  assert.match(appSource, /async function saveActivePermissionRuntimeControl/);
  assert.match(appSource, /window\.miaBotCommands\.saveBotRuntimeControl\(\{/);
  assert.match(appSource, /window\.miaBotCommands\.getBotRuntimeBinding\(\{/);
  assert.doesNotMatch(appSource, new RegExp("window\\.mia\\.social\\.save" + "BotRuntime\\(context\\." + "fellow" + "Key"));
  assert.doesNotMatch(appSource, /async function saveActiveCloudBotRuntimeConfig/);
  assert.match(commandsSource, /async function saveBotRuntimeControl/);
  assert.doesNotMatch(commandsSource, /async function saveDesktopLocalBotRuntimeControl/);
  assert.match(commandsSource, /saveBotRuntimeConfig\(\{ api, cache, botKey: key, runtimeKind: kind, patch \}\)/);
  assert.match(quickControlSource, /saveActiveBotRuntimeControl\(\s*"model"/);
  assert.match(quickControlSource, /saveActiveBotRuntimeControl\(\s*"effortLevel"/);
  assert.match(quickControlSource, /saveActivePermissionRuntimeControl\(/);
  assert.doesNotMatch(quickControlSource, /window\.mia\.saveFellowEngine\(/);
  assert.doesNotMatch(quickControlSource, /window\.mia\.saveModel\(/);
  assert.doesNotMatch(quickControlSource, /window\.mia\.saveEffort\(/);
  assert.match(appSource, /window\.mia\.savePermissions\(/);
  assert.match(appSource, /const conversationPersona = personas\.find[\s\S]*if \(conversationPersona\) return conversationPersona;\s*return null;/);
});

test("conversation runtime controls do not fall back to an unrelated persona during non-bot chats", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const activeContext = extractFunctionSource(appSource, "activeBotRuntimeControlContext");
  const syncControls = extractFunctionSource(appSource, "syncConversationBotRuntimeControls");

  assert.match(activeContext, /const activeConversationId = window\.miaSocial\?\.getActiveConversationId\?\. \(\)/);
  assert.match(activeContext, /if \(activeConversationId\) return null;/);
  assert.match(syncControls, /当前聊天不支持切换模型/);
});

test("active cloud bot conversations use session-history runtime resolution", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const activeContext = extractFunctionSource(appSource, "activeConversationBotContext");

  assert.match(activeContext, /const defaultRuntimeKind = runtimeKindForBotConversation\(conversation\);/);
  assert.match(activeContext, /const botRuntimeKind = sessionHistory\.runtimeKind\(bot,\s*""\);/);
  assert.doesNotMatch(activeContext, /const botRuntimeKind = String\(bot\?\.runtimeKind/);
});

test("desktop-local bot runtime controls read cloud runtime bindings", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const body = appSource.slice(
    appSource.indexOf("function syncConversationBotRuntimeControls()"),
    appSource.indexOf("function setRuntimeControlDisabled")
  );
  const runtimeFetchBlock = body.slice(body.indexOf("const runtimeCacheKey = botRuntimeCacheKey"));

  assert.match(appSource, /const botRuntimeControlInFlight = new Set\(\);/);
  assert.doesNotMatch(runtimeFetchBlock, /context\.runtimeKind === "cloud-claude-code"/);
  assert.match(runtimeFetchBlock, /if \(!botRuntimeControlCache\.has\(runtimeCacheKey\)/);
  assert.match(body, /!botRuntimeControlInFlight\.has\(runtimeCacheKey\)/);
  assert.match(body, /botRuntimeControlInFlight\.add\(runtimeCacheKey\)/);
  assert.match(body, /botRuntimeControlInFlight\.delete\(runtimeCacheKey\)/);
  assert.match(body, /ensureBotRuntimeBinding\(context\.botKey, context\.runtimeKind\)/);
});

test("desktop Hermes conversation model picker uses platform model catalog", () => {
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

test("desktop cloud Claude permission picker exposes only sandbox mode", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const body = extractFunctionSource(appSource, "platformHermesPermissionEntries");

  assert.match(body, /value:\s*"bypassPermissions"/);
  assert.match(body, /label:\s*"Sandbox"/);
  assert.doesNotMatch(body, /value:\s*"ask"/);
  assert.doesNotMatch(body, /value:\s*"readOnly"/);
});

test("desktop bot runtime model selection resolves providerless saved bindings from modelProfileId", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const start = appSource.indexOf("function runtimeControlModelProfileId");
  const end = appSource.indexOf("function permissionEntriesForRuntimeControl", start);
  const source = appSource.slice(start, end).trim();
  const sandbox = {
    state: {
      runtime: {
        model: {
          provider: "openai-codex",
          model: "gpt-5.5"
        }
      }
    },
    agentEngineForRuntimeControl: () => "hermes",
    isExternalAgentEngineForRuntimeControl: () => false,
    window: {
      miaModelHelpers: {
        catalogEntryForModel: () => ({ id: "openai-codex::gpt-5.5" })
      }
    }
  };
  vm.runInNewContext(`${source}; this.modelValueForRuntimeControl = modelValueForRuntimeControl;`, sandbox);

  const selected = sandbox.modelValueForRuntimeControl(
    { runtimeKind: "desktop-local" },
    [
      { id: "openai-codex::gpt-5.4", value: "openai-codex::gpt-5.4", provider: "openai-codex", model: "gpt-5.4", label: "gpt-5.4" },
      { id: "mia-auto", value: "mia-auto", provider: "mia", model: "mia-auto", label: "Auto", modelProfileId: "mia:mia-auto" }
    ],
    {
      model: "gpt-5.4",
      modelProfileId: "openai-codex:gpt-5.4"
    }
  );

  assert.equal(selected, "openai-codex::gpt-5.4");
});

test("desktop avatar picker supports video avatars with one trim row", () => {
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const dialogSource = fs.readFileSync(path.join(root, "src/renderer/bot/bot-dialog.js"), "utf8");
  const avatarSource = fs.readFileSync(path.join(root, "src/renderer/helpers/avatar-helpers.js"), "utf8");
  const styleSource = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");

  assert.match(html, /packages\/shared\/avatar\.js/);
  assert.match(html, /id="profileAvatarFile"[^>]+accept="image\/\*,video\/\*"/);
  assert.match(html, /id="botAvatarFile"[^>]+accept="image\/\*,video\/\*"/);
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
  assert.match(styleSource, /\.avatar,\n\.bot-photo\s*\{[\s\S]*?border:\s*0;/);
  assert.match(styleSource, /\.contact-profile-avatar\s*\{[\s\S]*?border:\s*0;[\s\S]*?box-shadow:\s*none;/);
});

test("desktop avatar helpers tolerate null crop values", () => {
  const avatarSource = fs.readFileSync(path.join(root, "src/renderer/helpers/avatar-helpers.js"), "utf8");
  const resolveSource = fs.readFileSync(path.join(root, "packages/shared/avatar.js"), "utf8");
  const context = vm.createContext({ window: {}, console });
  vm.runInContext(resolveSource, context);
  vm.runInContext(avatarSource, context);

  const crop = context.window.miaAvatar.normalizeCrop(null);
  assert.equal(crop.x, 50);
  assert.equal(crop.y, 50);
  assert.equal(crop.zoom, 1);
  assert.doesNotThrow(() => context.window.miaAvatar.avatarBackgroundStyle("data:image/gif;base64,abc", null, "#34c759"));
});

test("desktop avatar video crop updates do not restart playback unless trim changes", () => {
  const avatarSource = fs.readFileSync(path.join(root, "src/renderer/helpers/avatar-helpers.js"), "utf8");
  const sharedAvatarSource = fs.readFileSync(path.join(root, "packages/shared/avatar.js"), "utf8");
  const context = vm.createContext({
    window: {},
    console,
    setTimeout
  });
  context.globalThis = context.window;
  vm.runInContext(sharedAvatarSource, context, { filename: "packages/shared/avatar.js" });
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

test("cloud-only: submit routes through the active cloud conversation, not a local session", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const start = appSource.indexOf('els.chatForm.addEventListener("submit"');
  const handler = appSource.slice(start, appSource.indexOf("\n});", start) + 4);

  assert.match(handler, /window\.miaSocial\.sendInActiveConversation\(/);
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

test("cloud-only: the sidebar uses social rows normally and message hits while searching", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.match(appSource, /const searchMode = Boolean\(state\.personaSearchOpen \|\| searchQuery\)/);
  assert.match(appSource, /const useMessageSearch = searchMode && Boolean\(searchQuery\)/);
  assert.match(appSource, /searchMode[\s\S]*\? \(useMessageSearch[\s\S]*: ""\)/);
  assert.match(appSource, /conversationRowsFromMessageSearch\(/);
  assert.match(appSource, /sortMessageCardsForSidebar\(socialRows\)/);
  // No local bot personas feed the conversation list anymore.
  assert.doesNotMatch(appSource, /visiblePersonas\.map/);
});

test("bot cloud conversations are not hidden from the sidebar", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.doesNotMatch(appSource, /if\s*\(\s*isFellow\s*\)\s*return\s+null/);
});

test("creating or messaging a bot opens its conversation through the unified bot route", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const botManagerSource = fs.readFileSync(path.join(root, "src/renderer/bot/bot-manager.js"), "utf8");

  assert.match(appSource, /async function openBotConversation\(botKey\)/);
  assert.match(appSource, /window\.miaSocial\.ensureBotConversation\(bot\)/);
  assert.match(appSource, /window\.miaSocial\.setActiveConversationId\(conversation\.id\)/);
  assert.match(appSource, /if \(savedKey\) await openBotConversation\(savedKey\);/);
  assert.match(botManagerSource, /window\.miaOpenBotConversation\??\.?\(botKey\)/);
});

test("contacts use cloud-stored owned bot identities", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const botDirectorySource = fs.readFileSync(path.join(root, "src/renderer/bot/bot-directory.js"), "utf8");
  const botManagerSource = fs.readFileSync(path.join(root, "src/renderer/bot/bot-manager.js"), "utf8");
  const socialSource = fs.readFileSync(path.join(root, "src/renderer/social/social.js"), "utf8");

  assert.match(html, /bot\/bot-directory\.js/);
  assert.match(botDirectorySource, /function listOwnedBots/);
  assert.match(socialSource, /window\.miaBotDirectory[\s\S]*listOwnedBots/);
  assert.match(botManagerSource, /function allOwnedBots\(\)/);
  assert.match(botManagerSource, /window\.miaBotDirectory\.listOwnedBots/);
  assert.match(botManagerSource, /const bots = allOwnedBots\(\);/);
  assert.match(botManagerSource, /adapterCtx\?\.\(\)\?\.bots/);
  assert.match(botManagerSource, /moduleState\?\.bots/);
  assert.doesNotMatch(botManagerSource, /state\.runtime\?\.bots/);
  assert.doesNotMatch(botManagerSource, /runtime\?\.fellows/);
  assert.doesNotMatch(botManagerSource, /runtime\?\.personas/);
  assert.doesNotMatch(botManagerSource, /cloudOnly/);
  assert.doesNotMatch(socialSource, /cloudOnly:\s*(true|false)/);
  assert.match(appSource, /const syncedBotKeys = new Set/);
  assert.match(appSource, /const contactKeys = new Set/);
});

test("contacts group desktop-local bots from other devices behind a collapsed section", () => {
  const botManagerSource = fs.readFileSync(path.join(root, "src/renderer/bot/bot-manager.js"), "utf8");

  assert.match(botManagerSource, /const OTHER_DEVICE_GROUP_KEY = "other-devices"/);
  assert.match(botManagerSource, /const CONTACT_GROUP_COLLAPSED_KEY = "mia\.contactGroupCollapsed\.v1"/);
  assert.match(botManagerSource, /function botRunsOnOtherDevice\(bot = \{\}\)/);
  assert.match(botManagerSource, /target\.runtimeKind !== "desktop-local"/);
  assert.match(botManagerSource, /function contactDisplayGroupKey\(bot = \{\}\)[\s\S]*OTHER_DEVICE_GROUP_KEY/);
  assert.match(botManagerSource, /function contactGroupsForSidebar\(bots = \[\]\)/);
  assert.match(botManagerSource, /function contactGroupCollapsedSet\(\)[\s\S]*\[OTHER_DEVICE_GROUP_KEY\]/);
  assert.match(botManagerSource, /function isContactGroupCollapsed\(key,\s*options = \{\}\)[\s\S]*options\.forceExpanded/);
  assert.match(botManagerSource, /function toggleContactGroupCollapsed\(key\)/);
  assert.match(botManagerSource, /contactGroupLabel\(key\)[\s\S]*"其他设备"/);
  assert.match(botManagerSource, /const primarySortedBots = sortBotsForSidebar\(bots\.filter\(\(bot\) => !botRunsOnOtherDevice\(bot\)\)\);/);
  assert.match(botManagerSource, /const contactGroups = contactGroupsForSidebar\(visibleContacts\);/);
  assert.match(botManagerSource, /const collapsed = isContactGroupCollapsed\(group\.key,\s*\{ forceExpanded: filterActive \}\);/);
  assert.match(botManagerSource, /botRunsOnOtherDevice\(bot\) \? `<small>\$\{window\.miaMarkdown\.escapeHtml\(botDeviceLabel\(bot\)\)\}<\/small>` : ""/);
});

test("contact bot avatars resolve through shared bot identity", () => {
  const botManagerSource = fs.readFileSync(path.join(root, "src/renderer/bot/bot-manager.js"), "utf8");

  assert.match(botManagerSource, /function avatarForBot\(bot = \{\}\)/);
  assert.match(botManagerSource, /api\.resolveContact\(/);
  assert.match(botManagerSource, /kind:\s*api\.IdentityKind\.Bot/);
  assert.doesNotMatch(botManagerSource, /ContactKind\.Fellow/);
  assert.match(botManagerSource, /botAvatarIdentityId\(bot\)/);
  assert.doesNotMatch(botManagerSource, /id:\s*bot\.key\s*\|\|\s*bot\.id/);
});

test("contact fallback avatars share text color and round shape styling", () => {
  const styleSource = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");
  const profileBlock = styleSource.match(/\.contact-profile-avatar\s*\{[\s\S]*?\n\}/)?.[0] || "";
  const rowBlock = styleSource.match(/\.contact-row \.bot-photo\s*\{[\s\S]*?\n\}/)?.[0] || "";

  assert.match(profileBlock, /display:\s*grid;/);
  assert.match(profileBlock, /place-items:\s*center;/);
  assert.match(profileBlock, /color:\s*#fff;/);
  assert.match(rowBlock, /border-radius:\s*50%;/);
  assert.match(rowBlock, /font-size:\s*11px;/);
  assert.match(rowBlock, /line-height:\s*1;/);
  assert.match(rowBlock, /white-space:\s*nowrap;/);
  assert.doesNotMatch(rowBlock, /border-radius:\s*7px;/);
});

test("cloud conversation headers use the shared avatar identity path", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const socialSource = fs.readFileSync(path.join(root, "src/renderer/social/social.js"), "utf8");

  assert.match(socialSource, /otherUserForConversation/);
  assert.match(appSource, /function allOwnedBotsForIdentity/);
  assert.match(appSource, /social\?\.otherUserForConversation\?\.\(conversation\)/);
  assert.match(appSource, /miaAvatarResolve\.resolveAvatarForContact/);
  assert.match(appSource, /avatarHelper\.paintAvatar\(avatarEl,\s*avatar\)/);
});

test("contact detail shows engine logo and bot device label", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const botManagerSource = fs.readFileSync(path.join(root, "src/renderer/bot/bot-manager.js"), "utf8");
  const styleSource = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");

  assert.match(mainSource, /localDeviceName,/);
  assert.match(mainSource, /localDevice:\s*\{\s*name:\s*localDeviceName\(\)/);
  assert.match(botManagerSource, /function botDeviceLabel\(bot = \{\}\)/);
  assert.match(botManagerSource, /function engineLogoHtml\(engine = ""\)/);
  assert.match(botManagerSource, /function renderBotRuntimeTargetPanel\(bot\)/);
  assert.match(botManagerSource, /window\.miaBotCommands\.saveBotRuntimeTarget\(\{/);
  assert.match(botManagerSource, /<details class="contact-runtime-target accordion-details"/);
  assert.match(botManagerSource, /data-runtime-panel-key/);
  assert.match(botManagerSource, /openRuntimeTargetPanelKeys/);
  assert.match(botManagerSource, /<div class="accordion-body">/);
  assert.match(botManagerSource, /status:\s*"local"/);
  assert.match(botManagerSource, /function mergeDevices\(existing, incoming/);
  assert.match(botManagerSource, /function isSameLocalDevice\(device, local\)/);
  assert.match(botManagerSource, /device\?\.id === active\.deviceId/);
  assert.doesNotMatch(botManagerSource, /device\?\.aliases/);
  assert.match(botManagerSource, /engine-row-logo contact-engine-logo/);
  assert.match(botManagerSource, /botDeviceLabel\(bot\)/);
  assert.match(botManagerSource, /RUNTIME_DEVICE_REFRESH_INTERVAL_MS/);
  assert.match(styleSource, /\.contact-engine-badge \.contact-engine-logo/);
  assert.match(styleSource, /\.contact-runtime-target/);
  assert.match(styleSource, /\.contact-runtime-target > summary/);
  assert.match(styleSource, /\.accordion-details > \.accordion-body/);
  assert.match(styleSource, /\.runtime-target-option\.selected/);
});

test("profile and account surfaces expose uid fields", () => {
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const styleSource = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");
  const remoteSettingsSource = fs.readFileSync(path.join(root, "src/renderer/settings/settings-remote.js"), "utf8");
  const botManagerSource = fs.readFileSync(path.join(root, "src/renderer/bot/bot-manager.js"), "utf8");

  assert.match(html, /id="profileDialogTitle"/);
  assert.match(html, /id="profileDialog" class="profile-popover hidden"/);
  assert.match(html, /id="userAvatar"[^>]+aria-expanded="false"/);
  assert.match(html, /id="profileUidValue"/);
  assert.match(html, /id="profileNameText"/);
  assert.match(html, /id="profileStatusBadge"/);
  assert.match(html, /id="profileStatusBadgeDetails"/);
  assert.match(html, /id="profileStatusBadgeTrigger"/);
  assert.doesNotMatch(html, /id="cancelProfile"/);
  assert.doesNotMatch(html, />保存资料</);
  assert.match(html, /id="botNameText"/);
  assert.match(html, /id="botStatusBadge"/);
  assert.match(html, /id="botStatusBadgeDetails"/);
  assert.match(html, /id="botStatusBadgeTrigger"/);
  assert.match(html, /status-badge-assets\.js/);
  assert.doesNotMatch(html, /data-lottie-fallback/);
  assert.doesNotMatch(html, /profileStatusBadgePreview/);
  assert.match(html, /id="cloudAccountProfile"/);
  assert.match(html, /id="cloudAccountAvatar"/);
  assert.match(html, /id="cloudAccountName"/);
  assert.match(html, /id="cloudAccountUid"/);
  assert.match(html, /id="cloudModelBalanceRow"/);
  assert.match(html, /id="cloudModelBalanceAmount"/);
  assert.match(html, /id="cloudModelBalanceMeta"/);
  assert.match(appSource, /profileUidValue:\s*document\.getElementById\("profileUidValue"\)/);
  assert.match(appSource, /cloudModelBalanceAmount:\s*document\.getElementById\("cloudModelBalanceAmount"\)/);
  assert.match(appSource, /fetchModelBalance:\s*\(\) => window\.mia\.cloudModelBalance\(\)/);
  assert.match(appSource, /closeProfilePopoverFromOutside/);
  assert.match(appSource, /function profileDraftPayload/);
  assert.match(appSource, /async function saveProfileDraft/);
  assert.match(styleSource, /\.profile-popover/);
  assert.match(styleSource, /@keyframes profile-popover-open/);
  assert.match(appSource, /profileNameText:\s*document\.getElementById\("profileNameText"\)/);
  assert.match(appSource, /profileStatusBadge:\s*document\.getElementById\("profileStatusBadge"\)/);
  assert.match(appSource, /profileStatusBadgeTrigger:\s*document\.getElementById\("profileStatusBadgeTrigger"\)/);
  assert.match(appSource, /botNameText:\s*document\.getElementById\("botNameText"\)/);
  assert.match(appSource, /botStatusBadge:\s*document\.getElementById\("botStatusBadge"\)/);
  assert.match(appSource, /statusBadgeForPreset/);
  assert.match(appSource, /renderStatusBadgeChoiceLists/);
  assert.match(appSource, /function setNameWithBadge/);
  assert.match(appSource, /els\.profileUidValue\.textContent = user\.id/);
  assert.match(remoteSettingsSource, /cloudAccountUid/);
  assert.match(remoteSettingsSource, /refreshModelBalance/);
  assert.match(remoteSettingsSource, /renderNameWithBadge/);
  assert.match(remoteSettingsSource, /applyAvatarMedia|paintAvatar/);
  assert.match(botManagerSource, /contact-profile-uid/);
  assert.match(botManagerSource, /contactUid\(bot\)/);
});

test("desktop name surfaces render status badges beside names", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const botManagerSource = fs.readFileSync(path.join(root, "src/renderer/bot/bot-manager.js"), "utf8");
  const contactCardSource = fs.readFileSync(path.join(root, "src/renderer/social/contact-card.js"), "utf8");
  const groupInfoSource = fs.readFileSync(path.join(root, "src/renderer/social/group-info-dialog.js"), "utf8");
  const socialGroupsSource = fs.readFileSync(path.join(root, "src/renderer/social/social-groups.js"), "utf8");
  const remoteSettingsSource = fs.readFileSync(path.join(root, "src/renderer/settings/settings-remote.js"), "utf8");
  const badgeStyles = fs.readFileSync(path.join(root, "src/renderer/styles/name-with-badge.css"), "utf8");

  assert.match(appSource, /setNameWithBadge\(nameEl/);
  assert.match(appSource, /setNameWithBadge\(els\.activeChatName/);
  assert.match(botManagerSource, /renderBotNameWithBadgeHtml/);
  assert.match(botManagerSource, /setBotNameWithBadge\(els\.contactPageTitle/);
  assert.match(contactCardSource, /renderNameWithBadgeHtml/);
  assert.match(groupInfoSource, /appendNameWithBadge\(nameEl/);
  assert.match(socialGroupsSource, /nameEl\.innerHTML = renderNameWithBadgeHtml/);
  assert.match(remoteSettingsSource, /renderer\.setNameWithBadge\(els\.cloudAccountName/);
  assert.match(badgeStyles, /--name-badge-size:\s*max\(20px,\s*1\.12em\)/);
  assert.match(badgeStyles, /--name-badge-gap:\s*0px/);
  assert.match(badgeStyles, /--name-badge-shift-x:\s*2px/);
  assert.match(badgeStyles, /--name-badge-shift-y:\s*-1px/);
  assert.match(badgeStyles, /padding-left:\s*var\(--name-badge-shift-x\)/);
  assert.match(badgeStyles, /\.name-with-badge-badge\s*\{[^}]*overflow:\s*visible;/);
  assert.match(badgeStyles, /\.name-with-badge-badge\s*\{[^}]*transform:\s*translateY\(var\(--name-badge-shift-y\)\)/);
  assert.match(badgeStyles, /#activeChatName \.name-with-badge/);
  assert.match(badgeStyles, /\.contact-card-name \.name-with-badge/);
  assert.match(badgeStyles, /\.group-info-member-name \.name-with-badge/);
});

test("group settings member names prefer display names over generated WeChat usernames", () => {
  const groupInfoSource = fs.readFileSync(path.join(root, "src/renderer/social/group-info-dialog.js"), "utf8");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(
    `${extractFunctionSource(groupInfoSource, "firstDisplayName")}\n${extractFunctionSource(groupInfoSource, "userNameFor")}\nthis.userNameFor = userNameFor;`,
    sandbox
  );

  assert.equal(
    sandbox.userNameFor(
      {
        member_ref: "1234567890",
        identity: { displayName: "服务器名字" },
        user: { displayName: "接口名字" }
      },
      [],
      { id: "1234567890", username: "wx_8067aabb7153", displayName: "展示名字" }
    ),
    "展示名字"
  );
  assert.equal(
    sandbox.userNameFor(
      { member_ref: "1234567890" },
      [],
      { id: "1234567890", username: "wx_8067aabb7153" }
    ),
    "我"
  );
});

test("contact detail deletes bots through runtime-backed ownership rules", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const botManagerSource = fs.readFileSync(path.join(root, "src/renderer/bot/bot-manager.js"), "utf8");
  const commandsSource = fs.readFileSync(path.join(root, "src/renderer/bot/bot-commands.js"), "utf8");
  const preloadSource = fs.readFileSync(path.join(root, "src/preload.js"), "utf8");
  const channelSource = fs.readFileSync(path.join(root, "src/shared/ipc-channels.js"), "utf8");
  const socialApiSource = fs.readFileSync(path.join(root, "src/main/social/social-api.js"), "utf8");
  const socialIpcSource = fs.readFileSync(path.join(root, "src/main/social/social-ipc.js"), "utf8");

  assert.doesNotMatch(appSource, /if \(!bot \|\| bot\.key === "mia"\) return;/);
  assert.match(appSource, /if \(bot\.canDelete === false\) return;/);
  assert.match(commandsSource, /async function deleteCloudClaudeCodeBot/);
  assert.doesNotMatch(commandsSource, /async function deleteDesktopLocalBot/);
  assert.match(botManagerSource, /const canDeleteBot = bot\.canDelete !== false;/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, "src/renderer/bot/bot-directory.js"), "utf8"), /key !== "mia"/);
  assert.match(channelSource, /SocialDeleteBot/);
  assert.doesNotMatch(channelSource, /SocialDeleteFellow/);
  assert.match(preloadSource, /deleteBot: \(botId\) => ipcRenderer\.invoke\(IpcChannel\.SocialDeleteBot, botId\)/);
  assert.doesNotMatch(preloadSource, /deleteFellow: \(fellowId\) => ipcRenderer\.invoke\(IpcChannel\.SocialDeleteFellow, fellowId\)/);
  assert.match(socialApiSource, /async deleteBot\(botId\)/);
  assert.doesNotMatch(socialApiSource, /async deleteFellow\(fellowId\)/);
  assert.match(socialIpcSource, /SocialDeleteBot/);
  assert.doesNotMatch(socialIpcSource, /SocialDeleteFellow/);
});

test("contact capability saves go through bot command adapters", () => {
  const botManagerSource = fs.readFileSync(path.join(root, "src/renderer/bot/bot-manager.js"), "utf8");
  const commandsSource = fs.readFileSync(path.join(root, "src/renderer/bot/bot-commands.js"), "utf8");

  assert.match(botManagerSource, /window\.miaBotCommands\.saveBotCapabilities\(\{/);
  assert.doesNotMatch(botManagerSource, /window\.mia\.social\.saveFellowIdentity/);
  assert.doesNotMatch(botManagerSource, /window\.mia\.saveFellow\(\{/);
  assert.match(commandsSource, /async function saveCloudClaudeCodeBotCapabilities/);
  assert.doesNotMatch(commandsSource, /async function saveDesktopLocalBotCapabilities/);
});

test("contact capability checkboxes use official preset default capabilities", () => {
  const botManagerSource = fs.readFileSync(path.join(root, "src/renderer/bot/bot-manager.js"), "utf8");

  assert.match(botManagerSource, /botCapabilitiesWithPresetDefaults/);
  assert.match(botManagerSource, /state\?\.skillLibrary\?\.botPresets/);
});

test("bot-only contact detail renders capabilities, persona, and memory as compact accordions", () => {
  const botManagerSource = fs.readFileSync(path.join(root, "src/renderer/bot/bot-manager.js"), "utf8");
  const styleSource = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");

  assert.match(botManagerSource, /function renderBotCapabilitiesPanel\(bot\)/);
  assert.match(botManagerSource, /<details class="contact-capabilities accordion-details"/);
  assert.match(botManagerSource, /data-capabilities-panel-key/);
  assert.match(botManagerSource, /openCapabilityPanelKeys/);
  assert.match(botManagerSource, /function renderBotPersonaPanel\(bot\)/);
  assert.match(botManagerSource, /<details class="contact-persona-card accordion-details"/);
  assert.match(botManagerSource, /botPersonaText\(bot\)/);
  assert.match(botManagerSource, /renderBotPersonaPanel\(bot\)/);
  assert.match(botManagerSource, /function renderContactMemoryPanel\(bot\)/);
  assert.match(botManagerSource, /<details class="contact-memory-card accordion-details"/);
  assert.match(botManagerSource, /function contactMemoryBotId\(bot = \{\}\)/);
  assert.match(botManagerSource, /contactMemoryBotId\(bot\)/);
  assert.match(botManagerSource, /contactUid\(bot\)/);
  assert.match(botManagerSource, /window\.mia\.memory\.delete/);
  assert.match(botManagerSource, /refreshContactMemoryForBot/);
  assert.doesNotMatch(botManagerSource, /contact-memory-draft/);
  assert.doesNotMatch(botManagerSource, /data-memory-action="save"/);
  assert.doesNotMatch(botManagerSource, /data-memory-action="edit"/);
  assert.doesNotMatch(botManagerSource, /window\.mia\.memory\.remember/);
  assert.doesNotMatch(botManagerSource, /window\.mia\.memory\.update/);
  assert.doesNotMatch(botManagerSource, /panel\.loading \|\| !panel\.loaded/);
  assert.match(botManagerSource, /const summary = panel\.loading\s*\?\s*"正在加载记忆"/);
  assert.match(botManagerSource, /if \(panel\.loading\) return `<div class="contact-memory-empty">正在加载记忆\.\.\.<\/div>`;/);
  assert.doesNotMatch(botManagerSource, /contact-memory-kind/);
  assert.doesNotMatch(botManagerSource, /contact-memory-pill/);
  assert.doesNotMatch(botManagerSource, /draftKind/);
  assert.doesNotMatch(botManagerSource, /renderHumanPersonaPanel/);
  assert.match(styleSource, /\.contact-persona-card/);
  assert.match(styleSource, /\.contact-memory-card/);
  assert.match(styleSource, /\.contact-persona-text/);
});

test("memory list panes recover from suspended IPC invokes", () => {
  const botManagerSource = fs.readFileSync(path.join(root, "src/renderer/bot/bot-manager.js"), "utf8");
  const settingsMemorySource = fs.readFileSync(path.join(root, "src/renderer/settings/settings-memory.js"), "utf8");
  const styleSource = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");

  assert.match(botManagerSource, /MEMORY_LIST_TIMEOUT_MS = 3000/);
  assert.match(botManagerSource, /withMemoryListTimeout\(\s*window\.mia\.memory\.list\(\{/);
  assert.doesNotMatch(botManagerSource, /const result = await window\.mia\.memory\.list\(\{/);
  assert.match(botManagerSource, /data-memory-action="reload"/);
  assert.match(botManagerSource, /action === "reload"[\s\S]{0,160}loadContactMemoryEntries\(contactMemoryBotId\(bot\), \{ force: true \}\)/);
  assert.match(botManagerSource, /if \(!window\.mia\?\.memory\?\.list\)[\s\S]{0,220}renderContacts\(\);/);
  assert.match(settingsMemorySource, /MEMORY_LIST_TIMEOUT_MS = 3000/);
  assert.match(settingsMemorySource, /withMemoryListTimeout\(\s*window\.mia\.memory\.listAll\(\{/);
  assert.doesNotMatch(settingsMemorySource, /const result = await window\.mia\.memory\.listAll\(\{/);
  assert.match(settingsMemorySource, /data-memory-action="reload"/);
  assert.match(settingsMemorySource, /memoryAction === "reload"[\s\S]{0,120}loadMemorySettings\(\);/);
  assert.match(styleSource, /\.contact-memory-error,\s*\n\.settings-memory-error/);
});

test("bot edit dialog keeps memory out of the create/edit modal", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const htmlSource = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const dialogSource = fs.readFileSync(path.join(root, "src/renderer/bot/bot-dialog.js"), "utf8");

  assert.doesNotMatch(htmlSource, /id="botMemoryDetails"/);
  assert.doesNotMatch(htmlSource, /id="botMemoryDraftScope"/);
  assert.doesNotMatch(appSource, /botMemoryDetails: document\.getElementById/);
  assert.doesNotMatch(dialogSource, /function loadBotMemoryEntries\(\)/);
  assert.doesNotMatch(dialogSource, /window\.mia\.memory\.promote/);
  assert.match(htmlSource, /这段人设保存在 Mia 的 Bot 身份里/);
});

test("settings exposes account-level memory governance", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const htmlSource = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const memorySource = fs.readFileSync(path.join(root, "src/renderer/settings/settings-memory.js"), "utf8");
  const styleSource = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const coreSource = fs.readFileSync(path.join(root, "src/core/mia-core.js"), "utf8");

  assert.match(htmlSource, /data-settings-tab="memory"/);
  assert.match(htmlSource, /data-settings-panel="memory"/);
  assert.match(htmlSource, /id="settingsMemoryList"/);
  assert.match(htmlSource, /id="settingsMemoryEnabled"/);
  assert.doesNotMatch(htmlSource, /id="settingsMemoryDraftKind"/);
  assert.doesNotMatch(htmlSource, /id="settingsMemoryExportText"/);
  assert.doesNotMatch(htmlSource, /id="settingsMemoryDeleteAll"/);
  assert.doesNotMatch(htmlSource, /id="settingsMemoryStatus"/);
  assert.doesNotMatch(htmlSource, /id="settingsMemoryQuery"/);
  assert.match(htmlSource, /<script src="\.\/settings\/settings-memory\.js"><\/script>/);
  assert.match(appSource, /settingsMemoryEnabled: document\.getElementById\("settingsMemoryEnabled"\)/);
  assert.match(appSource, /settingsMemoryList: document\.getElementById\("settingsMemoryList"\)/);
  assert.doesNotMatch(appSource, /settingsMemoryDraftKind/);
  assert.doesNotMatch(appSource, /settingsMemoryDeleteAll: document\.getElementById/);
  assert.match(appSource, /window\.miaSettingsMemory\?\.loadMemorySettings/);
  assert.match(memorySource, /window\.mia\.saveMemorySettings/);
  assert.match(memorySource, /function saveMemoryEnabled\(enabled\)/);
  assert.match(memorySource, /window\.mia\.memory\.listAll/);
  assert.doesNotMatch(memorySource, /draftKind|settingsMemoryDraftKind|memoryLabel|KIND_LABELS/);
  assert.doesNotMatch(memorySource, /window\.mia\.memory\.activate/);
  assert.doesNotMatch(memorySource, /window\.mia\.memory\.promote/);
  assert.match(memorySource, /window\.mia\.memory\.delete/);
  assert.doesNotMatch(memorySource, /window\.mia\.memory\.deleteAll/);
  assert.doesNotMatch(memorySource, /function memoryProvenanceParts/);
  assert.doesNotMatch(memorySource, /function promoteTargetForEntry/);
  assert.doesNotMatch(memorySource, /data-memory-action="promote"/);
  assert.doesNotMatch(memorySource, /function deleteAllMatchingMemories\(\)/);
  assert.doesNotMatch(memorySource, /window\.mia\.memory\.exportAll/);
  assert.match(styleSource, /\.settings-memory-list/);
  assert.match(mainSource, /IpcChannel\.MemoryListAll/);
  assert.doesNotMatch(mainSource, /IpcChannel\.MemoryPromote/);
  assert.doesNotMatch(mainSource, /IpcChannel\.MemoryDeleteAll/);
  assert.doesNotMatch(mainSource, /IpcChannel\.MemoryExport/);
  assert.match(mainSource, /IpcChannel\.MemorySettingsSave/);
  assert.match(mainSource, /function syncNativeMemoryFilesForAgent\(input = \{\}\)/);
  assert.doesNotMatch(mainSource, /miaMemoryBlock|memoryBlock:\s*/);
  assert.doesNotMatch(mainSource, /syncNativeMemoryFiles:\s*miaMemoryService\.syncNativeMemoryFiles/);
  assert.match(coreSource, /function syncNativeMemoryFilesForAgent\(input = \{\}\)/);
  assert.doesNotMatch(coreSource, /miaMemoryBlock|memoryBlock:\s*/);
  assert.doesNotMatch(coreSource, /syncNativeMemoryFiles:\s*miaMemoryService\.syncNativeMemoryFiles/);
});

test("renderer handles memory events as lightweight UI refreshes, not chat messages", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const memoryStart = appSource.indexOf("let visibleMemoryRefreshTimer");
  const memoryEnd = appSource.indexOf("\n\nasync function createNewSessionForActive", memoryStart);
  const memoryHandlerBlock = appSource.slice(memoryStart, memoryEnd);

  assert.match(appSource, /envelope\.type === "memory\.updated" \|\| envelope\.type === "memory\.deleted"/);
  assert.match(appSource, /handleMemoryEvent\(envelope\);\s*return;/);
  assert.match(memoryHandlerBlock, /window\.miaSettingsMemory\?\.loadMemorySettings\?\.\(\)/);
  assert.match(memoryHandlerBlock, /window\.miaBotManager\?\.refreshContactMemoryForBot\?\./);
  assert.doesNotMatch(memoryHandlerBlock, /appendTransientChat|chatStore|appendMessage|sendInActiveConversation/);
});

test("social keeps desktop-local bot runtime binding explicit", () => {
  const socialSource = fs.readFileSync(path.join(root, "src/renderer/social/social.js"), "utf8");
  const commandsSource = fs.readFileSync(path.join(root, "src/renderer/bot/bot-commands.js"), "utf8");

  assert.match(socialSource, /window\.miaBotCommands\.ensureDesktopLocalBotConversation\(\{/);
  assert.doesNotMatch(socialSource, /function syncLocalBotRuntimeBindings/);
  assert.doesNotMatch(socialSource, /ensureLocalBotConversationsInBackground/);
  assert.doesNotMatch(socialSource, /runtime\.bots\)\s*\? runtime\.bots/);
  assert.doesNotMatch(socialSource, new RegExp("api\\.save" + "BotRuntime\\(" + "fellow" + "Key"));
  assert.doesNotMatch(socialSource, /api\.ensureFellowConversation\(fellow\.key,/);
  assert.match(commandsSource, /function desktopLocalRuntimeConfig/);
  assert.match(commandsSource, /async function ensureDesktopLocalBotConversation/);
});

test("bot creation dialog combines runtime location and agent engine into one grouped selector", () => {
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const dialogSource = fs.readFileSync(path.join(root, "src/renderer/bot/bot-dialog.js"), "utf8");

  assert.match(html, /id="botRuntimeTarget"/);
  assert.doesNotMatch(html, /当前设备 · Hermes/);
  assert.match(html, /helpers\/accordion\.js/);
  assert.match(html, /class="persona-details accordion-details"/);
  assert.match(html, /class="accordion-body"/);
  assert.doesNotMatch(html, /id="botRuntimeLocation"/);
  assert.doesNotMatch(html, /id="botRuntimeDevice"/);
  assert.match(appSource, /botRuntimeTarget:\s*document\.getElementById\("botRuntimeTarget"\)/);
  assert.match(appSource, /readSelectedRuntimeTarget/);
  assert.match(appSource, /targetDeviceId/);
  assert.match(dialogSource, /function renderBotRuntimeTargetSelect/);
  assert.match(dialogSource, /function readSelectedRuntimeTarget/);
  assert.match(dialogSource, /document\.createElement\("optgroup"\)/);
  assert.match(dialogSource, /refreshBridgeDevicesForDialog/);
  assert.match(dialogSource, /state\?\.runtime\?\.cloud\?\.enabled/);
  assert.match(dialogSource, /openclaw/);
});

test("desktop accordion helper animates managed details instead of native snap toggles", () => {
  const source = fs.readFileSync(path.join(root, "src/renderer/helpers/accordion.js"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.match(source, /details\.accordion-details/);
  assert.match(source, /event\.preventDefault\(\)/);
  assert.match(source, /body\.animate\(/);
  assert.match(source, /function setElementOpen/);
  assert.match(source, /element\.animate\(/);
  assert.match(appSource, /window\.miaAccordion\?\.setElementOpen/);
  assert.match(appSource, /window\.miaAccordion\.setElementOpen\(els\.modelForm, next\)/);
  assert.match(source, /global\.miaAccordion/);
});

test("bot creation branches cloud-claude-code without saving local manifest", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const commandsSource = fs.readFileSync(path.join(root, "src/renderer/bot/bot-commands.js"), "utf8");

  assert.match(html, /bot\/bot-commands\.js/);
  assert.match(appSource, /window\.miaBotCommands\.saveBot\(\{/);
  assert.doesNotMatch(appSource, /async function createCloudHermesBot/);
  assert.doesNotMatch(appSource, /window\.mia\.social\.saveFellowIdentity\(key,/);
  assert.match(commandsSource, /async function saveCloudClaudeCodeBot/);
  assert.match(commandsSource, /api\.social\.saveBotIdentity\(key,/);
  assert.match(commandsSource, /const CLOUD_RUNTIME_KIND = "cloud-claude-code"/);
  assert.match(commandsSource, /runtimeKind:\s*CLOUD_RUNTIME_KIND/);
  assert.doesNotMatch(commandsSource, /async function saveDesktopLocalBot/);
  assert.doesNotMatch(commandsSource, /api\.saveBot\(bot\)/);
});

test("editing a cloud-sourced desktop bot does not load local manifest details", async () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const calls = [];
  const bot = {
    key: "codex-pal",
    name: "Codex Pal",
    runtimeKind: "desktop-local",
    sourceKinds: ["cloud"],
    personaText: "Cloud persona"
  };
  const context = vm.createContext({
    window: {
      miaBotManager: { botByKey: (key) => (key === bot.key ? bot : null) },
      miaBotDirectory: {
        isCloudIdentityBot: (item) => Array.isArray(item?.sourceKinds) && item.sourceKinds.includes("cloud")
      },
      miaBotDialog: {
        openBotDialog(openedBot, personaText) {
          calls.push(["dialog", openedBot.key, personaText]);
        }
      }
    },
    appendTransientChat(role, message) {
      calls.push(["toast", role, message]);
    }
  });

  await vm.runInContext(`async ${extractFunctionSource(appSource, "openEditBotDialog")}; openEditBotDialog("${bot.key}")`, context);

  assert.deepEqual(calls, [["dialog", "codex-pal", "Cloud persona"]]);
});

test("opening a bot conversation preserves existing cloud runtime kind", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const socialSource = fs.readFileSync(path.join(root, "src/renderer/social/social.js"), "utf8");

  assert.match(socialSource, /function botConversationForKey\(botKey\)/);
  assert.match(appSource, /const existingConversation = window\.miaSocial\?\.botConversationForKey\?\.\(key\)/);
  assert.match(appSource, /if \(existingConversation\?\.id\)/);
  assert.match(appSource, /window\.miaSocial\.setActiveConversationId\(existingConversation\.id\)/);
});

test("discover contacts capsule exposes pending friend request badge", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const botStoreCss = fs.readFileSync(path.join(root, "src/renderer/styles/bot-store.css"), "utf8");

  assert.match(appSource, /data-discover-unread="contacts"/);
  assert.match(appSource, /function syncDiscoverModeUnread\(incomingCount\)/);
  assert.match(appSource, /syncDiscoverModeUnread\(incomingCount\)/);
  assert.match(appSource, /联系人，\$\{count\} 个新好友请求/);
  assert.match(botStoreCss, /\.discover-mode-unread\s*\{/);
  assert.match(botStoreCss, /\.discover-mode-unread\.hidden\s*\{/);
});

test("settings is a workspace view instead of a drawer", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.doesNotMatch(appSource, /let settingsDrawerHideTimer/);
  assert.doesNotMatch(appSource, /function closeSettingsDrawer/);
  assert.match(appSource, /function openSettingsView\(tab = state\.activeSettingsTab\)/);
  assert.doesNotMatch(appSource, /function closeSettingsView/);
  assert.match(appSource, /state\.activeView = "settings";/);
  assert.doesNotMatch(appSource, /state\.lastMainView/);
  assert.doesNotMatch(appSource, /els\.closeSettings/);
});

test("bot runtime controls resolve identity from the canonical bot directory", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.match(appSource, /function activeBotRuntimeControlContext\(\)/);
  assert.match(appSource, /const bots = allOwnedBotsForIdentity\(\);/);
  assert.match(appSource, /const bot = bots\.find\(\(item\) => \(item\.key \|\| item\.id\) === conversationContext\.botKey\) \|\| \{\};/);
  assert.doesNotMatch(appSource, /const personas = state\.runtime\?\.bots \|\| \[\];\s*const bot = personas\.find/);
});

test("renderer app state factory owns default mutable state", () => {
  const source = fs.readFileSync(path.join(root, "src/renderer/app-state.js"), "utf8");
  const localStorage = {
    getItem(key) {
      if (key === "mia.setupGuideDismissed.v2") return "1";
      if (key === "mia.agentSetupSkipped.v1") return "1";
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
  assert.equal(state.agentSetupSkipped, true);
  assert.equal(state.onboardingStep, "model");
  assert.equal(state.isNarrowWindow, true);
  assert.equal(state.sidebarWidth, 300);
  assert.deepEqual(plain(state.slashCommands), []);
  assert.deepEqual(plain(state.agentSlashCommands), { "claude-code": [], codex: [], openclaw: [] });
});
