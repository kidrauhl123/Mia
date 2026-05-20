const CHAT_ENGINE_ADAPTERS = Object.freeze({
  hermes: Object.freeze({
    id: "hermes",
    label: "Hermes",
    responseModel: "hermes-agent",
    transport: "runs",
    usesRuntime: true,
    usesSdkPromptPrefix: false
  }),
  "claude-code": Object.freeze({
    id: "claude-code",
    label: "Claude Code",
    responseModel: "claude-code",
    transport: "claude-agent-sdk",
    cliCommand: "claude",
    usesRuntime: false,
    usesSdkPromptPrefix: true
  }),
  codex: Object.freeze({
    id: "codex",
    label: "Codex",
    responseModel: "codex-cli",
    transport: "codex-sdk",
    cliCommand: "codex",
    usesRuntime: false,
    usesSdkPromptPrefix: true
  })
});

function normalizeAgentEngine(value) {
  const id = String(value || "hermes").trim().toLowerCase().replace(/_/g, "-");
  if (id === "claude" || id === "claude-code") return "claude-code";
  if (id === "codex" || id === "openai-codex") return "codex";
  return "hermes";
}

function adapterForEngine(value) {
  return CHAT_ENGINE_ADAPTERS[normalizeAgentEngine(value)] || CHAT_ENGINE_ADAPTERS.hermes;
}

function resolveChatEngineAdapter(fellow = {}) {
  return adapterForEngine(fellow.agentEngine || fellow.agent_engine || fellow.engine);
}

module.exports = {
  CHAT_ENGINE_ADAPTERS,
  adapterForEngine,
  normalizeAgentEngine,
  resolveChatEngineAdapter
};
