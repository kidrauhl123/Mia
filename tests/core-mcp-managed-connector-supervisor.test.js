const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const { createManagedConnectorSupervisor } = require("../src/core/mcp/managed-connector-supervisor.js");
const { normalizeCoreMcpRecord } = require("../src/core/mcp/records.js");

function fakeChildProcess(calls) {
  return {
    spawn(command, args, options) {
      calls.push({ kind: "spawn", command, args, cwd: options?.cwd || "" });
      const child = new EventEmitter();
      child.pid = 1234;
      child.kill = () => {
        calls.push({ kind: "kill", pid: child.pid });
        child.emit("exit", 0);
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      return child;
    },
    execFile(command, args, options, callback) {
      calls.push({ kind: "execFile", command, args, cwd: options?.cwd || "" });
      if (command === "git" && args[0] === "clone" && args[2]) {
        fs.mkdirSync(args[2], { recursive: true });
        fs.writeFileSync(path.join(args[2], "go.mod"), "module xiaohongshu-mcp\n");
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
  const supervisor = createManagedConnectorSupervisor({
    runtimePaths: () => ({ runtime: dir }),
    fs,
    path,
    childProcess: fakeChildProcess(calls),
    fetch,
    listTools: overrides.listTools,
    healthPollAttempts: overrides.healthPollAttempts,
    healthPollIntervalMs: overrides.healthPollIntervalMs,
    sleep: overrides.sleep,
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

test("login action runs the connector login command in managed directory", async (t) => {
  const { calls, supervisor, record } = setup(t);
  const installed = await supervisor.runAction(record, "install", {});
  const withInstallDir = normalizeCoreMcpRecord({ ...record, ...installed.recordPatch, transport: record.transport });

  const result = await supervisor.runAction(withInstallDir, "login", {});

  assert.equal(result.ok, true);
  assert.equal(result.state, "login_started");
  assert.equal(calls.some((call) => call.kind === "spawn" && call.command === "go" && call.args.join(" ") === "run cmd/login/main.go"), true);
});

test("login action fails cleanly when the managed checkout is missing", async (t) => {
  const { calls, supervisor, record } = setup(t);

  await assert.rejects(
    supervisor.runAction(record, "login", {}),
    /checkout is not installed/i
  );
  assert.equal(calls.some((call) => call.kind === "spawn"), false);
});

test("start action keeps a running child process and stop kills it", async (t) => {
  const { calls, supervisor, record } = setup(t);
  const installed = await supervisor.runAction(record, "install", {});
  const withInstallDir = normalizeCoreMcpRecord({ ...record, ...installed.recordPatch, transport: record.transport });

  const started = await supervisor.runAction(withInstallDir, "start", {});
  const stopped = await supervisor.stop(withInstallDir.id);

  assert.equal(started.ok, true);
  assert.equal(started.state, "running");
  assert.equal(calls.some((call) => call.kind === "spawn" && call.command === "go" && call.args.join(" ") === "run ."), true);
  assert.equal(stopped.ok, true);
  assert.equal(calls.some((call) => call.kind === "kill"), true);
});

test("start action fails cleanly when the managed checkout is missing", async (t) => {
  const { calls, supervisor, record } = setup(t);

  await assert.rejects(
    supervisor.runAction(record, "start", {}),
    /checkout is not installed/i
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
  assert.equal(calls.some((call) => call.kind === "spawn" && call.command === "go" && call.args.join(" ") === "run ."), true);
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
