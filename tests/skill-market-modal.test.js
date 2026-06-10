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
  assert.match(src, /function renderMarketModal/);
});

test("detail modal shows Chinese name + summary, body toggle, and add action", () => {
  const src = read("src/renderer/skills/skill-library.js");
  // intro uses Chinese fields with graceful fallback
  assert.match(src, /skill\.name_zh \|\| skill\.name/);
  assert.match(src, /skill\.summary_zh \|\| marketDescriptionZh\(skill\)/);
  // 展开正文 ⇄ 返回 toggle reveals the raw SKILL.md body
  assert.match(src, /marketModal\.showBody/);
  assert.match(src, /renderSkillMarkdownSource\(skill\.body\)/);
  assert.match(src, /展开正文/);
  assert.match(src, /返回简介/);
  // add / use action
  assert.match(src, /installMarketSkill\(skill\.id\)/);
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
