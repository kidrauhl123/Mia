const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

function createEngineRuntimeConfigService(deps = {}) {
  const runtimePaths = deps.runtimePaths;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");

  const fsImpl = deps.fs || fs;
  const permissionSettings = deps.permissionSettings || (() => ({ mode: "ask" }));
  const effortSettings = deps.effortSettings || (() => ({ level: "medium" }));
  const prepareRuntimeConfigRequest = deps.prepareRuntimeConfigRequest || (async () => {
    throw new Error("prepareRuntimeConfigRequest dependency is required.");
  });
  const getUserMcpSpecs = typeof deps.getUserMcpSpecs === "function"
    ? deps.getUserMcpSpecs
    : () => ({});
  let cachedApiServerKey = "";

  function effectiveHermesHome() {
    const p = runtimePaths();
    return p.hermesHome || p.home;
  }

  function apiServerKey() {
    if (cachedApiServerKey) return cachedApiServerKey;
    const p = runtimePaths();
    try {
      cachedApiServerKey = fsImpl.readFileSync(p.apiServerKey, "utf8").trim();
      return cachedApiServerKey;
    } catch {
      return "";
    }
  }

  async function prepareRuntimeConfig(port) {
    const p = runtimePaths();
    const response = await prepareRuntimeConfigRequest({
      method: "POST",
      route: "/api/engines/hermes/runtime-config",
      body: {
        port,
        paths: {
          home: p.home,
          hermesHome: effectiveHermesHome(),
          config: p.config || path.join(effectiveHermesHome(), "config.yaml"),
          apiServerKey: p.apiServerKey,
          botManifest: p.botManifest
        },
        permissionSettings: permissionSettings(),
        effortSettings: effortSettings(),
        userMcpSpecs: getUserMcpSpecs() || {}
      }
    });
    cachedApiServerKey = String(response?.apiServerKey || cachedApiServerKey || "").trim();
    return response || {};
  }

  function readConfiguredPort() {
    const configPath = path.join(effectiveHermesHome(), "config.yaml");
    if (!fsImpl.existsSync(configPath)) return 18642;
    try {
      const parsed = yaml.load(fsImpl.readFileSync(configPath, "utf8"));
      const port = Number(parsed?.platforms?.api_server?.port);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      // Fall back to the default Hermes API port.
    }
    return 18642;
  }

  return {
    apiServerKey,
    effectiveHermesHome,
    prepareRuntimeConfig,
    readConfiguredPort
  };
}

module.exports = {
  createEngineRuntimeConfigService
};
