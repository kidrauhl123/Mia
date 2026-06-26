const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const { createManagedConnectorSupervisor } = require("../src/core/mcp/managed-connector-supervisor.js");
const { normalizeCoreMcpRecord } = require("../src/core/mcp/records.js");

function runtimeTarget(platform = process.platform, arch = process.arch) {
  const osName = platform === "darwin" ? "darwin" : platform === "win32" ? "windows" : "linux";
  const archName = arch === "arm64" ? "arm64" : "amd64";
  const exe = osName === "windows" ? ".exe" : "";
  return {
    loginBinary: `xiaohongshu-login-${osName}-${archName}${exe}`,
    serverBinary: `xiaohongshu-mcp-${osName}-${archName}${exe}`
  };
}

function fakeChildProcess(calls, fakeOptions = {}) {
  return {
    spawn(command, args, spawnOptions) {
      calls.push({ kind: "spawn", command, args, cwd: spawnOptions?.cwd || "" });
      const child = new EventEmitter();
      child.pid = 1234;
      child.kill = () => {
        calls.push({ kind: "kill", pid: child.pid });
        child.emit("exit", 0);
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdout.resume = () => calls.push({ kind: "resume", stream: "stdout" });
      child.stderr.resume = () => calls.push({ kind: "resume", stream: "stderr" });
      if (typeof fakeOptions?.onSpawn === "function") fakeOptions.onSpawn(child);
      return child;
    },
    execFile(command, args, execOptions, callback) {
      calls.push({ kind: "execFile", command, args, cwd: execOptions?.cwd || "" });
      if (fakeOptions?.execFileError) {
        callback(Object.assign(new Error(fakeOptions.execFileError), { stderr: "TOKEN=secret-value" }), "", "TOKEN=secret-value");
        return;
      }
      if (command === "git" && args[0] === "clone" && args[2]) {
        fs.mkdirSync(args[2], { recursive: true });
        fs.writeFileSync(path.join(args[2], "go.mod"), "module xiaohongshu-mcp\n");
      }
      if (command === "tar" && args.includes("-C")) {
        const target = runtimeTarget(fakeOptions.platform, fakeOptions.arch);
        const outputDir = args[args.indexOf("-C") + 1];
        fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(path.join(outputDir, target.loginBinary), "#!/bin/sh\n");
        fs.writeFileSync(path.join(outputDir, target.serverBinary), "#!/bin/sh\n");
      }
      callback(null, "", "");
    }
  };
}

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-xhs-supervisor-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const fetch = Object.prototype.hasOwnProperty.call(overrides, "fetch")
    ? overrides.fetch
    : async () => ({ ok: true, status: 200 });
  const downloadFetch = Object.prototype.hasOwnProperty.call(overrides, "downloadFetch")
    ? overrides.downloadFetch
    : async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(1) });
  const supervisor = createManagedConnectorSupervisor({
    runtimePaths: () => ({ runtime: dir }),
    fs,
    path,
    childProcess: fakeChildProcess(calls, {
      ...(overrides.childProcessOptions || {}),
      platform: overrides.platform || process.platform,
      arch: overrides.arch || process.arch
    }),
    fetch,
    downloadFetch,
    listTools: overrides.listTools,
    healthPollAttempts: overrides.healthPollAttempts,
    healthPollIntervalMs: overrides.healthPollIntervalMs,
    sleep: overrides.sleep,
    platform: overrides.platform || process.platform,
    arch: overrides.arch || process.arch,
    now: () => 1710000000000
  });
  const record = normalizeCoreMcpRecord({
    name: "小红书 MCP",
    nativeName: "xiaohongshu",
    managementMode: "managed",
    registryId: "xiaohongshu",
    enabled: false,
    transport: { type: "http", url: "http://127.0.0.1:18060/mcp" },
    managedRuntime: {
      connectorId: "xiaohongshu",
      endpoint: "http://127.0.0.1:18060/mcp",
      expectedToolCount: 13
    }
  });
  return { dir, calls, supervisor, record };
}

