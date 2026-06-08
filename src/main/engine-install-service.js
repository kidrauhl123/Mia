const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync: defaultSpawnSync } = require("node:child_process");
const { createHermesInstallSourceService } = require("./hermes-install-source-service.js");

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
  const NPM_ENGINE_PACKAGES = { "claude-code": "@anthropic-ai/claude-code", codex: "@openai/codex" };

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
    ], { encoding: "utf8" });
    if (result.error || result.status !== 0) return null;
    const version = String(result.stdout || "").trim();
    const [major, minor] = version.split(".").map((part) => Number(part));
    if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
    return { version, major, minor };
  }

  function selectOfficialEnginePython() {
    const candidates = [officialPython, "python3.13", "python3.12", "python3.11", "python3"].filter(Boolean);
    for (const command of candidates) {
      const info = pythonVersion(command);
      if (info && (info.major > 3 || (info.major === 3 && info.minor >= 11))) return command;
    }
    throw new Error("Official Hermes requires Python 3.11+. Set MIA_PYTHON=/path/to/python3.11 or newer.");
  }

  function systemHermesPythonPath() {
    return String(systemHermesPython() || "").trim();
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

  function runInstallCommand(command, args, cwd) {
    appendLog(`$ ${command} ${args.join(" ")}`);
    const result = spawnSync(command, args, {
      cwd,
      env: { ...env, PIP_DISABLE_PIP_VERSION_CHECK: "1", PYTHONPATH: buildPythonPath() },
      encoding: "utf8"
    });
    appendCommandOutput(result.stdout);
    appendCommandOutput(result.stderr);
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}`);
    return result;
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
      ["-c", `import ${modules.join(", ")}; print('${modules.join("+")} import OK')`],
      undefined
    );
  }

  // Where `pip install --user` placed the console scripts for this python. On
  // macOS this is ~/Library/Python/<ver>/bin (NOT ~/.local/bin); on Linux it is
  // ~/.local/bin; on Windows %APPDATA%\Python\PythonXY\Scripts.
  function userScriptsDir(python) {
    const result = spawnSync(
      python,
      ["-c", "import sysconfig; print(sysconfig.get_path('scripts', sysconfig.get_preferred_scheme('user')))"],
      { encoding: "utf8" }
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
    const { signal = null } = options;
    throwIfCancelled(signal);
    initializeRuntime();
    stopEngine();
    clearLogs();
    const source = installSourceService.resolveInstallSource();
    const python = selectOfficialEnginePython();

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
        // Don't accept an index until the runtime + web deps actually import;
        // otherwise the gateway fails to start later. A bad index falls through.
        importCheck(python, ["hermes_cli.main", "fastapi", "uvicorn"]);
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

  // Dispatch install by engine. Hermes uses the official PyPI flow; claude/codex
  // use their official npm packages. Anything else is not installable here.
  function installEngine(engineId, options = {}) {
    if (!engineId || engineId === "hermes") return installFromOfficialPackage(options);
    if (NPM_ENGINE_PACKAGES[engineId]) return installNpmEngine(engineId, options);
    throw new Error(`Engine ${engineId} is not installable from Mia.`);
  }

  function install(options = {}) {
    throwIfCancelled(options.signal);
    return installFromOfficialPackage(options);
  }

  function repair(options = {}) {
    return install(options);
  }

  return {
    pythonVersion,
    selectOfficialEnginePython,
    isInstalled,
    enginePython,
    engineSource,
    systemHermesPythonPath,
    runInstallCommand,
    installFromOfficialPackage,
    installNpmEngine,
    installEngine,
    install,
    repair
  };
}

module.exports = { createEngineInstallService };
