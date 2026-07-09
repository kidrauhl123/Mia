const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MIA_LOCAL_DATA_RESET_EPOCH = "2026-07-09-prelaunch-account-reset";
const RESET_MARKER_FILE = "mia-local-data-reset.json";
const DISABLE_RESET_ENV = "MIA_DISABLE_PRELAUNCH_DATA_RESET";
const ALLOW_EXTERNAL_HOME_ENV = "MIA_RESET_ALLOW_EXTERNAL_HOME";
const PRESERVED_USER_DATA_NAMES = new Set([
  RESET_MARKER_FILE,
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket"
]);

function normalizeEpoch(value) {
  return String(value || "").trim();
}

function safeJsonRead(fsImpl, filePath) {
  try {
    if (!fsImpl.existsSync(filePath)) return null;
    return JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function isSameOrInside(pathImpl, parent, child) {
  const resolvedParent = pathImpl.resolve(parent);
  const resolvedChild = pathImpl.resolve(child);
  if (resolvedParent === resolvedChild) return true;
  const relative = pathImpl.relative(resolvedParent, resolvedChild);
  return Boolean(relative) && !relative.startsWith("..") && !pathImpl.isAbsolute(relative);
}

function isUnsafeResetRoot(pathImpl, targetPath) {
  const resolved = pathImpl.resolve(targetPath || "");
  const root = pathImpl.parse(resolved).root;
  return !resolved || resolved === root;
}

function removePath(fsImpl, targetPath) {
  if (!targetPath) return false;
  const root = path.parse(path.resolve(targetPath)).root;
  const resolved = path.resolve(targetPath);
  if (resolved === root) return false;
  if (!fsImpl.existsSync(resolved)) return false;
  fsImpl.rmSync(resolved, { recursive: true, force: true });
  return true;
}

function stopLaunchAgent({ fsImpl, spawnSyncImpl, platform, getuid, plistPath }) {
  if (!plistPath || !fsImpl.existsSync(plistPath)) return;
  if (platform !== "darwin" || typeof spawnSyncImpl !== "function") return;
  const uid = typeof getuid === "function" ? getuid() : null;
  if (!Number.isFinite(uid)) return;
  try {
    spawnSyncImpl("launchctl", ["bootout", `gui/${uid}`, plistPath], {
      stdio: "ignore",
      timeout: 5000
    });
  } catch {
    // Best effort only; removing the plist prevents the next launch.
  }
}

function removeUserDataChildren({ fsImpl, pathImpl, userDataDir, markerPath }) {
  const removed = [];
  fsImpl.mkdirSync(userDataDir, { recursive: true });
  for (const entry of fsImpl.readdirSync(userDataDir)) {
    if (PRESERVED_USER_DATA_NAMES.has(entry) || entry.startsWith("Singleton")) continue;
    const target = pathImpl.join(userDataDir, entry);
    if (pathImpl.resolve(target) === pathImpl.resolve(markerPath)) continue;
    if (removePath(fsImpl, target)) removed.push(target);
  }
  return removed;
}

function removeExternalHermesFiles({ fsImpl, runtime }) {
  const removed = [];
  const hermesHome = String(runtime?.hermesHome || "").trim();
  if (!hermesHome) return removed;
  const hermesDir = path.resolve(hermesHome);
  for (const target of [runtime?.apiKey, runtime?.config]) {
    if (!target) continue;
    const resolved = path.resolve(target);
    if (!isSameOrInside(path, hermesDir, resolved)) continue;
    if (removePath(fsImpl, resolved)) removed.push(resolved);
  }
  return removed;
}

function applyPrelaunchLocalDataReset(options = {}) {
  const {
    app,
    runtimePaths,
    env = process.env,
    fsImpl = fs,
    pathImpl = path,
    spawnSyncImpl = spawnSync,
    platform = process.platform,
    getuid = () => (typeof process.getuid === "function" ? process.getuid() : null),
    epoch = MIA_LOCAL_DATA_RESET_EPOCH
  } = options;
  const resetEpoch = normalizeEpoch(epoch);
  if (!resetEpoch) return { applied: false, reason: "missing_epoch" };
  if (String(env[DISABLE_RESET_ENV] || "") === "1") return { applied: false, reason: "disabled" };
  if (!app || typeof app.getPath !== "function" || typeof runtimePaths !== "function") {
    return { applied: false, reason: "missing_dependencies" };
  }

  const userDataDir = pathImpl.resolve(app.getPath("userData"));
  if (isUnsafeResetRoot(pathImpl, userDataDir)) return { applied: false, reason: "unsafe_user_data" };
  const markerPath = pathImpl.join(userDataDir, RESET_MARKER_FILE);
  const marker = safeJsonRead(fsImpl, markerPath);
  if (marker && marker.epoch === resetEpoch) {
    return { applied: false, reason: "already_applied", markerPath };
  }

  const runtime = runtimePaths();
  const removed = [];
  const errors = [];
  const record = (fn) => {
    try {
      const result = fn();
      if (Array.isArray(result)) removed.push(...result);
      else if (typeof result === "string") removed.push(result);
    } catch (error) {
      errors.push(error?.message || String(error));
    }
  };

  for (const plistPath of [runtime.launchAgent, runtime.daemonLaunchAgent]) {
    record(() => {
      stopLaunchAgent({ fsImpl, spawnSyncImpl, platform, getuid, plistPath });
      return removePath(fsImpl, plistPath) ? plistPath : "";
    });
  }

  record(() => removeExternalHermesFiles({ fsImpl, runtime }));

  const runtimeDir = pathImpl.resolve(runtime.runtime || "");
  if (runtimeDir && !isSameOrInside(pathImpl, userDataDir, runtimeDir) && env[ALLOW_EXTERNAL_HOME_ENV] === "1") {
    record(() => (removePath(fsImpl, runtimeDir) ? runtimeDir : ""));
  }

  record(() => removeUserDataChildren({ fsImpl, pathImpl, userDataDir, markerPath }));

  fsImpl.mkdirSync(userDataDir, { recursive: true });
  fsImpl.writeFileSync(markerPath, JSON.stringify({
    epoch: resetEpoch,
    appliedAt: new Date().toISOString(),
    appVersion: typeof app.getVersion === "function" ? app.getVersion() : "",
    removedCount: removed.filter(Boolean).length,
    errors
  }, null, 2));

  return {
    applied: true,
    epoch: resetEpoch,
    markerPath,
    removed: removed.filter(Boolean),
    errors
  };
}

module.exports = {
  applyPrelaunchLocalDataReset,
  MIA_LOCAL_DATA_RESET_EPOCH,
  RESET_MARKER_FILE,
  DISABLE_RESET_ENV
};
