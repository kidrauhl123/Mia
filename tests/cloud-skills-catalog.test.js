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

test("the real skills/ folder loads top-level catalog and excludes _builtin", () => {
  const skills = loadSkillsCatalog();
  const ids = skills.map((s) => s.id);
  assert.ok(ids.includes("pdf"), "pdf present");
  assert.ok(ids.includes("docx"), "docx present");
  assert.ok(ids.includes("latex-document"), "latex-document present");
  // _builtin (pre-installed, e.g. pet-generator) is NOT part of the market catalog
  assert.ok(!ids.includes("_builtin"), "_builtin dir is not a catalog entry");
  assert.ok(!ids.includes("pet-generator"), "bundled pet-generator is excluded from the market");
  assert.ok(skills.every((s) => s.body.length > 0), "every catalog entry has a body");
});

test("loadSkillsCatalog skips _-prefixed dirs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-catalog-"));
  try {
    fs.mkdirSync(path.join(dir, "_builtin", "x"), { recursive: true });
    fs.writeFileSync(path.join(dir, "_builtin", "x", "SKILL.md"), "---\nname: x\n---\n# X");
    fs.mkdirSync(path.join(dir, "real"));
    fs.writeFileSync(path.join(dir, "real", "SKILL.md"), "---\nname: real\n---\n# Real");
    const ids = loadSkillsCatalog(dir).map((s) => s.id);
    assert.deepEqual(ids, ["real"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("publishVersion packages a version, preserves install_count across versions, deleteSkill prunes", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-catalog-db-"));
  try {
    const store = createCloudStore({ dataDir });
    const skills = createSkillsStore(store.getDb(), { uploadDir: store.uploadDir, dataDir: store.dataDir });

    skills.publishVersion({ id: "a", ownerLabel: "Mia", name: "A", category: "x", description: "d", version: "1.0.0", body: "# A" });
    skills.publishVersion({ id: "b", ownerLabel: "Mia", name: "B", category: "y", description: "d", version: "1.0.0", body: "# B" });

    const a1 = skills.getSkill("a");
    assert.equal(a1.latestVersion, "1.0.0");
    assert.ok(a1.version && a1.version.checksum, "version carries a package checksum");
    assert.ok(fs.existsSync(skills.packageAbsPath(a1.version)), "package zip written to uploads/");

    // installs accumulate, then a new version is published → listing updates, count preserved
    store.getDb().prepare("UPDATE skills SET install_count = 5 WHERE id = ?").run("a");
    skills.publishVersion({ id: "a", ownerLabel: "Mia", name: "A v2", category: "x", description: "d2", version: "1.1.0", body: "# A v2" });
    const a2 = skills.getSkill("a");
    assert.equal(a2.name, "A v2");
    assert.equal(a2.latestVersion, "1.1.0");
    assert.equal(a2.installCount, 5, "install_count preserved across new version");

    assert.equal(skills.deleteSkill("b"), 1);
    assert.equal(skills.getSkill("b"), null);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
