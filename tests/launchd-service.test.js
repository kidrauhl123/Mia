const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createLaunchdService } = require("../src/main/launchd-service.js");

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-launchd-service-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const runtime = {
    home: path.join(dir, "home & data"),
    engine: path.join(dir, "engine <runtime>"),
    logsDir: path.join(dir, "logs"),
    launchAgent: path.join(dir, "LaunchAgents", "ai.mia.hermes.gateway.plist"),
    daemonLaunchAgent: path.join(dir, "LaunchAgents", "ai.mia.daemon.plist")
  };
  const service = createLaunchdService({
    gatewayServiceLabel: "ai.mia.hermes.gateway",
    daemonServiceLabel: "ai.mia.daemon",
    runtimePaths: () => runtime,
    appPath: () => path.join(dir, "Mia <Dev>.app"),
    execPath: () => "/Applications/Mia.app/Contents/MacOS/Mia",
    defaultApp: () => false,
    enginePython: () => path.join(dir, "venv", "bin", "python3"),
    effectiveHermesHome: () => path.join(dir, "hermes & home"),
    buildPythonPath: () => `${path.join(dir, "plugins")}:${path.join(dir, "site")}`,
    env: {
      HERMES_LANGUAGE: "zh",
      PATH: "/usr/local/bin:/usr/bin"
    },
    platform: "darwin",
    getuid: () => 501,
    execFile: (command, args, _options, callback) => {
      calls.push([command, ...args]);
      callback(null, "", "");
    },
    appendLog: (line) => calls.push(["log", line]),
    ...overrides
  });
  return { calls, runtime, service };
}

test("Hermes gateway launchd service can only be cleaned up, not started", async (t) => {
  const { calls, runtime, service } = setup(t);

  assert.equal(typeof service.startGateway, "undefined");
  assert.equal(typeof service.gatewayLaunchAgentPlist, "undefined");
  assert.equal(typeof service.writeGatewayLaunchAgentPlist, "undefined");
  assert.deepEqual(service.gatewayProgramArguments(), [
    path.join(path.dirname(runtime.home), "venv", "bin", "python3"),
    "-m",
    "mia_plugins",
    "gateway",
    "run",
    "--replace",
    "--accept-hooks"
  ]);

  await service.stopGateway();

  assert.deepEqual(calls, [
    ["launchctl", "bootout", "gui/501", runtime.launchAgent],
    ["launchctl", "bootout", "gui/501/ai.mia.hermes.gateway"]
  ]);
});

test("startDaemon re-enables a disabled LaunchAgent before bootstrapping", async (t) => {
  const { calls, runtime, service } = setup(t);

  await service.startDaemon();

  assert.ok(fs.existsSync(runtime.daemonLaunchAgent));
  assert.deepEqual(calls, [
    ["launchctl", "bootout", "gui/501", runtime.daemonLaunchAgent],
    ["launchctl", "bootout", "gui/501/ai.mia.daemon"],
    ["launchctl", "enable", "gui/501/ai.mia.daemon"],
    ["launchctl", "bootstrap", "gui/501", runtime.daemonLaunchAgent],
    ["launchctl", "kickstart", "-k", "gui/501/ai.mia.daemon"]
  ]);
});

test("daemon launch agent carries the daemon environment and labels", (t) => {
  // Real (uninjected) resolver in dev: a real `node` is on PATH so node-core
  // resolves; this asserts the daemon env/label contract regardless of target.
  const { runtime, service } = setup(t, { defaultApp: () => true });

  const daemonEnv = service.daemonEnvironment();
  const plist = service.daemonLaunchAgentPlist();

  assert.equal(daemonEnv.MIA_HOME, runtime.home);
  assert.equal(daemonEnv.MIA_USER_DATA_DIR, path.join(path.dirname(path.dirname(runtime.home)), "daemon-profile"));
  assert.match(plist, /<string>ai\.mia\.daemon<\/string>/);
  assert.match(plist, /<key>MIA_DAEMON<\/key>\n      <string>1<\/string>/);
  assert.match(plist, /<key>MIA_USER_DATA_DIR<\/key>/);
  assert.match(plist, /<key>PATH<\/key>/);
  assert.ok(daemonEnv.PATH.split(":").includes("/usr/local/bin"));
  assert.ok(daemonEnv.PATH.split(":").includes("/opt/homebrew/bin"));
  assert.match(plist, new RegExp(`<string>${escapeRe(path.join(runtime.logsDir, "daemon.error.log"))}</string>`));
});

test("daemon launch agent expands GUI app PATH with common CLI directories", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-launchd-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const { service } = setup(t, {
    env: {
      HOME: home,
      HERMES_LANGUAGE: "zh",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin"
    }
  });

  const pathEntries = service.daemonEnvironment().PATH.split(":");

  assert.equal(pathEntries[0], path.join(home, ".local", "bin"));
  assert.ok(pathEntries.includes("/opt/homebrew/bin"));
  assert.ok(pathEntries.includes("/usr/local/bin"));
  assert.ok(pathEntries.includes("/usr/bin"));
  assert.equal(pathEntries.filter((entry) => entry === "/usr/bin").length, 1);
});

