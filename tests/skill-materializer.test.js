const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildSkillMaterializationContext
} = require("../src/shared/skill-materializer.js");

test("skill materializer prompt mode includes index and loaded bodies", () => {
  const context = buildSkillMaterializationContext({
    indexBlock: "## Available Mia Skills\n\n- demo: Demo index.",
    loadedBlock: "## Loaded Mia Skill Guides\n\n=== Skill: demo ===\nDemo body.\n=== End Skill ===",
    loadedSkillIds: ["demo"]
  });

  assert.match(context, /Available Mia Skills/);
  assert.match(context, /Loaded Mia Skill Guides/);
  assert.match(context, /Demo body/);
});

test("skill materializer MCP mode points to tools without index or loaded bodies", () => {
  const context = buildSkillMaterializationContext({
    indexBlock: "## Available Mia Skills\n\n- demo: Demo index.",
    loadedBlock: "## Loaded Mia Skill Guides\n\n=== Skill: demo ===\nDemo body.\n=== End Skill ===",
    loadedSkillIds: ["demo"]
  }, { deliveryMode: "mcp" });

  assert.match(context, /Mia Skill Tools/);
  assert.match(context, /skill_list_current/);
  assert.match(context, /skill_read_current/);
  assert.match(context, /demo/);
  assert.doesNotMatch(context, /Available Mia Skills|Loaded Mia Skill Guides|Demo body|\[LOAD_SKILL:/);
});

test("skill materializer MCP mode is empty when no skill context exists", () => {
  assert.equal(buildSkillMaterializationContext(null, { deliveryMode: "mcp" }), "");
  assert.equal(buildSkillMaterializationContext({}, { deliveryMode: "mcp" }), "");
});

test("skill materializer native file mode does not prompt-render skill bodies", () => {
  const context = buildSkillMaterializationContext({
    indexBlock: "## Available Mia Skills\n\n- demo: Demo index.",
    loadedBlock: "## Loaded Mia Skill Guides\n\n=== Skill: demo ===\nDemo body.\n=== End Skill ===",
    loadedSkillIds: ["demo"]
  }, { deliveryMode: "file" });

  assert.equal(context, "");
});
