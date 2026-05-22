const {
  CHAT_ENGINE_ADAPTERS,
  adapterForEngine,
  normalizeAgentEngine
} = require("../shared/engine-contracts");

function resolveChatEngineAdapter(fellow = {}) {
  return adapterForEngine(fellow.agentEngine || fellow.agent_engine || fellow.engine);
}

module.exports = {
  CHAT_ENGINE_ADAPTERS,
  adapterForEngine,
  normalizeAgentEngine,
  resolveChatEngineAdapter
};
