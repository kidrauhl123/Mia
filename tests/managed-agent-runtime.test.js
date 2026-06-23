const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  createManagedAgentRuntimeService,
  runtimeEnv,
  runtimeKey
} = require("../src/main/agent-runtime/managed-agent-runtime.js");
const {
  isWindowsDirectExecutable,
  isWindowsShellShim,
  spawnSpecForExecutable
} = require("../src/main/agent-runtime/process-launcher.js");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-managed-runtime-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

test("managed runtime resolves AION-style ACP manifests with Windows exe entrypoints", (t) => {
  const root = tempDir(t);
  const runtimeDir = path.join(root, "acp", "codex-acp", "0.14.0", "win32-x64");
  const exe = path.join(runtimeDir, "codex-acp.exe");
  const nodeDir = path.join(runtimeDir, "node");
  fs.mkdirSync(nodeDir, { recursive: true });
  fs.writeFileSync(exe, "");
  writeJson(path.join(runtimeDir, "manifest.json"), {
    entrypoint: "codex-acp.exe",
    protocol: "acp",
    path_entries: ["node"],
    env: { CODEX_ACP_MANAGED: "1" }
  });

  const service = createManagedAgentRuntimeService({
    resourceRoots: [root],
    platform: "win32",
    arch: "x64",
    spawnSync: () => ({ status: 0, stdout: "codex-acp 0.14.0\n", stderr: "" })
  });
  const runtime = service.resolve("codex");
  const env = runtimeEnv(runtime, { PATH: "C:\\Windows" }, { platform: "win32" });

  assert.equal(runtime.runtimeKey, "win32-x64");
  assert.equal(runtime.toolId, "codex-acp");
  assert.equal(runtime.protocol, "acp");
  assert.equal(runtime.path, exe);
  assert.equal(runtime.version, "0.14.0");
  assert.equal(env.CODEX_ACP_MANAGED, "1");
  assert.equal(env.PATH.split(";")[0], runtimeDir);
  assert.equal(env.PATH.split(";")[1], nodeDir);
});

test("managed runtime rejects manifest entrypoints outside the runtime directory", (t) => {
  const root = tempDir(t);
  const runtimeDir = path.join(root, "acp", "codex-acp", "0.14.0", "win32-x64");
  const escaped = path.join(root, "acp", "codex-acp", "escape.exe");
  fs.mkdirSync(path.dirname(escaped), { recursive: true });
  fs.writeFileSync(escaped, "");
  writeJson(path.join(runtimeDir, "manifest.json"), {
    entrypoint: "..\\..\\escape.exe"
  });

  const service = createManagedAgentRuntimeService({
    resourceRoots: [root],
    platform: "win32",
    arch: "x64"
  });

  assert.equal(service.resolve("codex"), null);
  assert.match(service.diagnose("codex").diagnostics[0].reason, /inside its runtime directory/);
});

test("runtimeKey uses platform-arch names compatible with bundled resources", () => {
  assert.equal(runtimeKey("win32", "x64"), "win32-x64");
  assert.equal(runtimeKey("darwin", "arm64"), "darwin-arm64");
});

test("process launcher wraps Windows cmd shims and keeps native exe direct", () => {
  const cmd = spawnSpecForExecutable("C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd", ["--version"], { platform: "win32" });
  assert.equal(cmd.command, "cmd.exe");
  assert.deepEqual(cmd.args.slice(0, 4), ["/d", "/s", "/c", "call"]);
  assert.match(cmd.args[4], /codex\.cmd/);
  assert.equal(cmd.args[5], "--version");
  assert.equal(cmd.wrapped, true);

  const exe = spawnSpecForExecutable("C:\\Program Files\\Codex\\codex.exe", ["--version"], { platform: "win32" });
  assert.equal(exe.command, "C:\\Program Files\\Codex\\codex.exe");
  assert.deepEqual(exe.args, ["--version"]);
  assert.equal(exe.wrapped, false);
  assert.equal(isWindowsShellShim("C:\\npm\\codex.cmd", "win32"), true);
  assert.equal(isWindowsDirectExecutable("C:\\Codex\\codex.exe", "win32"), true);
});
