const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");

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

test("settings exposes manual update checks through the preload bridge", () => {
  const htmlSource = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const preloadSource = fs.readFileSync(path.join(root, "src/preload.js"), "utf8");
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");

  assert.match(htmlSource, /id="checkUpdates"/);
  assert.match(htmlSource, /id="appUpdateHint"/);
  assert.match(appSource, /window\.mia\.checkForUpdates\(\)/);
  assert.match(preloadSource, /checkForUpdates:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(IpcChannel\.UpdateCheck\)/);
  assert.match(mainSource, /ipcMain\.handle\(IpcChannel\.UpdateCheck,\s*\(\)\s*=>\s*autoUpdateService\.checkForUpdates\(\)\)/);
});

test("cloud conversation send and render do not depend on activeKey being empty", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.doesNotMatch(appSource, /getActiveConversationId\?\.\(\) && !state\.activeKey/);
  assert.doesNotMatch(appSource, /activeConversationId && !state\.activeKey/);
});

test("onboarding wizard init wires the async agent-scan deps", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  // The prepare step's progress loading page depends on these being passed in;
  // omitting them silently skips the scan (startScan awaits undefined).
  assert.match(appSource, /scanAgents:\s*\(\)\s*=>\s*window\.mia\.scanAgents/);
  assert.match(appSource, /onScanProgress:\s*\(cb\)\s*=>\s*window\.mia\.onAgentScanProgress/);
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
  assert.doesNotMatch(htmlSource, /正在准备 Mia/);
  assert.doesNotMatch(htmlSource, /正在创建本地 runtime/);
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

  const chatButton = htmlSource.match(/<button class="rail-button active"[\s\S]*?data-view="chat"[\s\S]*?<\/button>/)?.[0] || "";
  assert.match(chatButton, /data-lottie="chat"/);
  assert.match(chatButton, /data-lottie-rest="60"/);
  assert.match(chatButton, /data-lottie-play="70,130"/);
  assert.doesNotMatch(chatButton, /data-lottie-trigger="static"/);
  assert.doesNotMatch(chatButton, /data-lottie="forum"/);

  for (const name of ["contacts", "extension", "checklist", "settings"]) {
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
  assert.match(nameBadgeSource, /localJsonAssetIds = new Set\(\["rainbow"\]\)/);
  assert.match(nameBadgeSource, /localTgsAssetIds = new Set\(\["surprised-cat"\]\)/);
  assert.match(nameBadgeSource, /shouldUseLocalAsset/);
  assert.match(nameBadgeSource, /data-lottie-format", "tgs"/);
  assert.doesNotMatch(nameBadgeSource, /data-lottie-fallback/);
});

test("refreshRuntime bootstraps social when cloud status arrives after startup", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const refreshRuntime = extractFunctionSource(appSource, "refreshRuntime");
  const maybeBootstrap = extractFunctionSource(appSource, "maybeBootstrapSocialAfterRuntime");

  assert.match(refreshRuntime, /maybeBootstrapSocialAfterRuntime\(runtime\)/);
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
  assert.match(appSource, /trackStartupTask\("启动后台服务",\s*\(\) => window\.mia\.startupBackgroundServices\(\)\)/);
  assert.match(appSource, /window\.miaStartupOverlay\?\.setWelcome\?\.\(\)/);
  assert.match(appSource, /window\.miaStartupOverlay\?\.finish\?\.\(\)/);
});

