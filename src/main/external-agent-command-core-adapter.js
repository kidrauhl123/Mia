"use strict";

function commandText(input = {}) {
  return String(input.text || input.commandText || "").trim();
}

function sourceDeviceIdValue(sourceDeviceId) {
  try {
    return typeof sourceDeviceId === "function" ? String(sourceDeviceId() || "").trim() : "";
  } catch {
    return "";
  }
}

function createExternalAgentCommandCoreAdapter({
  coreRequest,
  projectPath = () => "",
  sourceDeviceId = () => ""
} = {}) {
  if (typeof coreRequest !== "function") {
    throw new Error("coreRequest dependency is required.");
  }

  function baseProjectPath(input = {}) {
    return String(input.projectPath || input.context?.projectPath || projectPath() || "").trim();
  }

  function contextWithCoreDefaults(input = {}) {
    const context = input.context && typeof input.context === "object" ? { ...input.context } : {};
    if (!context.projectPath) context.projectPath = baseProjectPath(input);
    if (!context.sourceDeviceId) context.sourceDeviceId = sourceDeviceIdValue(sourceDeviceId);
    return context;
  }

  async function loadCommands(input = {}) {
    return coreRequest({
      method: "POST",
      route: "/api/agents/commands/list",
      body: {
        ...input,
        projectPath: baseProjectPath(input)
      }
    });
  }

  async function executeCommand(input = {}) {
    return coreRequest({
      method: "POST",
      route: "/api/agents/commands/execute",
      body: {
        ...input,
        projectPath: baseProjectPath(input),
        context: contextWithCoreDefaults(input)
      }
    });
  }

  async function runSlashCommand(input = {}) {
    return executeCommand({
      engine: input.engine,
      text: commandText(input),
      context: {
        bot: input.bot || {},
        sessionId: input.sessionId || "",
        projectPath: baseProjectPath(input),
        sourceDeviceId: sourceDeviceIdValue(sourceDeviceId)
      }
    });
  }

  return {
    executeCommand,
    loadCommands,
    runSlashCommand
  };
}

module.exports = {
  createExternalAgentCommandCoreAdapter
};
