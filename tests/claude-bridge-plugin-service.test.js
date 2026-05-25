const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createClaudeBridgePluginService } = require("../src/main/claude-bridge-plugin-service.js");

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimashi-claude-bridge-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = {
    runtime: path.join(dir, "runtime"),
    home: path.join(dir, "engine-home")
  };
  const service = createClaudeBridgePluginService({
    runtimePaths: () => runtime
  });
  return { dir, runtime, service };
}

function makeSkill(root, category, name) {
  const skillDir = path.join(root, category, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `# ${name}\n`);
  return skillDir;
}

test("ensureInstalled creates the Claude plugin manifest and links runtime skills", (t) => {
  const { runtime, service } = setup(t);
  const skillsRoot = path.join(runtime.home, "skills");
  const skillPath = makeSkill(skillsRoot, "writing", "summarize");
  fs.mkdirSync(path.join(skillsRoot, "writing", "draft"), { recursive: true });
  fs.writeFileSync(path.join(skillsRoot, "writing", "not-a-dir.txt"), "");

  const result = service.ensureInstalled();

  assert.equal(result.path, path.join(runtime.runtime, "claude-bridge-plugin"));
  assert.equal(result.fingerprint.length, 16);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.path, ".claude-plugin", "plugin.json"), "utf8")), {
    name: "aimashi-skills",
    version: "1.0.0",
    description: "Aimashi bridge: surfaces Hermes runtime skills to Claude Code engine."
  });
  assert.equal(fs.readlinkSync(path.join(result.path, "skills", "summarize")), skillPath);
  assert.equal(fs.existsSync(path.join(result.path, "skills", "draft")), false);
});

test("ensureInstalled refreshes stale links and chooses collision-free link names", (t) => {
  const { runtime, service } = setup(t);
  const skillsRoot = path.join(runtime.home, "skills");
  const first = makeSkill(skillsRoot, "writing", "shared");
  const second = makeSkill(skillsRoot, "coding", "shared");
  const bridgeSkillsDir = path.join(runtime.runtime, "claude-bridge-plugin", "skills");
  fs.mkdirSync(bridgeSkillsDir, { recursive: true });
  fs.writeFileSync(path.join(bridgeSkillsDir, "stale"), "old");

  const result = service.ensureInstalled();
  const entries = fs.readdirSync(path.join(result.path, "skills")).sort();
  const targets = entries.map((entry) => fs.readlinkSync(path.join(result.path, "skills", entry))).sort();

  assert.deepEqual(entries, ["aimashi-shared", "shared"]);
  assert.deepEqual(targets, [first, second].sort());
  assert.equal(fs.existsSync(path.join(result.path, "skills", "stale")), false);
});
