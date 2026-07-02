const fs = require("node:fs");
const path = require("node:path");
const { execFileExecutable, isWindowsShellShim, spawnExecutable } = require("../agent-runtime/process-launcher.js");

const ACP_ENGINE_IDS = Object.freeze(["claude", "codex", "hermes", "openclaw"]);

function buildOpenClawGlobalArgs(config = {}) {
  const profile = String(config.openclawProfile || config.profile || "").trim();
  if (!profile) return [];
  if (!/^[A-Za-z0-9._-]+$/.test(profile)) {
    throw new Error("OpenClaw profile 名称只能包含字母、数字、点、下划线和短横线。");
  }
  return ["--profile", profile];
}

function buildOpenClawAcpArgs(bot = {}, options = {}) {
  const config = bot.engineConfig || {};
  const args = [...buildOpenClawGlobalArgs(config), "acp", "--no-prefix-cwd"];
  const sessionKey = String(options.sessionKey || "").trim();
  if (sessionKey) args.push("--session", sessionKey);
  const sessionLabel = String(config.openclawSessionLabel || "").trim();
  if (sessionLabel) args.push("--session-label", sessionLabel);
  if (config.openclawResetSession === true) args.push("--reset-session");
  if (config.openclawRequireExisting === true) args.push("--require-existing");
  const gatewayUrl = String(config.openclawGatewayUrl || config.gatewayUrl || "").trim();
  if (gatewayUrl) args.push("--url", gatewayUrl);
  const tokenFile = String(config.openclawGatewayTokenFile || "").trim();
  if (tokenFile) args.push("--token-file", tokenFile);
  const passwordFile = String(config.openclawGatewayPasswordFile || "").trim();
  if (passwordFile) args.push("--password-file", passwordFile);
  return args;
}

function openClawCommandSpec(file, args = [], runtimeOptions = {}) {
  const platform = runtimeOptions.platform || process.platform;
  if (isWindowsShellShim(file, platform)) {
    const script = path.join(path.dirname(file), "node_modules", "openclaw", "openclaw.mjs");
    if (fs.existsSync(script)) {
      return {
        file: runtimeOptions.nodePath || process.execPath,
        args: [script, ...(Array.isArray(args) ? args : [])]
      };
    }
  }
  return {
    file,
    args: Array.isArray(args) ? args.slice() : []
  };
}

function childProcessOptions(options = {}, platform = process.platform) {
  const next = { ...(options || {}) };
  if (!next.signal) delete next.signal;
  if (platform === "win32") next.windowsHide = true;
  return next;
}

function execFileAsync(execFile, file, args, options = {}, runtimeOptions = {}) {
  return new Promise((resolve, reject) => {
    const platform = runtimeOptions.platform || process.platform;
    const spec = openClawCommandSpec(file, args, runtimeOptions);
    const child = execFileExecutable(execFile, spec.file, spec.args, childProcessOptions(options, platform), (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    }, { platform });
    if (options.input != null) {
      try { child.stdin?.end(String(options.input)); } catch { /* stdin may be unavailable in tests or old CLIs */ }
    }
    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        try { child.kill(); } catch { /* already exited */ }
      }, { once: true });
    }
  });
}

function spawnOpenClaw(spawn, file, args, options = {}, runtimeOptions = {}) {
  const platform = runtimeOptions.platform || process.platform;
  const spec = openClawCommandSpec(file, args, runtimeOptions);
  return spawnExecutable(spawn, spec.file, spec.args, childProcessOptions(options, platform), { platform });
}

function buildAcpEngineSpecs(options = {}) {
  const openClawArgs = typeof options.buildOpenClawAcpArgs === "function"
    ? options.buildOpenClawAcpArgs
    : buildOpenClawAcpArgs;
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
      args: ["-y", "@zed-industries/codex-acp@0.14.0"],
      supportsSteerInput: false,
      supportsQueuedInput: true
    }),
    Object.freeze({
      engineId: "hermes",
      transport: "acp",
      command: "hermes",
      args: ["acp"],
      supportsSteerInput: false,
      supportsQueuedInput: true
    }),
    Object.freeze({
      engineId: "openclaw",
      transport: "acp",
      command: "openclaw",
      args: openClawArgs(),
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
  buildOpenClawAcpArgs,
  buildOpenClawGlobalArgs,
  childProcessOptions,
  execFileAsync,
  getAcpEngineSpec,
  openClawCommandSpec,
  spawnOpenClaw
});
