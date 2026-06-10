const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { test } = require("node:test");

const { createEngineInstallService } = require("../src/main/engine-install-service.js");

// Generic spawn result for the python `-c` probes the service runs:
// version detection, runtime import checks, and the user scripts dir lookup.
function dashCResult(args) {
  const body = String(args[1] || "");
  if (body.includes("version_info")) return { status: 0, stdout: "3.11.8\n", stderr: "" };
  if (body.includes("sysconfig")) return { status: 0, stdout: "/home/test/Library/Python/3.11/bin\n", stderr: "" };
  return { status: 0, stdout: "import OK\n", stderr: "" };
}

function fakeSpawnResult({ code = 0, stdout = "", stderr = "" } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit("close", null);
  process.nextTick(() => {
    if (stdout) child.stdout.write(stdout);
    if (stderr) child.stderr.write(stderr);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", code);
  });
  return child;
}

function setup(t, overrides = {}) {
  const calls = [];
  const logs = [];
  const service = createEngineInstallService({
    // Never touch the real filesystem / ~/.local/bin from a test.
    fs: { existsSync: () => false, mkdirSync: () => {}, rmSync: () => {}, symlinkSync: () => {} },
    homeDir: () => "/home/test",
    platform: "darwin",
    buildPythonPath: () => "/plugins:/extra",
    systemHermesPython: () => "",
    refreshSystemHermes: () => calls.push({ type: "refreshSystemHermes" }),
    appendLog: (line) => logs.push(line),
    clearLogs: () => calls.push({ type: "clearLogs" }),
    spawnSync: (command, args, options) => {
      calls.push({ type: "spawn", command, args, options });
      return { status: 0, stdout: "stdout line\n", stderr: "stderr line\n" };
    },
    initializeRuntime: () => calls.push({ type: "initializeRuntime" }),
    stopEngine: () => calls.push({ type: "stopEngine" }),
    ensureEnginePlugins: () => calls.push({ type: "ensureEnginePlugins" }),
    resetAgentEngineCache: () => calls.push({ type: "resetAgentEngineCache" }),
    getRuntimeStatus: (created) => {
      calls.push({ type: "getRuntimeStatus", created });
      return { created, engineInstalled: true };
    },
    officialPackage: "hermes-agent",
    officialExtras: "web",
    officialPython: "",
    ...overrides
  });
  return { calls, logs, service };
}

test("selectOfficialEnginePython chooses the first Python 3.11+ candidate", (t) => {
  const seen = [];
  const { service } = setup(t, {
    officialPython: "custom-python",
    spawnSync: (command) => {
      seen.push(command);
      const versions = { "custom-python": "3.10.9", "python3.13": "3.13.1" };
      return { status: 0, stdout: `${versions[command] || "3.9.9"}\n`, stderr: "" };
    }
  });

  assert.equal(service.selectOfficialEnginePython(), "python3.13");
  assert.deepEqual(seen, ["custom-python", "python3.13"]);
});

test("selectOfficialEnginePython fails clearly when no candidate is new enough", (t) => {
  const { service } = setup(t, {
    officialPython: "custom-python",
    spawnSync: () => ({ status: 0, stdout: "3.10.12\n", stderr: "" })
  });

  assert.throws(
    () => service.selectOfficialEnginePython(),
    /Official Hermes requires Python 3\.11\+/
  );
});

test("engine source and executable resolve from the system Hermes on PATH, else python3", (t) => {
  const system = setup(t, {
    systemHermesPython: () => "/Users/test/.local/share/hermes/bin/python3"
  });
  assert.equal(system.service.enginePython(), "/Users/test/.local/share/hermes/bin/python3");
  assert.equal(system.service.engineSource(), "system");
  assert.equal(system.service.isInstalled(), true);

  const missing = setup(t);
  assert.equal(missing.service.enginePython(), "python3");
  assert.equal(missing.service.engineSource(), "none");
  assert.equal(missing.service.isInstalled(), false);
});

