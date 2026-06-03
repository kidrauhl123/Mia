const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync: defaultSpawnSync } = require("node:child_process");

const SYSTEM_CLI_PATH_SEGMENTS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin"
];

function commandNameOnly(command) {
  const value = String(command || "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(value)) return "";
  return value;
}

function createLocalAgentEngineService(deps = {}) {
  const homeDir = typeof deps.homeDir === "function" ? deps.homeDir : () => os.homedir();
  const envSource = deps.env || process.env;
  const spawnSync = deps.spawnSync || defaultSpawnSync;
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const fsImpl = deps.fs || fs;
  const platform = deps.platform || process.platform;
  const cacheMs = Number.isFinite(Number(deps.cacheMs)) ? Number(deps.cacheMs) : 15000;
  let agentEngineCache = { at: 0, value: null };

  function currentEnv() {
    return typeof envSource === "function" ? (envSource() || {}) : envSource;
  }

  function cliPathSegments() {
    const home = String(homeDir() || "").trim();
    const userSegments = home ? [
      path.join(home, ".local", "bin"),
      path.join(home, ".npm-global", "bin"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".deno", "bin"),
      path.join(home, ".cargo", "bin"),
      path.join(home, "Library", "pnpm")
    ] : [];
    return [...userSegments, ...SYSTEM_CLI_PATH_SEGMENTS];
  }

  function cliPathEnv() {
    const current = String(currentEnv().PATH || "");
    const segments = [
      ...cliPathSegments(),
      ...current.split(path.delimiter)
    ].filter(Boolean);
    return [...new Set(segments)].join(path.delimiter);
  }

  function processEnvWithCliPath() {
    return {
      ...currentEnv(),
      PATH: cliPathEnv()
    };
  }

  function executablePath(filePath) {
    try {
      fsImpl.accessSync(filePath, fs.constants.X_OK);
      return filePath;
    } catch {
      return "";
    }
  }

  // Windows has no zsh and uses .exe/.cmd/.bat executables, so the posix
  // `command -v` + bare-name file scan never resolves a CLI there. `where`
  // searches the real PATH with PATHEXT and returns the full path (extension
  // included), which is exactly what the engine SDKs need to spawn it.
  function windowsCommandPath(name) {
    const result = spawnSync("where", [name], {
      encoding: "utf8",
      timeout: 1500,
      env: processEnvWithCliPath()
    });
    if (!result.error && result.status === 0) {
      const found = String(result.stdout || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
      if (found) return found;
    }
    return "";
  }

  function shellCommandPath(command) {
    const name = commandNameOnly(command);
    if (!name) return "";
    if (platform === "win32") return windowsCommandPath(name);
    const result = spawnSync("zsh", ["-lc", `command -v ${name}`], {
      encoding: "utf8",
      timeout: 1500,
      env: processEnvWithCliPath()
    });
    if (!result.error && result.status === 0) {
      const found = String(result.stdout || "").split(/\r?\n/)[0]?.trim() || "";
      if (found) return found;
    }
    for (const dir of cliPathSegments()) {
      const found = executablePath(path.join(dir, name));
      if (found) return found;
    }
    return "";
  }

  function commandVersion(commandPath) {
    if (!commandPath) return "";
    const result = spawnSync(commandPath, ["--version"], {
      encoding: "utf8",
      timeout: 2000,
      env: processEnvWithCliPath()
    });
    if (result.error) return "";
    return String(result.stdout || result.stderr || "").split(/\r?\n/)[0]?.trim() || "";
  }

  function resetCache() {
    agentEngineCache = { at: 0, value: null };
  }

  function localAgentEngines() {
    const at = now();
    if (agentEngineCache.value && at - agentEngineCache.at < cacheMs) return agentEngineCache.value;
    const claudePath = shellCommandPath("claude");
    const codexPath = shellCommandPath("codex");
    const value = {
      hermes: {
        id: "hermes",
        label: "默认",
        available: true,
        system: { available: false, disabled: true }
      },
      claudeCode: {
        id: "claude-code",
        label: "Claude Code",
        available: Boolean(claudePath),
        path: claudePath,
        version: commandVersion(claudePath)
      },
      codex: {
        id: "codex",
        label: "Codex",
        available: Boolean(codexPath),
        path: codexPath,
        version: commandVersion(codexPath)
      }
    };
    agentEngineCache = { at, value };
    return value;
  }

  return {
    cliPathEnv,
    cliPathSegments,
    commandNameOnly,
    commandVersion,
    localAgentEngines,
    processEnvWithCliPath,
    resetCache,
    shellCommandPath
  };
}

module.exports = {
  commandNameOnly,
  createLocalAgentEngineService
};
