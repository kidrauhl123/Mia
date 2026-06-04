const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

const { createRuntimePaths } = require("../src/main/runtime-paths.js");

function fakeApp(paths = {}) {
  return {
    getPath(name) {
      if (name === "userData") return paths.userData || "/profile/Mia";
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

  assert.equal(paths.root, "/profile/Mia");
  assert.equal(paths.runtime, "/profile/Mia/runtime");
  assert.equal(paths.home, "/profile/Mia/runtime/engine-home");
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

  assert.equal(paths.root, "/profile/Mia");
  assert.equal(paths.runtime, "/profile/Mia/runtime");
  assert.equal(paths.home, "/profile/Mia/runtime/engine-home");
  assert.equal(paths.config, path.join("/profile/Mia/runtime/engine-home", "config.yaml"));
});
