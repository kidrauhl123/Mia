const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { test } = require("node:test");

const {
  createMiaCoreProcessLauncher
} = require("../src/main/mia-core/process-launcher.js");

const LEGACY_DAEMON_ENV = `MIA_${"DAEMON"}`;
const LEGACY_DAEMON_TARGET_KIND_ENV = `${LEGACY_DAEMON_ENV}_TARGET_KIND`;

function setup(overrides = {}) {
  const dir = path.join(os.tmpdir(), "mia daemon launcher");
  const runtime = {
    root: dir,
    home: path.join(dir, "runtime", "engine-home")
  };
  const calls = [];
  const launcher = createMiaCoreProcessLauncher({
    runtimePaths: () => runtime,
    effectiveHermesHome: () => path.join(dir, ".hermes"),
    appPath: () => path.join(dir, "Mia App"),
    execPath: () => path.join(dir, "electron.exe"),
    defaultApp: () => true,
    env: { PATH: "base-path", HERMES_LANGUAGE: "en", CUSTOM_ENV: "kept" },
    appVersion: () => "0.1.39",
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return {
        pid: 4242,
        unref: () => calls.push({ unref: true })
      };
    },
    appendLog: (line) => calls.push({ log: line }),
    killProcess: (pid, signal) => {
      calls.push({ killProcess: [pid, signal] });
    },
    sleep: async (ms) => {
      calls.push({ sleep: ms });
    },
    ...overrides
  });
  return { calls, dir, launcher, runtime };
}

test("detached Core launcher starts Rust Core as a real background process", async () => {
  const { createMiaCoreResolver } = require("../src/main/mia-core/process-resolver.js");
  const { calls, dir, launcher, runtime } = setup({
    resolver: createMiaCoreResolver({
      runtimePaths: () => ({ root: dir, home: path.join(dir, "runtime", "engine-home") }),
      effectiveHermesHome: () => path.join(dir, ".hermes"),
      execPath: () => path.join(dir, "electron.exe"),
      defaultApp: () => true,
      platform: "darwin",
      env: { HERMES_LANGUAGE: "en" },
      repoRoot: () => dir,
      cargoPath: () => path.join(dir, "cargo"),
      parentPid: () => 1234,
      appVersion: () => "0.1.39"
    })
  });

  const result = await launcher.start();

  assert.equal(result.pid, 4242);
  assert.equal(calls[0].command, path.join(dir, "cargo"));
  assert.deepEqual(calls[0].args.slice(0, 8), ["run", "-p", "mia-core-app", "--bin", "mia-core", "--", "serve", "--host"]);
  assert.deepEqual(calls[0].args.slice(8, 11), ["127.0.0.1", "--port", "27861"]);
  assert.equal(calls[0].options.detached, true);
  assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(calls[0].options.windowsHide, process.platform === "win32" ? true : undefined);
  assert.equal(calls[0].options.cwd, dir);
  assert.equal(calls[0].options.env.MIA_CORE, "1");
  assert.equal(calls[0].options.env.MIA_CORE_HOST, "127.0.0.1");
  assert.equal(calls[0].options.env.MIA_CORE_PORT, "27861");
  assert.equal(calls[0].options.env.MIA_CORE_HOME, runtime.home);
  assert.equal(calls[0].options.env.MIA_CORE_APP_VERSION, "0.1.39");
  assert.equal(calls[0].options.env.MIA_HOME, runtime.home);
  assert.equal(calls[0].options.env.HERMES_HOME, path.join(dir, ".hermes"));
  assert.equal(calls[0].options.env.HERMES_LANGUAGE, "en");
  assert.equal(calls[0].options.env.CUSTOM_ENV, "kept");
  assert.equal(calls[0].options.env.MIA_CORE_TARGET_KIND, "rust-core");
  assert.equal(calls[0].options.env[LEGACY_DAEMON_ENV], undefined);
  assert.equal(calls[0].options.env.MIA_USER_DATA_DIR, undefined);
  assert.equal(calls[0].options.env[LEGACY_DAEMON_TARGET_KIND_ENV], undefined);
  assert.deepEqual(calls.slice(1), [
    { unref: true },
    { log: "Started Mia Core process pid 4242." }
  ]);
});

