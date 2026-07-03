const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
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

test("real market listing does not expose the duplicate Anthropic xlsx skill", () => {
  const repoRoot = path.join(__dirname, "..");
  const list = loadLocalSkillMarket();
  assert.equal(fs.existsSync(path.join(repoRoot, "skills", "xlsx")), false);
  assert.equal(list.some((skill) => skill.id === "xlsx"), false);
});

test("real market listing includes the LobsterAI content and search skills", () => {
  const list = loadLocalSkillMarket();
  const byId = new Map(list.map((skill) => [skill.id, skill]));
  const expected = [
    ["content-planner", "内容选题规划"],
    ["article-writer", "多风格文章写作"],
    ["daily-trending", "今日热榜"],
    ["web-search", "网页搜索"],
    ["weather", "天气查询"],
    ["films-search", "影视资源搜索"],
    ["music-search", "音乐资源搜索"]
  ];

  for (const [id, nameZh] of expected) {
    const skill = byId.get(id);
    assert.ok(skill, `${id} should be in the local skill market`);
    assert.equal(skill.name_zh, nameZh);
    assert.equal(skill.sourceLabel, "LobsterAI");
    assert.ok(skill.summary_zh.length >= 20, `${id} should have a useful Chinese summary`);
  }
});

test("real market listing keeps a broad curated catalog with quality-gated bodies", () => {
  const list = loadLocalSkillMarket();
  assert.ok(list.length >= 20, "market should stay broad, not shrink to a tiny shelf");

  const forbidden = [
    { pattern: /description:\s*["']>["']/i, label: "broken placeholder description" },
    { pattern: /\[Similar structure\.\.\.\]/i, label: "template placeholder" },
    { pattern: /\[Full tailored resume follows\.\.\.\]/i, label: "unfinished resume placeholder" },
    { pattern: /^\s*\.\.\.\s*$/m, label: "bare ellipsis placeholder line" },
    { pattern: /\boffice-mcp\b/i, label: "unavailable office-mcp dependency claim" }
  ];
  for (const skill of list) {
    for (const rule of forbidden) {
      assert.doesNotMatch(skill.body, rule.pattern, `${skill.id} contains ${rule.label}`);
    }
  }
});

test("bundled market Python scripts parse on the supported system Python", () => {
  const skillIds = loadLocalSkillMarket().map((skill) => skill.id);
  const files = [];
  for (const id of skillIds) {
    const dir = path.join(__dirname, "..", "skills", id);
    const stack = [dir];
    while (stack.length) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile() && entry.name.endsWith(".py")) files.push(full);
      }
    }
  }
  assert.ok(files.length > 0, "market should include Python helper scripts to validate");
  const script = `
import ast, sys
for file in sys.argv[1:]:
    with open(file, "r", encoding="utf-8") as fh:
        ast.parse(fh.read(), filename=file)
`;
  const result = spawnSync("python3", ["-c", script, ...files], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("bundled market skill bodies do not point at missing packaged files", () => {
  const repoRoot = path.join(__dirname, "..");
  const pathPattern = /(?:^|[\s`"'])((?:\.\/)?(?:scripts|assets|references|reference|examples|agents|eval-viewer|artifact|anki)\/[A-Za-z0-9_./@+%=-]+)(?=[\s`"')]|$)/gm;
  for (const skill of loadLocalSkillMarket()) {
    const skillDir = path.join(repoRoot, "skills", skill.id);
    const refs = new Set();
    for (const match of skill.body.matchAll(pathPattern)) {
      refs.add(match[1].replace(/^\.\//, "").replace(/[.,;:]+$/, ""));
    }
    for (const match of skill.body.matchAll(/\]\(([^)]+)\)/g)) {
      const href = String(match[1] || "").split("#")[0].trim();
      if (/^(scripts|assets|references|reference|examples|agents|eval-viewer|artifact|anki)\//.test(href)) {
        refs.add(href.replace(/[.,;:]+$/, ""));
      }
    }
    for (const ref of refs) {
      assert.ok(fs.existsSync(path.join(skillDir, ref)), `${skill.id} references missing packaged file: ${ref}`);
    }
  }
});
