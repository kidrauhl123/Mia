const {
  CHAT_ENGINE_ADAPTERS,
  adapterForEngine,
  normalizeAgentEngine
} = require("../shared/engine-contracts");

function resolveChatEngineAdapter(bot = {}) {
  return adapterForEngine(bot.agentEngine || bot.agent_engine || bot.engine);
}

module.exports = {
  CHAT_ENGINE_ADAPTERS,
  adapterForEngine,
  normalizeAgentEngine,
  resolveChatEngineAdapter
};
