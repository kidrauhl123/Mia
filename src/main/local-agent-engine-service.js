const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync: defaultSpawnSync, execFile: defaultExecFile } = require("node:child_process");
const {
  createManagedAgentRuntimeService,
  runtimeEnv
} = require("./agent-runtime/managed-agent-runtime.js");
const {
  execFileExecutable,
  spawnSyncExecutable
} = require("./agent-runtime/process-launcher.js");

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
    managedProtocols: ["cli"],
    installable: true,
    detectionOnly: false
  },
  {
    id: "claude-code",
    legacyKey: "claudeCode",
    label: "Claude Code",
    commands: ["claude"],
    doctorArgs: ["--help"],
    managedProtocols: ["cli", "claude-code-cli"],
    installable: true,
    detectionOnly: false
  },
  {
    id: "codex",
    legacyKey: "codex",
    label: "Codex",
    commands: ["codex"],
    doctorArgs: ["--help"],
    managedProtocols: ["cli", "codex-cli", "codex-app-server"],
    installable: true,
    detectionOnly: false
  },
  {
    id: "openclaw",
    legacyKey: "openClaw",
    label: "OpenClaw",
    commands: ["openclaw", "claw"],
    doctorArgs: ["--help"],
    managedProtocols: ["cli", "openclaw-cli"],
    installable: true,
    detectionOnly: false
  }
]);

