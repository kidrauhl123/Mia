const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");

test("shared skill defaults define Mia system and generic assistant skills once", () => {
  const modulePath = path.join(ROOT, "packages", "shared", "skill-defaults.js");
  assert.equal(fs.existsSync(modulePath), true, "shared skill defaults module must exist");
  const defaults = require(modulePath);
  assert.deepEqual(defaults.SYSTEM_AUTO_SKILL_IDS, [
    "mia-scheduler",
    "mia-official:officecli"
  ]);
  assert.deepEqual(defaults.GENERIC_ASSISTANT_SKILL_IDS, [
    "mia-official:officecli-docx",
    "mia-official:officecli-xlsx",
    "mia-official:officecli-pptx"
  ]);
});

test("shared skill resolver applies inheritance, disables, presets, manual skills, and turn chips", () => {
  const { resolveEffectiveSkillIds } = require("../packages/shared/skill-defaults.js");
  assert.deepEqual(resolveEffectiveSkillIds({ inheritEngineDefaults: true }), [
    "mia-scheduler",
    "mia-official:officecli"
  ]);
  assert.deepEqual(resolveEffectiveSkillIds({ inheritEngineDefaults: false }), []);
  assert.deepEqual(resolveEffectiveSkillIds({
    inheritEngineDefaults: true,
    disabledSkills: ["mia-official:officecli"]
  }), ["mia-scheduler"]);
  assert.deepEqual(resolveEffectiveSkillIds({
    inheritEngineDefaults: true,
    enabledSkills: ["manual", "preset"],
    disabledSkills: ["preset"]
  }, {
    presetSkillIds: ["preset", "role"],
    selectedSkillIds: ["preset", "turn"]
  }), ["mia-scheduler", "mia-official:officecli", "role", "manual", "preset", "turn"]);
});

test("shared package exports skill defaults as a public contract", () => {
  const packageJson = require("../packages/shared/package.json");
  assert.deepEqual(packageJson.exports["./skill-defaults"], {
    types: "./skill-defaults.d.ts",
    default: "./skill-defaults.js"
  });
  assert.equal(require("../packages/shared/index.js").skillDefaults, require("../packages/shared/skill-defaults.js"));
});