test("install action clones xiaohongshu connector into Mia runtime", async (t) => {
  const { dir, calls, supervisor, record } = setup(t);
  const result = await supervisor.runAction(record, "install", {});
  assert.equal(result.ok, true);
  assert.equal(result.state, "installed");
  assert.match(result.recordPatch.managedRuntime.installDir, /managed-mcp\/xiaohongshu-mcp$/);
  assert.deepEqual(calls[0], {
    kind: "execFile",
    command: "git",
    args: ["clone", "https://github.com/xpzouying/xiaohongshu-mcp", path.join(dir, "managed-mcp", "xiaohongshu-mcp")],
    cwd: dir
  });
});

test("install action prepares the xiaohongshu runtime binaries without requiring Go", async (t) => {
  const { dir, calls, supervisor, record } = setup(t);
  const target = runtimeTarget();

  const result = await supervisor.runAction(record, "install", {});

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(path.join(dir, "managed-mcp", "xiaohongshu-mcp", ".mia-runtime", "bin", target.loginBinary)), true);
  assert.equal(fs.existsSync(path.join(dir, "managed-mcp", "xiaohongshu-mcp", ".mia-runtime", "bin", target.serverBinary)), true);
  assert.equal(calls.some((call) => call.kind === "execFile" && call.command === "tar"), true);
  assert.equal(calls.some((call) => call.kind === "spawn" && call.command === "go"), false);
});

test("install action fails when the xiaohongshu runtime bundle cannot be downloaded", async (t) => {
  const { supervisor, record } = setup(t, {
    downloadFetch: async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) })
  });

  await assert.rejects(
    () => supervisor.runAction(record, "install", {}),
    /Xiaohongshu runtime download failed/
  );
});

test("install action replaces stale non-checkout managed directory", async (t) => {
  const { dir, calls, supervisor, record } = setup(t);
  const staleDir = path.join(dir, "managed-mcp", "xiaohongshu-mcp");
  fs.mkdirSync(staleDir, { recursive: true });
  fs.writeFileSync(path.join(staleDir, "README.md"), "partial checkout\n");

  const result = await supervisor.runAction(record, "install", {});

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(path.join(staleDir, "go.mod")), true);
  assert.equal(fs.existsSync(path.join(staleDir, "README.md")), false);
  assert.deepEqual(calls[0], {
    kind: "execFile",
    command: "git",
    args: ["clone", "https://github.com/xpzouying/xiaohongshu-mcp", staleDir],
    cwd: dir
  });
});

test("login action runs the connector login command in managed directory", async (t) => {
  const { calls, supervisor, record } = setup(t);
  const installed = await supervisor.runAction(record, "install", {});
  const withInstallDir = normalizeCoreMcpRecord({ ...record, ...installed.recordPatch, transport: record.transport });
  const target = runtimeTarget();

  const result = await supervisor.runAction(withInstallDir, "login", {});

  assert.equal(result.ok, true);
  assert.equal(result.state, "login_started");
  assert.equal(calls.some((call) => call.kind === "execFile" && call.command === "tar"), true);
  assert.equal(calls.some((call) => call.kind === "spawn" && call.command.endsWith(target.loginBinary) && call.args.length === 0), true);
  assert.equal(calls.some((call) => call.kind === "resume" && call.stream === "stdout"), true);
  assert.equal(calls.some((call) => call.kind === "resume" && call.stream === "stderr"), true);
});

test("login action reports runtime download failure instead of falling back to Go", async (t) => {
  const { dir, calls, supervisor, record } = setup(t, {
    downloadFetch: async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) })
  });
  const installDir = path.join(dir, "managed-mcp", "xiaohongshu-mcp");
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(path.join(installDir, "go.mod"), "module xiaohongshu-mcp\n");
  const withInstallDir = normalizeCoreMcpRecord({
    ...record,
    managedRuntime: { ...record.managedRuntime, installDir }
  });

  await assert.rejects(
    () => supervisor.runAction(withInstallDir, "login", {}),
    /Xiaohongshu runtime download failed/
  );
  assert.equal(calls.some((call) => call.kind === "spawn" && call.command === "go"), false);
});

