// Shared bot-turn helpers: `cloudBotSnapshotForTurn` and `botWithRuntimeConfig`
// were extracted verbatim from src/main.js so the standalone Mia Core node
// process can build the same turn-normalization pipeline as the Electron main
// process — no fork. Both helpers are pure node and depend only on two shared
// engine-policy functions, which are injected so the module stays decoupled
// from how each host imports them.

function createBotTurnHelpers({ normalizeAgentEngine, enginePermissionStoreTarget }) {
  if (typeof normalizeAgentEngine !== "function") {
    throw new Error("normalizeAgentEngine dependency is required.");
  }
  if (typeof enginePermissionStoreTarget !== "function") {
    throw new Error("enginePermissionStoreTarget dependency is required.");
  }

  function botWithRuntimeConfig(bot, runtimeConfig = {}, options = {}) {
    if (!runtimeConfig || !Object.keys(runtimeConfig).length) return bot;
    const agentEngine = normalizeAgentEngine(
      options.agentEngine || bot?.agentEngine || bot?.agent_engine || "hermes",
      "hermes"
    );
    const configForEngine = { ...runtimeConfig };
    if (enginePermissionStoreTarget(agentEngine) !== "root-mode") delete configForEngine.permissionMode;
    if (!Object.keys(configForEngine).length) return bot;
    return {
      ...bot,
      engineConfig: {
        ...(bot.engineConfig || bot.engine_config || {}),
        ...configForEngine
      }
    };
  }

  function cloudBotSnapshotForTurn(snapshot = null, key = "", runtimeConfig = null) {
    if (!snapshot || typeof snapshot !== "object") return null;
    const botKey = String(snapshot.key || snapshot.id || key || "").trim();
    if (!botKey) return null;
    const requested = String(key || "").trim();
    if (requested && botKey !== requested) return null;
    const agentEngine = normalizeAgentEngine(
      snapshot.agentEngine || snapshot.agent_engine || snapshot.engine || runtimeConfig?.agentEngine || runtimeConfig?.agent_engine,
      "hermes"
    );
    return {
      ...snapshot,
      key: botKey,
      id: String(snapshot.id || botKey),
      name: String(snapshot.name || snapshot.displayName || snapshot.display_name || botKey),
      agentEngine,
      capabilities: snapshot.capabilities && typeof snapshot.capabilities === "object" ? snapshot.capabilities : {}
    };
  }

  return { botWithRuntimeConfig, cloudBotSnapshotForTurn };
}

module.exports = { createBotTurnHelpers };
