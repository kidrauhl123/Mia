const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  applyPrelaunchLocalDataReset,
  MIA_LOCAL_DATA_RESET_EPOCH,
  RESET_MARKER_FILE,
  DISABLE_RESET_ENV
} = require("../src/main/local-data-reset.js");
const { createRuntimePaths } = require("../src/main/runtime-paths.js");

function mkdirp(target) {
  fs.mkdirSync(target, { recursive: true });
}

function writeFile(target, value = "x") {
  mkdirp(path.dirname(target));
  fs.writeFileSync(target, value);
}

function makeHarness(options = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mia-local-reset-"));
  const home = path.join(tmp, "home");
  const userData = path.join(tmp, "Mia");
  const env = options.env || {};
  const app = {
    getPath(name) {
      if (name === "userData") return userData;
      if (name === "home") return home;
      return tmp;
    },
    getVersion() {
      return "0.1.test";
    }
  };
  const { runtimePaths } = createRuntimePaths({
    app,
    MIA_GATEWAY_SERVICE_LABEL: "ai.mia.hermes.gateway",
    MIA_DAEMON_SERVICE_LABEL: "ai.mia.daemon",
    env
  });
  return { tmp, home, userData, env, app, runtimePaths };
}

test("prelaunch local data reset clears old desktop state before settings load", () => {
  const harness = makeHarness();
  const runtime = harness.runtimePaths();
  const launchCalls = [];

  writeFile(runtime.cloudSettings, JSON.stringify({ enabled: true, token: "tok_old" }));
  writeFile(runtime.userProfile, JSON.stringify({ id: "u_old" }));
  writeFile(path.join(harness.userData, "Local Storage", "leveldb", "000003.log"));
  writeFile(path.join(harness.userData, "Session Storage", "000001.log"));
  writeFile(path.join(harness.userData, "SingletonLock"), "lock");
  writeFile(runtime.config, "model: old\n");
  writeFile(runtime.apiKey, "key");
  writeFile(runtime.launchAgent, "<plist/>");
  writeFile(runtime.daemonLaunchAgent, "<plist/>");

  const result = applyPrelaunchLocalDataReset({
    app: harness.app,
    runtimePaths: harness.runtimePaths,
    env: {},
    platform: "darwin",
    getuid: () => 501,
    spawnSyncImpl: (command, args) => {
      launchCalls.push({ command, args });
      return { status: 0 };
    }
  });

  assert.equal(result.applied, true);
  assert.equal(result.epoch, MIA_LOCAL_DATA_RESET_EPOCH);
  assert.equal(fs.existsSync(runtime.cloudSettings), false);
  assert.equal(fs.existsSync(runtime.userProfile), false);
  assert.equal(fs.existsSync(path.join(harness.userData, "Local Storage")), false);
  assert.equal(fs.existsSync(path.join(harness.userData, "Session Storage")), false);
  assert.equal(fs.existsSync(runtime.config), false);
  assert.equal(fs.existsSync(runtime.apiKey), false);
  assert.equal(fs.existsSync(runtime.launchAgent), false);
  assert.equal(fs.existsSync(runtime.daemonLaunchAgent), false);
  assert.equal(fs.existsSync(path.join(harness.userData, "SingletonLock")), true);
  assert.equal(launchCalls.length, 2);
  assert.ok(launchCalls.every((call) => call.command === "launchctl"));

  const marker = JSON.parse(fs.readFileSync(path.join(harness.userData, RESET_MARKER_FILE), "utf8"));
  assert.equal(marker.epoch, MIA_LOCAL_DATA_RESET_EPOCH);
  assert.equal(marker.appVersion, "0.1.test");
});

test("prelaunch local data reset is one-time per epoch", () => {
  const harness = makeHarness();
  const first = applyPrelaunchLocalDataReset({
    app: harness.app,
    runtimePaths: harness.runtimePaths,
    env: {}
  });
  assert.equal(first.applied, true);

  const cachePath = path.join(harness.userData, "Local Storage", "fresh.log");
  writeFile(cachePath);
  const second = applyPrelaunchLocalDataReset({
    app: harness.app,
    runtimePaths: harness.runtimePaths,
    env: {}
  });

  assert.equal(second.applied, false);
  assert.equal(second.reason, "already_applied");
  assert.equal(fs.existsSync(cachePath), true);
});

test("prelaunch local data reset can be disabled for development", () => {
  const harness = makeHarness();
  const cloudSettings = harness.runtimePaths().cloudSettings;
  writeFile(cloudSettings, JSON.stringify({ enabled: true, token: "tok_dev" }));

  const result = applyPrelaunchLocalDataReset({
    app: harness.app,
    runtimePaths: harness.runtimePaths,
    env: { [DISABLE_RESET_ENV]: "1" }
  });

  assert.equal(result.applied, false);
  assert.equal(result.reason, "disabled");
  assert.equal(fs.existsSync(cloudSettings), true);
});

test("external MIA_HOME is not removed unless explicitly allowed", () => {
  const externalHome = path.join(os.tmpdir(), `mia-external-home-${process.pid}-${Date.now()}`, "engine-home");
  const harness = makeHarness({ env: { MIA_HOME: externalHome } });
  const runtime = harness.runtimePaths();
  writeFile(path.join(runtime.home, "mia-cloud.json"), JSON.stringify({ enabled: true }));

  const result = applyPrelaunchLocalDataReset({
    app: harness.app,
    runtimePaths: harness.runtimePaths,
    env: {}
  });

  assert.equal(result.applied, true);
  assert.equal(fs.existsSync(path.join(runtime.home, "mia-cloud.json")), true);
  fs.rmSync(path.dirname(externalHome), { recursive: true, force: true });
});

test("prelaunch local data reset refuses an unsafe userData root", () => {
  const app = {
    getPath(name) {
      if (name === "userData") return path.parse(process.cwd()).root;
      if (name === "home") return os.homedir();
      return "";
    }
  };
  const { runtimePaths } = createRuntimePaths({
    app,
    MIA_GATEWAY_SERVICE_LABEL: "ai.mia.hermes.gateway",
    MIA_DAEMON_SERVICE_LABEL: "ai.mia.daemon",
    env: {}
  });

  const result = applyPrelaunchLocalDataReset({
    app,
    runtimePaths,
    env: {}
  });

  assert.equal(result.applied, false);
  assert.equal(result.reason, "unsafe_user_data");
});
