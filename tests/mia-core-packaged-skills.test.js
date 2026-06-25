const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  coreOfficialLibraryManifestPath,
  coreMiaSkillsRoot,
  coreResolveOfficialLibraryRoot
} = require("../src/core/mia-core.js");

const REPO_ROOT = path.resolve(__dirname, "..");

// BLOCKER #3: packaged Core must resolve the bundled official-library manifest +
// skills/_builtin from process.resourcesPath, NOT the repo path that only exists
// in a dev checkout. Packaging puts official-library under app.asar.unpacked
// (asarUnpack — plain node can't read inside app.asar) and skills under
// extraResources at <resources>/skills.

test("dev resolution finds the repo official-library + skills (no resourcesPath)", () => {
  const original = process.resourcesPath;
  try {
    // Plain node leaves resourcesPath undefined; force it for determinism.
    delete process.resourcesPath;

    const manifest = coreOfficialLibraryManifestPath();
    assert.equal(manifest, path.join(REPO_ROOT, "resources", "official-library", "library.json"));
    assert.ok(fs.existsSync(manifest), "dev manifest must exist in the repo checkout");

    const skillsRoot = coreMiaSkillsRoot();
    assert.equal(skillsRoot, path.join(REPO_ROOT, "skills"));
    assert.ok(fs.existsSync(path.join(skillsRoot, "_builtin")), "dev skills/_builtin must exist");

    // skillSources roots like "skills/_builtin" resolve under the repo skills root.
    assert.equal(
      coreResolveOfficialLibraryRoot("skills/_builtin"),
      path.join(REPO_ROOT, "skills", "_builtin")
    );
    // A non-skills root resolves next to the manifest.
    assert.equal(
      coreResolveOfficialLibraryRoot("paper-research"),
      path.join(path.dirname(manifest), "paper-research")
    );
  } finally {
    if (original === undefined) delete process.resourcesPath;
    else process.resourcesPath = original;
  }
});

test("packaged resolution derives <resources>/app.asar.unpacked + <resources>/skills from resourcesPath", () => {
  const original = process.resourcesPath;
  // Build a fake packaged <resources> layout exactly where packaging places files.
  const res = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-pkg-res-"));
  try {
    const unpackedManifestDir = path.join(res, "app.asar.unpacked", "resources", "official-library");
    fs.mkdirSync(unpackedManifestDir, { recursive: true });
    fs.writeFileSync(path.join(unpackedManifestDir, "library.json"), JSON.stringify({ schemaVersion: 1 }));

    const skillsBuiltin = path.join(res, "skills", "_builtin", "pet-generator");
    fs.mkdirSync(skillsBuiltin, { recursive: true });
    fs.writeFileSync(path.join(skillsBuiltin, "SKILL.md"), "# pet");

    process.resourcesPath = res;

    const manifest = coreOfficialLibraryManifestPath();
    assert.equal(
      manifest,
      path.join(res, "app.asar.unpacked", "resources", "official-library", "library.json")
    );
    assert.ok(fs.existsSync(manifest), "resolved packaged manifest must exist");

    const skillsRoot = coreMiaSkillsRoot();
    assert.equal(skillsRoot, path.join(res, "skills"));

    assert.equal(
      coreResolveOfficialLibraryRoot("skills/_builtin"),
      path.join(res, "skills", "_builtin")
    );
    assert.equal(
      coreResolveOfficialLibraryRoot("skills/_builtin/pet-generator"),
      path.join(res, "skills", "_builtin", "pet-generator")
    );
  } finally {
    if (original === undefined) delete process.resourcesPath;
    else process.resourcesPath = original;
    fs.rmSync(res, { recursive: true, force: true });
  }
});
