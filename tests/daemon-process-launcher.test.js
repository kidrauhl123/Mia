const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createDaemonProcessLauncher } = require("../src/main/daemon/process-launcher.js");

function setup(overrides = {}) {
  const dir = path.join(os.tmpdir(), "mia daemon launcher");
  const runtime = {
    root: dir,
    home: path.join(dir, "runtime", "engine-home")
  };
  const calls = [];
  const launcher = createDaemonProcessLauncher({
    runtimePaths: () => runtime,
    effectiveHermesHome: () => path.join(dir, ".hermes"),
    appPath: () => path.join(dir, "Mia App"),
    execPath: () => path.join(dir, "electron.exe"),
    defaultApp: () => true,
    env: { PATH: "base-path", HERMES_LANGUAGE: "en", CUSTOM_ENV: "kept" },
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return {
        pid: 4242,
        unref: () => calls.push({ unref: true })
      };
    },
    appendLog: (line) => calls.push({ log: line }),
    ...overrides
  });
  return { calls, dir, launcher, runtime };
}

test("detached daemon launcher starts Electron app as a real daemon process", async () => {
  const { calls, dir, launcher, runtime } = setup();

  const result = await launcher.start();

  assert.equal(result.pid, 4242);
  assert.equal(calls[0].command, path.join(dir, "electron.exe"));
  assert.deepEqual(calls[0].args, [path.join(dir, "Mia App"), "--daemon"]);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, "ignore");
  assert.equal(calls[0].options.cwd, dir);
  assert.equal(calls[0].options.env.MIA_DAEMON, "1");
  assert.equal(calls[0].options.env.MIA_HOME, runtime.home);
  assert.equal(calls[0].options.env.MIA_USER_DATA_DIR, path.join(runtime.root, "daemon-profile"));
  assert.equal(calls[0].options.env.HERMES_HOME, path.join(dir, ".hermes"));
  assert.equal(calls[0].options.env.HERMES_LANGUAGE, "en");
  assert.equal(calls[0].options.env.CUSTOM_ENV, "kept");
  assert.deepEqual(calls.slice(1), [
    { unref: true },
    { log: "Started Mia daemon process pid 4242." }
  ]);
});

test("packaged daemon launcher does not pass an app path", () => {
  const { launcher, dir } = setup({ defaultApp: () => false });

  assert.deepEqual(launcher.daemonProgramArguments(), [path.join(dir, "electron.exe"), "--daemon"]);
});

test("detached launcher delegates command and env overlay to an injected resolver", async () => {
  const fakeResolver = {
    resolve: () => ({
      command: "/opt/mia/Mia Core",
      args: ["--daemon"],
      workingDirectory: "/opt/mia"
    }),
    daemonEnvOverlay: () => ({ MIA_DAEMON: "1", MIA_HOME: "/home" })
  };
  const { calls, launcher } = setup({ resolver: fakeResolver });

  await launcher.start();

  assert.equal(calls[0].command, "/opt/mia/Mia Core");
  assert.deepEqual(calls[0].args, ["--daemon"]);
  assert.equal(calls[0].options.cwd, "/opt/mia");
  assert.equal(calls[0].options.env.MIA_DAEMON, "1");
  assert.equal(calls[0].options.env.CUSTOM_ENV, "kept"); // parent env still spread through
});
