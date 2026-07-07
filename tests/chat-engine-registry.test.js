const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  CHAT_ENGINE_ADAPTERS,
  adapterForEngine,
  normalizeAgentEngine,
  resolveChatEngineAdapter
} = require("../src/main/chat-engine-registry.js");

test("normalizeAgentEngine preserves supported engine aliases", () => {
  assert.equal(normalizeAgentEngine("hermes"), "hermes");
  assert.equal(normalizeAgentEngine("claude"), "claude-code");
  assert.equal(normalizeAgentEngine("claude_code"), "claude-code");
  assert.equal(normalizeAgentEngine("openai-codex"), "codex");
  assert.equal(normalizeAgentEngine("openai_codex"), "codex");
});

test("normalizeAgentEngine falls back to hermes", () => {
  assert.equal(normalizeAgentEngine(""), "hermes");
  assert.equal(normalizeAgentEngine("other"), "hermes");
  assert.equal(normalizeAgentEngine("openclaw"), "hermes");
  assert.equal(normalizeAgentEngine("open_claw"), "hermes");
  assert.equal(normalizeAgentEngine(null), "hermes");
});

test("adapterForEngine exposes stable metadata for chat routing", () => {
  assert.equal(adapterForEngine("claude").id, "claude-code");
  assert.equal(adapterForEngine("claude").cliCommand, "claude");
  assert.equal(adapterForEngine("codex").responseModel, "codex-cli");
  assert.equal(adapterForEngine("hermes").usesRuntime, true);
  assert.equal(adapterForEngine("openclaw"), CHAT_ENGINE_ADAPTERS.hermes);
  assert.equal(adapterForEngine("unknown"), CHAT_ENGINE_ADAPTERS.hermes);
});

test("resolveChatEngineAdapter reads current and legacy bot fields", () => {
  assert.equal(resolveChatEngineAdapter({ agentEngine: "codex" }).id, "codex");
  assert.equal(resolveChatEngineAdapter({ agent_engine: "claude-code" }).id, "claude-code");
  assert.equal(resolveChatEngineAdapter({ engine: "openai-codex" }).id, "codex");
  assert.equal(resolveChatEngineAdapter({ agentEngine: "openclaw" }).id, "hermes");
  assert.equal(resolveChatEngineAdapter({}).id, "hermes");
});
