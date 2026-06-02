const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function toTomlStr(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function stripMiaSchedulerSection(toml = "") {
  const lines = String(toml || "").split("\n");
  const filtered = [];
  let inOurSection = false;
  for (const line of lines) {
    if (line.trim() === "[mcp_servers.mia-scheduler]") {
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
  const daemonStatus = typeof deps.daemonStatus === "function" ? deps.daemonStatus : () => ({});
  const daemonSettings = typeof deps.daemonSettings === "function" ? deps.daemonSettings : () => ({});
  const daemonToken = typeof deps.daemonToken === "function" ? deps.daemonToken : () => "";
  const nodePath = typeof deps.nodePath === "function" ? deps.nodePath : () => "";
  const serverScriptPath = typeof deps.serverScriptPath === "function"
    ? deps.serverScriptPath
    : () => path.join(__dirname, "scheduler-mcp-server.js");
  const homeDir = typeof deps.homeDir === "function" ? deps.homeDir : () => os.homedir();
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

  function writeContext({ fellowId = "", sessionId = "", originMessageId = "" } = {}) {
    const filePath = contextPath();
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    fsImpl.writeFileSync(filePath, JSON.stringify({ fellowId, sessionId, originMessageId }, null, 2), "utf8");
  }

  function daemonBaseUrl() {
    const status = daemonStatus();
    if (status?.baseUrl) return status.baseUrl;
    const settings = daemonSettings();
    if (settings?.host && settings?.port) {
      return `http://${settings.host}:${settings.port}`;
    }
    return "";
  }

  function getSpec() {
    const baseUrl = daemonBaseUrl();
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
        MIA_DAEMON_URL: baseUrl,
        MIA_DAEMON_TOKEN: daemonToken(),
        MIA_SCHEDULER_CONTEXT_FILE: contextPath()
      },
      alwaysLoad: true
    };
  }

  // Conversation history must NOT be shared with the user's own Codex CLI:
  // linking these makes every Fellow turn append to (and reload) the same
  // sessions pool the user fills via their terminal, which bloats a single
  // thread to hundreds of thousands of tokens — slow turns and "new session"
  // timeouts while Codex scans a giant session_index. Mia tracks its own
  // (engine, fellow, session) → thread id map in agent-session-store, so it
  // never needs the shared sessions/history to resume. Auth, model cache and
  // sqlite state are still linked so the user's existing login is reused.
  const SESSION_STATE_ENTRIES = new Set([
    "sessions",
    "history.jsonl",
    "session_index.jsonl"
  ]);

  function linkUserCodexState(userCodexHome, miaCodexHome) {
    if (!fsImpl.existsSync(userCodexHome)) return;
    let entries = [];
    try { entries = fsImpl.readdirSync(userCodexHome); } catch { return; }
    for (const name of entries) {
      if (name === "config.toml") continue;
      if (SESSION_STATE_ENTRIES.has(name)) continue;
      const target = path.join(userCodexHome, name);
      const link = path.join(miaCodexHome, name);
      let existing = null;
      try { existing = fsImpl.lstatSync(link); } catch { /* missing is fine */ }
      if (existing) {
        if (!existing.isSymbolicLink()) {
          try { fsImpl.rmSync(link, { recursive: true, force: true }); }
          catch { /* ignore stale cleanup failures */ }
        } else {
          continue;
        }
      }
      try {
        let stat = null;
        try { stat = fsImpl.statSync(target); } catch { /* broken target, skip */ }
        if (!stat) continue;
        fsImpl.symlinkSync(target, link, stat.isDirectory() ? "dir" : "file");
      } catch {
        // Ignore individual symlink failures: partial Codex state is still useful.
      }
    }
  }

  function schedulerTomlSection({ baseUrl, command, scriptPath }) {
    return [
      "",
      "[mcp_servers.mia-scheduler]",
      `command = ${toTomlStr(command)}`,
      `args = [${toTomlStr(scriptPath)}]`,
      "",
      "[mcp_servers.mia-scheduler.env]",
      `MIA_DAEMON_URL = ${toTomlStr(baseUrl)}`,
      `MIA_DAEMON_TOKEN = ${toTomlStr(daemonToken())}`,
      `MIA_SCHEDULER_CONTEXT_FILE = ${toTomlStr(contextPath())}`,
      ""
    ].join("\n");
  }

  function ensureCodexHome() {
    const baseUrl = daemonBaseUrl();
    if (!baseUrl) return "";
    const scriptPath = materializeServerScript();
    if (!scriptPath) return "";
    const command = resolveNodePath();
    if (!command) return "";

    const miaCodexHome = path.join(runtimePaths().runtime, "codex-home");
    fsImpl.mkdirSync(miaCodexHome, { recursive: true });

    const userCodexHome = path.join(homeDir(), ".codex");
    linkUserCodexState(userCodexHome, miaCodexHome);

    let baseConfig = "";
    try {
      baseConfig = fsImpl.readFileSync(path.join(userCodexHome, "config.toml"), "utf8");
    } catch {
      // No user config; write only Mia's MCP section.
    }

    const finalConfig = stripMiaSchedulerSection(baseConfig) + schedulerTomlSection({ baseUrl, command, scriptPath });
    fsImpl.writeFileSync(path.join(miaCodexHome, "config.toml"), finalConfig, "utf8");
    return miaCodexHome;
  }

  return {
    contextPath,
    daemonBaseUrl,
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
