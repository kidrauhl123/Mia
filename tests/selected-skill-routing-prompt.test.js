const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildSelectedSkillRoutingPrompt,
  skillDirectoryFromPath,
  skillMarkdownPath
} = require("../src/main/selected-skill-routing-prompt.js");

test("skillMarkdownPath resolves a canonical SKILL.md path from a source directory", () => {
  assert.equal(
    skillMarkdownPath({ sourcePath: "/Users/example/skills/docx" }),
    "/Users/example/skills/docx/SKILL.md"
  );
});

test("skillDirectoryFromPath normalizes separators and strips SKILL.md", () => {
  assert.equal(
    skillDirectoryFromPath("C:\\Users\\me\\skills\\docx\\SKILL.md"),
    "C:/Users/me/skills/docx"
  );
});

test("buildSelectedSkillRoutingPrompt emits only canonical SKILL.md paths without inlining skill bodies", () => {
  const prompt = buildSelectedSkillRoutingPrompt([{
    id: "docx",
    displayName: "Word 文档",
    sourcePath: "/Users/example/skills/docx",
    body: "FULL BODY MUST NOT APPEAR"
  }]);

  assert.match(prompt, /<selected_skill_paths>/);
  assert.match(prompt, /<path>\/Users\/example\/skills\/docx\/SKILL\.md<\/path>/);
  assert.doesNotMatch(prompt, /docx<\/id>|Word 文档|directory|location/);
  assert.doesNotMatch(prompt, /FULL BODY MUST NOT APPEAR/);
});

test("buildSelectedSkillRoutingPrompt escapes XML-sensitive characters", () => {
  const prompt = buildSelectedSkillRoutingPrompt([{
    id: "a&b",
    displayName: "A < B",
    sourcePath: "/tmp/a&b"
  }]);

  assert.match(prompt, /<path>\/tmp\/a&amp;b\/SKILL\.md<\/path>/);
});
