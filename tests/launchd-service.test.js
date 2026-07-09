const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createLaunchdService } = require("../src/main/launchd-service.js");

const LEGACY_DAEMON_ENV = `MIA_${"DAEMON"}`;
const LEGACY_DAEMON_TARGET_KIND_ENV = `${LEGACY_DAEMON_ENV}_TARGET_KIND`;
const LEGACY_DAEMON_USES_GUI_IDENTITY_ENV = `${LEGACY_DAEMON_ENV}_USES_GUI_IDENTITY`;

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
    coreServiceLabel: "ai.mia.daemon",
    runtimePaths: () => runtime,
    appPath: () => path.join(dir, "Mia <Dev>.app"),
    execPath: () => "/Applications/Mia.app/Contents/MacOS/Mia",
    defaultApp: () => false,
    enginePython: () => path.join(dir, "venv", "bin", "python3"),
    effectiveHermesHome: () => path.join(dir, "hermes & home"),
    appVersion: () => "0.1.39",
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

test("startCore re-enables a disabled LaunchAgent before bootstrapping", async (t) => {
  const { calls, runtime, service } = setup(t);

  await service.startCore();

  assert.ok(fs.existsSync(runtime.daemonLaunchAgent));
  assert.deepEqual(calls, [
    ["launchctl", "bootout", "gui/501", runtime.daemonLaunchAgent],
    ["launchctl", "bootout", "gui/501/ai.mia.daemon"],
    ["launchctl", "enable", "gui/501/ai.mia.daemon"],
    ["launchctl", "bootstrap", "gui/501", runtime.daemonLaunchAgent],
    ["launchctl", "kickstart", "-k", "gui/501/ai.mia.daemon"]
  ]);
});

test("daemon launch agent carries the Core environment and labels", (t) => {
  const { runtime, service } = setup(t, { defaultApp: () => true });

  const daemonEnv = service.coreEnvironment();
  const plist = service.coreLaunchAgentPlist();

  assert.equal(daemonEnv.MIA_CORE, "1");
  assert.equal(daemonEnv.MIA_CORE_HOST, "127.0.0.1");
  assert.equal(daemonEnv.MIA_CORE_PORT, "27861");
  assert.equal(daemonEnv.MIA_CORE_HOME, runtime.home);
  assert.equal(daemonEnv.MIA_CORE_APP_VERSION, "0.1.39");
  assert.equal(daemonEnv.MIA_CORE_TARGET_KIND, "rust-core");
  assert.equal(daemonEnv.MIA_HOME, runtime.home);
  assert.equal(daemonEnv[LEGACY_DAEMON_ENV], undefined);
  assert.equal(daemonEnv.MIA_USER_DATA_DIR, undefined);
  assert.match(plist, /<string>ai\.mia\.daemon<\/string>/);
  assert.match(plist, /<key>MIA_CORE<\/key>\n      <string>1<\/string>/);
  assert.match(plist, /<key>MIA_CORE_APP_VERSION<\/key>\n      <string>0\.1\.39<\/string>/);
  assert.doesNotMatch(plist, new RegExp(`<key>${LEGACY_DAEMON_ENV}</key>`));
  assert.doesNotMatch(plist, /<key>MIA_USER_DATA_DIR<\/key>/);
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

  const pathEntries = service.coreEnvironment().PATH.split(":");

  assert.equal(pathEntries[0], path.join(home, ".local", "bin"));
  assert.ok(pathEntries.includes("/opt/homebrew/bin"));
  assert.ok(pathEntries.includes("/usr/local/bin"));
  assert.ok(pathEntries.includes("/usr/bin"));
  assert.equal(pathEntries.filter((entry) => entry === "/usr/bin").length, 1);
});

test("launchd default resolver uses configured Core host and port", (t) => {
  const { service } = setup(t, {
    defaultApp: () => true,
    coreSettings: () => ({ host: "localhost", port: 27993 })
  });

  const args = service.coreProgramArguments();
  const env = service.coreEnvironment();
  const plist = service.coreLaunchAgentPlist();

  assert.deepEqual(args.slice(5, 10), ["serve", "--host", "localhost", "--port", "27993"]);
  assert.equal(args.includes("--parent-pid"), false);
  assert.equal(env.MIA_CORE_HOST, "localhost");
  assert.equal(env.MIA_CORE_PORT, "27993");
  assert.match(plist, /<string>localhost<\/string>/);
  assert.match(plist, /<string>27993<\/string>/);
});

test("packaged resolver makes the launchd plist point ProgramArguments at bundled Rust Core", (t) => {
  const {
    createMiaCoreResolver,
    packagedRustCorePath
  } = require("../src/main/mia-core/process-resolver.js");
  const res = "/Applications/Mia.app/Contents/Resources";
  const bundled = packagedRustCorePath(res, "darwin", "arm64");
  const packagedResolver = createMiaCoreResolver({
    runtimePaths: () => ({ root: "/r", home: "/r/runtime/engine-home" }),
    effectiveHermesHome: () => "/r/.hermes",
    execPath: () => "/Applications/Mia.app/Contents/MacOS/Mia",
    defaultApp: () => false,
    platform: "darwin",
    arch: "arm64",
    env: {},
    resourcesPath: () => res,
    existsSync: (candidate) => candidate === bundled
  });
  const { service } = setup(t, { resolver: packagedResolver, defaultApp: () => false });

  const args = service.coreProgramArguments();
  assert.equal(args[0], bundled);
  assert.deepEqual(args.slice(1, 6), ["serve", "--host", "127.0.0.1", "--port", "27861"]);

  const plist = service.coreLaunchAgentPlist();
  assert.match(plist, new RegExp(`<string>${escapeRe(bundled)}</string>`));
  assert.doesNotMatch(plist, /Mia\.app\/Contents\/MacOS\/Mia<\/string>/);
  assert.match(plist, /<key>MIA_CORE_TARGET_KIND<\/key>\n      <string>rust-core<\/string>/);
  assert.doesNotMatch(plist, new RegExp(`<key>${LEGACY_DAEMON_TARGET_KIND_ENV}</key>`));
  assert.doesNotMatch(plist, new RegExp(`<key>${LEGACY_DAEMON_USES_GUI_IDENTITY_ENV}</key>`));
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

  const plist = service.coreLaunchAgentPlist();
  const workdir = plist.match(/<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/)[1];

  assert.doesNotMatch(workdir, /\.asar/);
  assert.equal(workdir, "/Applications/Mia.app/Contents/MacOS");
});