test("login action rejects cleanly when command spawn emits error", async (t) => {
  let child;
  const { supervisor, record } = setup(t, {
    childProcessOptions: {
      onSpawn: (spawned) => {
        child = spawned;
        queueMicrotask(() => child.emit("error", new Error("go missing TOKEN=secret-value")));
      }
    }
  });
  const installed = await supervisor.runAction(record, "install", {});
  const withInstallDir = normalizeCoreMcpRecord({ ...record, ...installed.recordPatch, transport: record.transport });

  await assert.rejects(
    supervisor.runAction(withInstallDir, "login", {}),
    /go missing TOKEN=\[redacted\]/
  );
});

test("login action fails cleanly when the managed checkout is missing", async (t) => {
  const { calls, supervisor, record } = setup(t);

  await assert.rejects(
    supervisor.runAction(record, "login", {}),
    /runtime is not installed/i
  );
  assert.equal(calls.some((call) => call.kind === "spawn"), false);
});

test("start action keeps a running child process and stop kills it", async (t) => {
  const { calls, supervisor, record } = setup(t);
  const installed = await supervisor.runAction(record, "install", {});
  const withInstallDir = normalizeCoreMcpRecord({ ...record, ...installed.recordPatch, transport: record.transport });
  const target = runtimeTarget();

  const started = await supervisor.runAction(withInstallDir, "start", {});
  const stopped = await supervisor.stop(withInstallDir.id);

  assert.equal(started.ok, true);
  assert.equal(started.state, "running");
  assert.equal(calls.some((call) => call.kind === "spawn" && call.command.endsWith(target.serverBinary) && call.args.length === 0), true);
  assert.equal(stopped.ok, true);
  assert.equal(calls.some((call) => call.kind === "kill"), true);
});

test("start action rejects cleanly when command spawn emits error during readiness", async (t) => {
  const { supervisor, record } = setup(t, {
    childProcessOptions: {
      onSpawn: (child) => queueMicrotask(() => child.emit("error", new Error("go start failed TOKEN=secret-value")))
    },
    fetch: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return { ok: true, status: 200 };
    }
  });
  const installed = await supervisor.runAction(record, "install", {});
  const withInstallDir = normalizeCoreMcpRecord({ ...record, ...installed.recordPatch, transport: record.transport });

  await assert.rejects(
    supervisor.runAction(withInstallDir, "start", {}),
    /go start failed TOKEN=\[redacted\]/
  );
});

test("start action rejects cleanly when service process exits during readiness", async (t) => {
  const { supervisor, record } = setup(t, {
    childProcessOptions: {
      onSpawn: (child) => queueMicrotask(() => child.emit("exit", 127, null))
    },
    fetch: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return { ok: true, status: 200 };
    }
  });
  const installed = await supervisor.runAction(record, "install", {});
  const withInstallDir = normalizeCoreMcpRecord({ ...record, ...installed.recordPatch, transport: record.transport });

  await assert.rejects(
    supervisor.runAction(withInstallDir, "start", {}),
    /exited before it became ready/i
  );
});

test("start action fails cleanly when the managed checkout is missing", async (t) => {
  const { calls, supervisor, record } = setup(t);

  await assert.rejects(
    supervisor.runAction(record, "start", {}),
    /runtime is not installed/i
  );
  assert.equal(calls.some((call) => call.kind === "spawn"), false);
});

