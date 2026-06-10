const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validateCatalog, loadLocalSkillMarket } = require("../src/main/skills/skill-market-local.js");

// Guards the real committed catalog: every market skill dir must have a
// Chinese manifest entry (and vice versa), with all required fields filled.
// Fails CI if someone adds a skills/<id>/ without updating catalog.zh.json.
test("real skills/ catalog.zh.json is internally consistent", () => {
  assert.doesNotThrow(() => validateCatalog());
});

test("real market listing is non-empty and fully localized", () => {
  const list = loadLocalSkillMarket();
  assert.ok(list.length >= 1, "curated market must not be empty");
  for (const skill of list) {
    assert.ok(skill.name_zh, `${skill.id} missing name_zh`);
    assert.ok(skill.summary_zh, `${skill.id} missing summary_zh`);
    assert.ok(skill.category_zh, `${skill.id} missing category_zh`);
    assert.ok(skill.body.includes("---"), `${skill.id} body should include SKILL.md frontmatter`);
  }
});
