const { spawnExecutable } = require("../agent-runtime/process-launcher.js");

const ACP_ENGINE_IDS = Object.freeze(["claude", "codex", "hermes"]);

function childProcessOptions(options = {}, platform = process.platform) {
  const next = { ...(options || {}) };
  if (!next.signal) delete next.signal;
  if (platform === "win32") next.windowsHide = true;
  return next;
}

function spawnAcpEngineProcess(spawn, engineSpec = {}, options = {}, runtimeOptions = {}) {
  const spec = engineSpec && typeof engineSpec === "object" ? engineSpec : {};
  const command = String(spec.command || "").trim();
  const args = Array.isArray(spec.args) ? spec.args : [];
  const platform = runtimeOptions.platform || process.platform;
  return spawnExecutable(spawn, command, args, childProcessOptions(options, platform), { platform });
}

function buildAcpEngineSpecs(options = {}) {
  const hermesCommand = String(options.hermesCommandPath || options.hermesCommand || "").trim() || "hermes";
  return Object.freeze([
    Object.freeze({
      engineId: "claude",
      transport: "acp",
      command: "npx",
      args: ["-y", "@agentclientprotocol/claude-agent-acp@0.39.0"],
      supportsSteerInput: false,
      supportsQueuedInput: true
    }),
    Object.freeze({
      engineId: "codex",
      transport: "acp",
      command: "npx",
      args: ["-y", "@agentclientprotocol/codex-acp@1.1.0"],
      supportsSteerInput: false,
      supportsQueuedInput: true
    }),
    Object.freeze({
      engineId: "hermes",
      transport: "acp",
      command: hermesCommand,
      args: ["acp"],
      supportsSteerInput: false,
      supportsQueuedInput: true
    })
  ]);
}

function getAcpEngineSpec(engineId, options = {}) {
  const normalized = String(engineId || "").trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) return null;
  return buildAcpEngineSpecs(options).find((spec) => spec.engineId === normalized) || null;
}

const ACP_ENGINE_SPECS = buildAcpEngineSpecs();

module.exports = Object.freeze({
  ACP_ENGINE_IDS,
  ACP_ENGINE_SPECS,
  ENGINE_IDS: ACP_ENGINE_IDS,
  ENGINE_SPECS: ACP_ENGINE_SPECS,
  AGENT_SESSION_ENGINE_SPECS: ACP_ENGINE_SPECS,
  AGENT_SESSION_ENGINES: ACP_ENGINE_SPECS,
  acpEngineSpecForEngine: getAcpEngineSpec,
  acpEngineSpecs: buildAcpEngineSpecs,
  buildAcpEngineSpecs,
  childProcessOptions,
  getAcpEngineSpec,
  spawnAcpEngineProcess
});
