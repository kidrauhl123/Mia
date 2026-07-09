const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentRuntimeProfileService } = require("./agent-runtime-profile-service.js");

function toTomlStr(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function stripMiaSchedulerSection(toml = "") {
  const lines = String(toml || "").split("\n");
  const filtered = [];
  let inOurSection = false;
  for (const line of lines) {
    if (/^\[mcp_servers\.mia-scheduler(?:\.env)?\]$/.test(line.trim())) {
      inOurSection = true;
      continue;
    }
    if (inOurSection && line.trimStart().startsWith("[")) {
      inOurSection = false;
    }
    if (!inOurSection) filtered.push(line);
  }
  return filtered.join("\n").trimEnd();
}

function createSchedulerMcpBridge(deps = {}) {
  const runtimePaths = deps.runtimePaths;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");

  const fsImpl = deps.fs || fs;
  const coreStatus = typeof deps.coreStatus === "function" ? deps.coreStatus : () => ({});
  const coreSettings = typeof deps.coreSettings === "function" ? deps.coreSettings : () => ({});
  const coreToken = typeof deps.coreToken === "function" ? deps.coreToken : () => "";
  const nodePath = typeof deps.nodePath === "function" ? deps.nodePath : () => "";
  const serverScriptPath = typeof deps.serverScriptPath === "function"
    ? deps.serverScriptPath
    : () => path.join(__dirname, "scheduler-mcp-server.js");
  const homeDir = typeof deps.homeDir === "function" ? deps.homeDir : () => os.homedir();
  const runtimeProfileService = deps.runtimeProfileService || createAgentRuntimeProfileService({
    runtimePaths,
    fs: fsImpl,
    homeDir
  });
  let cachedNodePath = null;

  function resolveNodePath() {
    if (cachedNodePath !== null) return cachedNodePath;
    cachedNodePath = String(nodePath() || "").trim();
    return cachedNodePath;
  }

  function resetNodePathCache() {
    cachedNodePath = null;
  }

  function contextPath() {
    return path.join(runtimePaths().runtime, "scheduler-mcp", "context.json");
  }

  function runtimeServerScriptPath() {
    return path.join(runtimePaths().runtime, "scheduler-mcp", "scheduler-mcp-server.js");
  }

  function materializeServerScript() {
    const sourcePath = serverScriptPath();
    if (!sourcePath || !fsImpl.existsSync(sourcePath)) return "";
    let source = "";
    try {
      source = fsImpl.readFileSync(sourcePath, "utf8");
    } catch {
      return "";
    }
    const targetPath = runtimeServerScriptPath();
    fsImpl.mkdirSync(path.dirname(targetPath), { recursive: true });
    let current = null;
    try {
      current = fsImpl.readFileSync(targetPath, "utf8");
    } catch {
      // Missing or unreadable target: rewrite below.
    }
    if (current !== source) fsImpl.writeFileSync(targetPath, source, "utf8");
    return targetPath;
  }

  function writeContext({ botId = "", sessionId = "", originMessageId = "" } = {}) {
    const filePath = contextPath();
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    fsImpl.writeFileSync(filePath, JSON.stringify({ botId, sessionId, originMessageId }, null, 2), "utf8");
  }

  function coreBaseUrl() {
    const status = coreStatus();
    if (status?.baseUrl) return status.baseUrl;
    const settings = coreSettings();
    if (settings?.host && settings?.port) {
      return `http://${settings.host}:${settings.port}`;
    }
    return "";
  }

  function getSpec() {
    const baseUrl = coreBaseUrl();
    if (!baseUrl) return null;
    const scriptPath = materializeServerScript();
    if (!scriptPath) return null;
    const command = resolveNodePath();
    if (!command) return null;
    return {
      type: "stdio",
      command,
      args: [scriptPath],
      env: {
        MIA_CORE_URL: baseUrl,
        MIA_CORE_TOKEN: coreToken(),
        MIA_SCHEDULER_CONTEXT_FILE: contextPath()
      },
      alwaysLoad: true
    };
  }

  function schedulerTomlSection({ baseUrl, command, scriptPath }) {
    return [
      "",
      "[mcp_servers.mia-scheduler]",
      `command = ${toTomlStr(command)}`,
      `args = [${toTomlStr(scriptPath)}]`,
      "",
      "[mcp_servers.mia-scheduler.env]",
      `MIA_CORE_URL = ${toTomlStr(baseUrl)}`,
      `MIA_CORE_TOKEN = ${toTomlStr(coreToken())}`,
      `MIA_SCHEDULER_CONTEXT_FILE = ${toTomlStr(contextPath())}`,
      ""
    ].join("\n");
  }

  function ensureCodexHome(options = {}) {
    const profile = options.syncSchedulerMcp === false
      ? (typeof runtimeProfileService.ensureCodexProbeProfile === "function"
          ? runtimeProfileService.ensureCodexProbeProfile()
          : { home: path.join(runtimePaths().runtime, "codex-probe-home") })
      : runtimeProfileService.ensureCodexProfile();
    const codexHome = profile.home;
    if (options.syncSchedulerMcp === false) return codexHome;

    const baseUrl = coreBaseUrl();
    if (!baseUrl) return codexHome;
    const scriptPath = materializeServerScript();
    if (!scriptPath) return codexHome;
    const command = resolveNodePath();
    if (!command) return codexHome;

    const configPath = path.join(codexHome, "config.toml");
    let baseConfig = "";
    try {
      baseConfig = fsImpl.readFileSync(configPath, "utf8");
    } catch {
      // No user config; write only Mia's MCP section.
    }

    const finalConfig = stripMiaSchedulerSection(baseConfig) + schedulerTomlSection({ baseUrl, command, scriptPath });
    fsImpl.writeFileSync(configPath, finalConfig, "utf8");
    return codexHome;
  }

  return {
    contextPath,
    coreBaseUrl,
    ensureCodexHome,
    getSpec,
    resetNodePathCache,
    resolveNodePath,
    serverScriptPath,
    writeContext
  };
}

module.exports = {
  createSchedulerMcpBridge,
  stripMiaSchedulerSection,
  toTomlStr
};
