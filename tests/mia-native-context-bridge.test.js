const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  renderNativeIdentityMd,
  renderNativeToolsMd,
  syncNativeContextFiles
} = require("../src/main/mia-native-context-bridge.js");

test("native context bridge renders persona without memory text", () => {
  const text = renderNativeIdentityMd({
    botId: "mei",
    botName: "Mei",
    personaText: "Be concise and practical."
  });

  assert.match(text, /# Mia Bot Identity/);
  assert.match(text, /Bot: Mei/);
  assert.match(text, /Be concise and practical/);
  assert.doesNotMatch(text, /Mia Memories|memory_search/);
});

test("native context bridge renders skill index but not loaded skill bodies", () => {
  const text = renderNativeToolsMd({
    botId: "mei",
    sessionId: "s1",
    skillMaterialization: {
      indexBlock: "## Available Mia Skills\n\n- demo: Demo summary.",
      loadedBlock: "## Loaded Mia Skill Guides\n\nsecret full body",
      loadedSkillIds: ["demo"]
    }
  });

  assert.match(text, /# Mia Tools And Skills/);
  assert.match(text, /skill_list_current/);
  assert.match(text, /skill_read_current/);
  assert.match(text, /Demo summary/);
  assert.match(text, /Prioritized Skills/);
  assert.doesNotMatch(text, /secret full body/);
});

test("native context bridge writes only explicit workspace context files", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-native-context-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const result = syncNativeContextFiles({
    workspaceDir: dir,
    engine: "openclaw",
    botId: "mei",
    botName: "Mei",
    sessionId: "s1",
    personaText: "Stay focused.",
    skillMaterialization: {
      indexBlock: "- demo: Demo summary.",
      loadedBlock: "full body should not be written",
      loadedSkillIds: ["demo"]
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  assert.equal(result.changed, true);
  assert.equal(fs.existsSync(path.join(dir, "IDENTITY.md")), true);
  assert.equal(fs.existsSync(path.join(dir, "TOOLS.md")), true);
  assert.match(fs.readFileSync(path.join(dir, "IDENTITY.md"), "utf8"), /Stay focused/);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, "TOOLS.md"), "utf8"), /full body/);

  const second = syncNativeContextFiles({
    workspaceDir: dir,
    botId: "mei",
    botName: "Mei",
    sessionId: "s1",
    personaText: "Stay focused.",
    skillMaterialization: { indexBlock: "- demo: Demo summary.", loadedSkillIds: ["demo"] }
  });
  assert.equal(second.changed, false);
});
