const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { spawn } = require("node:child_process");

const { freePort } = require("./helpers/free-port.js");
const { createMiaCore } = require("../src/core/mia-core.js");
const { createMiaCoreResolver } = require("../src/main/daemon/executable-resolver.js");

const CORE_ENTRY = path.resolve(__dirname, "..", "src", "core", "mia-core.js");

function removeHome(home) {
  fs.rmSync(home, { recursive: true, force: true });
}

function stopCoreAndRemoveHome(t, core, home) {
  t.after(async () => {
    try { await core?.stop?.(); } catch { /* best effort */ }
    removeHome(home);
  });
}

function killChildAndRemoveHome(t, child, home) {
  t.after(async () => {
    try {
      if (!child.killed) child.kill("SIGKILL");
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } catch { /* best effort */ }
    removeHome(home);
  });
}

test("mia-core node process serves health/status with node-core identity", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-home-"));
  const port = await freePort();

  const core = createMiaCore({ env: { MIA_HOME: home }, version: "9.9.9" });
  stopCoreAndRemoveHome(t, core, home);
  core.writeDaemonSettings({ host: "127.0.0.1", port });

  const status = await core.start();

  assert.equal(status.running, true);
  assert.equal(status.baseUrl, `http://127.0.0.1:${port}`);

  const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
  assert.equal(health.mode, "daemon");
  assert.equal(health.version, "9.9.9");
  assert.equal(health.daemonTarget.kind, "node-core");
  assert.equal(health.daemonTarget.usesGuiAppIdentity, false);

  // Owns runtime files under MIA_HOME (real single-owner persistence, no electron).
  assert.ok(fs.existsSync(path.join(home, "mia-daemon.key")), "daemon token persisted");
  assert.ok(fs.existsSync(path.join(home, "mia-daemon.json")), "daemon settings persisted");
});

test("dev integration: launching the resolver's node-core command answers /health with mode:daemon", async (t) => {
  // Exercise the REAL launch the resolver produces: spawn `node mia-core.js
  // --daemon` (command + args from the resolver) and confirm the spawned process
  // is the daemon answering /health. nodePath uses the test runner's own node.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-launch-"));
  const port = await freePort();

  const resolver = createMiaCoreResolver({
    runtimePaths: () => ({ home, root: home }),
    effectiveHermesHome: () => path.join(home, ".hermes"),
    nodePath: () => process.execPath,
    coreEntry: () => CORE_ENTRY
  });
  const target = resolver.resolve();
  assert.equal(target.kind, "node-core");
  assert.equal(target.command, process.execPath);
  assert.deepEqual(target.args, [CORE_ENTRY, "--daemon"]);

  const env = {
    ...process.env,
    ...resolver.daemonEnvOverlay(),
    MIA_HOME: home,
    MIA_DAEMON_PORT: String(port),
    MIA_DAEMON_HOST: "127.0.0.1"
  };
  const child = spawn(target.command, target.args, {
    cwd: target.workingDirectory,
    env,
    stdio: "ignore",
    detached: false
  });
  killChildAndRemoveHome(t, child, home);

  // Poll /health until the launched node-core daemon answers.
  let health = null;
  for (let i = 0; i < 50 && !health; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(400) });
      if (res.ok) health = await res.json();
    } catch { /* not up yet */ }
    if (!health) await new Promise((resolve) => setTimeout(resolve, 200));
  }

  assert.ok(health, "launched node-core daemon answered /health");
  assert.equal(health.mode, "daemon");
  assert.equal(health.daemonTarget.kind, "node-core");
  assert.equal(health.daemonTarget.usesGuiAppIdentity, false);
});