test("runInstallCommand logs command output, injects install environment, and throws on failures", (t) => {
  const { calls, logs, service } = setup(t, {
    spawnSync: (command, args, options) => {
      calls.push({ type: "spawn", command, args, options });
      return { status: command === "bad-python" ? 2 : 0, stdout: "ok\n", stderr: "warn\n" };
    }
  });

  service.runInstallCommand("python3", ["-m", "pip"], "/tmp/cwd");
  assert.deepEqual(logs, ["$ python3 -m pip", "ok", "warn"]);
  assert.equal(calls[0].options.cwd, "/tmp/cwd");
  assert.equal(calls[0].options.env.PIP_DISABLE_PIP_VERSION_CHECK, "1");
  assert.equal(calls[0].options.env.PYTHONPATH, "/plugins:/extra");

  assert.throws(
    () => service.runInstallCommand("bad-python", ["-m", "pip"], "/tmp"),
    /bad-python exited with code 2/
  );
});

test("installFromOfficialPackage installs --user from the mirror, retries base package without extras, verifies imports, refreshes detection", (t) => {
  const pipCommands = [];
  const { calls, logs, service } = setup(t, {
    officialPython: "/opt/python3.11",
    spawnSync: (command, args) => {
      if (args[0] === "-c") return dashCResult(args);
      pipCommands.push([command, ...args]);
      // The extras requirement fails once; the base package then succeeds.
      if (args.includes("hermes-agent[web]")) return { status: 1, stdout: "", stderr: "no extra\n" };
      return { status: 0, stdout: "", stderr: "" };
    }
  });

  const status = service.installFromOfficialPackage();

  assert.deepEqual(pipCommands, [
    ["/opt/python3.11", "-m", "pip", "install", "--user", "--upgrade", "hermes-agent[web]", "--index-url", "https://pypi.tuna.tsinghua.edu.cn/simple"],
    ["/opt/python3.11", "-m", "pip", "install", "--user", "--upgrade", "hermes-agent", "--index-url", "https://pypi.tuna.tsinghua.edu.cn/simple"]
  ]);
  assert.match(logs.join("\n"), /retrying base package/);
  const types = calls.map((call) => call.type);
  assert.ok(types.includes("refreshSystemHermes"));
  assert.ok(types.includes("ensureEnginePlugins"));
  assert.ok(types.includes("resetAgentEngineCache"));
  assert.deepEqual(status, { created: ["hermes"], engineInstalled: true });
});

test("installFromOfficialPackage falls back to the official index when the mirror fails", (t) => {
  const indexes = [];
  const { logs, service } = setup(t, {
    officialPython: "/opt/python3.11",
    officialExtras: "",
    spawnSync: (command, args) => {
      if (args[0] === "-c") return dashCResult(args);
      const indexUrl = args[args.indexOf("--index-url") + 1];
      indexes.push(indexUrl);
      if (indexUrl.includes("tuna")) return { status: 1, stdout: "", stderr: "mirror down\n" };
      return { status: 0, stdout: "", stderr: "" };
    }
  });

  service.installFromOfficialPackage();

  assert.deepEqual(indexes, [
    "https://pypi.tuna.tsinghua.edu.cn/simple",
    "https://pypi.org/simple"
  ]);
  assert.match(logs.join("\n"), /Hermes install via https:\/\/pypi\.tuna[^\s]* failed/);
});

