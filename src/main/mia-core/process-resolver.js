"use strict";

const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

const DEFAULT_PATH = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";

function defaultRepoRoot() {
  return path.resolve(__dirname, "..", "..", "..");
}

function packagedRustCorePath(resourcesPath, platform = process.platform, arch = process.arch) {
  const base = String(resourcesPath || "").trim();
  if (!base) return "";
  const binary = platform === "win32" ? "mia-core.exe" : "mia-core";
  return path.join(base, "bundled-mia-core", `${platform}-${arch}`, binary);
}

function rustCoreBinaryName(platform = process.platform) {
  return platform === "win32" ? "mia-core.exe" : "mia-core";
}

function nodeBinaryName(platform = process.platform) {
  return platform === "win32" ? "node.exe" : "node";
}

function pathEntries(pathValue = "", delimiter = path.delimiter) {
  return String(pathValue || "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function findExecutableOnPath(binaryName, pathValue = DEFAULT_PATH, fsImpl = fs) {
  const binary = String(binaryName || "").trim();
  if (!binary) return "";
  for (const entry of pathEntries(pathValue)) {
    const candidate = path.join(entry, binary);
    try {
      const stat = fsImpl.statSync(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // Try next PATH entry.
    }
  }
  return "";
}

function repoBundledRustCorePath(repoRootValue, platform = process.platform, arch = process.arch) {
  const root = String(repoRootValue || "").trim();
  if (!root) return "";
  return packagedRustCorePath(path.join(root, "resources"), platform, arch);
}

function devRustCorePath(repoRootValue, profile = "debug", platform = process.platform) {
  const root = String(repoRootValue || "").trim();
  if (!root) return "";
  return path.join(root, "target", profile, rustCoreBinaryName(platform));
}

function officialSkillsDir(resourcesPathValue, repoRootValue, defaultAppValue, configured = "") {
  const explicit = String(configured || "").trim();
  if (explicit) return explicit;
  const resources = String(resourcesPathValue || "").trim();
  if (!defaultAppValue && resources) return path.join(resources, "skills", "_builtin");
  const root = path.resolve(String(repoRootValue || defaultRepoRoot()));
  return path.join(root, "skills", "_builtin");
}

function runtimeKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

function managedResourceRoots(resourcesPathValue, repoRootValue, platform = process.platform, arch = process.arch, configured = "", localRootValue = "", userHomeValue = "") {
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  const roots = pathEntries(configured, delimiter);
  const localRoot = String(localRootValue || "").trim();
  if (localRoot) roots.push(path.join(localRoot, "managed-resources"));
  const userHome = String(userHomeValue || "").trim();
  if (userHome) roots.push(path.join(userHome, ".mia", "managed-resources"));
  const resources = String(resourcesPathValue || "").trim();
  if (resources) {
    roots.push(path.join(resources, "managed-resources"));
    roots.push(path.join(resources, "bundled-mia-core", runtimeKey(platform, arch), "managed-resources"));
  }
  const repo = String(repoRootValue || "").trim();
  if (repo) roots.push(path.join(path.resolve(repo), "resources", "managed-resources"));
  return [...new Set(roots.filter(Boolean))];
}

function managedResourceRootsEnv(resourcesPathValue, repoRootValue, platform = process.platform, arch = process.arch, configured = "", localRootValue = "", userHomeValue = "") {
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  return managedResourceRoots(resourcesPathValue, repoRootValue, platform, arch, configured, localRootValue, userHomeValue).join(delimiter);
}

function managedAgentNodeRuntime(pathLookup, execPath, platform, defaultAppValue, env = {}) {
  const explicit = String(env.MIA_MANAGED_AGENT_NODE || "").trim();
  if (explicit) {
    return {
      command: explicit,
      electron: String(env.MIA_MANAGED_AGENT_NODE_ELECTRON || "") === "1"
    };
  }
  for (const binary of [...new Set([nodeBinaryName(platform), "node"])]) {
    const found = pathLookup(binary);
    if (found) return { command: found, electron: false };
  }
  if (!defaultAppValue) {
    const command = String(execPath() || "").trim();
    if (command) return { command, electron: true };
  }
  return { command: "", electron: false };
}

function defaultSourceFingerprint(repoRoot, fsImpl = fs) {
  const root = String(repoRoot || "").trim();
  if (!root) return "";
  const roots = [
    path.join(root, "Cargo.toml"),
    path.join(root, "Cargo.lock"),
    path.join(root, "crates"),
    path.join(root, "src", "main"),
    path.join(root, "package.json")
  ];
  const hash = crypto.createHash("sha256");
  let count = 0;

  function addFile(filePath) {
    if (count > 8000) return;
    let stat;
    try {
      stat = fsImpl.statSync(filePath);
    } catch {
      return;
    }
    if (!stat.isFile()) return;
    const ext = path.extname(filePath);
    if (![".js", ".json", ".lock", ".rs", ".sql", ".toml"].includes(ext)) return;
    count += 1;
    hash.update(path.relative(root, filePath));
    hash.update(":");
    hash.update(String(stat.size || 0));
    hash.update(":");
    hash.update(String(Math.floor(Number(stat.mtimeMs) || 0)));
    hash.update("\n");
  }

  function walk(target) {
    if (count > 8000) return;
    let stat;
    try {
      stat = fsImpl.statSync(target);
    } catch {
      return;
    }
    if (stat.isFile()) {
      addFile(target);
      return;
    }
    if (!stat.isDirectory()) return;
    let entries;
    try {
      entries = fsImpl.readdirSync(target, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "target") continue;
      const child = path.join(target, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) addFile(child);
    }
  }

  for (const rootPath of roots) walk(rootPath);
  return count ? hash.digest("hex").slice(0, 24) : "";
}

function createMiaCoreResolver(deps = {}) {
  const {
    runtimePaths,
    effectiveHermesHome,
    execPath = () => process.execPath,
    defaultApp = () => Boolean(process.defaultApp),
    platform = process.platform,
    arch = process.arch,
    env = process.env,
    resourcesPath = () => "",
    existsSync = (p) => fs.existsSync(p),
    repoRoot = defaultRepoRoot,
    coreSettings = () => ({}),
    appVersion = () => "",
    parentPid = () => process.pid,
    sourceFingerprint = (root) => defaultSourceFingerprint(root, fs),
    pathLookup = (binary) => findExecutableOnPath(binary, env.PATH || DEFAULT_PATH, fs),
    enginePython = () => String(env.MIA_ENGINE_PYTHON || ""),
    buildPythonPath = () => String(env.PYTHONPATH || ""),
    bundledHermesRuntimeDir = () => String(env.MIA_BUNDLED_HERMES_RUNTIME_DIR || "")
  } = deps;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");
  if (typeof effectiveHermesHome !== "function") throw new Error("effectiveHermesHome dependency is required.");

  function coreHome() {
    return runtimePaths().home;
  }

  function workspaceDir() {
    return path.join(coreHome(), "workspace");
  }

  function configuredHost() {
    const settings = typeof coreSettings === "function" ? coreSettings() : {};
    const value = String(env.MIA_CORE_HOST || settings.host || "127.0.0.1").trim();
    return value || "127.0.0.1";
  }

  function configuredPort() {
    const settings = typeof coreSettings === "function" ? coreSettings() : {};
    const raw = Number(env.MIA_CORE_PORT || settings.port || 27861);
    return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : 27861;
  }

  function serveArgs() {
    const pid = Number(parentPid());
    const args = [
      "serve",
      "--host",
      configuredHost(),
      "--port",
      String(configuredPort()),
      "--data-dir",
      coreHome(),
      "--workspace-dir",
      workspaceDir()
    ];
    if (Number.isInteger(pid) && pid > 0) {
      args.push("--parent-pid", String(pid));
    }
    args.push("--language", env.HERMES_LANGUAGE || "zh");
    return args;
  }

  function rustCoreTarget(command, args, workingDirectory, fingerprintRoot) {
    const fingerprint = String(sourceFingerprint(fingerprintRoot || workingDirectory) || "").trim();
    const targetParentPid = Number(parentPid());
    return {
      kind: "rust-core",
      command,
      args,
      workingDirectory,
      usesGuiAppIdentity: false,
      ...(Number.isInteger(targetParentPid) && targetParentPid > 0 ? { parentPid: targetParentPid } : {}),
      ...(fingerprint ? { sourceFingerprint: fingerprint } : {})
    };
  }

  function resolve() {
    const configuredBin = String(env.MIA_CORE_BIN || "").trim();
    if (configuredBin) {
      return rustCoreTarget(configuredBin, serveArgs(), path.dirname(configuredBin), configuredBin);
    }

    const packaged = packagedRustCorePath(resourcesPath(), platform, arch);
    if (!defaultApp() && packaged && existsSync(packaged)) {
      return rustCoreTarget(packaged, serveArgs(), path.dirname(packaged), packaged);
    }

    if (defaultApp()) {
      const root = path.resolve(String(repoRoot() || defaultRepoRoot()));
      for (const candidate of [
        devRustCorePath(root, "debug", platform),
        devRustCorePath(root, "release", platform),
        repoBundledRustCorePath(root, platform, arch),
        pathLookup(rustCoreBinaryName(platform))
      ]) {
        if (candidate && existsSync(candidate)) {
          return rustCoreTarget(candidate, serveArgs(), path.dirname(candidate), candidate);
        }
      }
      return {
        kind: "unresolved",
        command: execPath(),
        args: [],
        workingDirectory: root,
        usesGuiAppIdentity: false
      };
    }

    const command = execPath();
    return {
      kind: "unresolved",
      command,
      args: [],
      workingDirectory: path.dirname(command),
      usesGuiAppIdentity: false
    };
  }

  function coreEnvOverlay() {
    const p = runtimePaths();
    const r = resolve();
    const defaultAppValue = defaultApp();
    const repo = repoRoot();
    const resources = resourcesPath();
    const managedResources = defaultAppValue
      ? path.join(p.home, "managed-resources")
      : managedResourceRootsEnv(resources, repo, platform, arch, env.MIA_MANAGED_AGENT_RESOURCES, p.home, env.HOME || env.USERPROFILE);
    const managedNode = managedAgentNodeRuntime(pathLookup, execPath, platform, defaultAppValue, env);
    const selectedEnginePython = String(enginePython() || "").trim();
    const overlay = {
      MIA_CORE: "1",
      MIA_CORE_HOST: configuredHost(),
      MIA_CORE_PORT: String(configuredPort()),
      MIA_CORE_HOME: p.home,
      MIA_CORE_APP_VERSION: String(appVersion() || ""),
      MIA_CORE_WORKSPACE_DIR: workspaceDir(),
      MIA_HOME: p.home,
      MIA_OFFICIAL_SKILLS_DIR: officialSkillsDir(resources, repo, defaultAppValue, env.MIA_OFFICIAL_SKILLS_DIR),
      MIA_MANAGED_AGENT_RESOURCES: managedResources,
      ...(defaultAppValue ? { MIA_MANAGED_AGENT_RESOURCES_ONLY: "1" } : {}),
      MIA_MANAGED_AGENT_PREPARE: String(env.MIA_MANAGED_AGENT_PREPARE || "1"),
      ...(managedNode.command ? { MIA_MANAGED_AGENT_NODE: managedNode.command } : {}),
      MIA_MANAGED_AGENT_NODE_ELECTRON: managedNode.electron ? "1" : "0",
      MIA_CORE_RESOURCES_PATH: String(resources || ""),
      MIA_HERMES_ENGINE_DIR: p.engine,
      MIA_ENGINE_FALLBACKS_PATH: p.engineFallbacks || path.join(p.home, "mia-engine-fallbacks.json"),
      MIA_BUNDLED_HERMES_RUNTIME_DIR: String(bundledHermesRuntimeDir() || ""),
      ...(selectedEnginePython ? { MIA_ENGINE_PYTHON: selectedEnginePython } : {}),
      MIA_PLUGINS_DIR: p.pluginsDir,
      HERMES_HOME: effectiveHermesHome(),
      HERMES_LANGUAGE: env.HERMES_LANGUAGE || "zh",
      PYTHONUNBUFFERED: "1",
      PYTHONPATH: String(buildPythonPath() || ""),
      MIA_CORE_TARGET_KIND: r.kind,
      MIA_CORE_TARGET_COMMAND: path.basename(r.command || ""),
      MIA_CORE_WORKING_DIRECTORY: String(r.workingDirectory || ""),
      MIA_CORE_USES_GUI_IDENTITY: r.usesGuiAppIdentity ? "1" : "0",
      MIA_CORE_SOURCE_FINGERPRINT: String(r.sourceFingerprint || "")
    };

    return overlay;
  }

  function assertLaunchable() {
    const r = resolve();
    if (r.kind === "unresolved") {
      throw new Error("Mia Rust Core executable not found; refusing to start Core under the GUI app identity. Rebuild or reinstall Mia.");
    }
    return r;
  }

  function describe() {
    const r = resolve();
    return {
      kind: r.kind,
      command: path.basename(r.command),
      usesGuiAppIdentity: r.usesGuiAppIdentity,
      workingDirectory: r.workingDirectory,
      ...(Number.isInteger(Number(r.parentPid)) && Number(r.parentPid) > 0 ? { parentPid: Number(r.parentPid) } : {}),
      ...(r.sourceFingerprint ? { sourceFingerprint: r.sourceFingerprint } : {})
    };
  }

  return {
    resolve,
    coreEnvOverlay,
    assertLaunchable,
    describe
  };
}

module.exports = {
  createMiaCoreResolver,
  DEFAULT_PATH,
  devRustCorePath,
  findExecutableOnPath,
  managedResourceRoots,
  managedResourceRootsEnv,
  officialSkillsDir,
  packagedRustCorePath,
  repoBundledRustCorePath,
  runtimeKey,
  rustCoreBinaryName
};
