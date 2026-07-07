"use strict";

const {
  contextSnapshotInstruction,
  nativeContextModeFromConfig,
  selectNativeContextMode
} = require("./native-context-snapshot.js");

const MEMORY_TOOL_NAMES = Object.freeze([
  "memory_search",
  "memory_list",
  "memory_remember",
  "memory_update",
  "memory_forget"
]);

const SKILL_TOOL_NAMES = Object.freeze([
  "skill_list_current",
  "skill_read_current"
]);

function cleanText(value = "") {
  return String(value || "").trim();
}

function cleanId(value = "") {
  return String(value || "").trim();
}

function joinBlocks(...parts) {
  return parts
    .map((part) => cleanText(part))
    .filter(Boolean)
    .join("\n\n");
}

function buildMiaContextResource({
  engine = "",
  bot = {},
  botId = "",
  sessionId = "",
  runtimeConfig = null,
  modePrefix = "",
  mcpAvailable = false,
  nativeFilesAvailable = false,
  runtimePrompt = ""
} = {}) {
  const resolvedEngine = cleanId(engine);
  const resolvedBotId = cleanId(botId || bot?.key || bot?.id);
  const resolvedSessionId = cleanId(sessionId);
  const requestedMode = nativeContextModeFromConfig(bot, runtimeConfig, modePrefix || resolvedEngine);
  const nativeContextMode = selectNativeContextMode({
    requestedMode,
    mcpAvailable: Boolean(mcpAvailable)
  });
  const snapshotInstruction = nativeContextMode === "mcp"
    ? contextSnapshotInstruction({
        engine: resolvedEngine,
        botId: resolvedBotId,
        sessionId: resolvedSessionId
      })
    : "";
  const runtime = cleanText(runtimePrompt);
  const usingMcpContext = nativeContextMode === "mcp";
  const usingNativeFiles = !usingMcpContext && Boolean(nativeFilesAvailable);
  const personaDeliveryMode = usingMcpContext ? "mcp" : (usingNativeFiles ? "file" : (nativeContextMode === "prompt" ? "prompt" : "none"));
  const skillDeliveryMode = usingMcpContext ? "mcp" : (usingNativeFiles ? "file" : "prompt");

  return {
    engine: resolvedEngine,
    botId: resolvedBotId,
    sessionId: resolvedSessionId,
    requestedMode,
    nativeContextMode,
    runtime: {
      deliveryMode: runtime ? "prompt" : "none",
      prompt: runtime
    },
    persona: {
      deliveryMode: personaDeliveryMode,
      promptAllowed: personaDeliveryMode === "prompt",
      snapshotInstruction
    },
    memory: {
      deliveryMode: usingMcpContext ? "mcp" : "none",
      prompt: "",
      toolNames: usingMcpContext ? [...MEMORY_TOOL_NAMES] : []
    },
    skills: {
      deliveryMode: skillDeliveryMode,
      promptAllowed: skillDeliveryMode === "prompt",
      toolNames: usingMcpContext ? [...SKILL_TOOL_NAMES] : []
    },
    nativeFiles: {
      available: Boolean(nativeFilesAvailable),
      active: usingNativeFiles,
      fileNames: usingNativeFiles ? ["IDENTITY.md", "TOOLS.md"] : []
    },
    mcp: {
      available: Boolean(mcpAvailable),
      snapshotInstruction,
      toolNames: usingMcpContext ? [...MEMORY_TOOL_NAMES, ...SKILL_TOOL_NAMES] : []
    }
  };
}

function mcpContextPrompt(resource = {}, { includeRuntime = false } = {}) {
  const runtimePrompt = includeRuntime ? resource?.runtime?.prompt : "";
  return joinBlocks(runtimePrompt);
}

module.exports = {
  MEMORY_TOOL_NAMES,
  SKILL_TOOL_NAMES,
  buildMiaContextResource,
  mcpContextPrompt
};