test("mia-core control server applies delegated cloud-settings writes (not 501)", async (t) => {
  // BLOCKER #1: without writeCloudSettings the Core control server returns 501 on
  // POST /api/cloud-settings, so the window's delegated login/logout/profile-refresh
  // writes FAIL against Core. Assert the route persists to mia-cloud.json.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-cloud-write-"));
  const port = await freePort();

  const core = createMiaCore({ env: { MIA_HOME: home }, version: "1.0.0" });
  stopCoreAndRemoveHome(t, core, home);
  core.writeDaemonSettings({ host: "127.0.0.1", port });
  const status = await core.start();

  const token = core.daemonToken();
  const res = await fetch(`${status.baseUrl}/api/cloud-settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ patch: { enabled: true, token: "tok-abc", url: "https://example.test" } })
  });
  assert.notEqual(res.status, 501, "cloud-settings writes must be supported by Core");
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.settings.enabled, true);
  assert.equal(out.settings.token, "tok-abc");

  // Persisted to the single-owner mia-cloud.json under MIA_HOME.
  const persisted = JSON.parse(fs.readFileSync(path.join(home, "mia-cloud.json"), "utf8"));
  assert.equal(persisted.token, "tok-abc");
  assert.equal(persisted.enabled, true);
});

test("mia-core control server exposes chat stop for window delegation", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-chat-stop-"));
  const port = await freePort();

  const core = createMiaCore({ env: { MIA_HOME: home }, version: "1.0.0" });
  stopCoreAndRemoveHome(t, core, home);
  core.writeDaemonSettings({ host: "127.0.0.1", port });
  const status = await core.start();

  const res = await fetch(`${status.baseUrl}/api/chat/stop`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${core.daemonToken()}`
    },
    body: JSON.stringify({ conversationId: "dm:userA:bot1", runId: "local_1" })
  });

  assert.notEqual(res.status, 404, "Core daemon must route /api/chat/stop");
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(typeof out.stopped, "boolean");
});

test("mia-core exposes scoped Mia context snapshots with memory tools", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-context-"));
  const port = await freePort();

  const core = createMiaCore({ env: { MIA_HOME: home }, version: "1.0.0" });
  stopCoreAndRemoveHome(t, core, home);
  const paths = core.runtimePaths();
  fs.mkdirSync(paths.botDir, { recursive: true });
  fs.writeFileSync(path.join(paths.botDir, "mei.md"), "mei persona", "utf8");
  fs.mkdirSync(path.dirname(paths.memory), { recursive: true });
  fs.writeFileSync(paths.memory, JSON.stringify({
    shared: ["shared memory"],
    bots: { mei: ["bot memory"] }
  }), "utf8");

  core.writeDaemonSettings({ host: "127.0.0.1", port });
  const status = await core.start();

  const res = await fetch(`${status.baseUrl}/api/mia/context?botId=mei&sessionId=s1&originMessageId=m1`, {
    headers: { Authorization: `Bearer ${core.daemonToken()}` }
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.botId, "mei");
  assert.equal(body.sessionId, "s1");
  assert.equal(body.originMessageId, "m1");
  assert.equal(body.persona, "mei persona");
  assert.equal(body.memory, "");
  assert.deepEqual(body.memoryTools, {
    enabled: true,
    search: "memory_search",
    remember: "memory_remember",
    update: "memory_update",
    forget: "memory_forget"
  });
});

test("mia-core derives runtime home from MIA_HOME without electron", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-paths-"));
  const core = createMiaCore({ env: { MIA_HOME: home }, version: "1.0.0" });
  try {
    assert.equal(core.runtimePaths().home, path.resolve(home));
  } finally {
    await core.stop();
    removeHome(home);
  }
});

test("mia-core honors injected env for daemon host (no global process.env read)", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-env-"));
  const core = createMiaCore({ env: { MIA_HOME: home, MIA_DAEMON_HOST: "0.0.0.0" }, version: "1.0.0" });
  try {
    assert.equal(core.daemonSettings().host, "0.0.0.0");
  } finally {
    await core.stop();
    removeHome(home);
  }
});

test("mia-core picks a free port when the configured one is taken", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-port-"));
  const taken = await freePort();

  // Occupy the configured port; the core must probe forward to a free one.
  const blocker = require("node:net").createServer();
  await new Promise((resolve) => blocker.listen(taken, "127.0.0.1", resolve));

  const core = createMiaCore({ env: { MIA_HOME: home }, version: "1.0.0" });
  t.after(async () => {
    try { await core.stop(); } catch { /* best effort */ }
    try { await new Promise((resolve) => blocker.close(resolve)); } catch { /* best effort */ }
    removeHome(home);
  });
  core.writeDaemonSettings({ host: "127.0.0.1", port: taken });
  const status = await core.start();

  assert.equal(status.running, true);
  assert.notEqual(status.port, taken);
  const health = await fetch(`${status.baseUrl}/health`).then((r) => r.json());
  assert.equal(health.mode, "daemon");
});