test("installFromOfficialPackageAsync retries PEP 668 user installs with break-system-packages and reports progress", async (t) => {
  const pipArgs = [];
  const progress = [];
  const { service } = setup(t, {
    officialPython: "/opt/python3.11",
    spawnSync: (_command, args) => {
      if (args[0] === "-c") return dashCResult(args);
      return { status: 0, stdout: "", stderr: "" };
    },
    spawn: (_command, args) => {
      if (args[0] === "-m" && args[1] === "pip") {
        pipArgs.push(args);
        if (!args.includes("--break-system-packages")) {
          return fakeSpawnResult({
            code: 1,
            stderr: "error: externally-managed-environment\nThis environment is externally managed\n"
          });
        }
        return fakeSpawnResult({ stdout: "installed\n" });
      }
      if (args[0] === "-c") return fakeSpawnResult({ stdout: "import OK\n" });
      return fakeSpawnResult();
    }
  });

  const status = await service.installFromOfficialPackageAsync({ onProgress: (payload) => progress.push(payload) });

  assert.equal(pipArgs.length, 2);
  assert.equal(pipArgs[0].includes("--break-system-packages"), false);
  assert.equal(pipArgs[1].includes("--break-system-packages"), true);
  assert.match(progress.map((payload) => payload.message).join("\n"), /用户目录兼容模式/);
  assert.deepEqual(status, { created: ["hermes"], engineInstalled: true });
});

test("installFromOfficialPackage fails when the installed runtime does not import (no false success)", (t) => {
  const { service } = setup(t, {
    officialPython: "/opt/python3.11",
    officialExtras: "",
    spawnSync: (command, args) => {
      if (args[0] === "-c") {
        const body = String(args[1] || "");
        if (body.includes("version_info")) return { status: 0, stdout: "3.11.8\n", stderr: "" };
        if (body.includes("sysconfig")) return { status: 0, stdout: "/x/bin\n", stderr: "" };
        // Import verification always fails → install must not report success.
        return { status: 1, stdout: "", stderr: "ModuleNotFoundError: hermes_cli\n" };
      }
      return { status: 0, stdout: "", stderr: "" }; // pip install "succeeds"
    }
  });

  assert.throws(() => service.installFromOfficialPackage(), /import|exited with code/);
});

test("repair reinstalls the official package", (t) => {
  const indexes = [];
  const { service } = setup(t, {
    officialPython: "/opt/python3.11",
    officialExtras: "",
    spawnSync: (command, args) => {
      if (args[0] === "-c") return dashCResult(args);
      indexes.push(args[args.indexOf("--index-url") + 1]);
      return { status: 0, stdout: "", stderr: "" };
    }
  });

  service.repair();
  assert.deepEqual(indexes, ["https://pypi.tuna.tsinghua.edu.cn/simple"]);
});

test("install throws a user-visible cancellation error when signal is aborted", (t) => {
  const controller = new AbortController();
  controller.abort();
  const { service } = setup(t);

  assert.throws(
    () => service.install({ signal: controller.signal }),
    /Hermes install cancelled/
  );
});

test("installEngine routes npm engines to the China mirror registry, then falls back to npm", (t) => {
  const installs = [];
  const { service } = setup(t, {
    shellCommandPath: (c) => (c === "npm" ? "/usr/local/bin/npm" : ""),
    spawnSync: (command, args) => {
      if (args[0] === "install") {
        installs.push([command, ...args]);
        // First registry (mirror) fails, official npm registry succeeds.
        const registry = args[args.indexOf("--registry") + 1];
        return registry.includes("npmmirror")
          ? { status: 1, stdout: "", stderr: "mirror down\n" }
          : { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    }
  });

  service.installEngine("claude-code");
  assert.deepEqual(installs, [
    ["/usr/local/bin/npm", "install", "-g", "@anthropic-ai/claude-code", "--registry", "https://registry.npmmirror.com"],
    ["/usr/local/bin/npm", "install", "-g", "@anthropic-ai/claude-code", "--registry", "https://registry.npmjs.org"]
  ]);
});

test("installEngine maps npm engines to their official packages and rejects unknown engines", (t) => {
  const installs = [];
  const { service } = setup(t, {
    shellCommandPath: () => "npm",
    spawnSync: (command, args) => {
      if (args[0] === "install") { installs.push(args[2]); return { status: 0, stdout: "", stderr: "" }; }
      return { status: 0, stdout: "", stderr: "" };
    }
  });

  service.installEngine("codex");
  service.installEngine("openclaw");
  assert.deepEqual(installs, ["@openai/codex", "openclaw"]);
  assert.throws(() => service.installEngine("missing-engine"), /not installable/);
});
