const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("discover bot store uses a badge confirmation step without an enrollment form", () => {
  const src = read("src/renderer/bot/bot-store.js");

  assert.match(src, /data-act="add"/);
  assert.match(src, /async function addPresetBot/);
  assert.match(src, /enabledSkills/);
  assert.match(src, /function runtimeTargetOptionsRequest/);
  assert.match(src, /getBotRuntimeTargetOptions/);
  assert.match(src, /await api\(runtimeTargetOptionsRequest\(f\)\)/);
  assert.match(src, /title:\s*option\.title \|\| ""/);
  assert.match(src, /const coreTitle = String\(target\.title \|\| ""\)\.trim\(\)/);
  assert.doesNotMatch(src, /function runtimeTargetGroups/);
  assert.doesNotMatch(src, /function localRuntimeEngineIds/);
  assert.doesNotMatch(src, /function runtimeDeviceGroupLabel/);
  assert.doesNotMatch(src, /runtimeKind:\s*"cloud-claude-code"[\s\S]{0,160}agentEngine:\s*"hermes"/);
  assert.doesNotMatch(src, /runtimeKind:\s*"cloud-claude-code"[\s\S]{0,160}agentEngine:\s*"claude-code"/);
  assert.match(src, /function generateEnrollmentPrincipalId/);
  assert.match(src, /window\.miaIds\?\.generatePrincipalId/);
  assert.match(src, /function defaultConversationTagName/);
  assert.match(src, /setConversationTagNames\(\s*conversationId,\s*\[defaultConversationTagName\(f\)\]\s*\)/);
  assert.match(src, /target = normalizeRuntimeTarget\(await defaultEnrollmentTarget\(f\)\)/);
  assert.match(src, /bot-store-badge-card/);
  assert.match(src, /MIA · AI 助手凭证/);
  assert.match(src, /data-act="confirm"/);
  assert.match(src, /querySelector\('\[data-act="confirm"\]'\)\.addEventListener\("click",\s*\(\)\s*=>\s*addBot\(f,\s*target,\s*sheet\.dataset\.botKey \|\| plannedKey\)\)/);
  assert.doesNotMatch(src, /return addBot\(f,\s*target,\s*plannedKey\)/);
  assert.match(src, /runtimeKind:\s*target\.runtimeKind/);
  assert.match(src, /agentEngine:\s*target\.agentEngine/);
  assert.match(src, /targetDeviceId:\s*target\.deviceId/);
  assert.match(src, /targetDeviceName:\s*target\.deviceName/);
  assert.match(src, /category:\s*defaultConversationTagName\(f\)/);
  assert.match(src, /key,\s*\n\s*name: f\.name/);
  assert.match(src, /function principalId/);
  assert.doesNotMatch(src, /data-act="prepare"/);
  assert.doesNotMatch(src, /data-act="add-progress"/);
  assert.doesNotMatch(src, /function openEnrollmentStep/);
  assert.doesNotMatch(src, /data-runtime-target-select/);
  assert.doesNotMatch(src, /function setupFieldsHtml/);
  assert.doesNotMatch(src, /data-assistant-setup-field/);
  assert.doesNotMatch(src, /data-runtime-target-picker/);
  assert.doesNotMatch(src, /data-engine-toggle/);
  assert.doesNotMatch(src, /classList\.toggle\("is-engine-open"\)/);
  assert.doesNotMatch(src, /speak-partner/);
  assert.doesNotMatch(src, /key:\s*principalId\(f\)/);
  assert.doesNotMatch(src, /credentialId/);
  assert.doesNotMatch(src, /MIA-\$\{/);
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

test("discover bot store is framed as assistants, not coworkers", () => {
  const app = read("src/renderer/app.js");
  const html = read("src/renderer/index.html");
  const store = read("src/renderer/bot/bot-store.js");

  assert.match(app, /label:\s*"发现 AI 助手"/);
  assert.match(html, />发现 AI 助手</);
  assert.match(html, /aria-label="AI 助手列表"/);

  assert.doesNotMatch(app, /发现 AI 同事/);
  assert.doesNotMatch(html, /发现 AI 同事|AI 同事列表/);
  assert.match(store, /AI 助手入库/);
  assert.match(store, /MIA · AI 助手凭证/);
  assert.doesNotMatch(store, /AI 同事|入职/);
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
  const store = read("src/renderer/bot/bot-store.js");

  assert.match(store, /window\.miaAssistantTemplate/);
  assert.match(store, /assistantDisplayDescription\(f\)/);
  assert.match(store, /bot-store-card-description/);
  assert.match(store, />添加</);
  assert.match(store, />描述</);
  assert.match(store, />技能</);
  assert.match(store, /bot-store-sheet-skills/);
  assert.match(store, /bot-store-skill-chip/);
  assert.doesNotMatch(store, />添加并设置</);
  assert.doesNotMatch(store, />适合</);
  assert.doesNotMatch(store, />预设技能</);
  assert.doesNotMatch(store, /bot-store-card-skills/);
  assert.doesNotMatch(store, /assistantBestFor/);
  assert.doesNotMatch(store, /bestFor:/);
  assert.doesNotMatch(store, /"bestFor"/);
  assert.doesNotMatch(store, /长期负责：/);
  assert.doesNotMatch(store, /第一次需要：/);
  assert.doesNotMatch(store, /长期联系人/);
  assert.doesNotMatch(store, /bot-store-template-meta/);
  assert.doesNotMatch(store, /bot-store-demo/);
  assert.doesNotMatch(store, /<p class="line">\$\{escapeHtml\(f\.line\)\}<\/p>/);
  assert.doesNotMatch(store, /<button type="button" class="bot-store-btn primary" data-act="prepare">添加<\/button>/);
});

test("official assistant cards use visible emoji avatars instead of generated SVG placeholders", () => {
  const store = read("src/renderer/bot/bot-store.js");

  assert.match(store, /function assistantAvatarEmojiToken/);
  assert.match(store, /function assistantAvatarEmoji/);
  assert.match(store, /function assistantAvatarImage/);
  assert.match(store, /`emoji:\$\{token\}`/);
  assert.match(store, /bot-store-avatar-emoji/);
  assert.doesNotMatch(store, /data-lottie=/);
  assert.doesNotMatch(store, /bot-store-avatar-lottie/);
  assert.doesNotMatch(store, /const ASSISTANT_AVATAR_ICONS = Object\.freeze/);
  assert.doesNotMatch(store, /data:image\/svg\+xml;charset=utf-8/);
  assert.doesNotMatch(store, /<img class="bot-store-avatar-img"/);
  assert.doesNotMatch(store, /\$\{f\.emoji\}<\/div>/);
});

test("assistant store renders only real resolved preset skills as visible detail chips", () => {
  const library = JSON.parse(read("resources/official-library/library.json"));
  const store = read("src/renderer/bot/bot-store.js");

  const presets = Array.isArray(library.botPresets) ? library.botPresets : [];
  assert.ok(presets.every((item) => Array.isArray(item.capabilities?.enabledSkills) && item.capabilities.enabledSkills.length > 0));
  assert.match(store, /capabilities:\s*f\.capabilities \|\| \{\}/);
  assert.match(store, /function enabledSkillIds\(f = \{\}\)/);
  assert.match(store, /function resolvedSkillRecords\(f = \{\}\)/);
  assert.match(store, /state\?\.skillLibrary\?\.skills/);
  assert.match(store, /item\.id === id \|\| item\.name === id/);
  assert.match(store, /window\.miaSkillHelpers\?\.skillDisplayName/);
  assert.match(store, /function skillSummary\(f = \{\}\)/);
  assert.match(store, /function skillChipHtml\(f = \{\}\)/);
  assert.match(store, /bot-store-sheet-skills/);
  assert.match(store, /bot-store-skill-chip/);
  assert.match(store, />技能</);
  assert.doesNotMatch(store, /bot-store-card-skills/);
  assert.doesNotMatch(store, />预设技能</);
  assert.doesNotMatch(store, /const SKILL_LABELS/);
  assert.doesNotMatch(store, /未配置 Skill/);
  assert.doesNotMatch(store, /SKILL_LABELS\[id\]/);
  assert.doesNotMatch(store, /bot-store-skill-more/);
  assert.doesNotMatch(store, />\+\$\{/);
});

test("assistant enrollment saves without asking the user to fill setup fields", () => {
  const store = read("src/renderer/bot/bot-store.js");

  assert.match(store, /function addPresetBot/);
  assert.match(store, /querySelector\('\[data-act="add"\]'\)\.addEventListener\("click",\s*\(\)\s*=>\s*addPresetBot\(f\)\)/);
  assert.match(store, /bot-store-enroll-console/);
  assert.match(store, /bot-store-badge-card/);
  assert.match(store, /data-badge-uid/);
  assert.match(store, /data-act="confirm"/);
  assert.match(store, />确认</);
  assert.match(store, /classList\.add\("is-stamped"\)/);
  assert.match(store, /data-enroll-status/);
  assert.match(store, /assistantPersonaText\(f,\s*\{\}\)/);
  assert.match(store, /assistantDescription\(f,\s*\{\}\)/);
  assert.match(store, /description:\s*assistantDescription\(f,\s*\{\}\)/);
  assert.match(store, /personaText:\s*assistantPersonaText\(f,\s*\{\}\)/);
  assert.match(store, /avatarImage:\s*avatarImage/);
  assert.match(store, /avatarCrop:\s*assistantAvatarCrop\(avatarImage\)/);
  assert.match(store, /const avatarImage = assistantAvatarImage\(f\)/);
  assert.match(store, /function assistantAvatarCrop/);
  assert.match(store, /const key = String\(plannedKey \|\| ""\)\.trim\(\);\s*if \(!key\) throw new Error\("AI 助手账号 ID 缺失。"\);/s);
  assert.doesNotMatch(store, /function setupFieldsHtml/);
  assert.doesNotMatch(store, /function readAssistantSetupValues/);
  assert.doesNotMatch(store, /data-assistant-setup-field/);
  assert.doesNotMatch(store, /data-runtime-target-select/);
  assert.doesNotMatch(store, /throw new Error\(".*课程名/);
  assert.doesNotMatch(store, /required[^;]+checkValidity/);
  assert.doesNotMatch(store, /setupValues/);
  assert.doesNotMatch(store, /<textarea[^>]*\srequired(?:[=\s>])|<input[^>]*\srequired(?:[=\s>])/);
});
