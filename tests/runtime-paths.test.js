const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

const { createRuntimePaths } = require("../src/main/runtime-paths.js");

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
    MIA_DAEMON_SERVICE_LABEL: "ai.mia.daemon",
    env: {}
  });

  const paths = runtimePaths();
  const expectedRoot = defaultProfile;

  assert.equal(paths.root, expectedRoot);
  assert.equal(paths.runtime, path.join(expectedRoot, "runtime"));
  assert.equal(paths.home, path.join(expectedRoot, "runtime", "engine-home"));
  assert.equal(paths.mcpServers, path.join(expectedRoot, "runtime", "engine-home", "mia-mcp-servers.json"));
});

test("runtime paths use MIA_HOME for shared data even when Electron userData is isolated", () => {
  const { runtimePaths } = createRuntimePaths({
    app: fakeApp({ userData: "/profile/Mia/daemon-profile" }),
    runtimeResources: fakeResources(),
    MIA_GATEWAY_SERVICE_LABEL: "ai.mia.gateway",
    MIA_DAEMON_SERVICE_LABEL: "ai.mia.daemon",
    env: { MIA_HOME: "/profile/Mia/runtime/engine-home" }
  });

  const paths = runtimePaths();
  const expectedRoot = path.resolve("/profile/Mia");
  const expectedHome = path.resolve("/profile/Mia/runtime/engine-home");

  assert.equal(paths.root, expectedRoot);
  assert.equal(paths.runtime, path.join(expectedRoot, "runtime"));
  assert.equal(paths.home, expectedHome);
  assert.equal(paths.config, path.join(expectedHome, "config.yaml"));
});
