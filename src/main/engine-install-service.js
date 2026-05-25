const { spawnSync: defaultSpawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

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
  const engineMarkerPath = deps.engineMarkerPath || (() => path.join(runtimePaths().engine, "aimashi-runtime.json"));
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
  const getRuntimeStatus = deps.getRuntimeStatus || ((created) => ({ created }));
  const now = deps.now || (() => new Date());

  function configuredValue(depName, envName, fallback) {
    if (Object.prototype.hasOwnProperty.call(deps, depName)) return deps[depName];
    return env[envName] || fallback;
  }

  const officialPackage = configuredValue("officialPackage", "AIMASHI_ENGINE_PACKAGE", "hermes-agent");
  const officialRepoUrl = configuredValue("officialRepoUrl", "AIMASHI_ENGINE_REPO", "https://github.com/NousResearch/hermes-agent");
  const officialRef = configuredValue("officialRef", "AIMASHI_ENGINE_REF", "main");
  const officialUrl = configuredValue("officialUrl", "AIMASHI_ENGINE_URL", "");
  const officialExtras = configuredValue("officialExtras", "AIMASHI_ENGINE_EXTRAS", "web");
  const officialPython = configuredValue("officialPython", "AIMASHI_PYTHON", "");
  const devEngineSource = configuredValue("devEngineSource", "AIMASHI_ENGINE_SOURCE", "");

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
    throw new Error("Official Hermes requires Python 3.11+. Set AIMASHI_PYTHON=/path/to/python3.11 or newer.");
  }

  function isInstalled() {
    if (bundledPython() && bundledSitePackages()) return true;
    const p = runtimePaths();
    const sourceEntrypoint = path.join(p.engine, "hermes_cli", "main.py");
    const marker = readJson(engineMarkerPath(), {});
    if (marker?.source === "official-github-archive" || marker?.source === "official-python-package") {
      return fsImpl.existsSync(venvPythonPath());
    }
    if (marker?.source === "maintained-local-source") {
      return fsImpl.existsSync(sourceEntrypoint);
    }
    return false;
  }

  function enginePython() {
    const bundled = bundledPython();
    if (bundled) return bundled;
    const managedPython = venvPythonPath();
    if (fsImpl.existsSync(managedPython)) return managedPython;
    return "python3";
  }

  function engineSource() {
    if (bundledPython() && bundledSitePackages()) return "bundled";
    if (fsImpl.existsSync(venvPythonPath())) return "managed";
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

  function installFromDevSource() {
    initializeRuntime();
    stopEngine();
    const p = runtimePaths();
    if (!fsImpl.existsSync(devEngineSource)) {
      throw new Error(`Hermes source missing: ${devEngineSource}`);
    }

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
    fsImpl.writeFileSync(engineMarkerPath(), JSON.stringify({
      product: "aimashi",
      source: "maintained-local-source",
      source_path: devEngineSource,
      installed_at: now().toISOString()
    }, null, 2) + "\n");
    ensureEnginePlugins();
    return getRuntimeStatus(["runtime/hermes-engine"]);
  }

  function installFromOfficialPackage() {
    initializeRuntime();
    stopEngine();
    const p = runtimePaths();
    const packageSpec = officialEngineRequirement(officialExtras);
    const basePackageSpec = officialEngineRequirement("");
    const python = selectOfficialEnginePython();

    clearLogs();
    fsImpl.rmSync(p.engine, { recursive: true, force: true });
    fsImpl.mkdirSync(p.engine, { recursive: true });
    fsImpl.writeFileSync(path.join(p.engine, "README.md"), [
      "# Aimashi Hermes Engine",
      "",
      `This runtime installs the official Hermes source archive: ${officialEngineUrl()}`,
      `Python executable used for installation: ${python}`,
      "Set AIMASHI_ENGINE_SOURCE only for local Hermes development builds.",
      ""
    ].join("\n"));

    runInstallCommand(python, ["-m", "venv", ".venv"], p.engine);
    runInstallCommand(venvPythonPath(), ["-m", "pip", "install", "--upgrade", "pip"], p.engine);
    try {
      runInstallCommand(venvPythonPath(), ["-m", "pip", "install", "--upgrade", packageSpec], p.engine);
    } catch (error) {
      if (!officialExtras) throw error;
      appendLog(`Official Hermes install with extras failed; retrying base install: ${error.message}`);
      runInstallCommand(venvPythonPath(), ["-m", "pip", "install", "--upgrade", basePackageSpec], p.engine);
    }
    runInstallCommand(venvPythonPath(), ["-c", "import hermes_cli.main, fastapi, uvicorn; print('hermes_cli + web deps import OK')"], p.engine);
    ensureEnginePlugins();
    runInstallCommand(venvPythonPath(), ["-c", "import aimashi_plugins; print('aimashi_plugins import OK')"], p.engine);

    fsImpl.writeFileSync(engineMarkerPath(), JSON.stringify({
      product: "aimashi",
      source: "official-github-archive",
      package: officialPackage,
      repo: officialRepoUrl,
      ref: officialRef,
      url: officialEngineUrl(),
      extras: officialExtras || null,
      python,
      spec: packageSpec,
      installed_at: now().toISOString()
    }, null, 2) + "\n");
    return getRuntimeStatus(["runtime/hermes-engine"]);
  }

  function install() {
    if (devEngineSource) return installFromDevSource();
    return installFromOfficialPackage();
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
    installFromDevSource,
    installFromOfficialPackage,
    install,
    venvPythonPath,
    engineMarkerPath
  };
}

module.exports = { createEngineInstallService };
