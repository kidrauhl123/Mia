const fs = require("node:fs");
const path = require("node:path");

function createSystemHermesService(deps = {}) {
  const runtimePaths = deps.runtimePaths;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");

  const fsImpl = deps.fs || fs;
  const readJson = deps.readJson || ((filePath, fallback) => {
    try {
      return JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
    } catch {
      return fallback;
    }
  });
  const now = typeof deps.now === "function" ? deps.now : () => new Date();
  const resetAgentEngineCache = typeof deps.resetAgentEngineCache === "function"
    ? deps.resetAgentEngineCache
    : () => {};

  function cachePath() {
    return path.join(runtimePaths().home, "aimashi-system-hermes.json");
  }

  function loadCache() {
    const cached = readJson(cachePath(), null);
    if (!cached || typeof cached !== "object") {
      return { available: false, pending: true, disabled: true };
    }
    return cached;
  }

  function persistCache(value) {
    const filePath = cachePath();
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    fsImpl.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    if (typeof fsImpl.chmodSync === "function") fsImpl.chmodSync(filePath, 0o600);
  }

  async function refresh() {
    persistCache({
      available: false,
      checkedAt: now().toISOString(),
      disabled: true
    });
    resetAgentEngineCache();
  }

  function userHomePath() {
    return "";
  }

  function loadDotenv() {
    return {};
  }

  return {
    cachePath,
    loadCache,
    loadDotenv,
    persistCache,
    refresh,
    userHomePath
  };
}

module.exports = {
  createSystemHermesService
};
