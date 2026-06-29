"use strict";

const { buildBotTurnContext } = require("../../shared/bot-turn-context.js");
const { materializeLegacyBotPrompt } = require("../../shared/bot-prompt-materializer.js");
const { activeSkillIdsFromMessage } = require("./local-bot-responder.js");
const { normalizeTurnRuntimeConfig } = require("../runtime-config-normalizer.js");

function normalizedBotSnapshot(botSnapshot = {}, botId = "", runtimeAgentEngine = "") {
  const botAgentEngine = String(botSnapshot.agentEngine || botSnapshot.agent_engine || "").trim();
  return {
    ...botSnapshot,
    key: botSnapshot.key || botSnapshot.id || botId,
    id: botSnapshot.id || botSnapshot.key || botId,
    name: botSnapshot.name || botSnapshot.displayName || botSnapshot.display_name || botId,
    ...(botAgentEngine ? { agentEngine: botAgentEngine } : {}),
    ...(runtimeAgentEngine && !botAgentEngine ? { agentEngine: runtimeAgentEngine } : {})
  };
}

function buildBotInvocation(payload, bots) {
  const context = buildBotTurnContext(payload || {}, { bots });
  if (!context) return null;
  const args = materializeLegacyBotPrompt(context, { bots });
  if (!args) return null;

  const normalizedRuntimeConfig = normalizeTurnRuntimeConfig(payload?.runtimeConfig);
  const nextRuntimeConfig = Object.keys(normalizedRuntimeConfig).length ? { ...normalizedRuntimeConfig } : null;
  const botAgentEngine = String(args.botSnapshot?.agentEngine || args.botSnapshot?.agent_engine || "").trim();
  const runtimeAgentEngine = String(nextRuntimeConfig?.agentEngine || nextRuntimeConfig?.agent_engine || "").trim();
  if (botAgentEngine && nextRuntimeConfig && (!runtimeAgentEngine || runtimeAgentEngine === "hermes")) {
    nextRuntimeConfig.agentEngine = botAgentEngine;
  }

  return {
    ...args,
    botSnapshot: normalizedBotSnapshot(args.botSnapshot, args.botId, runtimeAgentEngine),
    runtimeConfig: nextRuntimeConfig,
    activeSkillIds: activeSkillIdsFromMessage(payload?.triggeringMessage)
  };
}

module.exports = { buildBotInvocation };