test("renderer exposes official Hermes install actions without private install wording", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.match(appSource, /install-hermes/);
  assert.match(appSource, /repair-hermes/);
  assert.match(appSource, /retry-install-hermes/);
  assert.match(appSource, /runHermesSetupAction/);
  assert.match(appSource, /安装官方 Hermes/);
  assert.doesNotMatch(appSource, /可安装到 Mia 私有目录|Mia 私有 Hermes|独立 Hermes|随安装包内置|使用 Mia 私有配置和记忆/);
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
      function botAvatarIdentityId(ref) { return "botc_user_me_" + ref; }
      function formatRunTime() { return ""; }
      function renderMessageTime() { return ""; }
      function renderCommandResultHtml() { return ""; }
      function generatedAttachmentsForMessage() { return []; }
      function hydrateAttachmentPreview(value) { return value; }
      function renderAttachmentChips() { return ""; }
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

test("sidebar card specs carry identity status badges when available", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const conversationCardSpecFromRow = eval(`(
    function () {
      const state = {};
      const window = {
        miaSocial: {
          getActiveConversationId: () => "",
          isConversationPinned: () => false,
          isConversationMuted: () => false,
          getUnreadForConversation: () => 0,
          getConversationMembers: () => [],
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
      const ownedBots = [{ key: "mia", id: "mia", name: "Mia", statusBadge: { kind: "emoji", emoji: "⭐", label: "Premium" } }];
      function allOwnedBotsForIdentity() { return ownedBots; }
      function botGlobalIdFromConversation() { return "bot_global"; }
      function botAvatarIdentityId() { return "bot_global"; }
      function formatConversationTime() { return ""; }
      function groupTilesCtx() { return {}; }
      function showNarrowContent() {}
      function render() {}
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
  assert.deepEqual(groupSpec.statusBadge, badge);
});

test("desktop cloud human and group conversations hide the chat history session selector", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.match(appSource, /const activeIsGroup = activeCloudConversationType === "group";/);
  assert.match(appSource, /const activeIsHumanDm = activeCloudConversationType === "dm";/);
  assert.match(appSource, /const hideSessionSelector = activeIsGroup \|\| activeIsHumanDm;/);
  assert.match(appSource, /if \(hideSessionSelector\) state\.sessionMenuOpen = false;/);
  assert.match(appSource, /sessionMenuButton\.classList\.toggle\("hidden",\s*hideSessionSelector\)/);
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

  assert.match(mainSource, /acceptFirstMouse:\s*true/);
  assert.match(mainSource, /function shouldOpenAgentSetupWindow/);
  assert.doesNotMatch(mainSource, /fellows\.length === 0/);
  assert.match(mainSource, /const onboardingWidth = 460;/);
  assert.match(mainSource, /const onboardingHeight = 680;/);
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
  assert.match(mainSource, /const minWindowWidth = onboarding \? 400 : 500;/);
  assert.match(mainSource, /const minWindowHeight = onboarding \? 560 : 560;/);
  assert.match(mainSource, /getRuntimeStatus\(created,\s*\{\s*scanAgents:\s*false\s*\}\)/);
  assert.match(ipcSource, /WindowShowMain:\s*"window:show-main"/);
  assert.match(ipcSource, /WindowOnboarding:\s*"window:onboarding"/);
  assert.match(ipcSource, /WindowSignedOutOnboarding:\s*"window:signed-out-onboarding"/);
  assert.match(preloadSource, /showMain: \(\) => ipcRenderer\.invoke\(IpcChannel\.WindowShowMain\)/);
  assert.match(preloadSource, /onboarding: \(\) => ipcRenderer\.invoke\(IpcChannel\.WindowOnboarding\)/);
  assert.match(preloadSource, /signedOutOnboarding: \(\) => ipcRenderer\.invoke\(IpcChannel\.WindowSignedOutOnboarding\)/);
  assert.match(windowIpcSource, /setMinimumSize\(420,\s*560\)/);
  assert.match(windowIpcSource, /setSize\(1040,\s*700\)/);
  // Compact onboarding window driven from the renderer.
  assert.match(windowIpcSource, /IpcChannel\.WindowOnboarding/);
  assert.match(windowIpcSource, /setSize\(460,\s*680\)/);
});

test("agent setup completion does not force first bot creation", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const setupSource = fs.readFileSync(path.join(root, "src/renderer/onboarding/setup-guide.js"), "utf8");
  const appStateSource = fs.readFileSync(path.join(root, "src/renderer/app-state.js"), "utf8");

  assert.match(appStateSource, /readLocal\(storage, "mia\.onboardingStep", ""\)/);
  assert.match(appSource, /agentSetupLaunch/);
  assert.match(appSource, /function completeAgentSetup/);
  assert.match(appSource, /window\.mia\.window\?\.showMain\?\.\(\)/);
  assert.doesNotMatch(appSource, /advanceOnboarding\("create-fellow"\)/);
  assert.doesNotMatch(setupSource, /创建你的第一个伙伴/);
});

test("first-run onboarding cannot enter Mia while an engine install is running", () => {
  const wizardSource = fs.readFileSync(path.join(root, "src/renderer/onboarding/onboarding-wizard.js"), "utf8");
  const standaloneSource = fs.readFileSync(path.join(root, "src/renderer/onboarding/onboarding-window.js"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const standaloneStyles = fs.readFileSync(path.join(root, "src/renderer/onboarding/onboarding.css"), "utf8");
  const appStyles = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");

  assert.match(wizardSource, /function isSetupInstallInFlight\(\)/);
  assert.match(wizardSource, /data-onb-action="finish"[^`]*\$\{isSetupInstallInFlight\(\) \? " disabled" : ""\}/);
  assert.match(wizardSource, /if\s*\(action === "finish"\)\s*\{[\s\S]*?if\s*\(isSetupInstallInFlight\(\)\)\s*return;[\s\S]*?deps\.finish\?\.\(\);[\s\S]*?\}/);

  assert.match(standaloneSource, /function hasActiveInstall\(\)/);
  assert.match(standaloneSource, /data-action="finish"[^`]*\$\{hasActiveInstall\(\) \? " disabled" : ""\}/);
  assert.match(standaloneSource, /else if\s*\(action === "finish"\)\s*\{[\s\S]*?if\s*\(hasActiveInstall\(\)\)\s*return;[\s\S]*?mia\.onboardingComplete\?\.\(\);[\s\S]*?\}/);

  assert.match(appSource, /state\.agentSetupInstallInFlight = true;/);
  assert.match(appSource, /state\.agentSetupInstallInFlight = false;/);
  assert.match(appSource, /if\s*\(state\.agentSetupInstallInFlight\)\s*return true;/);
  assert.match(wizardSource, /wechatIconSvg/);
  assert.match(standaloneSource, /wechatIconSvg/);
  assert.match(wizardSource, /wechat-login-cta/);
  assert.match(standaloneSource, /wechat-login-cta/);
  assert.match(wizardSource, /action:\s*"start"/);
  assert.match(wizardSource, /action:\s*"complete"/);
  assert.match(wizardSource, /onb-login-qr-card/);
  assert.match(standaloneSource, /action:\s*"start"/);
  assert.match(standaloneSource, /action:\s*"complete"/);
  assert.match(standaloneSource, /onb-qr-card/);
  assert.match(standaloneStyles, /--wechat-green:\s*#07c160/);
  assert.match(standaloneStyles, /\.onb-qr-card/);
  assert.match(appStyles, /\.setup-cta\.wechat-login-cta[\s\S]*background:\s*#07c160/);
  assert.match(appStyles, /\.onb-login-qr-card/);
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

test("agent permission banner blends into the composer and keeps allow buttons compact", () => {
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

  assert.doesNotMatch(block, /border:/);
  assert.doesNotMatch(block, /border-radius:/);
  assert.doesNotMatch(block, /background:/);
  assert.doesNotMatch(block, /box-shadow:/);
  assert.match(block, /gap:\s*6px;/);
  assert.match(block, /padding:\s*4px 0 2px;/);
  assert.match(allowButtons, /width:\s*64px;/);
  assert.match(allowButtons, /min-height:\s*26px;/);
  assert.doesNotMatch(primary, /min-width:/);
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
  assert.match(appSource, /window\.miaBotCommands\.saveBotRuntimeControl\(\{/);
  assert.match(appSource, /window\.miaBotCommands\.getBotRuntimeBinding\(\{/);
  assert.doesNotMatch(appSource, new RegExp("window\\.mia\\.social\\.save" + "BotRuntime\\(context\\." + "fellow" + "Key"));
  assert.doesNotMatch(appSource, /async function saveActiveCloudBotRuntimeConfig/);
  assert.match(commandsSource, /async function saveBotRuntimeControl/);
  assert.doesNotMatch(commandsSource, /async function saveDesktopLocalBotRuntimeControl/);
  assert.match(commandsSource, /saveBotRuntimeConfig\(\{ api, cache, botKey: key, runtimeKind: kind, patch \}\)/);
  assert.match(quickControlSource, /saveActiveBotRuntimeControl\(\s*"model"/);
  assert.match(quickControlSource, /saveActiveBotRuntimeControl\(\s*"effortLevel"/);
  assert.match(quickControlSource, /saveActiveBotRuntimeControl\(\s*"permissionMode"/);
  assert.doesNotMatch(quickControlSource, /window\.mia\.saveFellowEngine\(/);
  assert.doesNotMatch(quickControlSource, /window\.mia\.saveModel\(/);
  assert.doesNotMatch(quickControlSource, /window\.mia\.saveEffort\(/);
  assert.doesNotMatch(quickControlSource, /window\.mia\.savePermissions\(/);
  assert.match(appSource, /const conversationPersona = personas\.find[\s\S]*if \(conversationPersona\) return conversationPersona;\s*return null;/);
});

test("desktop-local bot runtime controls read cloud runtime bindings", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const body = appSource.slice(
    appSource.indexOf("function syncConversationBotRuntimeControls()"),
    appSource.indexOf("function setRuntimeControlDisabled")
  );
  const runtimeFetchBlock = body.slice(body.indexOf("const runtimeCacheKey = botRuntimeCacheKey"));

  assert.match(appSource, /const botRuntimeControlInFlight = new Set\(\);/);
  assert.doesNotMatch(runtimeFetchBlock, /context\.runtimeKind === "cloud-hermes"/);
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

test("cloud-only: the sidebar message list is built from social rows alone", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

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

  assert.match(mainSource, /function localDeviceName\(\)/);
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
  assert.match(botManagerSource, /aliases:\s*\[/);
  assert.match(botManagerSource, /\(device\?\.aliases \|\| \[\]\)\.includes\(active\.deviceId\)/);
  assert.match(botManagerSource, /engine-row-logo contact-engine-logo/);
  assert.match(botManagerSource, /botDeviceLabel\(bot\)/);
  assert.match(botManagerSource, /RUNTIME_DEVICE_REFRESH_INTERVAL_MS/);
  assert.doesNotMatch(botManagerSource, /"本地伙伴"/);
  assert.match(styleSource, /\.contact-engine-badge \.contact-engine-logo/);
  assert.match(styleSource, /\.contact-runtime-target/);
  assert.match(styleSource, /\.contact-runtime-target > summary/);
  assert.match(styleSource, /\.accordion-details > \.accordion-body/);
  assert.match(styleSource, /\.runtime-target-option\.selected/);
});

test("profile and account surfaces expose uid fields", () => {
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const remoteSettingsSource = fs.readFileSync(path.join(root, "src/renderer/settings/settings-remote.js"), "utf8");
  const botManagerSource = fs.readFileSync(path.join(root, "src/renderer/bot/bot-manager.js"), "utf8");

  assert.match(html, /id="profileDialogTitle">个人资料</);
  assert.doesNotMatch(html, /id="profileDialogTitle">编辑个人资料</);
  assert.match(html, /id="profileUidValue"/);
  assert.match(html, /id="profileNameText"/);
  assert.match(html, /id="profileStatusBadge"/);
  assert.match(html, /id="profileStatusBadgeDetails"/);
  assert.match(html, /id="profileStatusBadgeTrigger"/);
  assert.match(html, /id="botNameText"/);
  assert.match(html, /id="botStatusBadge"/);
  assert.match(html, /id="botStatusBadgeDetails"/);
  assert.match(html, /id="botStatusBadgeTrigger"/);
  assert.match(html, /value="surprised-cat">惊讶猫/);
  assert.match(html, /data-lottie-format="tgs"/);
  assert.doesNotMatch(html, /data-lottie-fallback/);
  assert.doesNotMatch(html, /profileStatusBadgeTrigger"[^>]*title="徽章"/);
  assert.doesNotMatch(html, /botStatusBadgeTrigger"[^>]*title="徽章"/);
  assert.doesNotMatch(html, /profileStatusBadgePreview/);
  assert.match(html, /id="cloudAccountProfile"/);
  assert.match(html, /id="cloudAccountAvatar"/);
  assert.match(html, /id="cloudAccountName"/);
  assert.match(html, /id="cloudAccountUid"/);
  assert.match(appSource, /profileUidValue:\s*document\.getElementById\("profileUidValue"\)/);
  assert.match(appSource, /profileNameText:\s*document\.getElementById\("profileNameText"\)/);
  assert.match(appSource, /profileStatusBadge:\s*document\.getElementById\("profileStatusBadge"\)/);
  assert.match(appSource, /profileStatusBadgeTrigger:\s*document\.getElementById\("profileStatusBadgeTrigger"\)/);
  assert.match(appSource, /botNameText:\s*document\.getElementById\("botNameText"\)/);
  assert.match(appSource, /botStatusBadge:\s*document\.getElementById\("botStatusBadge"\)/);
  assert.match(appSource, /statusBadgeForPreset/);
  assert.match(appSource, /surprised-cat/);
  assert.match(appSource, /function setNameWithBadge/);
  assert.match(appSource, /els\.profileUidValue\.textContent = user\.id/);
  assert.match(remoteSettingsSource, /cloudAccountUid/);
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
  assert.match(badgeStyles, /#activeChatName \.name-with-badge/);
  assert.match(badgeStyles, /\.contact-card-name \.name-with-badge/);
  assert.match(badgeStyles, /\.group-info-member-name \.name-with-badge/);
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
  assert.match(appSource, /这会删除该 Bot，并清理当前账号可管理的配置和会话。/);
  assert.match(commandsSource, /async function deleteCloudHermesBot/);
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

test("bot management copy avoids cloud/local split in user-facing language", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const contactCardSource = fs.readFileSync(path.join(root, "src/renderer/social/contact-card.js"), "utf8");

  assert.doesNotMatch(appSource, /云端联系人|本地会话记录/);
  assert.doesNotMatch(contactCardSource, /不在你的本地 fellow 列表里/);
  assert.match(contactCardSource, /不属于你/);
});

test("contact capability saves go through bot command adapters", () => {
  const botManagerSource = fs.readFileSync(path.join(root, "src/renderer/bot/bot-manager.js"), "utf8");
  const commandsSource = fs.readFileSync(path.join(root, "src/renderer/bot/bot-commands.js"), "utf8");

  assert.match(botManagerSource, /window\.miaBotCommands\.saveBotCapabilities\(\{/);
  assert.doesNotMatch(botManagerSource, /window\.mia\.social\.saveFellowIdentity/);
  assert.doesNotMatch(botManagerSource, /window\.mia\.saveFellow\(\{/);
  assert.match(commandsSource, /async function saveCloudHermesBotCapabilities/);
  assert.doesNotMatch(commandsSource, /async function saveDesktopLocalBotCapabilities/);
});

test("contact capability checkboxes use official preset default capabilities", () => {
  const botManagerSource = fs.readFileSync(path.join(root, "src/renderer/bot/bot-manager.js"), "utf8");

  assert.match(botManagerSource, /botCapabilitiesWithPresetDefaults/);
  assert.match(botManagerSource, /state\?\.skillLibrary\?\.botPresets/);
});

test("bot-only contact detail renders capabilities and persona as compact accordions", () => {
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
  assert.doesNotMatch(botManagerSource, /renderHumanPersonaPanel/);
  assert.match(styleSource, /\.contact-persona-card/);
  assert.match(styleSource, /\.contact-persona-text/);
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
  assert.match(html, /运行位置和 Agent 内核/);
  assert.match(html, /helpers\/accordion\.js/);
  assert.match(html, /class="persona-details accordion-details"/);
  assert.match(html, /class="accordion-body"/);
  assert.doesNotMatch(html, /id="botRuntimeLocation"/);
  assert.doesNotMatch(html, /id="botRuntimeDevice"/);
  assert.doesNotMatch(html, /目标设备/);
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

test("bot creation branches cloud-hermes without saving local manifest", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const commandsSource = fs.readFileSync(path.join(root, "src/renderer/bot/bot-commands.js"), "utf8");

  assert.match(html, /bot\/bot-commands\.js/);
  assert.match(appSource, /window\.miaBotCommands\.saveBot\(\{/);
  assert.doesNotMatch(appSource, /async function createCloudHermesBot/);
  assert.doesNotMatch(appSource, /window\.mia\.social\.saveFellowIdentity\(key,/);
  assert.match(commandsSource, /async function saveCloudHermesBot/);
  assert.match(commandsSource, /api\.social\.saveBotIdentity\(key,/);
  assert.match(commandsSource, /runtimeKind:\s*"cloud-hermes"/);
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
  assert.equal(state.slashCommands[0].command, "/new");
  assert.notEqual(state.slashCommands, sandbox.window.miaAppState.fallbackSlashCommands);
});
