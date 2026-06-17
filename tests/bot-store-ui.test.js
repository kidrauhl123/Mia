const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("discover bot store uses a two-step enrollment flow before saving", () => {
  const src = read("src/renderer/bot/bot-store.js");

  assert.match(src, /data-act="prepare"/);
  assert.match(src, /openEnrollmentStep\(f\)/);
  assert.match(src, /data-act="confirm"/);
  assert.match(src, /function openEnrollmentStep/);
  assert.match(src, /function skillSummary/);
  assert.match(src, /enabledSkills/);
  assert.match(src, /data-badge-engine/);
  assert.match(src, /data-runtime-target-select/);
  assert.match(src, /function targetSelectHtml/);
  assert.match(src, /function targetOptionValue/);
  assert.match(src, /function parseTargetOptionValue/);
  assert.match(src, /<optgroup label=/);
  assert.match(src, /function runtimeTargetGroups/);
  assert.match(src, /function readEnrollmentTarget/);
  assert.match(src, /function refreshRuntimeDevicesForStore/);
  assert.match(src, /listBridgeDevices\(\{ includeOffline: true \}\)/);
  assert.match(src, /function generateEnrollmentPrincipalId/);
  assert.match(src, /window\.miaIds\?\.generatePrincipalId/);
  assert.match(src, /function defaultConversationTagName/);
  assert.match(src, /setConversationTagNames\(\s*conversationId,\s*\[defaultConversationTagName\(f\)\]\s*\)/);
  assert.match(src, /sheet\.dataset\.botKey = plannedKey/);
  assert.match(src, /addBot\(f, readEnrollmentTarget\(sheet\), sheet\.dataset\.botKey \|\| plannedKey\)/);
  assert.match(src, /runtimeKind:\s*target\.runtimeKind/);
  assert.match(src, /agentEngine:\s*target\.agentEngine/);
  assert.match(src, /targetDeviceId:\s*target\.deviceId/);
  assert.match(src, /targetDeviceName:\s*target\.deviceName/);
  assert.match(src, /category:\s*defaultConversationTagName\(f\)/);
  assert.match(src, /key,\s*\n\s*name: f\.name/);
  assert.match(src, /function principalId/);
  assert.match(src, /data-badge-uid/);
  assert.match(src, /UID · \$\{savedKey\}/);
  assert.match(src, /UID · \$\{escapeHtml\(plannedKey\)\}/);
  assert.doesNotMatch(src, /data-runtime-target-picker/);
  assert.doesNotMatch(src, /data-engine-toggle/);
  assert.doesNotMatch(src, /classList\.toggle\("is-engine-open"\)/);
  assert.doesNotMatch(src, /speak-partner/);
  assert.doesNotMatch(src, /key:\s*principalId\(f\)/);
  assert.doesNotMatch(src, /credentialId/);
  assert.doesNotMatch(src, /MIA-\$\{/);
});

test("discover bot store is framed as assistants, not coworkers", () => {
  const app = read("src/renderer/app.js");
  const html = read("src/renderer/index.html");
  const store = read("src/renderer/bot/bot-store.js");

  assert.match(app, /label:\s*"发现 AI 助手"/);
  assert.match(html, />发现 AI 助手</);
  assert.match(html, /aria-label="AI 助手列表"/);
  assert.match(store, /AI 助手入库/);
  assert.match(store, /MIA · AI 助手凭证/);

  assert.doesNotMatch(app, /发现 AI 同事/);
  assert.doesNotMatch(html, /发现 AI 同事|AI 同事列表/);
  assert.doesNotMatch(store, /AI 同事|入职/);
});

test("discover bot store credential styles are tied to the second step", () => {
  const css = read("src/renderer/styles/bot-store.css");

  assert.match(css, /\.bot-store-sheet\.is-enrolling/);
  assert.match(css, /\.bot-store-enroll-console/);
  assert.match(css, /\.bot-store-badge-card/);
  assert.match(css, /\.bot-store-badge-fields/);
  assert.match(css, /\.bot-store-badge-target-select/);
  assert.match(css, /\.bot-store-badge-target-select\s*\{[\s\S]*?position:\s*absolute;/);
  assert.match(css, /\.bot-store-badge-target-select\s*\{[\s\S]*?opacity:\s*0;/);
  assert.match(css, /\.bot-store-badge-stamp/);
  assert.match(css, /bot-store-badge-stamp-slam/);
  assert.doesNotMatch(css, /\.bot-store-engine-picker/);
  assert.doesNotMatch(css, /\.bot-store-badge-engine-picker/);
  assert.doesNotMatch(css, /\.bot-store-badge-target-picker/);
  assert.doesNotMatch(css, /\.bot-store-badge-target-group/);
  assert.doesNotMatch(css, /\.bot-store-badge-empty/);
  assert.match(css, /\.bot-store-actions\s*\{[\s\S]*?justify-content:\s*flex-end;/);
  assert.match(css, /\.bot-store-btn\s*\{[\s\S]*?height:\s*38px;/);
  assert.match(css, /\.bot-store-btn\.primary\s*\{[\s\S]*?flex:\s*0 0 auto;/);
  assert.match(css, /:root\[data-theme="dark"\] \.bot-store-enroll-console/);
  assert.match(css, /--badge-card-bg:\s*#fffefa/);
  assert.match(css, /--badge-card-bg:\s*#161d2e/);
  assert.match(css, /\.bot-store-sheet\.is-enrolling\s*\{[\s\S]*?overflow:\s*hidden;/);
  assert.match(css, /\.bot-store-badge-stage\s*\{[\s\S]*?min-height:\s*clamp/);
});

test("official bot presets exclude voice-only coworkers until voice is available", () => {
  const library = JSON.parse(read("resources/official-library/library.json"));
  const presets = Array.isArray(library.botPresets) ? library.botPresets : [];

  assert.equal(presets.some((item) => item.key === "speak-partner"), false);
  assert.equal(presets.some((item) => item.name === "口语陪练"), false);
  assert.equal(presets.length, 10);
  assert.deepEqual([...new Set(presets.map((item) => item.category))], ["学习", "办公", "写作", "求职", "娱乐"]);
  assert.ok(["表格整理师", "汇报设计师", "文档编辑", "会议纪要官", "剧情主持"].every((name) =>
    presets.some((item) => item.name === name)
  ));
  assert.equal(presets.every((item) => Array.isArray(item.capabilities?.enabledSkills) && item.capabilities.enabledSkills.length > 0), true);
  assert.equal(presets.every((item) => !Object.prototype.hasOwnProperty.call(item, "tags")), true);
  assert.equal(presets.every((item) => !Object.prototype.hasOwnProperty.call(item, "roleTitle")), true);
});
