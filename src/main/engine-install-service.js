"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  resolveManagedAgentRuntime,
  runtimeKey
} = require("./agent-runtime/managed-agent-runtime.js");

const ENGINE_DEFINITIONS = Object.freeze({
  hermes: Object.freeze({ label: "Hermes" }),
  "claude-code": Object.freeze({ label: "Claude Code", protocols: ["claude-code-cli"] }),
  codex: Object.freeze({ label: "Codex", protocols: ["codex-app-server"] })
});
const PINNED_CLAUDE_CLI_VERSION = "2.1.211";
const PINNED_CLAUDE_ACP_VERSION = "0.59.0";
const PINNED_CODEX_CLI_VERSION = "0.144.5";
const PINNED_CODEX_ACP_VERSION = "1.1.4";

const CODEX_TARGETS = Object.freeze({
  "darwin-arm64": Object.freeze({ package: "@openai/codex-darwin-arm64", triple: "aarch64-apple-darwin" }),
  "darwin-x64": Object.freeze({ package: "@openai/codex-darwin-x64", triple: "x86_64-apple-darwin" }),
  "linux-arm64": Object.freeze({ package: "@openai/codex-linux-arm64", triple: "aarch64-unknown-linux-musl" }),
  "linux-x64": Object.freeze({ package: "@openai/codex-linux-x64", triple: "x86_64-unknown-linux-musl" }),
  "win32-arm64": Object.freeze({ package: "@openai/codex-win32-arm64", triple: "aarch64-pc-windows-msvc" }),
  "win32-x64": Object.freeze({ package: "@openai/codex-win32-x64", triple: "x86_64-pc-windows-msvc" })
});

function normalizeEngineId(value = "") {
  const id = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (id === "claude") return "claude-code";
  if (id === "openai-codex") return "codex";
  return id;
}

function packagePath(root, packageName) {
  return path.join(root, "node_modules", ...String(packageName).split("/").filter(Boolean));
}

