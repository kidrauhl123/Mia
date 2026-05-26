const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSkillsLoader } = require("../src/main/skills-loader.js");

function makeLoader(home) {
  return createSkillsLoader({
    runtimePaths: () => ({ home }),
    readJson: () => null, // no official library → only the private source is active
    officialLibraryManifestPath: () => path.join(home, "does-not-exist.json"),
    resolveOfficialLibraryRoot: () => "",
    getEngineState: () => ({ running: false }),
    apiKey: () => "",
    appendEngineLog: () => {},
    isChildPath: (parent, child) =>
      path.resolve(String(child)).startsWith(path.resolve(String(parent)) + path.sep)
  });
}

const SKILL_BODY = ["---", "name: demo-skill", "description: A demo.", "---", "", "# Demo Skill", "", "Hello."].join("\n");

test("installMarketplaceSkill writes SKILL.md under <home>/skills and it scans as a 'mia' skill", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-skills-loader-"));
  try {
    const loader = makeLoader(home);
    const library = await loader.installMarketplaceSkill({ id: "demo-skill", name: "demo-skill", body: SKILL_BODY });

    // file landed in the writable private root
    const written = path.join(home, "skills", "demo-skill", "SKILL.md");
    assert.ok(fs.existsSync(written), "SKILL.md written to <home>/skills/<id>/");
    assert.equal(fs.readFileSync(written, "utf8"), SKILL_BODY);

    // and it surfaces in the scan as a private (source: "mia") skill
    const found = library.skills.find((s) => s.name === "demo-skill");
    assert.ok(found, "installed skill appears in local scan");
    assert.equal(found.source, "mia");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("an installed marketplace skill is deletable (private source)", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-skills-loader-"));
  try {
    const loader = makeLoader(home);
    const library = await loader.installMarketplaceSkill({ id: "demo-skill", name: "demo-skill", body: SKILL_BODY });
    const installed = library.skills.find((s) => s.name === "demo-skill");

    const after = await loader.deleteLocalSkill(installed.id);
    assert.ok(!after.skills.some((s) => s.name === "demo-skill"), "skill removed after delete");
    assert.ok(!fs.existsSync(path.join(home, "skills", "demo-skill")), "skill dir removed");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("installMarketplaceSkill rejects missing body", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-skills-loader-"));
  try {
    const loader = makeLoader(home);
    await assert.rejects(loader.installMarketplaceSkill({ id: "x", name: "x" }), /body required/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
