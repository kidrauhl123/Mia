const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("market card click opens the detail modal", () => {
  const src = read("src/renderer/skills/skill-library.js");
  // the previously-dead market card now wires a left click
  assert.match(src, /\[data-market-id\][\s\S]*addEventListener\("click", \(\) => openMarketModal/);
  assert.match(src, /function openMarketModal/);
  assert.match(src, /function closeMarketModal/);
  assert.match(src, /function renderSkillModal/);
});

test("detail modal shows Chinese name + summary, body toggle, and add action", () => {
  const src = read("src/renderer/skills/skill-library.js");
  // intro uses Chinese fields with graceful fallback
  assert.match(src, /skill\.name_zh \|\| skill\.name/);
  assert.match(src, /skill\.summary_zh \|\| marketDescriptionZh\(skill\)/);
  // 展开正文 ⇄ 返回 toggle reveals the raw SKILL.md body
  assert.match(src, /skillModal\.showBody/);
  assert.match(src, /function loadMarketSkillBody/);
  assert.match(src, /window\.mia\.readMarketSkill/);
  assert.match(src, /renderSkillMarkdownSource\(skill\.body\)/);
  assert.match(src, /展开正文/);
  assert.match(src, /返回简介/);
  assert.doesNotMatch(src, /完整 SKILL\.md 内容将在添加到本机后查看/);
  // add / use action
  assert.match(src, /installMarketSkill\(skill\.id\)/);
});

test("market modal refreshes its add button after install state changes", () => {
  const src = read("src/renderer/skills/skill-library.js");

  assert.match(src, /function renderMarketSkillInstallState\(skillId\)/);
  assert.match(src, /state\.installingSkillIds\.add\(skillId\);\s*renderMarketSkillInstallState\(skillId\);/);
  assert.match(src, /state\.installingSkillIds\.delete\(skillId\);\s*renderMarketSkillInstallState\(skillId\);/);
  assert.match(src, /skillModal\.kind === "market" && skillModal\.skillId === skillId[\s\S]*renderSkillModal\(\)/);
});

test("market modal uses a text-only theme-color button after install", () => {
  const css = read("src/renderer/styles/skills.css");

  assert.match(css, /\.skill-market-modal \.smm-add\.smm-add-installed\s*\{[\s\S]*background:\s*transparent;[\s\S]*color:\s*var\(--accent/);
  assert.match(css, /\.skill-market-modal \.smm-add\.smm-add-installed\s*\{[\s\S]*padding:\s*0;/);
  assert.match(css, /\.skill-market-modal \.smm-add\.smm-add-installed\s*\{[\s\S]*align-self:\s*center;/);
  assert.match(css, /\.skill-market-modal \.smm-add\.smm-add-installed\s*\{[\s\S]*cursor:\s*default;/);
  assert.match(css, /\.skill-market-modal \.smm-add\.smm-add-installed:hover\s*\{[\s\S]*background:\s*transparent;[\s\S]*color:\s*color-mix\(in srgb, var\(--accent/);
  assert.match(css, /\.skill-market-modal \.smm-add\.smm-add-installed:hover\s*\{[\s\S]*filter:\s*none;/);
  assert.doesNotMatch(css, /\.skill-market-modal \.smm-add\.smm-add-installed:hover\s*\{[\s\S]*text-decoration:\s*underline;/);
  assert.doesNotMatch(css, /\.skill-market-modal \.smm-add\.smm-add-installed:hover\s*\{[\s\S]*text-underline-offset:/);
  assert.doesNotMatch(css, /\.skill-market-modal \.smm-add\.smm-add-installed\s*\{[\s\S]*background:\s*var\(--surface-muted\);/);
});

test("local skill cards reuse the shared market modal and keep the body entry", () => {
  const src = read("src/renderer/skills/skill-library.js");
  assert.match(src, /\[data-skill-select\][\s\S]*addEventListener\("click", \(\) => selectSkill/);
  assert.match(src, /function openLocalSkillModal/);
  assert.match(src, /skillModal = \{ kind: "local", skillId, showBody: false \}/);
  assert.match(src, /ensureMarketModalEl\(\)\.classList\.remove\("hidden"\)/);
  assert.match(src, /skillModal\.kind === "local"[\s\S]*window\.miaSkillHelpers\.skillSummaryZh\(skill\)/);
  assert.match(src, /skillModal\.kind === "local"[\s\S]*useSkillInComposer\(skill\.id\)/);
  assert.match(src, /renderSkillMarkdownSource\(skill\.body\)/);
  assert.doesNotMatch(src, /function renderSkillPreview/);
});

test("legacy local skill preview dialog is removed", () => {
  const html = read("src/renderer/index.html");
  const app = read("src/renderer/app.js");
  const state = read("src/renderer/app-state.js");
  assert.doesNotMatch(html, /id="skillPreviewDialog"/);
  assert.doesNotMatch(app, /skillPreviewDialog|closeSkillPreview|skillPreviewBody|renderSkillPreview/);
  assert.doesNotMatch(state, /skillPreviewOpen/);
});

test("detail modal closes on Escape and backdrop", () => {
  const src = read("src/renderer/skills/skill-library.js");
  assert.match(src, /event\.key === "Escape"/);
  assert.match(src, /data-smm-close/);
});

test("detail modal styles exist", () => {
  const css = read("src/renderer/styles/skills.css");
  assert.match(css, /\.skill-market-modal/);
  assert.match(css, /\.smm-panel/);
  assert.match(css, /\.smm-body-toggle/);
  assert.match(css, /\.smm-add/);
});

test("legacy local skill preview styles are removed", () => {
  const css = read("src/renderer/styles.css");
  const skillsCss = read("src/renderer/styles/skills.css");
  assert.doesNotMatch(css, /\.skill-preview-intro/);
  assert.doesNotMatch(css, /\.skill-preview-use/);
  assert.doesNotMatch(skillsCss, /\.skill-dot/);
});