test("packaged resolver makes the launchd plist point ProgramArguments at mia-node, never Mia --daemon", (t) => {
  // End-to-end with the REAL resolver wired exactly like packaged main.js:
  // process.defaultApp false → no injected node/coreEntry → derive bundled
  // mia-node + unpacked Core entry from resourcesPath. The launchd plist must
  // launch <resources>/mia-node, NOT `Mia.app/Contents/MacOS/Mia --daemon`.
  const { createMiaCoreResolver } = require("../src/main/daemon/executable-resolver.js");
  const res = "/Applications/Mia.app/Contents/Resources";
  const packagedResolver = createMiaCoreResolver({
    runtimePaths: () => ({ root: "/r", home: "/r/runtime/engine-home" }),
    effectiveHermesHome: () => "/r/.hermes",
    execPath: () => "/Applications/Mia.app/Contents/MacOS/Mia",
    defaultApp: () => false,
    platform: "darwin",
    env: {},
    nodePath: () => "",
    coreEntry: () => "",
    resourcesPath: () => res,
    // The derived packaged paths don't exist on the test machine; this test
    // asserts the derivation/plist shape, so trust existence.
    existsSync: () => true
  });
  const { service } = setup(t, { resolver: packagedResolver, defaultApp: () => false });

  const args = service.daemonProgramArguments();
  assert.equal(args[0], path.join(res, "mia-node"));
  assert.equal(args[1], path.join(res, "app.asar.unpacked", "src", "core", "mia-core.js"));
  assert.equal(args[2], "--daemon");

  const plist = service.daemonLaunchAgentPlist();
  assert.match(plist, new RegExp(`<string>${escapeRe(path.join(res, "mia-node"))}</string>`));
  assert.doesNotMatch(plist, /Mia\.app\/Contents\/MacOS\/Mia<\/string>/);
  assert.match(plist, /<key>MIA_DAEMON_TARGET_KIND<\/key>\n      <string>node-core<\/string>/);
  assert.match(plist, /<key>MIA_DAEMON_USES_GUI_IDENTITY<\/key>\n      <string>0<\/string>/);
});

test("daemon launch agent WorkingDirectory is a real directory, never the asar archive", (t) => {
  // Packaged apps resolve getAppPath() to the asar archive — a file, not a dir.
  // launchd chdir()s into WorkingDirectory before exec; a file path makes the
  // job die with EX_CONFIG (exit 78), so the daemon must never point there.
  const { service } = setup(t, {
    appPath: () => "/Applications/Mia.app/Contents/Resources/app.asar",
    execPath: () => "/Applications/Mia.app/Contents/MacOS/Mia",
    defaultApp: () => false
  });

  const plist = service.daemonLaunchAgentPlist();
  const workdir = plist.match(/<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/)[1];

  assert.doesNotMatch(workdir, /\.asar/);
  assert.equal(workdir, "/Applications/Mia.app/Contents/MacOS");
});

test("node-core resolver makes the daemon plist launch node + Core entry, never the GUI app", (t) => {
  const fakeResolver = {
    resolve: () => ({
      kind: "node-core",
      command: "/usr/local/bin/node",
      args: ["/repo/src/core/mia-core.js", "--daemon"],
      workingDirectory: "/repo/src/core",
      usesGuiAppIdentity: false
    }),
    daemonEnvOverlay: () => ({ MIA_DAEMON: "1", MIA_HOME: "/home", MIA_DAEMON_TARGET_KIND: "node-core" })
  };
  const { service } = setup(t, { resolver: fakeResolver });

  assert.deepEqual(service.daemonProgramArguments(), [
    "/usr/local/bin/node",
    "/repo/src/core/mia-core.js",
    "--daemon"
  ]);
  const plist = service.daemonLaunchAgentPlist();
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(plist, /<string>\/repo\/src\/core\/mia-core\.js<\/string>/);
  assert.doesNotMatch(plist, /Mia\.app\/Contents\/MacOS\/Mia/);
  assert.match(plist, /<key>MIA_DAEMON_TARGET_KIND<\/key>\n      <string>node-core<\/string>/);
});

test("launchd start fails clearly on non-macOS platforms", async (t) => {
  const { service } = setup(t, { platform: "linux" });

  await assert.rejects(() => service.startDaemon(), /macOS launchd/);
  await service.stopGateway();
  await service.stopDaemon();
});

test("daemon launch agent delegates command, workdir and env to an injected resolver", (t) => {
  const fakeResolver = {
    resolve: () => ({
      command: "/Applications/Mia.app/Contents/Resources/Mia Core.app/Contents/MacOS/Mia Core",
      args: ["--daemon"],
      workingDirectory: "/Applications/Mia.app/Contents/Resources/Mia Core.app/Contents/MacOS"
    }),
    daemonEnvOverlay: () => ({ MIA_DAEMON: "1", MIA_HOME: "/home", HERMES_LANGUAGE: "en" })
  };
  const { service } = setup(t, { resolver: fakeResolver });

  assert.deepEqual(service.daemonProgramArguments(), [
    "/Applications/Mia.app/Contents/Resources/Mia Core.app/Contents/MacOS/Mia Core",
    "--daemon"
  ]);
  const plist = service.daemonLaunchAgentPlist();
  assert.match(plist, /Mia Core\.app\/Contents\/MacOS\/Mia Core/);
  const daemonEnv = service.daemonEnvironment();
  assert.equal(daemonEnv.MIA_DAEMON, "1");
  assert.ok(daemonEnv.PATH.split(":").includes("/usr/local/bin")); // from setup env, preserved
  assert.ok(daemonEnv.PATH.split(":").includes("/opt/homebrew/bin"));
});
