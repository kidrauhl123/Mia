const fs = require("node:fs");
const path = require("node:path");

function createMiaAppMcpBridge(deps = {}) {
  const runtimePaths = deps.runtimePaths;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");

  const fsImpl = deps.fs || fs;
  const daemonStatus = typeof deps.daemonStatus === "function" ? deps.daemonStatus : () => ({});
  const daemonSettings = typeof deps.daemonSettings === "function" ? deps.daemonSettings : () => ({});
  const daemonToken = typeof deps.daemonToken === "function" ? deps.daemonToken : () => "";
  const nodePath = typeof deps.nodePath === "function" ? deps.nodePath : () => "";
  const serverScriptPath = typeof deps.serverScriptPath === "function"
    ? deps.serverScriptPath
    : () => path.join(__dirname, "mia-app-mcp-server.js");
  let cachedNodePath = null;

  function resolveNodePath() {
    if (cachedNodePath !== null) return cachedNodePath;
    cachedNodePath = String(nodePath() || "").trim();
    return cachedNodePath;
  }

  function resetNodePathCache() {
    cachedNodePath = null;
  }

  function rootDir() {
    return path.join(runtimePaths().runtime, "mia-app-mcp");
  }

  function contextPath() {
    return path.join(rootDir(), "context.json");
  }

  function runtimeServerScriptPath() {
    return path.join(rootDir(), "mia-app-mcp-server.js");
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
      // Missing target is rewritten below.
    }
    if (current !== source) fsImpl.writeFileSync(targetPath, source, "utf8");
    return targetPath;
  }

  function writeContext({ botId = "", sessionId = "", originMessageId = "" } = {}) {
    const filePath = contextPath();
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    const payload = { botId, sessionId };
    if (originMessageId) payload.originMessageId = originMessageId;
    fsImpl.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  }

  function daemonBaseUrl() {
    const status = daemonStatus();
    if (status?.baseUrl) return status.baseUrl;
    const settings = daemonSettings();
    if (settings?.host && settings?.port) return `http://${settings.host}:${settings.port}`;
    return "";
  }

  function getSpec(context = {}) {
    const baseUrl = daemonBaseUrl();
    if (!baseUrl) return null;
    const scriptPath = materializeServerScript();
    if (!scriptPath) return null;
    const command = resolveNodePath();
    if (!command) return null;
    writeContext(context);
    return {
      type: "stdio",
      command,
      args: [scriptPath],
      env: {
        MIA_DAEMON_URL: baseUrl,
        MIA_DAEMON_TOKEN: daemonToken(),
        MIA_APP_CONTEXT_FILE: contextPath()
      },
      alwaysLoad: true
    };
  }

  return {
    contextPath,
    daemonBaseUrl,
    getSpec,
    materializeServerScript,
    resetNodePathCache,
    resolveNodePath,
    writeContext
  };
}

module.exports = { createMiaAppMcpBridge };
