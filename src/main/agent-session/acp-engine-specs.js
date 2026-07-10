const { spawnExecutable } = require("../agent-runtime/process-launcher.js");

const ACP_ENGINE_IDS = Object.freeze(["claude", "codex", "hermes"]);
const MANAGED_ENGINE_PROTOCOLS = Object.freeze({
  claude: Object.freeze(["acp", "cli", "claude-code-cli"]),
  codex: Object.freeze(["acp", "cli", "codex-cli", "codex-app-server"])
});

function normalizeAcpEngineId(value = "") {
  const id = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (id === "claude-code" || id === "claude-code-agent") return "claude";
  if (id === "openai-codex" || id === "codex-cli") return "codex";
  if (id === "hermes-cli") return "hermes";
  return id;
}

function managedServiceEngineId(engineId = "") {
  return engineId === "claude" ? "claude-code" : engineId;
}

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

function managedRuntimeForEngine(engineId, options = {}) {
  const runtimeByEngine = options.managedRuntimeByEngine || options.managedRuntimes;
  if (runtimeByEngine && typeof runtimeByEngine === "object") {
    const direct = runtimeByEngine[engineId] || runtimeByEngine[managedServiceEngineId(engineId)];
    if (direct?.path || direct?.command) return direct;
  }
  if (typeof options.resolveManagedAgentRuntime === "function") {
    const runtime = options.resolveManagedAgentRuntime(managedServiceEngineId(engineId), {
      protocols: MANAGED_ENGINE_PROTOCOLS[engineId] || []
    });
    if (runtime?.path || runtime?.command) return runtime;
  }
  const service = options.managedAgentRuntime;
  if (service && typeof service.resolve === "function") {
    const runtime = service.resolve(managedServiceEngineId(engineId), {
      protocols: MANAGED_ENGINE_PROTOCOLS[engineId] || []
    });
    if (runtime?.path || runtime?.command) return runtime;
  }
  return null;
}

function specFromManagedRuntime(engineId, runtime = {}) {
  if (!runtime || typeof runtime !== "object") return null;
  const command = String(runtime.command || runtime.path || "").trim();
  if (!command) return null;
  return Object.freeze({
    engineId,
    transport: "acp",
    command,
    args: Array.isArray(runtime.args) ? runtime.args.map(String) : [],
    source: String(runtime.source || "managed"),
    managed: true,
    runtimePath: String(runtime.path || command),
    runtimeVersion: String(runtime.version || ""),
    runtimeProtocol: String(runtime.protocol || ""),
    supportsSteerInput: false,
    supportsQueuedInput: true
  });
}

function buildAcpEngineSpecs(options = {}) {
  const hermesCommand = String(options.hermesCommandPath || options.hermesCommand || "").trim() || "hermes";
  return Object.freeze([
    specFromManagedRuntime("claude", managedRuntimeForEngine("claude", options)),
    specFromManagedRuntime("codex", managedRuntimeForEngine("codex", options)),
    Object.freeze({
      engineId: "hermes",
      transport: "acp",
      command: hermesCommand,
      args: ["acp"],
      supportsSteerInput: false,
      supportsQueuedInput: true
    })
  ].filter(Boolean));
}

function getAcpEngineSpec(engineId, options = {}) {
  const normalized = normalizeAcpEngineId(engineId);
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
  managedRuntimeForEngine,
  normalizeAcpEngineId,
  specFromManagedRuntime,
  spawnAcpEngineProcess
});
