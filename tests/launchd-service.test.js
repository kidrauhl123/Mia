const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createLaunchdService } = require("../src/main/launchd-service.js");

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimashi-launchd-service-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const runtime = {
    home: path.join(dir, "home & data"),
    engine: path.join(dir, "engine <runtime>"),
    logsDir: path.join(dir, "logs"),
    launchAgent: path.join(dir, "LaunchAgents", "ai.aimashi.hermes.gateway.plist"),
    daemonLaunchAgent: path.join(dir, "LaunchAgents", "ai.aimashi.daemon.plist")
  };
  const service = createLaunchdService({
    gatewayServiceLabel: "ai.aimashi.hermes.gateway",
    daemonServiceLabel: "ai.aimashi.daemon",
    runtimePaths: () => runtime,
    appPath: () => path.join(dir, "Aimashi <Dev>.app"),
    execPath: () => "/Applications/Aimashi.app/Contents/MacOS/Aimashi",
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
    spawnSync: (command, args) => {
      calls.push([command, ...args]);
      return { status: 0, stdout: "", stderr: "" };
    },
    appendLog: (line) => calls.push(["log", line]),
    ...overrides
  });
  return { calls, runtime, service };
}

test("gateway launch agent plist escapes values and uses Hermes gateway arguments", (t) => {
  const { runtime, service } = setup(t);

  const plist = service.gatewayLaunchAgentPlist();

  assert.match(plist, /<string>ai\.aimashi\.hermes\.gateway<\/string>/);
  assert.match(plist, /<string>gateway<\/string>/);
  assert.match(plist, /<string>run<\/string>/);
  assert.match(plist, /<string>--replace<\/string>/);
  assert.match(plist, /<string>--accept-hooks<\/string>/);
  assert.match(plist, /<key>HERMES_HOME<\/key>\n      <string>.*hermes &amp; home<\/string>/);
  assert.match(plist, /<key>AIMASHI_HOME<\/key>\n      <string>.*home &amp; data<\/string>/);
  assert.match(plist, /<string>.*engine &lt;runtime&gt;<\/string>/);
  assert.match(plist, new RegExp(`<string>${runtime.logsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/gateway\\.log</string>`));
});

test("startGateway writes plist, bootouts old jobs, then bootstrap and kickstart", (t) => {
  const { calls, runtime, service } = setup(t);

  service.startGateway();

  assert.ok(fs.existsSync(runtime.launchAgent));
  assert.deepEqual(calls, [
    ["launchctl", "bootout", "gui/501", runtime.launchAgent],
    ["launchctl", "bootout", "gui/501/ai.aimashi.hermes.gateway"],
    ["launchctl", "bootstrap", "gui/501", runtime.launchAgent],
    ["launchctl", "kickstart", "-k", "gui/501/ai.aimashi.hermes.gateway"]
  ]);
});

test("daemon launch agent uses the app executable and daemon environment", (t) => {
  const { runtime, service } = setup(t, { defaultApp: () => true });

  const args = service.daemonProgramArguments();
  const plist = service.daemonLaunchAgentPlist();

  assert.deepEqual(args, ["/Applications/Aimashi.app/Contents/MacOS/Aimashi", service.appPath(), "--daemon"]);
  assert.match(plist, /<string>ai\.aimashi\.daemon<\/string>/);
  assert.match(plist, /<key>AIMASHI_DAEMON<\/key>\n      <string>1<\/string>/);
  assert.match(plist, /<key>PATH<\/key>\n      <string>\/usr\/local\/bin:\/usr\/bin<\/string>/);
  assert.match(plist, new RegExp(`<string>${runtime.logsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/daemon\\.error\\.log</string>`));
});

test("launchd start fails clearly on non-macOS platforms", (t) => {
  const { service } = setup(t, { platform: "linux" });

  assert.throws(() => service.startGateway(), /macOS launchd/);
  assert.throws(() => service.startDaemon(), /macOS launchd/);
  assert.doesNotThrow(() => service.stopGateway());
  assert.doesNotThrow(() => service.stopDaemon());
});