function safeReadJson(fsImpl, filePath, fallback = null) {
  try {
    return JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function createEngineInstallService(deps = {}) {
  const runtimePaths = deps.runtimePaths;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");

  const fsImpl = deps.fs || fs;
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  const arch = deps.arch || process.arch;
  const projectRoot = String(deps.projectRoot || path.join(__dirname, "..", ".."));
  const packageConfig = safeReadJson(fsImpl, path.join(projectRoot, "package.json"), {});
  const pinnedHermesVersion = String(deps.hermesVersion || packageConfig?.hermes?.version || "").trim();
  const pinnedHermesPackageVersion = String(deps.hermesPackageVersion || packageConfig?.hermes?.packageVersion || "").trim();
  const pinnedHermesWheelSha256 = String(deps.hermesWheelSha256 || packageConfig?.hermes?.wheelSha256 || "").trim();
  const bundledHermesRuntimeDir = deps.bundledHermesRuntimeDir || (() => path.join(runtimePaths().home, "engine-backups", "hermes", runtimeKey(platform, arch)));
  const buildPythonPath = deps.buildPythonPath || (() => "");
  const systemHermesPython = deps.systemHermesPython || (() => "");
  const appendLog = deps.appendLog || (() => {});
  const clearLogs = deps.clearLogs || (() => {});
  const initializeRuntime = deps.initializeRuntime || (() => {});
  const stopEngine = deps.stopEngine || (() => {});
  const ensureEnginePlugins = deps.ensureEnginePlugins || (() => {});
  const resetAgentEngineCache = deps.resetAgentEngineCache || (() => {});
  const getRuntimeStatus = deps.getRuntimeStatus || ((created) => ({ created }));
  const now = deps.now || (() => new Date());
  const spawnSync = deps.spawnSync || require("node:child_process").spawnSync;
  const manifestUrl = String(
    deps.engineBackupManifestUrl ||
    env.MIA_ENGINE_BACKUP_MANIFEST_URL ||
    packageConfig?.engineBackups?.manifestUrl ||
    ""
  ).trim();
  let backupClient = deps.backupClient || null;
  function getBackupClient() {
    if (!backupClient) {
      const { createEngineBackupClient } = require("./engine-backup-client.js");
      backupClient = createEngineBackupClient({
        manifestUrl,
        fetchImpl: deps.fetchImpl || globalThis.fetch,
        fs: fsImpl,
        allowInsecure: env.MIA_ENGINE_BACKUP_ALLOW_INSECURE === "1"
      });
    }
    return backupClient;
  }

  function paths() {
    const value = runtimePaths();
    return {
      ...value,
      engineBackups: value.engineBackups || path.join(value.home, "engine-backups"),
      managedResources: value.managedResources || path.join(value.home, "managed-resources")
    };
  }

  function fallbackStatePath() {
    return paths().engineFallbacks || path.join(paths().home, "mia-engine-fallbacks.json");
  }

  function fallbackState() {
    const value = safeReadJson(fsImpl, fallbackStatePath(), {});
    return {
      schemaVersion: 1,
      engines: value?.engines && typeof value.engines === "object" ? { ...value.engines } : {}
    };
  }

  function fallbackEnabled(engineId) {
    return fallbackState().engines?.[normalizeEngineId(engineId)]?.enabled === true;
  }

  function persistFallback(engineId, info) {
    const id = normalizeEngineId(engineId);
    const state = fallbackState();
    state.engines[id] = {
      enabled: true,
      source: "mia-backup",
      version: String(info.version || ""),
      runtimeVersion: String(info.runtimeVersion || ""),
      enabledAt: now().toISOString()
    };
    const target = fallbackStatePath();
    fsImpl.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    fsImpl.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    try {
      fsImpl.renameSync(temp, target);
    } catch {
      try { fsImpl.rmSync(target, { force: true }); } catch { /* best effort */ }
      fsImpl.renameSync(temp, target);
    }
    if (typeof fsImpl.chmodSync === "function") {
      try { fsImpl.chmodSync(target, 0o600); } catch { /* Windows or restricted filesystem */ }
    }
  }

  function managedResourceRoots() {
    if (Array.isArray(deps.managedResourceRoots)) return deps.managedResourceRoots.slice();
    return [paths().managedResources];
  }

  function managedRuntime(engineId) {
    const id = normalizeEngineId(engineId);
    const definition = ENGINE_DEFINITIONS[id];
    if (!definition?.protocols) return null;
    const runtime = resolveManagedAgentRuntime({
      fs: fsImpl,
      platform,
      arch,
      engine: id,
      protocols: definition.protocols,
      resourceRoots: managedResourceRoots()
    });
    return runtime?.source === "managed" ? runtime : null;
  }

  function runtimeFromDirectory(engineId, root) {
    const id = normalizeEngineId(engineId);
    const manifestPath = path.join(root, "manifest.json");
    const manifest = safeReadJson(fsImpl, manifestPath, null);
    if (!manifest) throw new Error(`Mia 稳定版 ${ENGINE_DEFINITIONS[id].label} 备份缺少 manifest.json。`);
    const entrypoint = String(manifest.entrypoint || manifest.command || "").trim();
    const entrypointPath = entrypoint ? path.resolve(root, entrypoint) : "";
    const relative = entrypointPath ? path.relative(root, entrypointPath) : "";
    if (!entrypoint || !entrypointPath || relative.startsWith("..") || path.isAbsolute(relative) || !fsImpl.existsSync(entrypointPath)) {
      throw new Error(`Mia 稳定版 ${ENGINE_DEFINITIONS[id].label} 备份入口不完整。`);
    }
    if (!ENGINE_DEFINITIONS[id].protocols.includes(String(manifest.protocol || ""))) {
      throw new Error(`Mia 稳定版 ${ENGINE_DEFINITIONS[id].label} 备份协议不匹配。`);
    }
    return {
      source: "managed",
      engine: id,
      version: String(manifest.version || ""),
      runtimeKey: runtimeKey(platform, arch),
      rootDir: root,
      path: entrypointPath,
      manifest
    };
  }

  function claudeStableInfo(runtime) {
    if (String(runtime.version || "") !== PINNED_CLAUDE_ACP_VERSION) {
      throw new Error(`Mia 稳定版 Claude ACP 版本不匹配：需要 ${PINNED_CLAUDE_ACP_VERSION}。`);
    }
    const key = runtime.runtimeKey || runtimeKey(platform, arch);
    const executable = path.join(
      runtime.rootDir,
      "node_modules",
      `@anthropic-ai/claude-agent-sdk-${key}`,
      platform === "win32" ? "claude.exe" : "claude"
    );
    if (!fsImpl.existsSync(executable)) {
      throw new Error(`Mia 稳定版 Claude Code 备份不完整：缺少 ${executable}。`);
    }
    const sdkManifest = safeReadJson(fsImpl, path.join(runtime.rootDir, "node_modules", "@anthropic-ai", "claude-agent-sdk", "manifest.json"), {});
    if (String(sdkManifest.version || "") !== PINNED_CLAUDE_CLI_VERSION) {
      throw new Error(`Mia 稳定版 Claude Code 版本不匹配：需要 ${PINNED_CLAUDE_CLI_VERSION}。`);
    }
    return {
      engineId: "claude-code",
      label: "Claude Code",
      path: executable,
      version: String(sdkManifest.version || ""),
      runtimeVersion: runtime.version
    };
  }

  function codexStableInfo(runtime) {
    if (String(runtime.version || "") !== PINNED_CODEX_ACP_VERSION) {
      throw new Error(`Mia 稳定版 Codex ACP 版本不匹配：需要 ${PINNED_CODEX_ACP_VERSION}。`);
    }
    const key = runtime.runtimeKey || runtimeKey(platform, arch);
    const target = CODEX_TARGETS[key];
    if (!target) throw new Error(`Mia 稳定版 Codex 暂不支持 ${key}。`);
    const binaryName = platform === "win32" ? "codex.exe" : "codex";
    const candidates = [
      path.join(packagePath(runtime.rootDir, target.package), "vendor", target.triple, "bin", binaryName),
      path.join(packagePath(runtime.rootDir, "@openai/codex"), "vendor", target.triple, "bin", binaryName)
    ];
    const executable = candidates.find((candidate) => fsImpl.existsSync(candidate)) || "";
    if (!executable) throw new Error(`Mia 稳定版 Codex 备份不完整：缺少 ${target.package} 平台程序。`);
    const packageJson = safeReadJson(fsImpl, path.join(packagePath(runtime.rootDir, "@openai/codex"), "package.json"), {});
    if (String(packageJson.version || "") !== PINNED_CODEX_CLI_VERSION) {
      throw new Error(`Mia 稳定版 Codex 版本不匹配：需要 ${PINNED_CODEX_CLI_VERSION}。`);
    }
    return {
      engineId: "codex",
      label: "Codex",
      path: executable,
      version: String(packageJson.version || ""),
      runtimeVersion: runtime.version
    };
  }

  function hermesStableInfo(rootOverride = "") {
    const root = String(rootOverride || bundledHermesRuntimeDir() || "").trim();
    const python = root
      ? platform === "win32" ? path.join(root, "python", "python.exe") : path.join(root, "python", "bin", "python3")
      : "";
    const sitePackages = root ? path.join(root, "site-packages") : "";
    if (!root || !fsImpl.existsSync(python) || !fsImpl.existsSync(sitePackages)) {
      throw new Error("Mia 稳定版 Hermes 备份尚未下载或资源不完整。");
    }
    const buildInfo = safeReadJson(fsImpl, path.join(root, "runtime-build-info.json"), {});
    if (!buildInfo.hermesVersion) throw new Error("Mia 稳定版 Hermes 备份缺少版本清单。");
    if (pinnedHermesVersion && String(buildInfo.hermesVersion) !== pinnedHermesVersion) {
      throw new Error(`Mia 稳定版 Hermes 版本不匹配：需要 ${pinnedHermesVersion}。`);
    }
    if (pinnedHermesPackageVersion && String(buildInfo.hermesPackageVersion || "") !== pinnedHermesPackageVersion) {
      throw new Error(`Mia 稳定版 Hermes 包版本不匹配：需要 ${pinnedHermesPackageVersion}。`);
    }
    if (pinnedHermesWheelSha256 && String(buildInfo.hermesWheelSha256 || "") !== pinnedHermesWheelSha256) {
      throw new Error("Mia 稳定版 Hermes 包校验值不匹配，请重新下载。");
    }
    return {
      engineId: "hermes",
      label: "Hermes",
      path: python,
      sitePackages,
      version: String(buildInfo.hermesVersion),
      runtimeVersion: String(buildInfo.pythonVersion || "")
    };
  }

  function stableEngineInfoAt(engineId, root) {
    const id = normalizeEngineId(engineId);
    if (id === "hermes") return hermesStableInfo(root);
    const runtime = runtimeFromDirectory(id, root);
    return id === "claude-code" ? claudeStableInfo(runtime) : codexStableInfo(runtime);
  }

  function stableEngineInfo(engineId) {
    const id = normalizeEngineId(engineId);
    if (!ENGINE_DEFINITIONS[id]) throw new Error(`Engine ${id} is not installable from Mia.`);
    if (id === "hermes") return hermesStableInfo();
    const runtime = managedRuntime(id);
    if (!runtime) throw new Error(`Mia 稳定版 ${ENGINE_DEFINITIONS[id].label} 备份尚未下载。`);
    return id === "claude-code" ? claudeStableInfo(runtime) : codexStableInfo(runtime);
  }

  function stableEngineDestination(engineId) {
    const id = normalizeEngineId(engineId);
    const key = runtimeKey(platform, arch);
    if (id === "hermes") return bundledHermesRuntimeDir();
    if (id === "claude-code") return path.join(paths().managedResources, "acp", "claude-agent-acp", PINNED_CLAUDE_ACP_VERSION, key);
    if (id === "codex") return path.join(paths().managedResources, "acp", "codex-acp", PINNED_CODEX_ACP_VERSION, key);
    throw new Error(`Engine ${id} is not installable from Mia.`);
  }

  function expectedBackupVersions(engineId) {
    const id = normalizeEngineId(engineId);
    if (id === "hermes") return { version: pinnedHermesVersion, runtimeVersion: pinnedHermesPackageVersion };
    if (id === "claude-code") return { version: PINNED_CLAUDE_CLI_VERSION, runtimeVersion: PINNED_CLAUDE_ACP_VERSION };
    return { version: PINNED_CODEX_CLI_VERSION, runtimeVersion: PINNED_CODEX_ACP_VERSION };
  }

  function systemHermesPythonPath() {
    return String(systemHermesPython() || "").trim();
  }

  function managedHermesInfo() {
    if (!fallbackEnabled("hermes")) return null;
    try { return hermesStableInfo(); } catch { return null; }
  }

  function enginePython() {
    return systemHermesPythonPath() || managedHermesInfo()?.path || "python3";
  }

  function engineSource() {
    if (systemHermesPythonPath()) return "system";
    return managedHermesInfo() ? "mia-managed" : "none";
  }

  function isInstalled() {
    return engineSource() !== "none";
  }

  function hermesApiRuntimeCheck(python = enginePython()) {
    if (!isInstalled()) return { ok: false, error: "Hermes is not enabled." };
    const result = spawnSync(python, [
      "-c",
      "import importlib; [importlib.import_module(x) for x in ['hermes_cli.main','aiohttp','mcp','ddgs']]; print('import OK')"
    ], {
      encoding: "utf8",
      timeout: 5000,
      env: { ...env, PYTHONPATH: buildPythonPath() },
      ...(platform === "win32" ? { windowsHide: true } : {})
    });
    if (!result.error && result.status === 0) return { ok: true, error: "" };
    return {
      ok: false,
      error: String(result.stderr || result.stdout || result.error?.message || "Hermes runtime check failed.").trim()
    };
  }

  function isApiRuntimeReady() {
    return hermesApiRuntimeCheck().ok;
  }

  function throwIfCancelled(signal) {
    if (!signal?.aborted) return;
    const error = new Error("Engine activation cancelled.");
    error.code = "MIA_ENGINE_INSTALL_CANCELLED";
    throw error;
  }

  function emitProgress(options, payload) {
    options?.onProgress?.(payload);
  }

  function activateStableEngine(engineId, options = {}) {
    const id = normalizeEngineId(engineId || "hermes");
    throwIfCancelled(options.signal);
    const definition = ENGINE_DEFINITIONS[id];
    if (!definition) throw new Error(`Engine ${id} is not installable from Mia.`);
    clearLogs();
    stopEngine();
    if (id === "hermes") initializeRuntime();
    emitProgress(options, { engineId: id, status: "running", stage: "verify", percent: 93, message: `正在校验 Mia 稳定版 ${definition.label}...` });
    const info = stableEngineInfo(id);
    throwIfCancelled(options.signal);
    appendLog(`Activating Mia backup ${definition.label} ${info.version || "(pinned)"} at ${info.path}`);
    persistFallback(id, info);
    if (id === "hermes") ensureEnginePlugins();
    resetAgentEngineCache();
    emitProgress(options, { engineId: id, status: "success", stage: "done", percent: 100, message: `Mia 稳定版 ${definition.label} 已启用，正在重新检测。` });
    return getRuntimeStatus([id]);
  }

  function installEngine(engineId, options = {}) {
    return activateStableEngine(engineId, options);
  }

  async function installEngineAsync(engineId, options = {}) {
    const id = normalizeEngineId(engineId || "hermes");
    const definition = ENGINE_DEFINITIONS[id];
    if (!definition) throw new Error(`Engine ${id} is not installable from Mia.`);
    throwIfCancelled(options.signal);
    try {
      stableEngineInfo(id);
    } catch {
      const expected = expectedBackupVersions(id);
      await getBackupClient().install({
        engineId: id,
        targetKey: runtimeKey(platform, arch),
        destination: stableEngineDestination(id),
        expectedVersion: expected.version,
        expectedRuntimeVersion: expected.runtimeVersion,
        signal: options.signal,
        prepare: async (root) => {
          const info = stableEngineInfoAt(id, root);
          if (platform !== "win32" && typeof fsImpl.chmodSync === "function") fsImpl.chmodSync(info.path, 0o755);
        },
        validate: async (root) => stableEngineInfoAt(id, root),
        onProgress: (progress) => emitProgress(options, {
          engineId: id,
          status: "running",
          ...progress,
          message: progress.stage === "download"
            ? `正在从 Mia 备份下载 ${definition.label}...`
            : progress.stage === "extract"
              ? `正在解压 ${definition.label}...`
              : `正在准备 Mia 稳定版 ${definition.label}...`
        })
      });
    }
    return activateStableEngine(id, options);
  }

  function install(options = {}) {
    return installEngine("hermes", options);
  }

  function repair(options = {}) {
    return install(options);
  }

  function repairAsync(options = {}) {
    return installEngineAsync("hermes", options);
  }

  return {
    activateStableEngine,
    enginePython,
    engineSource,
    fallbackEnabled,
    fallbackState,
    fallbackStatePath,
    hermesApiRuntimeCheck,
    install,
    installEngine,
    installEngineAsync,
    isApiRuntimeReady,
    isInstalled,
    managedRuntime,
    repair,
    repairAsync,
    stableEngineDestination,
    stableEngineInfo,
    systemHermesPythonPath
  };
}

module.exports = {
  CODEX_TARGETS,
  ENGINE_DEFINITIONS,
  PINNED_CLAUDE_CLI_VERSION,
  PINNED_CLAUDE_ACP_VERSION,
  PINNED_CODEX_CLI_VERSION,
  PINNED_CODEX_ACP_VERSION,
  createEngineInstallService,
  normalizeEngineId
};
