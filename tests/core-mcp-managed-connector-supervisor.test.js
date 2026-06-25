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
      callback(null, "", "");
    }
  };
}

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-xhs-supervisor-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const supervisor = createManagedConnectorSupervisor({
    runtimePaths: () => ({ runtime: dir }),
    fs,
    path,
    childProcess: fakeChildProcess(calls),
    fetch: async () => ({ ok: true, status: 200 }),
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
