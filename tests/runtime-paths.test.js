const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

const { createRuntimePaths } = require("../src/main/runtime-paths.js");
const runtimeResources = require("../src/runtime-resource-paths.js");

const defaultProfile = path.join(path.sep, "profile", "Mia");

function fakeApp(paths = {}) {
  return {
    getPath(name) {
      if (name === "userData") return paths.userData || defaultProfile;
      if (name === "home") return paths.home || "/Users/alice";
      return "";
    },
    getAppPath() {
      return paths.appPath || "/Applications/Mia.app/Contents/Resources/app.asar";
    }
  };
}

function fakeResources() {
  return {
    bundledHermesRuntimeDir: () => "",
    bundledPython: () => "",
    bundledSitePackages: () => ""
  };
}

test("runtime paths default to the Electron userData profile", () => {
  const { runtimePaths } = createRuntimePaths({
    app: fakeApp({ userData: "/profile/Mia" }),
    runtimeResources: fakeResources(),
    MIA_GATEWAY_SERVICE_LABEL: "ai.mia.gateway",
    MIA_CORE_SERVICE_LABEL: "ai.mia.daemon",
    env: {}
  });

  const paths = runtimePaths();
  const expectedRoot = defaultProfile;

  assert.equal(paths.root, expectedRoot);
  assert.equal(paths.runtime, path.join(expectedRoot, "runtime"));
  assert.equal(paths.home, path.join(expectedRoot, "runtime", "engine-home"));
  assert.equal(paths.hermesHome, path.join("/Users/alice", ".hermes"));
  assert.equal(paths.config, path.join("/Users/alice", ".hermes", "config.yaml"));
  assert.equal(paths.mcpServers, path.join(expectedRoot, "runtime", "engine-home", "mia-mcp-servers.json"));
  assert.equal(paths.coreSettings, path.join(expectedRoot, "runtime", "engine-home", "mia-core.json"));
  assert.equal(paths.engineBackups, path.join(paths.home, "engine-backups"));
  assert.equal(paths.managedResources, path.join(paths.home, "managed-resources"));
  assert.equal(paths.daemonSettings, paths.coreSettings);
  assert.equal(Object.hasOwn(paths, "memorySettings"), false);
  assert.equal(Object.hasOwn(paths, "providerConnections"), false);
  assert.equal(paths.coreLaunchAgent, path.join("/Users/alice", "Library", "LaunchAgents", "ai.mia.daemon.plist"));
  assert.equal(paths.daemonLaunchAgent, paths.coreLaunchAgent);
});

test("Hermes stable runtime resolves to the Mia-private backup directory, not app resources", () => {
  const home = path.join(path.sep, "profile", "Mia", "runtime", "engine-home");
  const root = runtimeResources.bundledHermesRuntimeDir({ home, platform: "win32", arch: "x64" });

  assert.equal(root, path.join(home, "engine-backups", "hermes", "win32-x64"));
  assert.equal(runtimeResources.bundledPython(root, { platform: "win32" }), path.join(root, "python", "python.exe"));
  assert.equal(runtimeResources.bundledSitePackages(root), path.join(root, "site-packages"));
});

test("runtime paths use MIA_HOME for shared data even when Electron userData is isolated", () => {
  const { runtimePaths } = createRuntimePaths({
    app: fakeApp({ userData: "/profile/Mia/daemon-profile" }),
    runtimeResources: fakeResources(),
    MIA_GATEWAY_SERVICE_LABEL: "ai.mia.gateway",
    MIA_CORE_SERVICE_LABEL: "ai.mia.daemon",
    env: { MIA_HOME: "/profile/Mia/runtime/engine-home" }
  });

  const paths = runtimePaths();
  const expectedRoot = path.resolve("/profile/Mia");
  const expectedHome = path.resolve("/profile/Mia/runtime/engine-home");

  assert.equal(paths.root, expectedRoot);
  assert.equal(paths.runtime, path.join(expectedRoot, "runtime"));
  assert.equal(paths.home, expectedHome);
  assert.equal(paths.hermesHome, path.join("/Users/alice", ".hermes"));
  assert.equal(paths.config, path.join("/Users/alice", ".hermes", "config.yaml"));
  assert.equal(Object.hasOwn(paths, "modelSettings"), false);
});
