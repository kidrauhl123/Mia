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

const AGENT_DEFINITIONS = Object.freeze([
  {
    id: "hermes",
    legacyKey: "hermes",
    label: "Hermes",
    commands: ["hermes"],
    installable: true,
    detectionOnly: false
  },
  {
    id: "claude-code",
    legacyKey: "claudeCode",
    label: "Claude Code",
    commands: ["claude"],
    installable: false,
    detectionOnly: false
  },
  {
    id: "codex",
    legacyKey: "codex",
    label: "Codex",
    commands: ["codex"],
    installable: false,
    detectionOnly: false
  },
  {
    id: "openclaw",
    legacyKey: "openClaw",
    label: "OpenClaw",
    commands: ["openclaw", "claw"],
    installable: false,
    detectionOnly: true
  }
]);

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
  const isHermesInstalled = typeof deps.isHermesInstalled === "function"
    ? deps.isHermesInstalled
    : () => false;
  const hermesSource = typeof deps.hermesSource === "function"
    ? deps.hermesSource
    : () => "";
  const cacheMs = Number.isFinite(Number(deps.cacheMs)) ? Number(deps.cacheMs) : 15000;
  let agentInventoryCache = { at: 0, value: null };
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
    agentInventoryCache = { at: 0, value: null };
    agentEngineCache = { at: 0, value: null };
  }

  function firstCommandPath(commands) {
    for (const command of commands) {
      const found = shellCommandPath(command);
      if (found) {
        return {
          command,
          path: found,
          version: commandVersion(found)
        };
      }
    }
    return { command: commands[0] || "", path: "", version: "" };
  }

  function miaHermesSource() {
    const source = String(hermesSource() || "").trim();
    if (source === "bundled") return "mia-bundled";
    if (source === "managed") return "mia-managed";
    return "";
  }

  function miaHermesUsable() {
    const source = miaHermesSource();
    return Boolean(source && isHermesInstalled());
  }

  function agentStatus(definition) {
    const probe = firstCommandPath(definition.commands);
    const systemAvailable = Boolean(probe.path);
    const hermesRuntimeUsable = definition.id === "hermes" ? miaHermesUsable() : false;
    const installed = Boolean(systemAvailable || hermesRuntimeUsable);
    const usableInMia = definition.id === "hermes"
      ? hermesRuntimeUsable
      : Boolean(systemAvailable && !definition.detectionOnly);
    const source = definition.id === "hermes" && hermesRuntimeUsable
      ? miaHermesSource()
      : systemAvailable
        ? "system"
        : "missing";
    const health = usableInMia ? "ready" : installed ? "detected" : "missing";
    return {
      id: definition.id,
      label: definition.label,
      commands: definition.commands.slice(),
      command: probe.command,
      installed,
      usableInMia,
      installable: Boolean(definition.installable),
      installAction: definition.id === "hermes" && !usableInMia ? "install-hermes" : "",
      detectionOnly: Boolean(definition.detectionOnly),
      path: probe.path,
      version: probe.version,
      source,
      health,
      system: {
        available: systemAvailable,
        path: probe.path,
        version: probe.version
      }
    };
  }

  function agentInventory() {
    const at = now();
    if (agentInventoryCache.value && at - agentInventoryCache.at < cacheMs) return agentInventoryCache.value;
    const agents = AGENT_DEFINITIONS.map(agentStatus);
    const installedCount = agents.filter((agent) => agent.installed).length;
    const usableCount = agents.filter((agent) => agent.usableInMia).length;
    const value = {
      generatedAt: at,
      agents,
      summary: {
        installedCount,
        usableCount,
        missingCount: agents.length - installedCount,
        hasUsableAgent: usableCount > 0,
        recommendedAction: usableCount > 0 ? "continue" : "install-hermes"
      }
    };
    agentInventoryCache = { at, value };
    return value;
  }

  function inventoryAgent(id) {
    return agentInventory().agents.find((agent) => agent.id === id) || null;
  }

  function localAgentEngines() {
    const at = now();
    if (agentEngineCache.value && at - agentEngineCache.at < cacheMs) return agentEngineCache.value;
    const hermes = inventoryAgent("hermes") || {};
    const claudeCode = inventoryAgent("claude-code") || {};
    const codex = inventoryAgent("codex") || {};
    const openClaw = inventoryAgent("openclaw") || {};
    const value = {
      hermes: {
        id: "hermes",
        label: "默认",
        available: Boolean(hermes.usableInMia),
        installed: Boolean(hermes.installed),
        path: hermes.path || "",
        version: hermes.version || "",
        source: hermes.source || "missing",
        system: hermes.system || { available: false, path: "", version: "" }
      },
      claudeCode: {
        id: "claude-code",
        label: "Claude Code",
        available: Boolean(claudeCode.usableInMia),
        installed: Boolean(claudeCode.installed),
        path: claudeCode.path || "",
        version: claudeCode.version || ""
      },
      codex: {
        id: "codex",
        label: "Codex",
        available: Boolean(codex.usableInMia),
        installed: Boolean(codex.installed),
        path: codex.path || "",
        version: codex.version || ""
      },
      openClaw: {
        id: "openclaw",
        label: "OpenClaw",
        available: Boolean(openClaw.usableInMia),
        installed: Boolean(openClaw.installed),
        path: openClaw.path || "",
        version: openClaw.version || "",
        detectionOnly: true
      }
    };
    agentEngineCache = { at, value };
    return value;
  }

  return {
    agentInventory,
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
