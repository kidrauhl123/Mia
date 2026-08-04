const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("discover bot store uses a badge confirmation step without an enrollment form", () => {
  const bridge = read("src/renderer/bot/bot-store.js");
  const view = read("src/renderer/react/components/BotStore.tsx");

  assert.match(bridge, /async function addPresetBot/);
  assert.match(bridge, /enabledSkills/);
  assert.match(bridge, /function runtimeTargetOptionsRequest/);
  assert.match(bridge, /getBotRuntimeTargetOptions/);
  assert.match(bridge, /await api\(runtimeTargetOptionsRequest\(f\)\)/);
  assert.match(bridge, /title:\s*option\.title \|\| ""/);
  assert.match(bridge, /const coreTitle = String\(target\.title \|\| ""\)\.trim\(\)/);
  assert.doesNotMatch(bridge, /function runtimeTargetGroups/);
  assert.doesNotMatch(bridge, /function localRuntimeEngineIds/);
  assert.doesNotMatch(bridge, /function runtimeDeviceGroupLabel/);
  assert.doesNotMatch(bridge, /runtimeKind:\s*"cloud-claude-code"[\s\S]{0,160}agentEngine:\s*"hermes"/);
  assert.doesNotMatch(bridge, /runtimeKind:\s*"cloud-claude-code"[\s\S]{0,160}agentEngine:\s*"claude-code"/);
  assert.match(bridge, /function generateEnrollmentPrincipalId/);
  assert.match(bridge, /window\.miaIds\?\.generatePrincipalId/);
  assert.match(bridge, /function defaultConversationTagName/);
  assert.match(bridge, /setConversationTagNames\(\s*conversationId,\s*\[defaultConversationTagName\(f\)\]\s*\)/);
  assert.match(bridge, /target = normalizeRuntimeTarget\(await defaultEnrollmentTarget\(f\)\)/);
  assert.match(bridge, /runtimeKind:\s*target\.runtimeKind/);
  assert.match(bridge, /agentEngine:\s*target\.agentEngine/);
  assert.match(bridge, /targetDeviceId:\s*target\.deviceId/);
  assert.match(bridge, /targetDeviceName:\s*target\.deviceName/);
  assert.match(bridge, /category:\s*defaultConversationTagName\(f\)/);
  assert.match(bridge, /key,\s*\n\s*name: f\.name/);
  assert.match(bridge, /function principalId/);
  assert.match(view, /bot-store-badge-card/);
  assert.match(view, /MIA · AI 助手凭证/);
  assert.match(view, /onClick=\{add\}/);
  assert.match(view, /onClick=\{confirm\}/);
  assert.match(view, /host\.classList\.toggle\("is-stamped", sheet\.stamped\)/);
  assert.doesNotMatch(bridge, /function openEnrollmentStep/);
  assert.doesNotMatch(bridge, /function setupFieldsHtml/);
  assert.doesNotMatch(bridge, /data-assistant-setup-field/);
  assert.doesNotMatch(bridge, /data-runtime-target-picker/);
  assert.doesNotMatch(bridge, /data-engine-toggle/);
  assert.doesNotMatch(bridge, /classList\.toggle\("is-engine-open"\)/);
  assert.doesNotMatch(bridge, /speak-partner/);
  assert.doesNotMatch(bridge, /key:\s*principalId\(f\)/);
  assert.doesNotMatch(bridge, /credentialId/);
  assert.doesNotMatch(bridge, /MIA-\$\{/);
});

test("bot runtime target UI uses Core options for dialog, contacts, and store enrollment", () => {
  const store = read("src/renderer/bot/bot-store.js");
  const dialog = read("src/renderer/bot/bot-dialog.js");
  const manager = read("src/renderer/bot/bot-manager.js");

  assert.match(store, /getBotRuntimeTargetOptions/);
  assert.match(store, /runtimeTargetOptionsRequest/);
  const storeTargetOptionsRequest = store.slice(
    store.indexOf("function runtimeTargetOptionsRequest"),
    store.indexOf("function runtimeTargetFromCoreOption")
  );
  assert.match(storeTargetOptionsRequest, /targetIntent/);
  assert.doesNotMatch(storeTargetOptionsRequest, /runtimeConfig/);
  assert.doesNotMatch(store, /runtime\.engineInstalled \|\| runtime\.engineRunning/);
  assert.doesNotMatch(store, /if \(!engines\.length\) engines\.push/);
  assert.match(dialog, /getBotRuntimeTargetOptions/);
  assert.match(dialog, /dialogRuntimeTargetOptionsCache/);
  const dialogTargetOptionsRequest = dialog.slice(
    dialog.indexOf("function runtimeTargetBotSnapshot"),
    dialog.indexOf("function runtimeTargetOptionsKey")
  );
  assert.match(dialogTargetOptionsRequest, /targetIntent/);
  assert.doesNotMatch(dialogTargetOptionsRequest, /runtimeConfig/);
  assert.doesNotMatch(dialog, /function editableBridgeDeviceOptions/);
  assert.doesNotMatch(dialog, /function runtimeDeviceGroupLabel/);
  assert.doesNotMatch(dialog, /function runtimeDeviceDisplayName/);
  assert.doesNotMatch(dialog, /function normalizedDevice/);
  assert.doesNotMatch(dialog, /function mergeDeviceEngines/);
  assert.doesNotMatch(dialog, /function mergeDevices/);
  assert.doesNotMatch(dialog, /function localDeviceOption/);
  assert.doesNotMatch(dialog, /function bridgeDeviceOptions/);
  assert.doesNotMatch(dialog, /function deviceEngineIds/);
  assert.doesNotMatch(dialog, /function detectedAgentEngineOptions/);
  assert.doesNotMatch(dialog, /agentInventory\?\.agents|agentInventorySummary|runtime\.agentEngines|runtime\.engineInstalled|runtime\.engineRunning/);
  assert.match(manager, /getBotRuntimeTargetOptions/);
  assert.doesNotMatch(manager, /function localRuntimeEngineIds/);
});

test("bot creation opens immediately and guides empty local Agent setups", () => {
  const app = read("src/renderer/app.js");
  const controller = read("src/renderer/bot/bot-dialog.js");
  const main = read("src/renderer/react/main.tsx");
  const dialogs = read("src/renderer/react/components/Dialogs.tsx");
  const dialogStore = read("src/renderer/react/stores/dialogs.ts");
  const css = read("src/renderer/styles/bot-dialog.css");
  const shellCss = read("src/renderer/styles.css");
  const html = read("src/renderer/index.html");

  const addBotHandler = app.slice(
    app.indexOf('els.addBot?.addEventListener("click"'),
    app.indexOf('els.convMenuNewGroup?.addEventListener("click"')
  );
  const contactAddBotHandler = app.slice(
    app.indexOf('els.contactMenuAddBot?.addEventListener("click"'),
    app.indexOf('els.contactMenuNewGroup?.addEventListener("click"')
  );
  assert.match(addBotHandler, /window\.miaBotDialog\.openBotDialog\(\)/);
  assert.doesNotMatch(addBotHandler, /renderView\(\)/);
  assert.match(contactAddBotHandler, /window\.miaBotDialog\.openBotDialog\(\)/);
  assert.doesNotMatch(contactAddBotHandler, /renderView\(\)/);

  assert.match(main, /const dialogPortalsModule = import\("\.\/components\/Dialogs"\)/);
  assert.match(main, /const DialogPortals = lazy\(\(\) => dialogPortalsModule\)/);
  assert.match(main, /fallback=\{<DialogLoadingFallback \/>\}/);
  assert.match(controller, /localAgentSetupRequired/);
  assert.match(controller, /openModelSettings/);
  assert.match(controller, /runtimeSetupRequired/);
  assert.match(controller, /actualBot && window\.miaBotDirectory\?\.isCloudIdentityBot\?\.\(actualBot\)/);
  assert.match(dialogStore, /openModelSettings: \(\) => void/);
  assert.match(dialogs, /本机尚未启用 Agent/);
  assert.match(dialogs, /请前往“设置 → 模型”启用 Mia 稳定版。/);
  assert.match(dialogs, /前往模型设置/);
  assert.match(dialogs, /重新检测/);
  assert.match(dialogStore, /retryRuntime: \(\) => void/);
  assert.match(css, /\.bot-runtime-setup/);
  assert.match(shellCss, /body\.platform-win32 \.bot-dialog\s*\{\s*z-index:\s*82;/);
  assert.match(shellCss, /body\.platform-win32 \.composer-select-menu\s*\{\s*z-index:\s*84;/);
  assert.match(html, /styles\/bot-dialog\.css/);
});

test("discover bot store is framed as assistants, not coworkers", () => {
  const tabs = read("src/renderer/react/components/SectionTabs.tsx");
  const bridge = read("src/renderer/bot/bot-store.js");
  const view = read("src/renderer/react/components/BotStore.tsx");

  assert.match(tabs, /\["bot-store", "发现 AI 助手"\]/);
  assert.match(tabs, /data-discover-mode=\{view\}/);

  assert.doesNotMatch(tabs, /发现 AI 同事|AI 同事列表/);
  assert.match(view, /AI 助手入库/);
  assert.match(view, /MIA · AI 助手凭证/);
  assert.doesNotMatch(bridge, /AI 同事|入职/);
  assert.doesNotMatch(view, /AI 同事|入职/);
});

test("discover bot store detail sheet stays compact, form-free, and keeps the badge flow", () => {
  const css = read("src/renderer/styles/bot-store.css");

  assert.match(css, /\.bot-store-sheet-head/);
  assert.match(css, /\.bot-store-sheet-section/);
  assert.match(css, /\.bot-store-enroll-console/);
  assert.match(css, /\.bot-store-badge-card/);
  assert.match(css, /\.bot-store-badge-stamp/);
  assert.match(css, /\.bot-store-sheet\.is-enrolling/);
  assert.doesNotMatch(css, /\.bot-store-engine-picker/);
  assert.doesNotMatch(css, /\.bot-store-setup-/);
  assert.doesNotMatch(css, /\.bot-store-badge-target-select/);
  assert.match(css, /\.bot-store-actions\s*\{[\s\S]*?justify-content:\s*flex-end;/);
  assert.match(css, /\.bot-store-btn\s*\{[\s\S]*?height:\s*38px;/);
  assert.match(css, /\.bot-store-btn\.primary\s*\{[\s\S]*?flex:\s*0 0 auto;/);
});

test("bot store sheets have explicit and standard dismissal controls", () => {
  const bridge = read("src/renderer/bot/bot-store.js");
  const view = read("src/renderer/react/components/BotStore.tsx");
  const css = read("src/renderer/styles/bot-store.css");

  assert.match(view, /function SheetCloseButton/);
  assert.match(view, /className="bot-store-sheet-close"/);
  assert.match(view, /aria-label="关闭"/);
  assert.match(view, /onClick=\{close\}/);
  assert.match(bridge, /if \(event\.target === els\.botStoreScrim\) closeSheet\(\)/);
  assert.match(bridge, /event\.key === "Escape"/);
  assert.match(bridge, /els\.botStoreScrim\?\.classList\.contains\("open"\)/);
  assert.match(view, /<SheetCloseButton close=\{close\} \/>/);
  assert.match(css, /\.bot-store-sheet-close\s*\{/);
  assert.match(css, /\.bot-store-sheet-close svg\s*\{/);
  assert.match(css, /\.bot-store-sheet-head\s*\{[\s\S]*?padding-right:\s*42px;/);
});

test("official assistant templates are natural assistants, not skill wrappers", () => {
  const library = JSON.parse(read("resources/official-library/library.json"));
  const presets = Array.isArray(library.botPresets) ? library.botPresets : [];

  assert.equal(presets.length, 8);
  assert.deepEqual(presets.map((item) => item.name), [
    "课程助教",
    "项目汇报负责人",
    "实验记录管理员",
    "求职投递管家",
    "个人事务秘书",
    "代码仓库维护员",
    "公开情报官",
    "跑团故事主持"
  ]);
  assert.ok(presets.every((item) => typeof item.responsibility === "string" && item.responsibility.trim()));
  assert.ok(presets.every((item) => !/长期上下文/.test(`${item.line} ${item.responsibility} ${item.description}`)));
  assert.ok(presets.filter((item) => /长期/.test(`${item.line} ${item.responsibility} ${item.description}`)).length <= 2);
  assert.ok(presets.every((item) => !Object.prototype.hasOwnProperty.call(item, "setupPrompt")));
  assert.ok(presets.every((item) => !Object.prototype.hasOwnProperty.call(item, "setup")));
  assert.ok(presets.every((item) => Array.isArray(item.contextBindings) && item.contextBindings.length > 0));
  assert.ok(presets.every((item) => Array.isArray(item.handoffExamples) && item.handoffExamples.length >= 3));
  assert.ok(presets.every((item) => /不要求用户填写表格|不要要求用户填写表格/.test(item.persona)));
  assert.ok(presets.every((item) => Array.isArray(item.capabilities?.enabledSkills) && item.capabilities.enabledSkills.length > 0));
  assert.ok(presets.every((item) => item.avatar && typeof item.avatar.emoji === "string" && item.avatar.emoji.trim()));
  assert.ok(presets.every((item) => item.avatar && typeof item.avatar.token === "string" && item.avatar.token.trim()));
  assert.ok(presets.every((item) => !/^[\u4e00-\u9fff]$/.test(item.avatar.emoji)));
  assert.equal(presets.some((item) => ["论文搭子", "表格整理师", "汇报设计师", "文档编辑", "会议纪要官", "剧情主持"].includes(item.name)), false);
  assert.equal(presets.some((item) => item.key === "speak-partner"), false);
  assert.equal(presets.every((item) => !Object.prototype.hasOwnProperty.call(item, "tags")), true);
  assert.equal(presets.every((item) => !Object.prototype.hasOwnProperty.call(item, "roleTitle")), true);
});

test("bot store fallback presets and category order match the first-release assistant taxonomy", () => {
  const src = read("src/renderer/bot/bot-store.js");
  const fallbackBlock = src.match(/const FALLBACK_PRESETS = \[(.*?)\n  \];/s)?.[1] || "";

  assert.match(src, /const CATEGORY_ORDER = \["学习", "项目", "事务", "代码", "情报", "娱乐", "推荐"\];/);

  for (const name of ["课程助教", "项目汇报负责人", "实验记录管理员", "求职投递管家", "个人事务秘书", "代码仓库维护员", "公开情报官", "跑团故事主持"]) {
    assert.match(fallbackBlock, new RegExp(name));
  }

  for (const stale of ["论文搭子", "表格整理师", "汇报设计师", "文档编辑", "会议纪要官", "剧情主持"]) {
    assert.doesNotMatch(fallbackBlock, new RegExp(stale));
  }

  assert.match(fallbackBlock, /runtimeRecommendation:\s*"desktop-local"/);
  assert.match(fallbackBlock, /runtimeRecommendation:\s*"cloud-or-desktop"/);
  assert.doesNotMatch(fallbackBlock, /setupPrompt:/);
  assert.doesNotMatch(fallbackBlock, /setup:\s*\{\s*fields:/);
  assert.match(fallbackBlock, /contextBindings:/);
  assert.match(fallbackBlock, /handoffExamples:/);
  assert.match(fallbackBlock, /avatar:\s*\{\s*emoji:/);
  assert.match(fallbackBlock, /token:\s*"books"/);
  assert.match(fallbackBlock, /mia-scheduler/);
});

test("discover bot store presents assistant templates as context contacts", () => {
  const bridge = read("src/renderer/bot/bot-store.js");
  const view = read("src/renderer/react/components/BotStore.tsx");

  assert.match(bridge, /window\.miaAssistantTemplate/);
  assert.match(bridge, /assistantDisplayDescription\(f\)/);
  assert.match(view, /bot-store-card-description/);
  assert.match(view, />添加</);
  assert.match(view, />描述</);
  assert.match(view, />技能</);
  assert.match(view, /bot-store-sheet-skills/);
  assert.match(view, /bot-store-skill-chip/);
  assert.doesNotMatch(view, />添加并设置</);
  assert.doesNotMatch(view, />适合</);
  assert.doesNotMatch(view, />预设技能</);
  assert.doesNotMatch(view, /bot-store-card-skills/);
  assert.doesNotMatch(bridge, /assistantBestFor/);
  assert.doesNotMatch(bridge, /bestFor:/);
  assert.doesNotMatch(bridge, /"bestFor"/);
  assert.doesNotMatch(bridge, /长期负责：/);
  assert.doesNotMatch(bridge, /第一次需要：/);
  assert.doesNotMatch(bridge, /长期联系人/);
  assert.doesNotMatch(view, /bot-store-template-meta/);
  assert.doesNotMatch(view, /bot-store-demo/);
});

test("official assistant cards use visible emoji avatars instead of generated SVG placeholders", () => {
  const bridge = read("src/renderer/bot/bot-store.js");
  const view = read("src/renderer/react/components/BotStore.tsx");

  assert.match(bridge, /function assistantAvatarEmojiToken/);
  assert.match(bridge, /function assistantAvatarEmoji/);
  assert.match(bridge, /function assistantAvatarImage/);
  assert.match(bridge, /`emoji:\$\{token\}`/);
  assert.match(view, /bot-store-avatar-emoji/);
  assert.match(view, /\{emoji \? <span/);
  assert.doesNotMatch(view, /data-lottie=/);
  assert.doesNotMatch(view, /bot-store-avatar-lottie/);
  assert.doesNotMatch(bridge, /const ASSISTANT_AVATAR_ICONS = Object\.freeze/);
  assert.doesNotMatch(bridge, /data:image\/svg\+xml;charset=utf-8/);
  assert.doesNotMatch(view, /bot-store-avatar-img/);
});

test("assistant store renders only real resolved preset skills as visible detail chips", () => {
  const library = JSON.parse(read("resources/official-library/library.json"));
  const bridge = read("src/renderer/bot/bot-store.js");
  const view = read("src/renderer/react/components/BotStore.tsx");

  const presets = Array.isArray(library.botPresets) ? library.botPresets : [];
  assert.ok(presets.every((item) => Array.isArray(item.capabilities?.enabledSkills) && item.capabilities.enabledSkills.length > 0));
  assert.match(bridge, /capabilities:\s*f\.capabilities \|\| \{\}/);
  assert.match(bridge, /function enabledSkillIds\(f = \{\}\)/);
  assert.match(bridge, /function resolvedSkillRecords\(f = \{\}\)/);
  assert.match(bridge, /state\?\.skillLibrary\?\.skills/);
  assert.match(bridge, /item\.id === id \|\| item\.name === id/);
  assert.match(bridge, /window\.miaSkillHelpers\?\.skillDisplayName/);
  assert.match(view, /bot-store-sheet-skills/);
  assert.match(view, /bot-store-skill-chip/);
  assert.match(view, />技能</);
  assert.doesNotMatch(view, /bot-store-card-skills/);
  assert.doesNotMatch(view, />预设技能</);
  assert.doesNotMatch(bridge, /const SKILL_LABELS/);
  assert.doesNotMatch(bridge, /未配置 Skill/);
  assert.doesNotMatch(bridge, /SKILL_LABELS\[id\]/);
  assert.doesNotMatch(view, /bot-store-skill-more/);
});

test("assistant enrollment saves without asking the user to fill setup fields", () => {
  const bridge = read("src/renderer/bot/bot-store.js");
  const view = read("src/renderer/react/components/BotStore.tsx");

  assert.match(bridge, /function addPresetBot/);
  assert.match(bridge, /function addBot/);
  assert.match(view, /bot-store-enroll-console/);
  assert.match(view, /bot-store-badge-card/);
  assert.match(view, /onClick=\{confirm\}/);
  assert.match(view, /"确认"/);
  assert.match(view, /host\.classList\.toggle\("is-stamped", sheet\.stamped\)/);
  assert.match(bridge, /assistantPersonaText\(f,\s*\{\}\)/);
  assert.match(bridge, /assistantDescription\(f,\s*\{\}\)/);
  assert.match(bridge, /description:\s*assistantDescription\(f,\s*\{\}\)/);
  assert.match(bridge, /personaText:\s*assistantPersonaText\(f,\s*\{\}\)/);
  assert.match(bridge, /avatarImage:\s*avatarImage/);
  assert.match(bridge, /avatarCrop:\s*assistantAvatarCrop\(avatarImage\)/);
  assert.match(bridge, /const avatarImage = assistantAvatarImage\(f\)/);
  assert.match(bridge, /function assistantAvatarCrop/);
  assert.match(bridge, /const key = String\(plannedKey \|\| ""\)\.trim\(\);\s*if \(!key\) throw new Error\("AI 助手账号 ID 缺失。"\);/s);
  assert.doesNotMatch(bridge, /function setupFieldsHtml/);
  assert.doesNotMatch(bridge, /function readAssistantSetupValues/);
  assert.doesNotMatch(bridge, /data-assistant-setup-field/);
  assert.doesNotMatch(bridge, /data-runtime-target-select/);
  assert.doesNotMatch(bridge, /throw new Error\(".*课程名/);
  assert.doesNotMatch(bridge, /required[^;]+checkValidity/);
  assert.doesNotMatch(bridge, /setupValues/);
});
