const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  contextSnapshotInstruction,
  nativeContextModeFromConfig,
  normalizeNativeContextMode,
  selectNativeContextMode
} = require("../src/main/native-context-snapshot.js");

test("native context mode defaults to auto and selects MCP only when available", () => {
  assert.equal(normalizeNativeContextMode(""), "auto");
  assert.equal(normalizeNativeContextMode("default"), "auto");
  assert.equal(selectNativeContextMode({ requestedMode: "auto", mcpAvailable: true }), "mcp");
  assert.equal(selectNativeContextMode({ requestedMode: "auto", mcpAvailable: false }), "prompt");
  assert.equal(selectNativeContextMode({ requestedMode: "mcp", mcpAvailable: false }), "mcp");
  assert.equal(selectNativeContextMode({ requestedMode: "prompt", mcpAvailable: true }), "prompt");
  assert.equal(selectNativeContextMode({ requestedMode: "none", mcpAvailable: true }), "none");
});

test("native context mode reads engine-specific runtime and bot config keys", () => {
  assert.equal(nativeContextModeFromConfig({}, null, "hermes"), "auto");
  assert.equal(nativeContextModeFromConfig(
    { engineConfig: { nativeContextMode: "prompt" } },
    null,
    "openclaw"
  ), "prompt");
  assert.equal(nativeContextModeFromConfig(
    { engineConfig: { openclawContextMode: "mcp" } },
    null,
    "openclaw"
  ), "mcp");
  assert.equal(nativeContextModeFromConfig(
    { engineConfig: { nativeContextMode: "prompt" } },
    { hermesNativeContextMode: "mcp" },
    "hermes"
  ), "mcp");
});

test("context snapshot instruction is scoped to one bot and session", () => {
  const text = contextSnapshotInstruction({ engine: "openclaw", botId: "mei", sessionId: "conversation:1" });
  assert.match(text, /context_snapshot/);
  assert.match(text, /scope: current bot \+ current session only/);
  assert.match(text, /memory_tools: .*memory_search/);
  assert.match(text, /skill_tools: .*skill_read_current/);
  assert.match(text, /engine: openclaw/);
  assert.match(text, /bot: mei/);
  assert.match(text, /session: conversation:1/);
});