function compactOneLine(value, max = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

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

    // Claude Code's native installer owns the final launcher location. Keep
    // PATH lookup as the source of truth, with common user-local locations as
    // a best-effort fallback.
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

    // npm global shims and OpenClaw's portable Node bootstrap location.
    appData ? path.join(appData, "npm") : "",
    localAppData ? path.join(localAppData, "OpenClaw", "deps", "portable-node") : "",
    localAppData ? path.join(localAppData, "OpenClaw", "deps", "portable-node", "node_modules", ".bin") : "",
    home ? path.join(home, "openclaw", "node_modules", ".bin") : "",
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
  const execFile = deps.execFile || defaultExecFile;
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
  const isHermesInstalled = typeof deps.isHermesInstalled === "function"
    ? deps.isHermesInstalled
    : () => false;
  const isHermesApiRuntimeReady = typeof deps.isHermesApiRuntimeReady === "function"
    ? deps.isHermesApiRuntimeReady
    : () => true;
  const hermesSource = typeof deps.hermesSource === "function"
    ? deps.hermesSource
    : () => "";
  const cacheMs = Number.isFinite(Number(deps.cacheMs)) ? Number(deps.cacheMs) : 15000;
  const doctorTimeoutMs = Number.isFinite(Number(deps.doctorTimeoutMs)) ? Number(deps.doctorTimeoutMs) : 3000;
  let agentInventoryCache = { at: 0, value: null };
  let agentEngineCache = { at: 0, value: null };
  let warmScanPromise = null;

  function execFileAsync(file, args, options) {
    return new Promise((resolve) => {
      try {
        execFileExecutable(execFile, file, args, options, (error, stdout, stderr) => {
          resolve({ error, stdout: String(stdout || ""), stderr: String(stderr || ""), code: error?.code ?? 0 });
        }, { platform });
      } catch (error) {
        resolve({ error, stdout: "", stderr: "", code: error?.code ?? 0 });
      }
    });
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
    const result = spawnSync("where", [name], {
      encoding: "utf8",
      timeout: 1500,
      env: processEnvWithCliPath()
    });
    if (!result.error && result.status === 0) {
      const found = bestWindowsCommandPath(result.stdout);
      if (found) return found;
    }
    return "";
  }

  function managedRuntimeForCommand(commandName) {
    for (const definition of AGENT_DEFINITIONS) {
      if (definition.commands.includes(commandName)) {
        const runtime = managedAgentRuntime?.resolve?.(definition.id, { protocols: definition.managedProtocols });
        if (runtime?.path) return runtime;
      }
    }
    return null;
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
    const managed = managedRuntimeForCommand(name);
    if (managed?.path) return managed.path;
    const direct = directCommandPath(name);
    if (direct) return direct;
    if (platform === "win32") return windowsCommandPath(name);
    // Fast path first: scan the known CLI dirs + the process PATH directly, with
    // no child process. The previous `zsh -lc` login shell sourced the user's
    // full profile and was the main first-launch stall (run once per agent). We
    // only fall back to it when direct resolution fails, so a CLI on a custom,
    // profile-only PATH is still found.
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
    const result = spawnSyncExecutable(spawnSync, commandPath, ["--version"], {
      encoding: "utf8",
      timeout: 2000,
      env: processEnvWithCliPath()
    }, { platform });
    if (result.error) return "";
    return String(result.stdout || result.stderr || "").split(/\r?\n/)[0]?.trim() || "";
  }

  function managedProbe(definition) {
    const runtime = managedAgentRuntime?.resolve?.(definition.id);
    if (!runtime?.path) return null;
    return {
      command: runtime.command || definition.commands[0] || "",
      path: runtime.path,
      version: runtime.version || "",
      source: "managed",
      runtime
    };
  }

  function resetCache() {
    agentInventoryCache = { at: 0, value: null };
    agentEngineCache = { at: 0, value: null };
    managedAgentRuntime?.resetCache?.();
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

  function firstRuntimeProbe(definition) {
    return managedProbe(definition) || firstCommandPath(definition.commands);
  }

  // Async variants of the probes (execFile) for non-blocking detection. The
  // direct PATH scan is a cheap sync fs check; only the shell fallback and the
  // --version call shell out, and those run asynchronously here.
  async function shellCommandPathAsync(command) {
    const name = commandNameOnly(command);
    if (!name) return "";
    const managed = managedRuntimeForCommand(name);
    if (managed?.path) return managed.path;
    const direct = directCommandPath(name);
    if (direct) return direct;
    if (platform === "win32") {
      const result = await execFileAsync("where", [name], { encoding: "utf8", timeout: 1500, env: processEnvWithCliPath() });
      if (!result.error) {
        const found = bestWindowsCommandPath(result.stdout);
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

  async function firstRuntimeProbeAsync(definition) {
    return managedProbe(definition) || firstCommandPathAsync(definition.commands);
  }

  function miaHermesSource() {
    const source = String(hermesSource() || "").trim();
    if (source === "system") return "system";
    return "";
  }

  function hermesUsable(systemAvailable) {
    const source = miaHermesSource();
    if (source === "system") return Boolean(systemAvailable && isHermesInstalled());
    return Boolean(source && isHermesInstalled());
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
      return readiness("missing", `${definition.label} 未检测到`, "", status.installAction || "", true);
    }
    if (definition.id === "hermes" && status.health === "broken") {
      return readiness("repairable", "Hermes API 运行时不完整，可修复", "", status.installAction || "repair-hermes", true);
    }
    if (status.usableInMia) {
      return readiness("not_checked", "等待深度自检", "", "", false);
    }
    return readiness("detected", `${definition.label} 已检测到，但还不能直接用于 Mia`, "", status.installAction || "", false);
  }

  function agentInstallActionId(definition) {
    if (definition.id === "hermes") return "repair-hermes";
    return definition.installable ? `install-${definition.id}` : "";
  }

  function withReadiness(status, nextReadiness, patch = {}) {
    return {
      ...status,
      ...patch,
      readiness: nextReadiness
    };
  }

  async function cliHandshake(definition, status) {
    const commandPath = String(status.path || "").trim();
    if (!commandPath) {
      return { ok: false, detail: "command path missing" };
    }
    const args = Array.isArray(definition.doctorArgs) && definition.doctorArgs.length
      ? definition.doctorArgs
      : ["--help"];
    const result = await execFileAsync(commandPath, args, {
      encoding: "utf8",
      timeout: doctorTimeoutMs,
      env: processEnvWithCliPath()
    });
    if (!result.error) {
      return {
        ok: true,
        detail: compactOneLine(result.stdout || result.stderr)
      };
    }
    const output = compactOneLine(result.stderr || result.stdout || result.error?.message || "");
    return {
      ok: false,
      detail: output || `${path.basename(commandPath)} ${args.join(" ")} exited with code ${result.code || "unknown"}`
    };
  }

  async function doctorAgentStatus(definition, status) {
    if (!status.installed) {
      return withReadiness(status, readiness("missing", `${definition.label} 未检测到`, "", status.installAction || "", true));
    }
    if (definition.id === "hermes") {
      if (status.health === "broken") {
        return withReadiness(status, readiness(
          "repairable",
          "Hermes API 运行时不完整，可修复",
          "缺少 Hermes API server 依赖时，Mia 会无法连接本地 Hermes。",
          status.installAction || "repair-hermes"
        ));
      }
      if (status.usableInMia) {
        return withReadiness(status, readiness("ready", "Hermes CLI 与 API 依赖自检通过"));
      }
      const action = status.installAction || "repair-hermes";
      return withReadiness(status, readiness(
        "repairable",
        "Hermes 已检测到，但当前安装不能用于 Mia，可修复",
        "",
        action
      ), { installAction: action });
    }
    if (!status.runtime?.supported) {
      return withReadiness(status, readiness(
        "blocked",
        `${definition.label} runtime 协议暂不受 Mia 支持`,
        `protocol=${status.runtime?.protocol || "unknown"}`,
        ""
      ), { usableInMia: false, health: "blocked" });
    }
    const probe = await cliHandshake(definition, status);
    if (probe.ok) {
      return withReadiness(status, readiness(
        "ready",
        `${definition.label} CLI 启动自检通过`,
        probe.detail
      ), { usableInMia: true, health: "ready", installAction: "" });
    }
    const action = agentInstallActionId(definition);
    return withReadiness(status, readiness(
      "blocked",
      `${definition.label} 启动自检失败，可重新安装`,
      probe.detail,
      action
    ), {
      usableInMia: false,
      health: "blocked",
      installAction: action
    });
  }

  // Pure status builder shared by the sync and async detection paths.
  function buildAgentStatus(definition, probe) {
    const runtimeSource = String(probe.source || "").trim();
    const managedAvailable = runtimeSource === "managed" && Boolean(probe.path);
    const managedProtocol = String(probe.runtime?.protocol || "cli").trim();
    const managedSupported = managedAvailable && (
      !Array.isArray(definition.managedProtocols)
      || definition.managedProtocols.includes(managedProtocol)
    );
    const systemAvailable = Boolean(probe.path) && !managedAvailable;
    const runtimeAvailable = Boolean(probe.path);
    const hermesRuntimeUsable = definition.id === "hermes" ? hermesUsable(systemAvailable) : false;
    const installed = Boolean(runtimeAvailable || hermesRuntimeUsable);
    const hermesApiReady = definition.id === "hermes" && hermesRuntimeUsable
      ? Boolean(isHermesApiRuntimeReady())
      : true;
    const usableInMia = definition.id === "hermes"
      ? hermesRuntimeUsable && hermesApiReady
      : Boolean((systemAvailable || managedSupported) && !definition.detectionOnly);
    const source = managedAvailable
      ? "managed"
      : definition.id === "hermes" && hermesRuntimeUsable
      ? miaHermesSource()
      : systemAvailable
        ? "system"
        : "missing";
    const health = definition.id === "hermes" && hermesRuntimeUsable && !hermesApiReady
      ? "broken"
      : usableInMia ? "ready" : installed ? "detected" : "missing";
    const installAction = Boolean(definition.installable)
      ? definition.id === "hermes" && installed && !usableInMia
        ? "repair-hermes"
        : !usableInMia && !installed
          ? `install-${definition.id}`
          : ""
      : "";
    const status = {
      id: definition.id,
      label: definition.label,
      commands: definition.commands.slice(),
      command: probe.command,
      installed,
      usableInMia,
      installable: Boolean(definition.installable),
      installAction,
      detectionOnly: Boolean(definition.detectionOnly),
      path: probe.path,
      version: probe.version,
      source,
      health,
      system: {
        available: systemAvailable,
        path: probe.path,
        version: probe.version
      },
      runtime: {
        source,
        managed: managedAvailable,
        supported: managedSupported || systemAvailable,
        path: probe.path,
        version: probe.version,
        protocol: probe.runtime?.protocol || ""
      }
    };
    return {
      ...status,
      readiness: baseReadiness(definition, status)
    };
  }

  function agentStatus(definition) {
    return buildAgentStatus(definition, firstRuntimeProbe(definition));
  }

  function buildInventory(agents, at) {
    const installedCount = agents.filter((agent) => agent.installed).length;
    const usableCount = agents.filter((agent) => agent.usableInMia).length;
    const hasBrokenHermes = agents.some((agent) => agent.id === "hermes" && agent.health === "broken");
    const repairable = agents.find((agent) => agent.installed && !agent.usableInMia && agent.installAction);
    return {
      generatedAt: at,
      agents,
      summary: {
        installedCount,
        usableCount,
        missingCount: agents.length - installedCount,
        hasUsableAgent: usableCount > 0,
        recommendedAction: usableCount > 0 ? "continue" : hasBrokenHermes ? "repair-hermes" : repairable?.installAction || "install-hermes"
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
      const runtimeProbe = await firstRuntimeProbeAsync(definition);
      const status = await doctorAgentStatus(definition, buildAgentStatus(definition, runtimeProbe));
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
      },
      openClaw: {
        id: "openclaw",
        label: "OpenClaw",
        available: Boolean(openClaw.usableInMia),
        installed: Boolean(openClaw.installed),
        path: openClaw.path || "",
        version: openClaw.version || "",
        health: openClaw.health || "missing",
        installAction: openClaw.installAction || "",
        readiness: openClaw.readiness || null,
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
