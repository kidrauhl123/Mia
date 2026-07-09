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

function officialSkillsDir(resourcesPathValue, repoRootValue, defaultAppValue, configured = "") {
  const explicit = String(configured || "").trim();
  if (explicit) return explicit;
  const resources = String(resourcesPathValue || "").trim();
  if (!defaultAppValue && resources) return path.join(resources, "skills", "_builtin");
  const root = path.resolve(String(repoRootValue || defaultRepoRoot()));
  return path.join(root, "skills", "_builtin");
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
    cargoPath = () => env.CARGO || "cargo",
    parentPid = () => process.pid,
    sourceFingerprint = (root) => defaultSourceFingerprint(root, fs)
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
    const value = String(settings.host || env.MIA_CORE_HOST || "127.0.0.1").trim();
    return value || "127.0.0.1";
  }

  function configuredPort() {
    const settings = typeof coreSettings === "function" ? coreSettings() : {};
    const raw = Number(settings.port || env.MIA_CORE_PORT || 27861);
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
      return rustCoreTarget(
        String(cargoPath() || "cargo"),
        ["run", "-p", "mia-core-app", "--", ...serveArgs()],
        root,
        root
      );
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
    const overlay = {
      MIA_CORE: "1",
      MIA_CORE_HOST: configuredHost(),
      MIA_CORE_PORT: String(configuredPort()),
      MIA_CORE_HOME: p.home,
      MIA_CORE_APP_VERSION: String(appVersion() || ""),
      MIA_CORE_WORKSPACE_DIR: workspaceDir(),
      MIA_HOME: p.home,
      MIA_OFFICIAL_SKILLS_DIR: officialSkillsDir(resources, repo, defaultAppValue, env.MIA_OFFICIAL_SKILLS_DIR),
      MIA_HERMES_ENGINE_DIR: p.engine,
      MIA_PLUGINS_DIR: p.pluginsDir,
      HERMES_HOME: effectiveHermesHome(),
      HERMES_LANGUAGE: env.HERMES_LANGUAGE || "zh",
      PYTHONUNBUFFERED: "1",
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
  officialSkillsDir,
  packagedRustCorePath
};
