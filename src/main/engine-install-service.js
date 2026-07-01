const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn: defaultSpawn, spawnSync: defaultSpawnSync } = require("node:child_process");
const { createHermesInstallSourceService } = require("./hermes-install-source-service.js");

const HERMES_API_RUNTIME_MODULES = Object.freeze(["hermes_cli.main", "aiohttp", "mcp", "ddgs"]);
const HERMES_API_RUNTIME_REQUIREMENTS = Object.freeze(["aiohttp", "mcp", "ddgs"]);

// Hermes is an upstream engine the user runs from their own install on PATH
// (system-hermes-service), exactly like claude/codex. This service installs the
// official hermes-agent package from a package index into the user's standard
// location (`pip install --user` → ~/.local/bin/hermes) when it is missing, and
// resolves the engine python from whatever is detected on PATH. No Mia-private
// venv, no bundled runtime.
function createEngineInstallService(deps = {}) {
  const env = deps.env || process.env;
  const fsImpl = deps.fs || fs;
  const homeDir = typeof deps.homeDir === "function" ? deps.homeDir : () => os.homedir();
  const platform = deps.platform || process.platform;
  const spawnProcess = deps.spawn || defaultSpawn;
  const spawnSync = deps.spawnSync || defaultSpawnSync;
  const buildPythonPath = deps.buildPythonPath || (() => "");
  const systemHermesPython = typeof deps.systemHermesPython === "function" ? deps.systemHermesPython : () => "";
  const refreshSystemHermes = typeof deps.refreshSystemHermes === "function" ? deps.refreshSystemHermes : () => {};
  const appendLog = deps.appendLog || (() => {});
  const clearLogs = deps.clearLogs || (() => {});
  const initializeRuntime = deps.initializeRuntime || (() => {});
  const stopEngine = deps.stopEngine || (() => {});
  const ensureEnginePlugins = deps.ensureEnginePlugins || (() => {});
  const resetAgentEngineCache = deps.resetAgentEngineCache || (() => {});
  const getRuntimeStatus = deps.getRuntimeStatus || ((created) => ({ created }));
  const shellCommandPath = typeof deps.shellCommandPath === "function" ? deps.shellCommandPath : () => "";

  function spawnSyncOptions(options = {}) {
    return {
      ...(options || {}),
      ...(platform === "win32" ? { windowsHide: true } : {})
    };
  }

  function configuredValue(depName, envName, fallback) {
    if (Object.prototype.hasOwnProperty.call(deps, depName)) return deps[depName];
    return env[envName] || fallback;
  }
  const officialPackage = configuredValue("officialPackage", "MIA_ENGINE_PACKAGE", "hermes-agent");
  const officialExtras = configuredValue("officialExtras", "MIA_ENGINE_EXTRAS", "web");
  const officialPython = configuredValue("officialPython", "MIA_PYTHON", "");
  // npm-installed engines (claude/codex are official npm packages). China mirror
  // first, official npm registry as fallback.
  const npmRegistry = configuredValue("npmRegistry", "MIA_NPM_REGISTRY", "https://registry.npmmirror.com");
  const npmFallbackRegistry = configuredValue("npmFallbackRegistry", "MIA_NPM_FALLBACK_REGISTRY", "https://registry.npmjs.org");
  const NPM_ENGINE_PACKAGES = {
    "claude-code": "@anthropic-ai/claude-code",
    codex: "@openai/codex",
    openclaw: "openclaw"
  };
  const ENGINE_COMMANDS = {
    hermes: ["hermes"],
    "claude-code": ["claude"],
    codex: ["codex"],
    openclaw: ["openclaw", "claw"]
  };
  const WINDOWS_ENGINE_INSTALLERS = {
    hermes: {
      url: "https://hermes-agent.nousresearch.com/install.ps1",
      args: ["-NonInteractive"]
    },
    "claude-code": {
      url: "https://claude.ai/install.ps1",
      args: []
    },
    codex: {
      url: "https://chatgpt.com/codex/install.ps1",
      args: [],
      env: { CODEX_NON_INTERACTIVE: "1" }
    },
    openclaw: {
      url: "https://openclaw.ai/install.ps1",
      args: ["-NoOnboard"]
    }
  };

  const installSourceService = deps.installSourceService || createHermesInstallSourceService({
    env,
    officialPackage,
    officialExtras
  });

  function throwIfCancelled(signal) {
    if (signal?.aborted) {
      const error = new Error("Hermes install cancelled.");
      error.code = "MIA_HERMES_INSTALL_CANCELLED";
      throw error;
    }
  }

  function pythonVersion(command) {
    const result = spawnSync(command, [
      "-c",
      "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')"
    ], spawnSyncOptions({ encoding: "utf8" }));
    if (result.error || result.status !== 0) return null;
    const version = String(result.stdout || "").trim();
    const [major, minor] = version.split(".").map((part) => Number(part));
    if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
    return { version, major, minor };
  }

  function isMacDeveloperToolsPythonShim(commandPath) {
    return platform === "darwin" && path.resolve(String(commandPath || "")) === "/usr/bin/python3";
  }

  function defaultPythonCandidate(command, options = {}) {
    const name = String(command || "").trim();
    if (!name) return "";
    if (platform !== "darwin") return name;
    if (name === "python3" && !options.allowMacDeveloperToolsInstall) return "";
    const resolved = String(shellCommandPath(name) || "").trim();
    if (isMacDeveloperToolsPythonShim(resolved)) {
      return options.allowMacDeveloperToolsInstall ? resolved : "";
    }
    if (resolved) return resolved;
    // Missing versioned python commands fail normally. Only the generic
    // /usr/bin/python3 shim opens the Command Line Tools installer.
    return name === "python3" ? "" : name;
  }

  function officialPythonCandidates(options = {}) {
    const commands = ["python3.14", "python3.13", "python3.12", "python3.11", "python3"];
    if (platform === "win32") commands.push("python");
    return [
      String(officialPython || "").trim(),
      ...commands.map((command) => defaultPythonCandidate(command, options))
    ].filter(Boolean);
  }

  function selectOfficialEnginePython(options = {}) {
    for (const command of officialPythonCandidates(options)) {
      const info = pythonVersion(command);
      if (info && (info.major > 3 || (info.major === 3 && info.minor >= 11))) return command;
    }
    throw new Error("Official Hermes requires Python 3.11+. Set MIA_PYTHON=/path/to/python3.11 or newer.");
  }

  function systemHermesPythonPath() {
    return String(systemHermesPython() || "").trim();
  }

  function moduleImportScript(modules) {
    return [
      "import importlib",
      `modules = ${JSON.stringify(modules)}`,
      "[importlib.import_module(module) for module in modules]",
      "print('import OK')"
    ].join("; ");
  }

  function hermesApiRuntimeCheck(python = enginePython()) {
    const command = String(python || "").trim();
    if (!command) return { ok: false, error: "Hermes Python is not available." };
    const result = spawnSync(command, ["-c", moduleImportScript(HERMES_API_RUNTIME_MODULES)], spawnSyncOptions({
      encoding: "utf8",
      env: { ...env, PYTHONPATH: buildPythonPath() },
      timeout: 5000
    }));
    if (!result.error && result.status === 0) return { ok: true, error: "" };
    const output = String(result.stderr || result.stdout || result.error?.message || "").trim();
    return { ok: false, error: output || `Python import check exited with code ${result.status ?? "unknown"}` };
  }

  function isApiRuntimeReady() {
    return hermesApiRuntimeCheck().ok;
  }

  function isInstalled() {
    return Boolean(systemHermesPythonPath());
  }

  function enginePython() {
    return systemHermesPythonPath() || "python3";
  }

  function engineSource() {
    return systemHermesPythonPath() ? "system" : "none";
  }

  function appendCommandOutput(output) {
    for (const line of String(output || "").split(/\r?\n/).filter(Boolean)) appendLog(line);
  }

  function normalizePercent(value) {
    const percent = Number(value);
    if (!Number.isFinite(percent)) return undefined;
    return Math.max(0, Math.min(100, Math.round(percent)));
  }

  function emitProgress(options, payload = {}) {
    if (typeof options?.onProgress === "function") {
      const next = {
        engineId: payload.engineId || "hermes",
        ...payload
      };
      const percent = normalizePercent(payload.percent);
      if (percent === undefined) delete next.percent;
      else next.percent = percent;
      options.onProgress(next);
    }
  }

  function psQuote(value) {
    return `'${String(value || "").replace(/'/g, "''")}'`;
  }

  function windowsInstallerEnvAssignments(installer) {
    return Object.entries(installer.env || {})
      .map(([key, value]) => `$env:${key}=${psQuote(value)};`)
      .join(" ");
  }

  function windowsInstallerCommand(engineId) {
    const installer = WINDOWS_ENGINE_INSTALLERS[engineId];
    if (!installer) throw new Error(`No Windows installer mapping for engine ${engineId}.`);
    const envAssignments = windowsInstallerEnvAssignments(installer);
    const args = (installer.args || []).join(" ");
    return `${envAssignments} & ([scriptblock]::Create((irm ${psQuote(installer.url)}))) ${args}`.trim();
  }

  function windowsInstallerManifestCommand(engineId) {
    const installer = WINDOWS_ENGINE_INSTALLERS[engineId];
    if (!installer) throw new Error(`No Windows installer mapping for engine ${engineId}.`);
    const envAssignments = windowsInstallerEnvAssignments(installer);
    return `${envAssignments} & ([scriptblock]::Create((irm ${psQuote(installer.url)}))) -Manifest`.trim();
  }

  function windowsInstallerStageCommand(engineId, stageName) {
    const installer = WINDOWS_ENGINE_INSTALLERS[engineId];
    if (!installer) throw new Error(`No Windows installer mapping for engine ${engineId}.`);
    const envAssignments = windowsInstallerEnvAssignments(installer);
    const args = ["-Stage", psQuote(stageName), ...(installer.args || [])].join(" ");
    return `${envAssignments} & ([scriptblock]::Create((irm ${psQuote(installer.url)}))) ${args}`.trim();
  }

  function runInstallCommand(command, args, cwd) {
    appendLog(`$ ${command} ${args.join(" ")}`);
    const result = spawnSync(command, args, spawnSyncOptions({
      cwd,
      env: { ...env, PIP_DISABLE_PIP_VERSION_CHECK: "1", PYTHONPATH: buildPythonPath() },
      encoding: "utf8"
    }));
    appendCommandOutput(result.stdout);
    appendCommandOutput(result.stderr);
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}`);
    return result;
  }

  function useWindowsShell(command) {
    if (platform !== "win32") return false;
    const base = path.basename(String(command || "")).toLowerCase();
    return base !== "powershell.exe" && base !== "powershell" && base !== "pwsh.exe" && base !== "pwsh";
  }

  function createLineCollector(onLine) {
    let pending = "";
    return {
      push(chunk) {
        pending += String(chunk || "");
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || "";
        for (const line of lines) {
          if (line) onLine(line);
        }
      },
      flush() {
        if (pending) onLine(pending);
        pending = "";
      }
    };
  }

  function runInstallCommandAsync(command, args, cwd, options = {}) {
    throwIfCancelled(options.signal);
    appendLog(`$ ${command} ${args.join(" ")}`);
    emitProgress(options, {
      engineId: options.engineId || "hermes",
      status: "running",
      stage: options.stage || "command",
      message: options.message || `${command} ${args.join(" ")}`,
      percent: options.percent
    });

    return new Promise((resolve, reject) => {
      const child = spawnProcess(command, args, {
        cwd,
        env: { ...env, PIP_DISABLE_PIP_VERSION_CHECK: "1", PYTHONPATH: buildPythonPath() },
        shell: useWindowsShell(command)
      });
      const outputLines = [];
      const rememberLine = (line) => {
        outputLines.push(line);
        if (outputLines.length > 40) outputLines.shift();
      };
      const stdout = createLineCollector((line) => {
        rememberLine(line);
        appendLog(line);
        if (options.emitOutputProgress !== false) {
          emitProgress(options, {
            engineId: options.engineId || "hermes",
            status: "running",
            stage: options.stage || "command",
            message: line,
            percent: options.percent
          });
        }
      });
      const stderr = createLineCollector((line) => {
        rememberLine(line);
        appendLog(line);
        if (options.emitOutputProgress !== false) {
          emitProgress(options, {
            engineId: options.engineId || "hermes",
            status: "running",
            stage: options.stage || "command",
            message: line,
            percent: options.percent
          });
        }
      });
      const abort = () => {
        try { child.kill(); } catch { /* already exited */ }
        const error = new Error("Hermes install cancelled.");
        error.code = "MIA_HERMES_INSTALL_CANCELLED";
        reject(error);
      };
      if (options.signal?.aborted) return abort();
      if (options.signal) options.signal.addEventListener("abort", abort, { once: true });
      child.stdout?.on("data", (chunk) => stdout.push(chunk));
      child.stderr?.on("data", (chunk) => stderr.push(chunk));
      child.on("error", (error) => {
        if (options.signal) options.signal.removeEventListener("abort", abort);
        reject(error);
      });
      child.on("close", (code) => {
        if (options.signal) options.signal.removeEventListener("abort", abort);
        stdout.flush();
        stderr.flush();
        if (code !== 0) {
          const output = outputLines.join("\n");
          const error = new Error(`${command} exited with code ${code}${output ? `: ${output}` : ""}`);
          error.output = output;
          error.exitCode = code;
          reject(error);
          return;
        }
        resolve({ status: code, output: outputLines.join("\n") });
      });
    });
  }

  function installOutputTail(output) {
    return String(output || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-8)
      .join(" | ");
  }

  function isWindowsEngineDetected(engineId) {
    if (engineId === "hermes") return Boolean(systemHermesPythonPath());
    return (ENGINE_COMMANDS[engineId] || []).some((command) => Boolean(shellCommandPath(command)));
  }

  async function refreshDetectionAsync() {
    try {
      const result = refreshSystemHermes();
      if (result && typeof result.then === "function") await result;
    } catch {
      // Detection refresh is best-effort; the explicit post-install check below
      // still probes live paths through systemHermesPython/shellCommandPath.
    }
  }

  function assertWindowsInstallDetected(engineId, output = "") {
    if (isWindowsEngineDetected(engineId)) return;
    const label = engineId === "claude-code" ? "Claude Code" : engineId === "hermes" ? "Hermes" : engineId === "openclaw" ? "OpenClaw" : "Codex";
    const tail = installOutputTail(output);
    throw new Error(`Official ${label} installer finished, but Mia still cannot detect ${label}.${tail ? ` Last output: ${tail}` : ""}`);
  }

  function parseInstallerManifest(output, engineId) {
    const text = String(output || "").trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new Error(`Official ${engineId} installer did not return a stage manifest.`);
    }
    const manifest = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(manifest.stages)) {
      throw new Error(`Official ${engineId} installer returned an invalid stage manifest.`);
    }
    return manifest.stages;
  }

  async function readWindowsInstallerManifestAsync(engineId, options = {}) {
    emitProgress(options, {
      engineId,
      status: "running",
      stage: "manifest",
      percent: 1,
      message: `读取 ${engineId} 官方安装步骤...`
    });
    const result = await runInstallCommandAsync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", windowsInstallerManifestCommand(engineId)],
      undefined,
      {
        ...options,
        engineId,
        stage: "manifest",
        percent: 1,
        message: `读取 ${engineId} 官方安装步骤...`,
        emitOutputProgress: false
      }
    );
    return parseInstallerManifest(result.output, engineId);
  }

  function stagePercent(index, total) {
    if (!total) return 2;
    return Math.max(2, Math.min(97, Math.round((index / total) * 94) + 2));
  }

  async function installHermesWithWindowsStagesAsync(options = {}) {
    const { signal = null } = options;
    throwIfCancelled(signal);
    initializeRuntime();
    stopEngine();
    clearLogs();
    const manifestStages = await readWindowsInstallerManifestAsync("hermes", options);
    const installStages = manifestStages
      .filter((stage) => stage && !stage.needs_user_input && stage.category !== "post-install")
      .map((stage) => ({
        name: String(stage.name || "").trim(),
        title: String(stage.title || stage.name || "").trim()
      }))
      .filter((stage) => stage.name);
    if (!installStages.length) {
      throw new Error("Official Hermes installer did not expose any non-interactive install stages.");
    }

    let lastOutput = "";
    for (let index = 0; index < installStages.length; index += 1) {
      throwIfCancelled(signal);
      const stage = installStages[index];
      const total = installStages.length;
      const startPercent = stagePercent(index, total);
      const donePercent = stagePercent(index + 1, total);
      const message = `正在安装 Hermes：${stage.title} (${index + 1}/${total})`;
      emitProgress(options, {
        engineId: "hermes",
        status: "running",
        stage: stage.name,
        percent: startPercent,
        message
      });
      const result = await runInstallCommandAsync(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", windowsInstallerStageCommand("hermes", stage.name)],
        undefined,
        {
          ...options,
          engineId: "hermes",
          stage: stage.name,
          percent: startPercent,
          message,
          emitOutputProgress: false
        }
      );
      lastOutput = result.output;
      emitProgress(options, {
        engineId: "hermes",
        status: "running",
        stage: stage.name,
        percent: donePercent,
        message: `已完成：${stage.title} (${index + 1}/${total})`
      });
    }

    ensureEnginePlugins();
    await refreshDetectionAsync();
    resetAgentEngineCache();
    assertWindowsInstallDetected("hermes", lastOutput);
    emitProgress(options, {
      engineId: "hermes",
      status: "success",
      stage: "done",
      percent: 100,
      message: "Hermes 安装完成，正在刷新检测..."
    });
    return getRuntimeStatus(["hermes"]);
  }

  function installWithWindowsInstaller(engineId, options = {}) {
    const { signal = null } = options;
    throwIfCancelled(signal);
    if (engineId === "hermes") initializeRuntime();
    stopEngine();
    clearLogs();
    const commandText = windowsInstallerCommand(engineId);
    const result = runInstallCommand(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", commandText],
      undefined
    );
    if (engineId === "hermes") ensureEnginePlugins();
    refreshDetection();
    resetAgentEngineCache();
    assertWindowsInstallDetected(engineId, `${result.stdout || ""}\n${result.stderr || ""}`);
    return getRuntimeStatus([engineId]);
  }

  async function installWithWindowsInstallerAsync(engineId, options = {}) {
    if (engineId === "hermes") return installHermesWithWindowsStagesAsync(options);
    const { signal = null } = options;
    throwIfCancelled(signal);
    if (engineId === "hermes") initializeRuntime();
    stopEngine();
    clearLogs();
    emitProgress(options, {
      engineId,
      status: "running",
      stage: "windows-installer",
      percent: 5,
      message: `Running official Windows installer for ${engineId}.`
    });
    const commandText = windowsInstallerCommand(engineId);
    const result = await runInstallCommandAsync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", commandText],
      undefined,
      {
        ...options,
        engineId,
        stage: "windows-installer",
        percent: 10,
        message: `Running official Windows installer for ${engineId}.`
      }
    );
    if (engineId === "hermes") ensureEnginePlugins();
    await refreshDetectionAsync();
    resetAgentEngineCache();
    assertWindowsInstallDetected(engineId, result.output);
    emitProgress(options, {
      engineId,
      status: "success",
      stage: "done",
      percent: 100,
      message: `${engineId} installed; refreshing detection.`
    });
    return getRuntimeStatus([engineId]);
  }

  function refreshDetection() {
    try {
      const result = refreshSystemHermes();
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {
      // Detection refresh is best-effort; probe() still runs live on next read.
    }
  }

  function importCheck(python, modules) {
    runInstallCommand(
      python,
      ["-c", moduleImportScript(modules)],
      undefined
    );
  }

  function importCheckAsync(python, modules, options = {}) {
    return runInstallCommandAsync(
      python,
      ["-c", moduleImportScript(modules)],
      undefined,
      {
        ...options,
        message: options.message || `验证 ${modules.join(", ")}`
      }
    );
  }

  function isExternallyManagedPipError(error) {
    return /externally-managed-environment|externally managed/i.test(`${error?.message || ""}\n${error?.output || ""}`);
  }

  // Where `pip install --user` placed the console scripts for this python. On
  // macOS this is ~/Library/Python/<ver>/bin (NOT ~/.local/bin); on Linux it is
  // ~/.local/bin; on Windows %APPDATA%\Python\PythonXY\Scripts.
  function userScriptsDir(python) {
    const result = spawnSync(
      python,
      ["-c", "import sysconfig; print(sysconfig.get_path('scripts', sysconfig.get_preferred_scheme('user')))"],
      spawnSyncOptions({ encoding: "utf8" })
    );
    if (result.error || result.status !== 0) return "";
    return String(result.stdout || "").trim();
  }

  // Make the freshly installed `hermes` discoverable where system-hermes-service
  // scans (~/.local/bin), matching what the official installer symlinks. pip
  // --user does not guarantee that location (esp. macOS), so we link it there.
  function linkIntoLocalBin(scriptsDir) {
    // Known limitation: on Windows pip writes hermes.exe to the user Scripts dir
    // and system-hermes-service can't recognize a .exe launcher (no shebang), so
    // detection may stay unavailable until that dir is on PATH. Hermes Windows
    // support is upstream early-beta; tracked for a separate fix.
    if (platform === "win32") {
      if (scriptsDir) appendLog(`Hermes installed to ${scriptsDir}; add it to PATH so Mia can detect it (Windows).`);
      return;
    }
    if (!scriptsDir) return;
    const source = path.join(scriptsDir, "hermes");
    if (!fsImpl.existsSync(source)) return;
    const localBin = path.join(homeDir(), ".local", "bin");
    const target = path.join(localBin, "hermes");
    if (path.resolve(source) === path.resolve(target)) return;
    try {
      fsImpl.mkdirSync(localBin, { recursive: true });
      try { fsImpl.rmSync(target, { force: true }); } catch { /* nothing to remove */ }
      fsImpl.symlinkSync(source, target);
      appendLog(`Linked ${target} -> ${source}`);
    } catch (error) {
      appendLog(`Could not link hermes into ~/.local/bin (${error.message}); ensure ${scriptsDir} is on PATH.`);
    }
  }

  // Install the official hermes-agent from a package index with `pip install
  // --user`. China mirror first, official PyPI as fallback. Per index we verify
  // the runtime actually imports before accepting it (so a base-only or partial
  // install is not reported as success), then link the entrypoint into
  // ~/.local/bin so system-hermes-service detects it.
  function installFromOfficialPackage(options = {}) {
    if (platform === "win32") return installWithWindowsInstaller("hermes", options);
    const { signal = null } = options;
    throwIfCancelled(signal);
    initializeRuntime();
    stopEngine();
    clearLogs();
    const source = installSourceService.resolveInstallSource();
    const python = selectOfficialEnginePython({ allowMacDeveloperToolsInstall: true });

    const pipInstall = (requirement, indexUrl) => runInstallCommand(
      python,
      ["-m", "pip", "install", "--user", "--upgrade", requirement, "--index-url", indexUrl],
      undefined
    );

    const indexUrls = source.indexUrls && source.indexUrls.length
      ? source.indexUrls
      : [source.indexUrl].filter(Boolean);
    let installed = false;
    let lastError = null;
    for (const indexUrl of indexUrls) {
      throwIfCancelled(signal);
      try {
        try {
          pipInstall(source.requirement, indexUrl);
        } catch (error) {
          if (!source.extras) throw error;
          appendLog(`Official Hermes install with extras failed on ${indexUrl}; retrying base package: ${error.message}`);
          pipInstall(source.baseRequirement, indexUrl);
        }
        for (const requirement of HERMES_API_RUNTIME_REQUIREMENTS) {
          pipInstall(requirement, indexUrl);
        }
        // Don't accept an index until the runtime + web deps actually import;
        // otherwise the gateway fails to start later. A bad index falls through.
        importCheck(python, HERMES_API_RUNTIME_MODULES);
        installed = true;
        break;
      } catch (error) {
        lastError = error;
        appendLog(`Hermes install via ${indexUrl} failed: ${error.message}`);
      }
    }
    if (!installed) throw lastError || new Error("Hermes install failed.");

    ensureEnginePlugins();
    importCheck(python, ["mia_plugins"]);
    linkIntoLocalBin(userScriptsDir(python));
    refreshDetection();
    resetAgentEngineCache();
    return getRuntimeStatus(["hermes"]);
  }

  async function installFromOfficialPackageAsync(options = {}) {
    if (platform === "win32") return installWithWindowsInstallerAsync("hermes", options);
    const { signal = null } = options;
    throwIfCancelled(signal);
    initializeRuntime();
    stopEngine();
    clearLogs();
    const source = installSourceService.resolveInstallSource();
    const python = selectOfficialEnginePython({ allowMacDeveloperToolsInstall: true });

    emitProgress(options, {
      engineId: "hermes",
      status: "running",
      stage: "prepare",
      message: "正在准备官方 Hermes 安装..."
    });

    const pipInstall = async (requirement, indexUrl) => {
      const runPipInstall = (extraArgs = []) => runInstallCommandAsync(
        python,
        ["-m", "pip", "install", "--user", ...extraArgs, "--upgrade", requirement, "--index-url", indexUrl],
        undefined,
        {
          ...options,
          engineId: "hermes",
          stage: "download",
          message: `正在从 ${indexUrl} 安装 ${requirement}`
        }
      );
      try {
        return await runPipInstall();
      } catch (error) {
        if (!isExternallyManagedPipError(error)) throw error;
        appendLog("Python reports an externally managed environment; retrying user install with --break-system-packages.");
        emitProgress(options, {
          engineId: "hermes",
          status: "running",
          stage: "retry",
          message: "当前 Python 受 uv 管理，正在用用户目录兼容模式重试..."
        });
        return runPipInstall(["--break-system-packages"]);
      }
    };

    const indexUrls = source.indexUrls && source.indexUrls.length
      ? source.indexUrls
      : [source.indexUrl].filter(Boolean);
    let installed = false;
    let lastError = null;
    for (const indexUrl of indexUrls) {
      throwIfCancelled(signal);
      try {
        try {
          await pipInstall(source.requirement, indexUrl);
        } catch (error) {
          if (!source.extras) throw error;
          appendLog(`Official Hermes install with extras failed on ${indexUrl}; retrying base package: ${error.message}`);
          emitProgress(options, {
            engineId: "hermes",
            status: "running",
            stage: "retry",
            message: "完整依赖安装失败，正在重试基础包..."
          });
          await pipInstall(source.baseRequirement, indexUrl);
        }
        for (const requirement of HERMES_API_RUNTIME_REQUIREMENTS) {
          await pipInstall(requirement, indexUrl);
        }
        emitProgress(options, {
          engineId: "hermes",
          status: "running",
          stage: "verify",
          message: "正在验证 Hermes 运行时..."
        });
        await importCheckAsync(python, HERMES_API_RUNTIME_MODULES, {
          ...options,
          engineId: "hermes",
          stage: "verify"
        });
        installed = true;
        break;
      } catch (error) {
        lastError = error;
        appendLog(`Hermes install via ${indexUrl} failed: ${error.message}`);
        emitProgress(options, {
          engineId: "hermes",
          status: "running",
          stage: "fallback",
          message: `安装源 ${indexUrl} 失败，正在尝试下一个源...`
        });
      }
    }
    if (!installed) throw lastError || new Error("Hermes install failed.");

    ensureEnginePlugins();
    emitProgress(options, {
      engineId: "hermes",
      status: "running",
      stage: "plugins",
      message: "正在验证 Mia 插件..."
    });
    await importCheckAsync(python, ["mia_plugins"], {
      ...options,
      engineId: "hermes",
      stage: "plugins"
    });
    linkIntoLocalBin(userScriptsDir(python));
    refreshDetection();
    resetAgentEngineCache();
    emitProgress(options, {
      engineId: "hermes",
      status: "success",
      stage: "done",
      message: "Hermes 已安装，正在刷新检测..."
    });
    return getRuntimeStatus(["hermes"]);
  }

  function resolveNpm() {
    return shellCommandPath("npm") || "npm";
  }

  // Install an npm-distributed engine (claude-code / codex) globally, China
  // mirror first then official npm registry. The result lands on the user's npm
  // global bin (on PATH), where system detection picks it up.
  function installNpmEngine(engineId, options = {}) {
    const { signal = null } = options;
    throwIfCancelled(signal);
    stopEngine();
    clearLogs();
    const pkg = NPM_ENGINE_PACKAGES[engineId];
    if (!pkg) throw new Error(`No npm package mapping for engine ${engineId}.`);
    const npm = resolveNpm();
    const registries = [npmRegistry, npmFallbackRegistry].filter((value, index, all) => value && all.indexOf(value) === index);
    let installed = false;
    let lastError = null;
    for (const registry of registries) {
      throwIfCancelled(signal);
      try {
        runInstallCommand(npm, ["install", "-g", pkg, "--registry", registry], undefined);
        installed = true;
        break;
      } catch (error) {
        lastError = error;
        appendLog(`${engineId} install via ${registry} failed: ${error.message}`);
      }
    }
    if (!installed) throw lastError || new Error(`${engineId} install failed.`);
    refreshDetection();
    resetAgentEngineCache();
    return getRuntimeStatus([engineId]);
  }

  async function installNpmEngineAsync(engineId, options = {}) {
    const { signal = null } = options;
    throwIfCancelled(signal);
    stopEngine();
    clearLogs();
    const pkg = NPM_ENGINE_PACKAGES[engineId];
    if (!pkg) throw new Error(`No npm package mapping for engine ${engineId}.`);
    const npm = resolveNpm();
    const registries = [npmRegistry, npmFallbackRegistry].filter((value, index, all) => value && all.indexOf(value) === index);
    let installed = false;
    let lastError = null;
    for (const registry of registries) {
      throwIfCancelled(signal);
      try {
        await runInstallCommandAsync(npm, ["install", "-g", pkg, "--registry", registry], undefined, {
          ...options,
          engineId,
          stage: "download",
          message: `正在从 ${registry} 安装 ${pkg}`
        });
        installed = true;
        break;
      } catch (error) {
        lastError = error;
        appendLog(`${engineId} install via ${registry} failed: ${error.message}`);
        emitProgress(options, {
          engineId,
          status: "running",
          stage: "fallback",
          message: `安装源 ${registry} 失败，正在尝试下一个源...`
        });
      }
    }
    if (!installed) throw lastError || new Error(`${engineId} install failed.`);
    refreshDetection();
    resetAgentEngineCache();
    emitProgress(options, {
      engineId,
      status: "success",
      stage: "done",
      message: "安装完成，正在刷新检测..."
    });
    return getRuntimeStatus([engineId]);
  }

  // Dispatch install by engine. Windows uses each upstream's native installer;
  // other platforms keep the existing PyPI/npm flows.
  function installEngine(engineId, options = {}) {
    const id = engineId || "hermes";
    if (platform === "win32" && WINDOWS_ENGINE_INSTALLERS[id]) return installWithWindowsInstaller(id, options);
    if (id === "hermes") return installFromOfficialPackage(options);
    if (NPM_ENGINE_PACKAGES[id]) return installNpmEngine(id, options);
    throw new Error(`Engine ${id} is not installable from Mia.`);
  }

  function installEngineAsync(engineId, options = {}) {
    const id = engineId || "hermes";
    if (platform === "win32" && WINDOWS_ENGINE_INSTALLERS[id]) return installWithWindowsInstallerAsync(id, options);
    if (id === "hermes") return installFromOfficialPackageAsync(options);
    if (NPM_ENGINE_PACKAGES[id]) return installNpmEngineAsync(id, options);
    throw new Error(`Engine ${id} is not installable from Mia.`);
  }

  function install(options = {}) {
    throwIfCancelled(options.signal);
    return installEngine("hermes", options);
  }

  function repair(options = {}) {
    return install(options);
  }

  function repairAsync(options = {}) {
    return installEngineAsync("hermes", options);
  }

  return {
    pythonVersion,
    selectOfficialEnginePython,
    hermesApiRuntimeCheck,
    isApiRuntimeReady,
    isInstalled,
    enginePython,
    engineSource,
    systemHermesPythonPath,
    runInstallCommand,
    runInstallCommandAsync,
    installFromOfficialPackage,
    installFromOfficialPackageAsync,
    installWithWindowsInstaller,
    installWithWindowsInstallerAsync,
    installNpmEngine,
    installNpmEngineAsync,
    installEngine,
    installEngineAsync,
    install,
    repair,
    repairAsync
  };
}

module.exports = { createEngineInstallService };
