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

test("mia-core node process serves health/status with node-core identity", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const port = await freePort();

  const core = createMiaCore({ env: { MIA_HOME: home }, version: "9.9.9" });
  core.writeDaemonSettings({ host: "127.0.0.1", port });

  const status = await core.start();
  t.after(() => core.stop());

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
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
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
  t.after(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } });

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
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const port = await freePort();

  const core = createMiaCore({ env: { MIA_HOME: home }, version: "1.0.0" });
  core.writeDaemonSettings({ host: "127.0.0.1", port });
  const status = await core.start();
  t.after(() => core.stop());

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

test("mia-core derives runtime home from MIA_HOME without electron", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-paths-"));
  const core = createMiaCore({ env: { MIA_HOME: home }, version: "1.0.0" });
  assert.equal(core.runtimePaths().home, path.resolve(home));
  fs.rmSync(home, { recursive: true, force: true });
});

test("mia-core honors injected env for daemon host (no global process.env read)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-env-"));
  const core = createMiaCore({ env: { MIA_HOME: home, MIA_DAEMON_HOST: "0.0.0.0" }, version: "1.0.0" });
  assert.equal(core.daemonSettings().host, "0.0.0.0");
  fs.rmSync(home, { recursive: true, force: true });
});

test("mia-core picks a free port when the configured one is taken", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-port-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const taken = await freePort();

  // Occupy the configured port; the core must probe forward to a free one.
  const blocker = require("node:net").createServer();
  await new Promise((resolve) => blocker.listen(taken, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));

  const core = createMiaCore({ env: { MIA_HOME: home }, version: "1.0.0" });
  core.writeDaemonSettings({ host: "127.0.0.1", port: taken });
  const status = await core.start();
  t.after(() => core.stop());

  assert.equal(status.running, true);
  assert.notEqual(status.port, taken);
  const health = await fetch(`${status.baseUrl}/health`).then((r) => r.json());
  assert.equal(health.mode, "daemon");
});
