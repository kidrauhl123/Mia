const {
  AgentSessionManager
} = require("./agent-session-manager.js");
const {
  createAcpAgentSession
} = require("./acp-agent-session.js");
const contract = require("./agent-session-contract.js");
const acpEngineSpecs = require("./acp-engine-specs.js");

function mergedAcpEngineSpec(engineId) {
  let normalizedEngineId;
  try {
    normalizedEngineId = contract.assertKnownAgentEngine(engineId);
  } catch {
    return null;
  }

  const contractSpec = contract.ENGINE_SPECS.find((spec) => spec.engineId === normalizedEngineId) || null;
  const runtimeSpec = acpEngineSpecs.getAcpEngineSpec(normalizedEngineId) || null;
  if (!contractSpec && !runtimeSpec) return null;
  return Object.freeze({
    ...(contractSpec || {}),
    ...(runtimeSpec || {})
  });
}

function listAcpEngineSpecs() {
  return Object.freeze(
    contract.ENGINE_IDS
      .map((engineId) => mergedAcpEngineSpec(engineId))
      .filter(Boolean)
  );
}

function getAcpEngineSpec(engineId) {
  return mergedAcpEngineSpec(engineId);
}

function createAgentSessionManager(options = {}) {
  const engineSpecs = Array.isArray(options.engineSpecs) ? options.engineSpecs : listAcpEngineSpecs();
  const createSession = typeof options.createSession === "function"
    ? options.createSession
    : async (descriptor = {}) => createAcpAgentSession({
      ...descriptor,
      engineSpec: descriptor.engineSpec || getAcpEngineSpec(descriptor.engineId),
      ...(typeof options.requestPermission === "function" ? { requestPermission: options.requestPermission } : {})
    });

  return new AgentSessionManager({
    ...options,
    engineSpecs,
    createSession
  });
}

module.exports = Object.freeze({
  AgentSessionManager,
  createAgentSessionManager,
  createAcpAgentSession,
  getAcpEngineSpec,
  listAcpEngineSpecs,
  ...contract
});
