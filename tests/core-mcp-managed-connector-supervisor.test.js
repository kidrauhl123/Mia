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
  const fetch = overrides.fetch || (async () => ({ ok: true, status: 200 }));
  const supervisor = createManagedConnectorSupervisor({
    runtimePaths: () => ({ runtime: dir }),
    fs,
    path,
    childProcess: fakeChildProcess(calls),
    fetch,
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
    fetch: async () => ({ ok: false, status: 503 })
  });
  const installed = await supervisor.runAction(record, "install", {});
  const withInstallDir = normalizeCoreMcpRecord({ ...record, ...installed.recordPatch, transport: record.transport });

  await assert.rejects(
    supervisor.runAction(withInstallDir, "start", {}),
    /health check failed/i
  );
  assert.equal(calls.some((call) => call.kind === "spawn" && call.command === "go" && call.args.join(" ") === "run ."), true);
});

test("test action uses the managed endpoint and marks the runtime healthy", async (t) => {
  const fetchCalls = [];
  const { supervisor, record } = setup(t, {
    fetch: async (url) => {
      fetchCalls.push(url);
      return { ok: true, status: 204 };
    }
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
