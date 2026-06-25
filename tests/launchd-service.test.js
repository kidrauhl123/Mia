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

test("daemon launch agent uses the app executable and daemon environment", (t) => {
  const { runtime, service } = setup(t, { defaultApp: () => true });

  const args = service.daemonProgramArguments();
  const daemonEnv = service.daemonEnvironment();
  const plist = service.daemonLaunchAgentPlist();

  assert.deepEqual(args, ["/Applications/Mia.app/Contents/MacOS/Mia", service.appPath(), "--daemon"]);
  assert.equal(daemonEnv.MIA_HOME, runtime.home);
  assert.equal(daemonEnv.MIA_USER_DATA_DIR, path.join(path.dirname(path.dirname(runtime.home)), "daemon-profile"));
  assert.match(plist, /<string>ai\.mia\.daemon<\/string>/);
  assert.match(plist, /<key>MIA_DAEMON<\/key>\n      <string>1<\/string>/);
  assert.match(plist, /<key>MIA_USER_DATA_DIR<\/key>/);
  assert.match(plist, /<key>PATH<\/key>\n      <string>\/usr\/local\/bin:\/usr\/bin<\/string>/);
  assert.match(plist, new RegExp(`<string>${escapeRe(path.join(runtime.logsDir, "daemon.error.log"))}</string>`));
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

test("launchd start fails clearly on non-macOS platforms", async (t) => {
  const { service } = setup(t, { platform: "linux" });

  await assert.rejects(() => service.startDaemon(), /macOS launchd/);
  await service.stopGateway();
  await service.stopDaemon();
});