test("start action fails when endpoint health check does not succeed", async (t) => {
  const { calls, supervisor, record } = setup(t, {
    fetch: async () => ({ ok: false, status: 503 }),
    healthPollAttempts: 1,
    sleep: async () => {}
  });
  const installed = await supervisor.runAction(record, "install", {});
  const withInstallDir = normalizeCoreMcpRecord({ ...record, ...installed.recordPatch, transport: record.transport });

  await assert.rejects(
    supervisor.runAction(withInstallDir, "start", {}),
    /health check failed/i
  );
  assert.equal(calls.some((call) => call.kind === "spawn" && call.command.endsWith(runtimeTarget().serverBinary)), true);
});

test("start action polls endpoint health until it succeeds", async (t) => {
  const fetchCalls = [];
  const sleepCalls = [];
  const responses = [
    { ok: false, status: 503 },
    { ok: false, status: 503 },
    { ok: true, status: 200 }
  ];
  const { supervisor, record } = setup(t, {
    fetch: async (url) => {
      fetchCalls.push(url);
      return responses.shift();
    },
    healthPollAttempts: 3,
    healthPollIntervalMs: 25,
    sleep: async (ms) => {
      sleepCalls.push(ms);
    }
  });
  const installed = await supervisor.runAction(record, "install", {});
  const withInstallDir = normalizeCoreMcpRecord({ ...record, ...installed.recordPatch, transport: record.transport });

  const result = await supervisor.runAction(withInstallDir, "start", {});

  assert.equal(result.ok, true);
  assert.equal(result.state, "running");
  assert.deepEqual(fetchCalls, [
    "http://127.0.0.1:18060/mcp",
    "http://127.0.0.1:18060/mcp",
    "http://127.0.0.1:18060/mcp"
  ]);
  assert.deepEqual(sleepCalls, [25, 25]);
});

test("test action uses the managed endpoint and marks the runtime healthy", async (t) => {
  const fetchCalls = [];
  const { supervisor, record } = setup(t, {
    fetch: async (url) => {
      fetchCalls.push(url);
      return { ok: true, status: 204 };
    },
    listTools: async () => Array.from({ length: 13 }, (_, index) => ({ name: `tool-${index}` }))
  });
  const installed = await supervisor.runAction(record, "install", {});
  const withInstallDir = normalizeCoreMcpRecord({ ...record, ...installed.recordPatch, transport: record.transport });

  const result = await supervisor.runAction(withInstallDir, "test", {});

  assert.equal(result.ok, true);
  assert.equal(result.state, "healthy");
  assert.deepEqual(fetchCalls, ["http://127.0.0.1:18060/mcp"]);
  assert.equal(result.recordPatch.managedRuntime.endpoint, "http://127.0.0.1:18060/mcp");
  assert.equal(result.recordPatch.managedRuntime.installDir, withInstallDir.managedRuntime.installDir);
});

test("managed actions ignore malicious persisted installDir outside Mia runtime", async (t) => {
  const { dir, calls, supervisor, record } = setup(t);
  const malicious = normalizeCoreMcpRecord({
    ...record,
    managedRuntime: {
      ...record.managedRuntime,
      installDir: "/tmp/evil",
      state: "installed"
    }
  });

  const result = await supervisor.runAction(malicious, "install", {});
  const spawnDirs = calls.filter((call) => call.cwd).map((call) => call.cwd);

  assert.equal(result.ok, true);
  assert.equal(result.recordPatch.managedRuntime.installDir, path.join(dir, "managed-mcp", "xiaohongshu-mcp"));
  assert.equal(spawnDirs.includes("/tmp/evil"), false);
});

test("test action accepts service-shaped tool verification output", async (t) => {
  const { supervisor, record } = setup(t, {
    listTools: async () => ({
      data: {
        server: {
          tools: Array.from({ length: 13 }, (_, index) => ({ name: `tool-${index}` }))
        }
      }
    })
  });
  const installed = await supervisor.runAction(record, "install", {});
  const withInstallDir = normalizeCoreMcpRecord({ ...record, ...installed.recordPatch, transport: record.transport });

  const result = await supervisor.runAction(withInstallDir, "test", {});

  assert.equal(result.ok, true);
  assert.equal(result.state, "healthy");
});

