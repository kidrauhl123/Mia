"use strict";

const crypto = require("node:crypto");

const { normalizeAcpMcpServer, normalizeAcpMcpServers } = require("./agent-session/acp-mcp-servers.js");
const { getAcpEngineSpec } = require("./agent-session/acp-engine-specs.js");
const { buildMiaContextResource, mcpContextPrompt } = require("./mia-context-resource.js");
const { createAgentSessionSkillRuntimeAdapter } = require("./agent-session-skill-runtime.js");

function hashRuntimePart(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function userMcpEngineId(engineId = "") {
  return engineId === "claude" ? "claude-code" : engineId;
}

function valueFromOption(source) {
  const resolved = typeof source === "function" ? source() : source;
  return String(resolved || "").trim();
}

function mergeRuntimeParts(base = {}, extra = {}) {
  const merged = { ...(base || {}), ...(extra || {}) };
  if (base.env || extra.env) {
    merged.env = {
      ...(base.env || {}),
      ...(extra.env || {})
    };
  }
  return Object.fromEntries(Object.entries(merged).filter(([, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === "object") return Object.keys(value).length > 0;
    return value != null && value !== "";
  }));
}

function createAgentSessionRuntimePreparer(options = {}) {
  const getMiaAppMcpSpec = typeof options.getMiaAppMcpSpec === "function" ? options.getMiaAppMcpSpec : () => null;
  const getSchedulerMcpSpec = typeof options.getSchedulerMcpSpec === "function" ? options.getSchedulerMcpSpec : () => null;
  const getUserMcpServers = typeof options.getUserMcpServers === "function" ? options.getUserMcpServers : () => [];
  const getMcpFingerprint = typeof options.getMcpFingerprint === "function" ? options.getMcpFingerprint : () => "";
  const writeMiaAppMcpContext = typeof options.writeMiaAppMcpContext === "function" ? options.writeMiaAppMcpContext : () => {};
  const writeSchedulerMcpContext = typeof options.writeSchedulerMcpContext === "function" ? options.writeSchedulerMcpContext : () => {};
  const hermesCommandPath = options.hermesCommandPath || (() => "");
  const skillRuntimeAdapter = options.skillRuntimeAdapter || createAgentSessionSkillRuntimeAdapter({
    listSkillRecordsForBot: typeof options.listSkillRecordsForBot === "function"
      ? options.listSkillRecordsForBot
      : undefined,
    resolveSkillRecord: typeof options.resolveSkillRecord === "function"
      ? options.resolveSkillRecord
      : undefined,
    resolveSkillRuntimeWithCore: typeof options.resolveSkillRuntimeWithCore === "function"
      ? options.resolveSkillRuntimeWithCore
      : undefined
  });

  function mcpContextFor(input = {}) {
    return {
      botId: String(input.botId || input.botKey || "").trim(),
      sessionId: String(input.conversationId || input.sessionId || "").trim()
    };
  }

  function prepareMcpRuntime(input = {}, engineId = "") {
    const context = mcpContextFor(input);
    const userServers = normalizeAcpMcpServers(getUserMcpServers(userMcpEngineId(engineId), {
      supportsHttp: false,
      supportsSse: false
    }));
    const miaAppServer = normalizeAcpMcpServer("mia-app", getMiaAppMcpSpec(context));
    const schedulerServer = normalizeAcpMcpServer("mia-scheduler", getSchedulerMcpSpec(context));
    const byName = new Map();
    for (const server of [...userServers, miaAppServer, schedulerServer].filter(Boolean)) {
      byName.set(server.name, server);
    }
    const mcpServers = Array.from(byName.values());
    if (!mcpServers.length) return {};

    const resource = buildMiaContextResource({
      engine: engineId,
      botId: context.botId,
      sessionId: context.sessionId,
      mcpAvailable: true
    });
    const initialPromptPrefix = mcpContextPrompt(resource, { includeRuntime: false });
    const userFingerprint = String(getMcpFingerprint() || "").trim();

    return {
      mcpServers,
      mcpFingerprint: `mcp:${hashRuntimePart({ mcpServers, userFingerprint })}`,
      initialPromptPrefix,
      refreshMcpContext(turn = {}) {
        const originMessageId = String(turn.turnId || turn.originMessageId || "").trim();
        const payload = {
          botId: context.botId,
          sessionId: context.sessionId,
          ...(originMessageId ? { originMessageId } : {})
        };
        writeMiaAppMcpContext(payload);
        writeSchedulerMcpContext(payload);
      }
    };
  }

  function prepareEngineSpecRuntime(engineId = "") {
    if (engineId !== "hermes") return {};
    const commandPath = valueFromOption(hermesCommandPath);
    if (!commandPath) return {};
    return {
      engineSpec: getAcpEngineSpec("hermes", { hermesCommandPath: commandPath })
    };
  }

  async function prepareSkillRuntime(input = {}, engineId = "", runtimeConfig = {}) {
    if (!skillRuntimeAdapter || typeof skillRuntimeAdapter.prepareAgentSessionSkillRuntime !== "function") {
      return {};
    }
    return skillRuntimeAdapter.prepareAgentSessionSkillRuntime({
      ...input,
      engineId,
      runtimeConfig
    });
  }

  async function prepare(input = {}) {
    const engineId = String(input.engineId || "").trim();
    const runtimeConfig = input.runtimeConfig && typeof input.runtimeConfig === "object"
      ? input.runtimeConfig
      : {};
    const mcpRuntime = prepareMcpRuntime(input, engineId);
    const skillRuntime = await prepareSkillRuntime(input, engineId, runtimeConfig);
    const engineSpecRuntime = prepareEngineSpecRuntime(engineId);
    return mergeRuntimeParts(mergeRuntimeParts(mcpRuntime, skillRuntime), engineSpecRuntime);
  }

  return { prepare };
}

module.exports = {
  createAgentSessionRuntimePreparer
};
