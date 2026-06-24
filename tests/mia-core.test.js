const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { freePort } = require("./helpers/free-port.js");
const { createMiaCore } = require("../src/core/mia-core.js");

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

test("mia-core derives runtime home from MIA_HOME without electron", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-paths-"));
  const core = createMiaCore({ env: { MIA_HOME: home }, version: "1.0.0" });
  assert.equal(core.runtimePaths().home, path.resolve(home));
  fs.rmSync(home, { recursive: true, force: true });
});