test("rust-core resolver makes the daemon plist launch Core binary, never the GUI app", (t) => {
  const fakeResolver = {
    resolve: () => ({
      kind: "rust-core",
      command: "/repo/target/debug/mia-core",
      args: ["serve", "--host", "127.0.0.1", "--port", "27861"],
      workingDirectory: "/repo",
      usesGuiAppIdentity: false
    }),
    coreEnvOverlay: () => ({ MIA_CORE: "1", MIA_HOME: "/home", MIA_CORE_TARGET_KIND: "rust-core" })
  };
  const { service } = setup(t, { resolver: fakeResolver });

  assert.deepEqual(service.coreProgramArguments(), [
    "/repo/target/debug/mia-core",
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    "27861"
  ]);
  const plist = service.coreLaunchAgentPlist();
  assert.match(plist, /<string>\/repo\/target\/debug\/mia-core<\/string>/);
  assert.doesNotMatch(plist, /Mia\.app\/Contents\/MacOS\/Mia/);
  assert.match(plist, /<key>MIA_CORE_TARGET_KIND<\/key>\n      <string>rust-core<\/string>/);
  assert.doesNotMatch(plist, new RegExp(`<key>${LEGACY_DAEMON_TARGET_KIND_ENV}</key>`));
});

test("cleanupLegacyNodeCore unloads legacy Node daemon launchd job and kills stale node-core processes", async (t) => {
  const { calls, runtime, service } = setup(t, {
    execFile: (command, args, _options, callback) => {
      calls.push([command, ...args]);
      if (command === "ps") {
        callback(null, [
          " 123 /opt/homebrew/bin/node /Users/jung/GitHub/Mia/src/core/mia-core.js --daemon",
          " 456 /repo/target/debug/mia-core serve --host 127.0.0.1 --port 27861",
          " 789 /Applications/Mia.app/Contents/MacOS/Mia"
        ].join("\n"), "");
        return;
      }
      callback(null, "", "");
    }
  });
  fs.mkdirSync(path.dirname(runtime.daemonLaunchAgent), { recursive: true });
  fs.writeFileSync(runtime.daemonLaunchAgent, [
    "<plist><dict>",
    "<key>Label</key><string>ai.mia.daemon</string>",
    `<key>${LEGACY_DAEMON_ENV}</key><string>1</string>`,
    "<key>ProgramArguments</key><array>",
    "<string>/opt/homebrew/bin/node</string>",
    "<string>/Users/jung/GitHub/Mia/src/core/mia-core.js</string>",
    "<string>--daemon</string>",
    "</array>",
    "</dict></plist>"
  ].join("\n"));

  const result = await service.cleanupLegacyNodeCore();

  assert.equal(result.removedLaunchAgent, true);
  assert.deepEqual(result.killedPids, [123]);
  assert.equal(fs.existsSync(runtime.daemonLaunchAgent), false);
  assert.deepEqual(calls.filter((call) => call[0] !== "log"), [
    ["launchctl", "bootout", "gui/501", runtime.daemonLaunchAgent],
    ["launchctl", "bootout", "gui/501/ai.mia.daemon"],
    ["launchctl", "remove", "ai.mia.daemon"],
    ["ps", "-axo", "pid=,command="],
    ["kill", "-TERM", "123"]
  ]);
});

test("launchd start fails clearly on non-macOS platforms", async (t) => {
  const { service } = setup(t, { platform: "linux" });

  await assert.rejects(() => service.startCore(), /macOS launchd/);
  await service.stopGateway();
  await service.stopCore();
});

test("daemon launch agent delegates command, workdir and env to an injected resolver", (t) => {
  const fakeResolver = {
    resolve: () => ({
      command: "/Applications/Mia.app/Contents/Resources/Mia Core.app/Contents/MacOS/Mia Core",
      args: ["--daemon"],
      workingDirectory: "/Applications/Mia.app/Contents/Resources/Mia Core.app/Contents/MacOS"
    }),
    coreEnvOverlay: () => ({ MIA_CORE: "1", MIA_HOME: "/home", HERMES_LANGUAGE: "en" })
  };
  const { service } = setup(t, { resolver: fakeResolver });

  assert.deepEqual(service.coreProgramArguments(), [
    "/Applications/Mia.app/Contents/Resources/Mia Core.app/Contents/MacOS/Mia Core",
    "--daemon"
  ]);
  const plist = service.coreLaunchAgentPlist();
  assert.match(plist, /Mia Core\.app\/Contents\/MacOS\/Mia Core/);
  const daemonEnv = service.coreEnvironment();
  assert.equal(daemonEnv.MIA_CORE, "1");
  assert.equal(daemonEnv[LEGACY_DAEMON_ENV], undefined);
  assert.ok(daemonEnv.PATH.split(":").includes("/usr/local/bin")); // from setup env, preserved
  assert.ok(daemonEnv.PATH.split(":").includes("/opt/homebrew/bin"));
});
