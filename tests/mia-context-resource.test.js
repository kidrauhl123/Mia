const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  MEMORY_TOOL_NAMES,
  SKILL_TOOL_NAMES,
  buildMiaContextResource,
  mcpContextPrompt
} = require("../src/main/mia-context-resource.js");

test("Mia context resource uses MCP tools without prompt-rendering memory", () => {
  const resource = buildMiaContextResource({
    engine: "codex",
    bot: { key: "mei" },
    sessionId: "session-1",
    runtimeConfig: {},
    mcpAvailable: true,
    runtimePrompt: "Mia runtime contract"
  });

  assert.equal(resource.nativeContextMode, "mcp");
  assert.equal(resource.memory.prompt, "");
  assert.equal(resource.memory.deliveryMode, "mcp");
  assert.deepEqual(resource.memory.toolNames, MEMORY_TOOL_NAMES);
  assert.equal(resource.skills.deliveryMode, "mcp");
  assert.deepEqual(resource.skills.toolNames, SKILL_TOOL_NAMES);
  assert.match(resource.mcp.snapshotInstruction, /context_snapshot/);
  assert.match(resource.mcp.snapshotInstruction, /memory_search/);
  assert.match(resource.mcp.snapshotInstruction, /bot: mei/);
  assert.doesNotMatch(resource.mcp.snapshotInstruction, /Mia runtime contract/);
});

test("Mia context resource keeps prompt fallback bounded when MCP is unavailable", () => {
  const resource = buildMiaContextResource({
    engine: "openclaw",
    bot: { key: "mei", engineConfig: { nativeContextMode: "auto" } },
    sessionId: "session-1",
    mcpAvailable: false
  });

  assert.equal(resource.nativeContextMode, "prompt");
  assert.equal(resource.persona.deliveryMode, "prompt");
  assert.equal(resource.persona.promptAllowed, true);
  assert.equal(resource.skills.deliveryMode, "prompt");
  assert.equal(resource.memory.prompt, "");
  assert.equal(resource.memory.deliveryMode, "none");
  assert.equal(resource.mcp.snapshotInstruction, "");
});

test("Mia context resource prefers native files over prompt fallback when available", () => {
  const resource = buildMiaContextResource({
    engine: "openclaw",
    bot: { key: "mei", engineConfig: { nativeContextMode: "auto" } },
    sessionId: "session-1",
    mcpAvailable: false,
    nativeFilesAvailable: true
  });

  assert.equal(resource.nativeContextMode, "prompt");
  assert.equal(resource.persona.deliveryMode, "file");
  assert.equal(resource.persona.promptAllowed, false);
  assert.equal(resource.skills.deliveryMode, "file");
  assert.equal(resource.skills.promptAllowed, false);
  assert.equal(resource.nativeFiles.active, true);
  assert.deepEqual(resource.nativeFiles.fileNames, ["IDENTITY.md", "TOOLS.md"]);
  assert.equal(resource.memory.prompt, "");
});

test("Mia context resource composes the Claude MCP system append without memory text", () => {
  const resource = buildMiaContextResource({
    engine: "claude-code",
    bot: { key: "mei" },
    sessionId: "session-1",
    mcpAvailable: true,
    runtimePrompt: "Runtime line"
  });
  const prompt = mcpContextPrompt(resource, { includeRuntime: true });

  assert.match(prompt, /^Runtime line/);
  assert.match(prompt, /context_snapshot/);
  assert.match(prompt, /memory_search/);
  assert.doesNotMatch(prompt, /## Mia Memories/);
  assert.equal(mcpContextPrompt(resource, { includeRuntime: false }).startsWith("## Mia Scoped Context"), true);
});