test("test action fails when fewer tools than expected are reported", async (t) => {
  const { supervisor, record } = setup(t, {
    listTools: async () => Array.from({ length: 12 }, (_, index) => ({ name: `tool-${index}` }))
  });
  const installed = await supervisor.runAction(record, "install", {});
  const withInstallDir = normalizeCoreMcpRecord({ ...record, ...installed.recordPatch, transport: record.transport });

  await assert.rejects(
    supervisor.runAction(withInstallDir, "test", {}),
    /expected 13.*reported 12/i
  );
});

test("test action fails when tool verification dependency is missing", async (t) => {
  const { supervisor, record } = setup(t, { listTools: undefined });
  const installed = await supervisor.runAction(record, "install", {});
  const withInstallDir = normalizeCoreMcpRecord({ ...record, ...installed.recordPatch, transport: record.transport });

  await assert.rejects(
    supervisor.runAction(withInstallDir, "test", {}),
    /tool verification dependency is required/i
  );
});

test("supervisor construction does not require fetch and start fails at action time", async (t) => {
  const { supervisor, record } = setup(t, { fetch: undefined, listTools: async () => [] });
  const installed = await supervisor.runAction(record, "install", {});
  const withInstallDir = normalizeCoreMcpRecord({ ...record, ...installed.recordPatch, transport: record.transport });

  await assert.rejects(
    supervisor.runAction(withInstallDir, "start", {}),
    /fetch dependency is required/i
  );
});

test("sanitized action errors redact secret-like tokens", async (t) => {
  const secret = "Bearer sk-secret-token-value";
  const { supervisor, record } = setup(t, {
    fetch: async () => {
      throw new Error(`request failed with ${secret}`);
    },
    healthPollAttempts: 1,
    sleep: async () => {}
  });
  const installed = await supervisor.runAction(record, "install", {});
  const withInstallDir = normalizeCoreMcpRecord({ ...record, ...installed.recordPatch, transport: record.transport });

  await assert.rejects(async () => {
    await supervisor.runAction(withInstallDir, "start", {});
  }, (error) => {
    assert.match(error.message, /Bearer \[redacted\]/);
    assert.doesNotMatch(error.message, /sk-secret-token-value/);
    return true;
  });
});

test("ensureRunning starts enabled managed records before bridge refresh", async (t) => {
  const { supervisor, record } = setup(t);
  const installed = await supervisor.runAction(record, "install", {});
  const enabled = normalizeCoreMcpRecord({
    ...record,
    ...installed.recordPatch,
    enabled: true,
    transport: record.transport
  });

  const result = await supervisor.ensureRunning([enabled]);

  assert.equal(result.records[0].managedRuntime.state, "running");
  assert.deepEqual(result.errors, []);
});

test("repeated start action is idempotent while a child is already tracked", async (t) => {
  const { calls, supervisor, record } = setup(t);
  const installed = await supervisor.runAction(record, "install", {});
  const withInstallDir = normalizeCoreMcpRecord({ ...record, ...installed.recordPatch, transport: record.transport });

  const first = await supervisor.runAction(withInstallDir, "start", {});
  const second = await supervisor.runAction(withInstallDir, "start", {});

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.state, "running");
  assert.match(second.message, /already running/i);
  assert.deepEqual(second.recordPatch, {
    managedRuntime: {
      ...withInstallDir.managedRuntime,
      state: "running",
      lastAction: "start"
    }
  });
  assert.equal(calls.filter((call) => call.kind === "spawn" && call.command.endsWith(runtimeTarget().serverBinary)).length, 1);
});

test("stop returns a canonical stopped patch when no child is tracked", async (t) => {
  const { supervisor, record } = setup(t);

  const stopped = await supervisor.stop(record.id);

  assert.equal(stopped.ok, true);
  assert.equal(stopped.state, "stopped");
  assert.deepEqual(stopped.recordPatch, {
    managedRuntime: {
      state: "stopped",
      lastAction: "stop"
    }
  });
});
