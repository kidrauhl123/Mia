"use strict";

function createMiaCoreRuntimeService(deps = {}) {
  const normalizeAgentEngine = typeof deps.normalizeAgentEngine === "function"
    ? deps.normalizeAgentEngine
    : (value) => String(value || "hermes").trim() || "hermes";
  const enginePermissionStoreTarget = typeof deps.enginePermissionStoreTarget === "function"
    ? deps.enginePermissionStoreTarget
    : () => "root-mode";

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

  return {
    botWithRuntimeConfig,
    cloudBotSnapshotForTurn
  };
}

module.exports = {
  createMiaCoreRuntimeService
};
