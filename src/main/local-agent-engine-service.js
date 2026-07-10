const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync: defaultSpawnSync } = require("node:child_process");
const {
  createManagedAgentRuntimeService,
  runtimeEnv
} = require("./agent-runtime/managed-agent-runtime.js");
const { getAcpEngineSpec } = require("./agent-session/index.js");
const { spawnSyncExecutable } = require("./agent-runtime/process-launcher.js");

const SYSTEM_CLI_PATH_SEGMENTS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin"
];
const DEFAULT_AGENT_SCAN_CACHE_MS = 5 * 60 * 1000;

const AGENT_DEFINITIONS = Object.freeze([
  {
    id: "hermes",
    legacyKey: "hermes",
    label: "Hermes",
    commands: ["hermes"],
    managedProtocols: ["cli"],
    installable: true,
    detectionOnly: false
  },
  {
    id: "claude-code",
    legacyKey: "claudeCode",
    label: "Claude Code",
    commands: ["claude"],
    managedProtocols: ["cli", "claude-code-cli"],
    installable: true,
    detectionOnly: false
  },
  {
    id: "codex",
    legacyKey: "codex",
    label: "Codex",
    commands: ["codex"],
    managedProtocols: ["cli", "codex-cli", "codex-app-server"],
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

function windowsAgentPathSegments(home, env) {
  const localAppData = String(env.LOCALAPPDATA || (home ? path.join(home, "AppData", "Local") : "")).trim();
  const appData = String(env.APPDATA || (home ? path.join(home, "AppData", "Roaming") : "")).trim();
  const hermesHome = String(env.HERMES_HOME || "").trim();
  const codexHome = String(env.CODEX_HOME || (home ? path.join(home, ".codex") : "")).trim();
  const codexInstallDir = String(env.CODEX_INSTALL_DIR || "").trim();
  return [
    // Hermes native Windows installer: install.ps1 writes hermes.exe here and
    // adds this directory to User PATH, but a running Mia process may not see
    // the refreshed PATH until restart.
    hermesHome ? path.join(hermesHome, "hermes-agent", "venv", "Scripts") : "",
    localAppData ? path.join(localAppData, "hermes", "hermes-agent", "venv", "Scripts") : "",

    // Claude Code's native installer owns the final launcher location. Include
    // common user-local locations because a running Mia process may have a
    // stale PATH immediately after install.
    home ? path.join(home, ".claude", "local") : "",
    home ? path.join(home, ".claude", "local", "bin") : "",
    home ? path.join(home, ".claude", "bin") : "",
    localAppData ? path.join(localAppData, "Programs", "Claude", "bin") : "",
    localAppData ? path.join(localAppData, "Programs", "Claude Code", "bin") : "",

    // Codex standalone Windows installer default, plus its configurable and
    // current-release locations. npm/bun legacy installs still resolve by PATH.
    codexInstallDir,
    localAppData ? path.join(localAppData, "Programs", "OpenAI", "Codex", "bin") : "",
    codexHome ? path.join(codexHome, "packages", "standalone", "current", "bin") : "",
    codexHome ? path.join(codexHome, "packages", "standalone", "current") : "",

    appData ? path.join(appData, "npm") : "",
    home ? path.join(home, "scoop", "shims") : ""
  ].filter(Boolean);
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
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const fsImpl = deps.fs || fs;
  const platform = deps.platform || process.platform;
  const managedAgentRuntime = deps.managedAgentRuntime || createManagedAgentRuntimeService({
    arch: deps.arch || process.arch,
    env: currentEnv(),
    fs: fsImpl,
    platform,
    resourceRoots: deps.managedResourceRoots,
    resourcesPath: deps.resourcesPath,
    spawnSync
  });
  const coreAgentInventory = typeof deps.coreAgentInventory === "function"
    ? deps.coreAgentInventory
    : null;
  const cacheMs = Number.isFinite(Number(deps.cacheMs)) ? Number(deps.cacheMs) : DEFAULT_AGENT_SCAN_CACHE_MS;
  let agentInventoryCache = { at: 0, value: null };
  let agentEngineCache = { at: 0, value: null };
  let warmScanPromise = null;

  function childProcessOptions(options = {}) {
    return {
      ...(options || {}),
      ...(platform === "win32" ? { windowsHide: true } : {})
    };
  }

  function currentEnv() {
    return typeof envSource === "function" ? (envSource() || {}) : envSource;
  }

  function pathListDelimiter() {
    return platform === "win32" ? ";" : path.delimiter;
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
    if (platform === "win32") {
      return [
        ...windowsAgentPathSegments(home, env),
        ...userSegments
      ];
    }
    return [...userSegments, ...SYSTEM_CLI_PATH_SEGMENTS];
  }

  function cliPathEnv() {
    const current = String(currentEnv().PATH || "");
    const segments = [
      ...cliPathSegments(),
      ...current.split(pathListDelimiter())
    ].filter(Boolean);
    return [...new Set(segments)].join(pathListDelimiter());
  }

  function processEnvWithCliPath() {
    return {
      ...currentEnv(),
      PATH: cliPathEnv()
    };
  }

  function executablePath(filePath) {
    try {
      fsImpl.accessSync(filePath, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
      return filePath;
    } catch {
      return "";
    }
  }

  function commandFileNames(name) {
    if (platform !== "win32") return [name];
    if (/\.(?:exe|cmd|bat|ps1)$/i.test(name)) return [name];
    return [`${name}.exe`, `${name}.cmd`, `${name}.bat`];
  }

  function directCommandPath(name) {
    const dirs = [
      ...cliPathSegments(),
      ...String(currentEnv().PATH || "").split(pathListDelimiter())
    ].filter(Boolean);
    for (const dir of dirs) {
      for (const fileName of commandFileNames(name)) {
        const found = executablePath(path.join(dir, fileName));
        if (found) return found;
      }
    }
    return "";
  }

  function windowsCommandRank(filePath) {
    const ext = path.extname(String(filePath || "")).toLowerCase();
    if (ext === ".exe" || ext === ".com") return 1;
    if (ext === ".cmd") return 2;
    if (ext === ".bat") return 3;
    return 99;
  }

  function bestWindowsCommandPath(output) {
    const candidates = String(output || "")
      .split(/\r?\n/)
      .map((line, index) => ({ path: line.trim(), index }))
      .filter((entry) => entry.path)
      .map((entry) => ({ ...entry, rank: windowsCommandRank(entry.path) }))
      .filter((entry) => entry.rank < 99)
      .sort((a, b) => a.rank - b.rank || a.index - b.index);
    return candidates[0]?.path || "";
  }

  // Windows npm creates extensionless shell scripts next to .cmd wrappers.
  // Node cannot spawn those scripts directly, so accept only real Windows
  // executables or cmd/bat wrappers.
  function windowsCommandPath(name) {
    const result = spawnSync("where", [name], childProcessOptions({
      encoding: "utf8",
      timeout: 1500,
      env: processEnvWithCliPath()
    }));
    if (!result.error && result.status === 0) {
      const found = bestWindowsCommandPath(result.stdout);
      if (found) return found;
    }
    return "";
  }

  function resolveAgentRuntime(engine, options = {}) {
    return managedAgentRuntime?.resolve?.(engine, options) || null;
  }

  function agentRuntimeEnv(engine, baseEnv = {}, options = {}) {
    const runtime = resolveAgentRuntime(engine, options);
    if (!runtime?.path) return { ...(baseEnv || {}) };
    return runtimeEnv(runtime, baseEnv, { platform });
  }

  function shellCommandPath(command) {
    const name = commandNameOnly(command);
    if (!name) return "";
    const direct = directCommandPath(name);
    if (direct) return direct;
    if (platform === "win32") return windowsCommandPath(name);
    // Fast path first: scan the known CLI dirs + the process PATH directly, with
    // no child process. The previous `zsh -lc` login shell sourced the user's
    // full profile and was the main first-launch stall (run once per agent). We
    // only run the shell lookup when direct resolution fails, so a CLI on a
    // custom, profile-only PATH is still found.
    const result = spawnSync("zsh", ["-lc", `command -v ${name}`], childProcessOptions({
      encoding: "utf8",
      timeout: 1500,
      env: processEnvWithCliPath()
    }));
    if (!result.error && result.status === 0) {
      const found = String(result.stdout || "").split(/\r?\n/)[0]?.trim() || "";
      if (found) return found;
    }
    return "";
  }

  function commandVersion(commandPath) {
    if (!commandPath) return "";
    const result = spawnSyncExecutable(spawnSync, commandPath, ["--version"], childProcessOptions({
      encoding: "utf8",
      timeout: 2000,
      env: processEnvWithCliPath()
    }), { platform });
    if (result.error) return "";
    return String(result.stdout || result.stderr || "").split(/\r?\n/)[0]?.trim() || "";
  }

  function resetCache() {
    agentInventoryCache = { at: 0, value: null };
    agentEngineCache = { at: 0, value: null };
    managedAgentRuntime?.resetCache?.();
  }

  function acpSpecForDefinition(definition) {
    return getAcpEngineSpec(definition?.id) || null;
  }

  function acpCommandParts(definition, options = {}) {
    const spec = acpSpecForDefinition(definition);
    const commandPath = String(options.commandPath || "").trim();
    const command = commandPath || String(spec?.command || definition?.commands?.[0] || "").trim();
    const args = Array.isArray(spec?.args) ? spec.args.slice() : [];
    return {
      command,
      args,
      display: [command || String(spec?.command || definition?.commands?.[0] || "").trim(), ...args].filter(Boolean).join(" ").trim()
    };
  }

  function readiness(status, summary, detail = "", action = "", checked = true) {
    return {
      status,
      checked: Boolean(checked),
      summary: String(summary || ""),
      detail: String(detail || ""),
      action: String(action || "")
    };
  }

  function baseReadiness(definition, status) {
    if (status.health === "checking" || status.source === "checking") {
      return readiness("checking", "正在检查", "", "", false);
    }
    if (!status.installed) {
      return readiness(
        "missing",
        `${definition.label} ACP command 未检测到`,
        acpCommandParts(definition).display,
        status.installAction || "",
        true
      );
    }
    if (status.usableInMia) {
      return readiness("not_checked", "等待深度自检", "", "", false);
    }
    return readiness("detected", `${definition.label} 已检测到，但还不能直接用于 Mia`, "", status.installAction || "", false);
  }

  function buildInventory(agents, at) {
    const installedCount = agents.filter((agent) => agent.installed).length;
    const usableCount = agents.filter((agent) => agent.usableInMia).length;
    const actionable = agents.find((agent) => !agent.usableInMia && agent.installAction);
    return {
      generatedAt: at,
      agents,
      summary: {
        installedCount,
        usableCount,
        missingCount: agents.length - installedCount,
        hasUsableAgent: usableCount > 0,
        recommendedAction: usableCount > 0 ? "continue" : actionable?.installAction || "scan"
      }
    };
  }

  function normalizeCoreReadiness(value, definition, status) {
    const object = value && typeof value === "object" ? value : null;
    if (!object) return baseReadiness(definition, status);
    const errorCode = String(object.errorCode || object.error_code || "").trim();
    return {
      status: String(object.status || status.health || ""),
      checked: object.checked !== false,
      summary: String(object.summary || ""),
      detail: String(object.detail || ""),
      action: String(object.action || ""),
      ...(errorCode ? { errorCode } : {})
    };
  }

  function normalizeCoreAgentStatus(agent) {
    if (!agent || typeof agent !== "object") return null;
    const id = String(agent.id || "").trim();
    const definition = AGENT_DEFINITIONS.find((item) => item.id === id);
    if (!definition) return null;
    const installed = Boolean(agent.installed);
    const usableInMia = agent.usableInMia !== undefined ? Boolean(agent.usableInMia) : Boolean(agent.usable_in_mia);
    const installAction = String(agent.installAction || agent.install_action || "");
    const health = String(agent.health || (usableInMia ? "ready" : installed ? "blocked" : "missing"));
    const status = {
      id,
      label: String(agent.label || definition.label),
      commands: Array.isArray(agent.commands) && agent.commands.length ? agent.commands.map(String) : definition.commands.slice(),
      command: String(agent.command || definition.commands[0] || ""),
      installed,
      usableInMia,
      installable: agent.installable !== undefined ? Boolean(agent.installable) : Boolean(definition.installable),
      installAction,
      detectionOnly: Boolean(agent.detectionOnly || agent.detection_only),
      path: String(agent.path || ""),
      version: String(agent.version || ""),
      source: String(agent.source || (installed ? "system" : "missing")),
      health,
      system: agent.system && typeof agent.system === "object" ? agent.system : {
        available: installed,
        path: String(agent.path || ""),
        version: String(agent.version || "")
      },
      runtime: agent.runtime && typeof agent.runtime === "object" ? agent.runtime : {
        source: installed ? "system" : "missing",
        managed: false,
        supported: usableInMia,
        path: String(agent.path || ""),
        version: "",
        protocol: "acp"
      }
    };
    return {
      ...status,
      readiness: normalizeCoreReadiness(agent.readiness, definition, status)
    };
  }

  function normalizeCoreAgentInventory(value) {
    const agents = Array.isArray(value?.agents)
      ? value.agents.map(normalizeCoreAgentStatus).filter(Boolean)
      : [];
    if (!agents.length) return null;
    const generatedAt = Number(value.generatedAt || value.generated_at || now()) || now();
    const inventory = buildInventory(agents, generatedAt);
    if (value.summary && typeof value.summary === "object") {
      inventory.summary = {
        ...inventory.summary,
        ...value.summary,
        installedCount: Number(value.summary.installedCount ?? value.summary.installed_count ?? inventory.summary.installedCount),
        usableCount: Number(value.summary.usableCount ?? value.summary.usable_count ?? inventory.summary.usableCount),
        missingCount: Number(value.summary.missingCount ?? value.summary.missing_count ?? inventory.summary.missingCount),
        hasUsableAgent: value.summary.hasUsableAgent !== undefined
          ? Boolean(value.summary.hasUsableAgent)
          : value.summary.has_usable_agent !== undefined
            ? Boolean(value.summary.has_usable_agent)
            : inventory.summary.hasUsableAgent,
        recommendedAction: String(value.summary.recommendedAction || value.summary.recommended_action || inventory.summary.recommendedAction)
      };
    }
    return inventory;
  }

  async function scanAgentsFromCore(onProgress) {
    if (!coreAgentInventory) return null;
    let inventory = null;
    try {
      inventory = normalizeCoreAgentInventory(await coreAgentInventory());
    } catch {
      return null;
    }
    if (!inventory) return null;
    agentInventoryCache = { at: now(), value: inventory };
    agentEngineCache = { at: 0, value: null };
    if (typeof onProgress === "function") {
      for (const agent of inventory.agents) {
        try { onProgress(agent); } catch { /* ignore */ }
      }
    }
    return inventory;
  }

  function agentInventory() {
    const at = now();
    if (agentInventoryCache.value && at - agentInventoryCache.at < cacheMs) return agentInventoryCache.value;
    return pendingAgentInventory();
  }

  // Core-only async inventory refresh. The JS main process does not probe or
  // doctor agent commands; it only consumes the Rust Core inventory and returns
  // checking placeholders while Core is unavailable.
  function scanAgentsAsync(onProgress) {
    // Warm (no-progress) calls reuse a fresh cache and dedupe in-flight scans,
    // so the periodic runtime poll never restarts a scan needlessly. Explicit
    // progress scans (user-initiated, prepare step) always run fresh.
    if (typeof onProgress !== "function" && agentInventoryCache.value && (now() - agentInventoryCache.at < cacheMs)) {
      return Promise.resolve(agentInventoryCache.value);
    }
    const run = async () => {
      const coreInventory = await scanAgentsFromCore(onProgress);
      if (coreInventory) return coreInventory;
      const value = pendingAgentInventory();
      if (typeof onProgress === "function") {
        for (const agent of value.agents) {
          try { onProgress(agent); } catch { /* ignore */ }
        }
      }
      return value;
    };
    if (typeof onProgress === "function") return run();
    if (!warmScanPromise) warmScanPromise = run().finally(() => { warmScanPromise = null; });
    return warmScanPromise;
  }

  // Non-blocking inventory read: serve the cache (even if stale) so the window
  // never blocks; return the scanning placeholder only when truly cold.
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
      readiness: readiness("checking", "正在检查", "", "", false),
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
    return {
      hermes: {
        id: "hermes",
        label: "默认",
        available: Boolean(hermes.usableInMia),
        installed: Boolean(hermes.installed),
        path: hermes.path || "",
        version: hermes.version || "",
        source: hermes.source || "missing",
        health: hermes.health || "missing",
        installAction: hermes.installAction || "",
        readiness: hermes.readiness || null,
        system: hermes.system || { available: false, path: "", version: "" }
      },
      claudeCode: {
        id: "claude-code",
        label: "Claude Code",
        available: Boolean(claudeCode.usableInMia),
        installed: Boolean(claudeCode.installed),
        path: claudeCode.path || "",
        version: claudeCode.version || "",
        health: claudeCode.health || "missing",
        installAction: claudeCode.installAction || "",
        readiness: claudeCode.readiness || null
      },
      codex: {
        id: "codex",
        label: "Codex",
        available: Boolean(codex.usableInMia),
        installed: Boolean(codex.installed),
        path: codex.path || "",
        version: codex.version || "",
        health: codex.health || "missing",
        installAction: codex.installAction || "",
        readiness: codex.readiness || null
      }
    };
  }

  function localAgentEngines() {
    const at = now();
    if (agentEngineCache.value && at - agentEngineCache.at < cacheMs) return agentEngineCache.value;
    if (agentInventoryCache.value && at - agentInventoryCache.at < cacheMs) {
      const value = engineViewFromInventory(agentInventoryCache.value);
      agentEngineCache = { at, value };
      return value;
    }
    return pendingLocalAgentEngines();
  }

  // Non-blocking engine view built from whatever inventory is cached (or the
  // scanning placeholder when cold) — never spawns.
  function cachedLocalAgentEngines() {
    if (!agentInventoryCache.value) return pendingLocalAgentEngines();
    return engineViewFromInventory(agentInventoryCache.value);
  }

  function pendingLocalAgentEngines() {
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
    resolveAgentRuntime,
    agentRuntimeEnv,
    scanAgentsAsync,
    shellCommandPath
  };
}

module.exports = {
  commandNameOnly,
  createLocalAgentEngineService
};
