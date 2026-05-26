const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadSkillsCatalog, parseFrontmatter } = require("../src/cloud/skills-catalog.js");
const { createCloudStore } = require("../src/cloud/sqlite-store.js");
const { createSkillsStore } = require("../src/cloud/skills-store.js");

test("loadSkillsCatalog parses <id>/SKILL.md frontmatter + body from a folder", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-catalog-"));
  try {
    const body = [
      "---", "name: demo", "description: A demo skill.", "category: 办公学习", "source: Acme", "---",
      "", "# Demo", "body text"
    ].join("\n");
    fs.mkdirSync(path.join(dir, "demo"));
    fs.writeFileSync(path.join(dir, "demo", "SKILL.md"), body);
    // a folder without SKILL.md is skipped
    fs.mkdirSync(path.join(dir, "ignored"));

    const skills = loadSkillsCatalog(dir);
    assert.equal(skills.length, 1);
    const [s] = skills;
    assert.equal(s.id, "demo");
    assert.equal(s.name, "demo");
    assert.equal(s.category, "办公学习");
    assert.equal(s.description, "A demo skill.");
    assert.equal(s.sourceLabel, "Acme");
    assert.equal(s.body, body, "full SKILL.md kept as body (frontmatter included)");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSkillsCatalog falls back when frontmatter keys are missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-catalog-"));
  try {
    fs.mkdirSync(path.join(dir, "bare"));
    fs.writeFileSync(path.join(dir, "bare", "SKILL.md"), "# Bare\nno frontmatter");
    const [s] = loadSkillsCatalog(dir);
    assert.equal(s.id, "bare");
    assert.equal(s.name, "bare");
    assert.equal(s.category, "uncategorized");
    assert.equal(s.sourceLabel, "Mia 官方");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseFrontmatter returns {} for content without frontmatter", () => {
  assert.deepEqual(parseFrontmatter("# Title\nbody"), {});
});

test("the real skills-catalog/ folder loads the seeded first-party skills", () => {
  const skills = loadSkillsCatalog();
  const ids = skills.map((s) => s.id);
  assert.ok(ids.includes("commit-craft"), "commit-craft present");
  assert.ok(ids.includes("weekly-report"), "weekly-report present");
  assert.ok(ids.includes("trip-planner"), "trip-planner present");
  assert.ok(skills.every((s) => s.body.length > 0), "every catalog entry has a body");
});

test("syncing a catalog into the store upserts (preserving install_count) and prunes", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-catalog-db-"));
  try {
    const store = createCloudStore({ dataDir });
    const skills = createSkillsStore(store.getDb());

    // initial sync of two skills
    skills.upsertSkill({ id: "a", name: "A", category: "x", description: "d", sourceLabel: "Mia", body: "# A" });
    skills.upsertSkill({ id: "b", name: "B", category: "y", description: "d", sourceLabel: "Mia", body: "# B" });
    // "a" accumulates installs over time
    store.getDb().prepare("UPDATE skills SET install_count = 5 WHERE id = ?").run("a");
    assert.equal(skills.getSkill("a").installCount, 5);

    // re-sync "a" with edited content → updates body, keeps install_count
    skills.upsertSkill({ id: "a", name: "A v2", category: "x", description: "d2", sourceLabel: "Mia", body: "# A v2" });
    const a = skills.getSkill("a");
    assert.equal(a.name, "A v2");
    assert.equal(a.body, "# A v2");
    assert.equal(a.installCount, 5, "install_count preserved across re-sync");

    // prune "b"
    assert.equal(skills.deleteSkill("b"), 1);
    assert.equal(skills.getSkill("b"), null);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
