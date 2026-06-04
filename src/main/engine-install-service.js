const { spawnSync: defaultSpawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { createHermesInstallSourceService } = require("./hermes-install-source-service.js");

function createEngineInstallService(deps = {}) {
  const runtimePaths = deps.runtimePaths;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");

  const fsImpl = deps.fs || fs;
  const env = deps.env || process.env;
  const spawnSync = deps.spawnSync || defaultSpawnSync;
  const venvPythonPath = deps.venvPythonPath || (() => path.join(runtimePaths().engine, ".venv", "bin", "python"));
  const bundledPython = deps.bundledPython || (() => "");
  const bundledSitePackages = deps.bundledSitePackages || (() => "");
  const buildPythonPath = deps.buildPythonPath || (() => "");
  const engineMarkerPath = deps.engineMarkerPath || (() => path.join(runtimePaths().engine, "mia-runtime.json"));
  const systemHermesPython = typeof deps.systemHermesPython === "function"
    ? deps.systemHermesPython
    : () => "";
  const readJson = deps.readJson || ((filePath, fallback) => {
    try {
      return JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
    } catch {
      return fallback;
    }
  });
  const appendLog = deps.appendLog || (() => {});
  const clearLogs = deps.clearLogs || (() => {});
  const initializeRuntime = deps.initializeRuntime || (() => {});
  const stopEngine = deps.stopEngine || (() => {});
  const ensureEnginePlugins = deps.ensureEnginePlugins || (() => {});
  const resetAgentEngineCache = deps.resetAgentEngineCache || (() => {});
  const getRuntimeStatus = deps.getRuntimeStatus || ((created) => ({ created }));
  const now = deps.now || (() => new Date());

  function configuredValue(depName, envName, fallback) {
    if (Object.prototype.hasOwnProperty.call(deps, depName)) return deps[depName];
    return env[envName] || fallback;
  }

  const officialPackage = configuredValue("officialPackage", "MIA_ENGINE_PACKAGE", "hermes-agent");
  const officialRepoUrl = configuredValue("officialRepoUrl", "MIA_ENGINE_REPO", "https://github.com/NousResearch/hermes-agent");
  const officialRef = configuredValue("officialRef", "MIA_ENGINE_REF", "main");
  const officialUrl = configuredValue("officialUrl", "MIA_ENGINE_URL", "");
  const officialExtras = configuredValue("officialExtras", "MIA_ENGINE_EXTRAS", "web");
  const officialPython = configuredValue("officialPython", "MIA_PYTHON", "");
  const devEngineSource = configuredValue("devEngineSource", "MIA_ENGINE_SOURCE", "");
  const installSourceService = deps.installSourceService || createHermesInstallSourceService({
    env,
    officialPackage,
    officialRepoUrl,
    officialRef,
    officialUrl,
    officialExtras
  });

  function throwIfCancelled(signal) {
    if (signal?.aborted) {
      const error = new Error("Hermes install cancelled.");
      error.code = "MIA_HERMES_INSTALL_CANCELLED";
      throw error;
    }
  }

  function officialEngineUrl() {
    if (String(officialUrl || "").trim()) return officialUrl.trim();
    const repo = String(officialRepoUrl || "https://github.com/NousResearch/hermes-agent").replace(/\/+$/, "");
    const ref = encodeURIComponent(String(officialRef || "main").trim());
    return `${repo}/archive/${ref}.tar.gz`;
  }

  function officialEngineRequirement(extras = "") {
    const name = String(officialPackage || "hermes-agent").trim();
    const extraPart = extras ? `[${extras}]` : "";
    return `${name}${extraPart} @ ${officialEngineUrl()}`;
  }

  function pythonVersion(command) {
    const result = spawnSync(command, [
      "-c",
      "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')"
    ], {
      encoding: "utf8"
    });
    if (result.error || result.status !== 0) return null;
    const version = String(result.stdout || "").trim();
    const [major, minor] = version.split(".").map((part) => Number(part));
    if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
    return { version, major, minor };
  }

  function selectOfficialEnginePython() {
    const candidates = [
      officialPython,
      "python3.13",
      "python3.12",
      "python3.11",
      "python3"
    ].filter(Boolean);
    for (const command of candidates) {
      const info = pythonVersion(command);
      if (info && (info.major > 3 || (info.major === 3 && info.minor >= 11))) {
        return command;
      }
    }
    throw new Error("Official Hermes requires Python 3.11+. Set MIA_PYTHON=/path/to/python3.11 or newer.");
  }

  function isInstalled() {
    if (bundledPython() && bundledSitePackages()) return true;
    const marker = readJson(engineMarkerPath(), {});
    const managedSources = new Set(["official-github-archive", "official-python-package", "mia-mirror"]);
    if (managedSources.has(marker?.source)) {
      return fsImpl.existsSync(venvPythonPath());
    }
    if (localSourceInstalled(marker)) return true;
    if (systemHermesPythonPath()) return true;
    return false;
  }

  function localSourceEntrypoint() {
    return path.join(runtimePaths().engine, "hermes_cli", "main.py");
  }

  function localSourceInstalled(marker = readJson(engineMarkerPath(), {})) {
    return marker?.source === "maintained-local-source" && fsImpl.existsSync(localSourceEntrypoint());
  }

  function systemHermesPythonPath() {
    return String(systemHermesPython() || "").trim();
  }

  function enginePython() {
    const bundled = bundledPython();
    if (bundled) return bundled;
    const managedPython = venvPythonPath();
    if (fsImpl.existsSync(managedPython)) return managedPython;
    if (localSourceInstalled()) return "python3";
    const systemPython = systemHermesPythonPath();
    if (systemPython) return systemPython;
    return "python3";
  }

  function engineSource() {
    if (bundledPython() && bundledSitePackages()) return "bundled";
    if (fsImpl.existsSync(venvPythonPath())) return "managed";
    const marker = readJson(engineMarkerPath(), {});
    if (localSourceInstalled(marker)) return "local-source";
    if (systemHermesPythonPath()) return "system";
    return "none";
  }

  function appendCommandOutput(output) {
    for (const line of String(output || "").split(/\r?\n/).filter(Boolean)) {
      appendLog(line);
    }
  }

  function runInstallCommand(command, args, cwd) {
    appendLog(`$ ${command} ${args.join(" ")}`);
    const result = spawnSync(command, args, {
      cwd,
      env: {
        ...env,
        PIP_DISABLE_PIP_VERSION_CHECK: "1",
        PYTHONPATH: buildPythonPath()
      },
      encoding: "utf8"
    });
    appendCommandOutput(result.stdout);
    appendCommandOutput(result.stderr);
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`${command} exited with code ${result.status}`);
    }
    return result;
  }

  function installFromDevSource(options = {}) {
    const { signal = null } = options;
    throwIfCancelled(signal);
    initializeRuntime();
    stopEngine();
    const p = runtimePaths();
    if (!fsImpl.existsSync(devEngineSource)) {
      throw new Error(`Hermes source missing: ${devEngineSource}`);
    }

    throwIfCancelled(signal);
    fsImpl.rmSync(p.engine, { recursive: true, force: true });
    const skip = new Set([
      ".git",
      ".pytest_cache",
      ".ruff_cache",
      "__pycache__",
      "node_modules",
      "tests",
      "website",
      "ui-tui",
      "demo"
    ]);
    fsImpl.cpSync(devEngineSource, p.engine, {
      recursive: true,
      dereference: false,
      filter: (source) => !skip.has(path.basename(source))
    });
    throwIfCancelled(signal);
    fsImpl.writeFileSync(engineMarkerPath(), JSON.stringify({
      product: "mia",
      source: "maintained-local-source",
      source_path: devEngineSource,
      installed_at: now().toISOString()
    }, null, 2) + "\n");
    ensureEnginePlugins();
    resetAgentEngineCache();
    return getRuntimeStatus(["runtime/hermes-engine"]);
  }

  function installFromOfficialPackage(options = {}) {
    const { signal = null } = options;
    throwIfCancelled(signal);
    initializeRuntime();
    stopEngine();
    const p = runtimePaths();
    const source = installSourceService.resolveInstallSource();
    const packageSpec = source.requirement;
    const basePackageSpec = source.baseRequirement;
    const python = selectOfficialEnginePython();

    clearLogs();
    throwIfCancelled(signal);
    fsImpl.rmSync(p.engine, { recursive: true, force: true });
    fsImpl.mkdirSync(p.engine, { recursive: true });
    fsImpl.writeFileSync(path.join(p.engine, "README.md"), [
      "# Mia Hermes Engine",
      "",
      `This runtime installs the official Hermes source archive or verified Mia mirror: ${source.url}`,
      source.upstreamUrl && source.upstreamUrl !== source.url ? `Upstream Hermes source: ${source.upstreamUrl}` : "",
      source.checksum ? `Expected sha256: ${source.checksum}` : "",
      `Python executable used for installation: ${python}`,
      "Set MIA_ENGINE_SOURCE only for local Hermes development builds.",
      ""
    ].filter((line) => line !== "").join("\n"));

    throwIfCancelled(signal);
    runInstallCommand(python, ["-m", "venv", ".venv"], p.engine);
    throwIfCancelled(signal);
    runInstallCommand(venvPythonPath(), ["-m", "pip", "install", "--upgrade", "pip"], p.engine);
    try {
      throwIfCancelled(signal);
      runInstallCommand(venvPythonPath(), ["-m", "pip", "install", "--upgrade", packageSpec], p.engine);
    } catch (error) {
      if (!officialExtras) throw error;
      appendLog(`Official Hermes install with extras failed; retrying base install: ${error.message}`);
      throwIfCancelled(signal);
      runInstallCommand(venvPythonPath(), ["-m", "pip", "install", "--upgrade", basePackageSpec], p.engine);
    }
    throwIfCancelled(signal);
    runInstallCommand(venvPythonPath(), ["-c", "import hermes_cli.main, fastapi, uvicorn; print('hermes_cli + web deps import OK')"], p.engine);
    ensureEnginePlugins();
    throwIfCancelled(signal);
    runInstallCommand(venvPythonPath(), ["-c", "import mia_plugins; print('mia_plugins import OK')"], p.engine);

    fsImpl.writeFileSync(engineMarkerPath(), JSON.stringify({
      product: "mia",
      source: source.kind,
      package: source.package,
      repo: source.repo,
      ref: source.ref,
      url: source.url,
      upstream_url: source.upstreamUrl,
      extras: source.extras || null,
      checksum_sha256: source.checksum || "",
      python,
      spec: packageSpec,
      installed_at: now().toISOString()
    }, null, 2) + "\n");
    resetAgentEngineCache();
    return getRuntimeStatus(["runtime/hermes-engine"]);
  }

  function install(options = {}) {
    throwIfCancelled(options.signal);
    if (devEngineSource) return installFromDevSource(options);
    return installFromOfficialPackage(options);
  }

  function repair(options = {}) {
    throwIfCancelled(options.signal);
    initializeRuntime();
    stopEngine();
    fsImpl.rmSync(runtimePaths().engine, { recursive: true, force: true });
    return install(options);
  }

  return {
    officialEngineUrl,
    officialEngineRequirement,
    pythonVersion,
    selectOfficialEnginePython,
    isInstalled,
    enginePython,
    engineSource,
    runInstallCommand,
    systemHermesPythonPath,
    installFromDevSource,
    installFromOfficialPackage,
    install,
    repair,
    venvPythonPath,
    engineMarkerPath
  };
}

module.exports = { createEngineInstallService };