test("Core launcher never appends a deleted Electron daemon argument", () => {
  const { launcher, dir } = setup({ defaultApp: () => false });
  const args = launcher.coreProgramArguments();
  assert.deepEqual(args, [path.join(dir, "electron.exe")]);
  assert.equal(args.includes(path.join(dir, "Mia App")), false);
});

test("default launcher resolver uses configured Core host and port", () => {
  const { launcher } = setup({
    coreSettings: () => ({ host: "localhost", port: 27992 })
  });
  const args = launcher.coreProgramArguments();
  const env = launcher.coreEnvironment();
  const serveIndex = args.indexOf("serve");

  assert.deepEqual(args.slice(serveIndex, serveIndex + 5), ["serve", "--host", "localhost", "--port", "27992"]);
  assert.equal(env.MIA_CORE_HOST, "localhost");
  assert.equal(env.MIA_CORE_PORT, "27992");
});

test("process-mode launcher captures Core stdout stderr and exit diagnostics", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let spawnedChild = null;
  const { calls, launcher } = setup({
    env: { PATH: "base-path", MIA_CORE_START_MODE: "process" },
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.pid = 5151;
      child.stdout = stdout;
      child.stderr = stderr;
      child.unref = () => calls.push({ unref: true });
      spawnedChild = child;
      return child;
    }
  });

  await launcher.start();
  stdout.write("MIA_CORE_LISTENING {\"port\":27961}\n");
  stderr.write("startup warning\n");
  stdout.end("last stdout line");
  stderr.end();
  spawnedChild.emit("exit", 1, "SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
  assert.ok(calls.some((entry) => entry.log === "Mia Core stdout: MIA_CORE_LISTENING {\"port\":27961}"));
  assert.ok(calls.some((entry) => entry.log === "Mia Core stderr: startup warning"));
  assert.ok(calls.some((entry) => entry.log === "Mia Core stdout: last stdout line"));
  assert.ok(calls.some((entry) => entry.log === "Mia Core process exited code=1 signal=SIGTERM"));
});

test("process-mode launcher can stop a stale observed Core before starting replacement", async () => {
  const { calls, launcher } = setup();

  const result = await launcher.stopObservedProcess(5151);

  assert.deepEqual(result, { stopped: true, pid: 5151 });
  assert.deepEqual(calls, [
    { killProcess: [5151, "SIGTERM"] },
    { sleep: 150 },
    { log: "Stopped stale Mia Core process pid 5151." }
  ]);
});

test("process-mode launcher reuses an in-flight Core process and can stop it", async () => {
  const { calls, launcher } = setup();

  const first = await launcher.start();
  const second = await launcher.start();
  const stopped = await launcher.stopCurrentProcess();

  assert.deepEqual(first, { pid: 4242 });
  assert.deepEqual(second, { pid: 4242, reused: true });
  assert.deepEqual(stopped, { stopped: true, pid: 4242 });
  assert.equal(calls.filter((entry) => entry.command).length, 1);
  assert.ok(calls.some((entry) => entry.log === "Mia Core process pid 4242 is already starting."));
  assert.ok(calls.some((entry) => entry.killProcess?.[0] === 4242));
});

test("detached launcher delegates command and env overlay to an injected resolver", async () => {
  const fakeResolver = {
    resolve: () => ({
      command: "/opt/mia/Mia Core",
      args: ["--daemon"],
      workingDirectory: "/opt/mia"
    }),
    coreEnvOverlay: () => ({ MIA_CORE: "1", MIA_HOME: "/home" })
  };
  const { calls, launcher } = setup({ resolver: fakeResolver });

  await launcher.start();

  assert.equal(calls[0].command, "/opt/mia/Mia Core");
  assert.deepEqual(calls[0].args, ["--daemon"]);
  assert.equal(calls[0].options.cwd, "/opt/mia");
  assert.equal(calls[0].options.windowsHide, process.platform === "win32" ? true : undefined);
  assert.equal(calls[0].options.env.MIA_CORE, "1");
  assert.equal(calls[0].options.env[LEGACY_DAEMON_ENV], undefined);
  assert.equal(calls[0].options.env.CUSTOM_ENV, "kept"); // parent env still spread through
});
