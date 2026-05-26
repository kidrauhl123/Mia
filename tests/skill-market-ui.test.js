const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("market IPC channels + preload bridge are wired", () => {
  const channels = read("src/shared/ipc-channels.js");
  assert.match(channels, /SkillsMarketList:\s*"skills:market-list"/);
  assert.match(channels, /SkillsMarketInstall:\s*"skills:market-install"/);

  const preload = read("src/preload.js");
  assert.match(preload, /marketSkills:.*SkillsMarketList/);
  assert.match(preload, /installMarketSkill:.*SkillsMarketInstall/);
});

test("main orchestrates cloud install → local write", () => {
  const main = read("src/main.js");
  assert.match(main, /SkillsMarketList.*listMarketSkills/);
  // install: cloud call then write the body locally via skills-loader
  assert.match(main, /installMarketSkill\(skillId\)/);
  assert.match(main, /skillsLoader\.installMarketplaceSkill\(skill\)/);
});

test("skill-library renders a market mode with an install action", () => {
  const src = read("src/renderer/skills/skill-library.js");
  assert.match(src, /state\.skillMarketMode/);
  assert.match(src, /function renderMarketView/);
  assert.match(src, /function installMarketSkill/);
  assert.match(src, /data-skill-install=/);
  // a signed-out prompt rather than a broken empty grid
  assert.match(src, /登录 Mia Cloud/);
});

test("topbar has the mine/market toggle and market styles exist", () => {
  const html = read("src/renderer/index.html");
  assert.match(html, /id="skillModeToggle"/);
  const css = read("src/renderer/styles/skills.css");
  assert.match(css, /\.skill-mode-toggle/);
  assert.match(css, /\.skill-card-action/);
});
