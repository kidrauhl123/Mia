const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync: defaultSpawnSync, execFile: defaultExecFile } = require("node:child_process");

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
    installable: true,
    detectionOnly: false
  },
  {
    id: "codex",
    legacyKey: "codex",
    label: "Codex",
    commands: ["codex"],
    installable: true,
    detectionOnly: false
  },
  {
    id: "openclaw",
    legacyKey: "openClaw",
    label: "OpenClaw",
    commands: ["openclaw", "claw"],
    installable: true,
    detectionOnly: false
  }
]);

function safeReadDir(fsImpl, dir) {
  const readDir = typeof fsImpl.readdirSync === "function" ? fsImpl.readdirSync.bind(fsImpl) : fs.readdirSync;
  try {
    return readDir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function nodeVersionManagerPathSegments(home, env, fsImpl) {
  if (!home) return [];
  const segments = [
    env.NVM_BIN || "",
    env.PNPM_HOME || "",
    env.BUN_INSTALL ? path.join(env.BUN_INSTALL, "bin") : "",
    env.VOLTA_HOME ? path.join(env.VOLTA_HOME, "bin") : "",
    path.join(home, ".nvm", "current", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".asdf", "shims"),
    path.join(home, ".local", "share", "mise", "shims"),
    path.join(home, ".local", "share", "rtx", "shims")
  ];

  const nvmNodeRoot = path.join(home, ".nvm", "versions", "node");
  const nvmBins = safeReadDir(fsImpl, nvmNodeRoot)
    .filter((entry) => entry.isDirectory && entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse()
    .map((name) => path.join(nvmNodeRoot, name, "bin"));
  segments.push(...nvmBins);

  for (const root of [
    path.join(home, ".fnm", "node-versions"),
    path.join(home, ".local", "share", "fnm", "node-versions")
  ]) {
    const bins = safeReadDir(fsImpl, root)
      .filter((entry) => entry.isDirectory && entry.isDirectory())
      .map((entry) => path.join(root, entry.name, "installation", "bin"));
    segments.push(...bins);
  }

  if (env.APPDATA) segments.push(path.join(env.APPDATA, "npm"));
  if (env.LOCALAPPDATA) {
    segments.push(
      path.join(env.LOCALAPPDATA, "Programs", "Volta", "bin"),
      path.join(env.LOCALAPPDATA, "fnm_multishells")
    );
  }

  return segments.filter(Boolean);
}

function commandNameOnly(command) {
  const value = String(command || "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(value)) return "";
  return value;
}

function createLocalAgentEngineService(deps = {}) {
  const homeDir = typeof deps.homeDir === "function" ? deps.homeDir : () => os.homedir();
  const envSource = deps.env || process.env;
  const spawnSync = deps.spawnSync || defaultSpawnSync;
  const execFile = deps.execFile || defaultExecFile;
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
  let warmScanPromise = null;

  function execFileAsync(file, args, options) {
    return new Promise((resolve) => {
      try {
        execFile(file, args, options, (error, stdout, stderr) => {
          resolve({ error, stdout: String(stdout || ""), stderr: String(stderr || "") });
        });
      } catch (error) {
        resolve({ error, stdout: "", stderr: "" });
      }
    });
  }

  function currentEnv() {
    return typeof envSource === "function" ? (envSource() || {}) : envSource;
  }

  function cliPathSegments() {
    const home = String(homeDir() || "").trim();
    const env = currentEnv();
    const userSegments = home ? [
      path.join(home, ".local", "bin"),
      path.join(home, ".npm-global", "bin"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".deno", "bin"),
      path.join(home, ".cargo", "bin"),
      path.join(home, "Library", "pnpm"),
      ...nodeVersionManagerPathSegments(home, env, fsImpl)
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
    // Fast path first: scan the known CLI dirs + the process PATH directly, with
    // no child process. The previous `zsh -lc` login shell sourced the user's
    // full profile and was the main first-launch stall (run once per agent). We
    // only fall back to it when direct resolution fails, so a CLI on a custom,
    // profile-only PATH is still found.
    const dirs = [
      ...cliPathSegments(),
      ...String(currentEnv().PATH || "").split(path.delimiter)
    ].filter(Boolean);
    for (const dir of dirs) {
      const found = executablePath(path.join(dir, name));
      if (found) return found;
    }
    const result = spawnSync("zsh", ["-lc", `command -v ${name}`], {
      encoding: "utf8",
      timeout: 1500,
      env: processEnvWithCliPath()
    });
    if (!result.error && result.status === 0) {
      const found = String(result.stdout || "").split(/\r?\n/)[0]?.trim() || "";
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

  // Async variants of the probes (execFile) for non-blocking detection. The
  // direct PATH scan is a cheap sync fs check; only the shell fallback and the
  // --version call shell out, and those run asynchronously here.
  async function shellCommandPathAsync(command) {
    const name = commandNameOnly(command);
    if (!name) return "";
    const dirs = [
      ...cliPathSegments(),
      ...String(currentEnv().PATH || "").split(path.delimiter)
    ].filter(Boolean);
    for (const dir of dirs) {
      const found = executablePath(path.join(dir, name));
      if (found) return found;
    }
    if (platform === "win32") {
      const result = await execFileAsync("where", [name], { encoding: "utf8", timeout: 1500, env: processEnvWithCliPath() });
      if (!result.error) {
        const found = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
        if (found) return found;
      }
      return "";
    }
    const result = await execFileAsync("zsh", ["-lc", `command -v ${name}`], { encoding: "utf8", timeout: 1500, env: processEnvWithCliPath() });
    if (!result.error) {
      const found = result.stdout.split(/\r?\n/)[0]?.trim() || "";
      if (found) return found;
    }
    return "";
  }

  async function commandVersionAsync(commandPath) {
    if (!commandPath) return "";
    const result = await execFileAsync(commandPath, ["--version"], { encoding: "utf8", timeout: 2000, env: processEnvWithCliPath() });
    if (result.error) return "";
    return (result.stdout || result.stderr).split(/\r?\n/)[0]?.trim() || "";
  }

  async function firstCommandPathAsync(commands) {
    for (const command of commands) {
      const found = await shellCommandPathAsync(command);
      if (found) {
        return { command, path: found, version: await commandVersionAsync(found) };
      }
    }
    return { command: commands[0] || "", path: "", version: "" };
  }

  function miaHermesSource() {
    const source = String(hermesSource() || "").trim();
    if (source === "bundled") return "mia-bundled";
    if (source === "managed") return "mia-managed";
    if (source === "local-source" || source === "maintained-local-source") return "mia-managed";
    if (source === "system") return "system";
    return "";
  }

  function hermesUsable(systemAvailable) {
    const source = miaHermesSource();
    if (source === "system") return Boolean(systemAvailable && isHermesInstalled());
    return Boolean(source && isHermesInstalled());
  }

  // Pure status builder shared by the sync and async detection paths.
  function buildAgentStatus(definition, probe) {
    const systemAvailable = Boolean(probe.path);
    const hermesRuntimeUsable = definition.id === "hermes" ? hermesUsable(systemAvailable) : false;
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
      installAction: Boolean(definition.installable) && !usableInMia && !installed ? `install-${definition.id}` : "",
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

  function agentStatus(definition) {
    return buildAgentStatus(definition, firstCommandPath(definition.commands));
  }

  function buildInventory(agents, at) {
    const installedCount = agents.filter((agent) => agent.installed).length;
    const usableCount = agents.filter((agent) => agent.usableInMia).length;
    return {
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
  }

  function agentInventory() {
    const at = now();
    if (agentInventoryCache.value && at - agentInventoryCache.at < cacheMs) return agentInventoryCache.value;
    const value = buildInventory(AGENT_DEFINITIONS.map(agentStatus), at);
    agentInventoryCache = { at, value };
    return value;
  }

  // Async detection. Probes every agent in parallel without blocking the main
  // process (the sync path's shell probes for missing agents are what beachball
  // the window). Reports each agent as it resolves via onProgress, warms the
  // cache, and returns the full inventory. Non-progress calls are deduped.
  function scanAgentsAsync(onProgress) {
    // Warm (no-progress) calls reuse a fresh cache and dedupe in-flight scans,
    // so the periodic runtime poll never restarts a scan needlessly. Explicit
    // progress scans (user-initiated, prepare step) always run fresh.
    if (typeof onProgress !== "function" && agentInventoryCache.value && (now() - agentInventoryCache.at < cacheMs)) {
      return Promise.resolve(agentInventoryCache.value);
    }
    const run = () => Promise.all(AGENT_DEFINITIONS.map(async (definition) => {
      const probe = await firstCommandPathAsync(definition.commands);
      const status = buildAgentStatus(definition, probe);
      try { if (typeof onProgress === "function") onProgress(status); } catch { /* ignore */ }
      return status;
    })).then((agents) => {
      const value = buildInventory(agents, now());
      agentInventoryCache = { at: now(), value };
      agentEngineCache = { at: 0, value: null };
      return value;
    });
    if (typeof onProgress === "function") return run();
    if (!warmScanPromise) warmScanPromise = run().finally(() => { warmScanPromise = null; });
    return warmScanPromise;
  }

  // Non-blocking inventory read: serve the cache (even if stale) so the window
  // never blocks; fall back to the scanning placeholder only when truly cold.
  function cachedAgentInventory() {
    return agentInventoryCache.value || pendingAgentInventory();
  }

  function pendingAgentStatus(definition) {
    return {
      id: definition.id,
      label: definition.label,
      commands: definition.commands.slice(),
      command: definition.commands[0] || "",
      installed: false,
      usableInMia: false,
      installable: Boolean(definition.installable),
      installAction: "",
      detectionOnly: Boolean(definition.detectionOnly),
      path: "",
      version: "",
      source: "checking",
      health: "checking",
      system: {
        available: false,
        path: "",
        version: ""
      }
    };
  }

  function pendingAgentInventory() {
    const at = now();
    if (agentInventoryCache.value && at - agentInventoryCache.at < cacheMs) return agentInventoryCache.value;
    const agents = AGENT_DEFINITIONS.map(pendingAgentStatus);
    return {
      generatedAt: at,
      agents,
      summary: {
        installedCount: 0,
        usableCount: 0,
        missingCount: 0,
        hasUsableAgent: false,
        recommendedAction: "scan",
        scanning: true
      }
    };
  }

  function inventoryAgent(id) {
    return agentInventory().agents.find((agent) => agent.id === id) || null;
  }

  function engineViewFromInventory(inventory) {
    const byId = (id) => (inventory.agents || []).find((agent) => agent.id === id) || {};
    const hermes = byId("hermes");
    const claudeCode = byId("claude-code");
    const codex = byId("codex");
    const openClaw = byId("openclaw");
    return {
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
        detectionOnly: Boolean(openClaw.detectionOnly)
      }
    };
  }

  function localAgentEngines() {
    const at = now();
    if (agentEngineCache.value && at - agentEngineCache.at < cacheMs) return agentEngineCache.value;
    const value = engineViewFromInventory(agentInventory());
    agentEngineCache = { at, value };
    return value;
  }

  // Non-blocking engine view built from whatever inventory is cached (or the
  // scanning placeholder when cold) — never spawns.
  function cachedLocalAgentEngines() {
    if (!agentInventoryCache.value) return pendingLocalAgentEngines();
    return engineViewFromInventory(agentInventoryCache.value);
  }

  function pendingLocalAgentEngines() {
    const at = now();
    if (agentEngineCache.value && at - agentEngineCache.at < cacheMs) return agentEngineCache.value;
    return {
      hermes: {
        id: "hermes",
        label: "默认",
        available: false,
        installed: false,
        path: "",
        version: "",
        source: "checking",
        system: { available: false, path: "", version: "" }
      },
      claudeCode: {
        id: "claude-code",
        label: "Claude Code",
        available: false,
        installed: false,
        path: "",
        version: ""
      },
      codex: {
        id: "codex",
        label: "Codex",
        available: false,
        installed: false,
        path: "",
        version: ""
      },
      openClaw: {
        id: "openclaw",
        label: "OpenClaw",
        available: false,
        installed: false,
        path: "",
        version: "",
        detectionOnly: false
      }
    };
  }

  return {
    agentInventory,
    cachedAgentInventory,
    cachedLocalAgentEngines,
    cliPathEnv,
    cliPathSegments,
    commandNameOnly,
    commandVersion,
    localAgentEngines,
    pendingAgentInventory,
    pendingLocalAgentEngines,
    processEnvWithCliPath,
    resetCache,
    scanAgentsAsync,
    shellCommandPath
  };
}

module.exports = {
  commandNameOnly,
  createLocalAgentEngineService
};
