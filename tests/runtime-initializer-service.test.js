const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createRuntimeInitializerService } = require("../src/main/runtime-initializer-service.js");

function runtimeFor(dir) {
  const home = path.join(dir, "runtime", "engine-home");
  const hermesHome = path.join(dir, ".hermes");
  const engine = path.join(dir, "runtime", "hermes-engine");
  return {
    root: dir,
    runtime: path.join(dir, "runtime"),
    engine,
    home,
    hermesHome,
    pluginsDir: path.join(dir, "runtime", "mia-plugins"),
    botManifest: path.join(home, "bots", "manifest.json"),
    botDir: path.join(home, "bots"),
    legacyPersonaDir: path.join(home, "personas", "accounts"),
    apiServerKey: path.join(hermesHome, "mia-api-server.key"),
    config: path.join(hermesHome, "config.yaml"),
    permissionSettings: path.join(home, "mia-permissions.json"),
    effortSettings: path.join(home, "mia-effort.json"),
    coreSettings: path.join(home, "mia-core.json"),
    daemonSettings: path.join(home, "mia-core.json"),
    coreToken: path.join(home, "mia-core.key"),
    userProfile: path.join(home, "mia-user.json"),
    appearanceSettings: path.join(home, "mia-appearance.json"),
    soul: path.join(home, "SOUL.md"),
    petDir: path.join(home, "pets"),
    petJobsDir: path.join(home, "pet-jobs")
  };
}

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-runtime-init-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = runtimeFor(dir);
  const calls = [];
  const service = createRuntimeInitializerService({
    runtimePaths: () => runtime,
    randomBytes: () => Buffer.from("c".repeat(64), "hex"),
    ensureEnginePlugins: () => calls.push(["engine-plugins"]),
    defaultPermissionSettings: () => ({ mode: "ask" }),
    defaultEffortSettings: () => ({ level: "medium" }),
    defaultCoreSettings: () => ({ enabled: true }),
    defaultUserProfile: () => ({ displayName: "Boss" }),
    defaultAppearanceSettings: () => ({ theme: "system" }),
    getRuntimeStatus: (created) => ({ created, ok: true }),
    ...overrides
  });
  return { calls, dir, runtime, service };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

test("initializeRuntimeCore creates runtime directories and default files", (t) => {
  const { calls, runtime, service } = setup(t);

  const status = service.initializeRuntimeCore();

  assert.equal(status.ok, true);
  assert.equal(fs.existsSync(runtime.engine), true);
  assert.equal(fs.existsSync(runtime.pluginsDir), true);
  assert.equal(fs.existsSync(runtime.petDir), true);
  assert.equal(fs.existsSync(runtime.apiServerKey), false);
  assert.equal(fs.existsSync(runtime.config), false);
  assert.equal(fs.existsSync(path.join(runtime.home, "mia-providers.json")), false);
  assert.deepEqual(readJson(runtime.permissionSettings), { mode: "ask" });
  assert.deepEqual(readJson(runtime.effortSettings), { level: "medium" });
  assert.deepEqual(readJson(runtime.coreSettings), { enabled: true });
  assert.deepEqual(readJson(runtime.userProfile), { displayName: "Boss" });
  assert.deepEqual(readJson(runtime.appearanceSettings), { theme: "system" });
  assert.equal(fs.existsSync(path.join(runtime.home, "mia-sessions.json")), false);
  assert.match(fs.readFileSync(runtime.soul, "utf8"), /Mia Shared Soul/);
  assert.equal(fs.existsSync(path.join(runtime.botDir, "manifest.json")), false);
  assert.equal(fs.readdirSync(runtime.botDir).length, 0);
  assert.deepEqual(calls, [
    ["engine-plugins"]
  ]);
  assert.ok(status.created.includes("runtime/hermes-engine/README.md"));
  assert.equal(status.created.includes("~/.hermes/mia-api-server.key"), false);
  assert.equal(status.created.includes("~/.hermes/config.yaml"), false);
  assert.equal(status.created.includes("runtime/engine-home/mia-model.json"), false);
  assert.ok(status.created.includes("runtime/engine-home/mia-core.json"));
  assert.equal(status.created.some((entry) => entry.startsWith("runtime/engine-home/bots/")), false);
});

test("initializeRuntimeCore does not overwrite existing user-owned runtime files", (t) => {
  const { runtime, service } = setup(t);
  fs.mkdirSync(path.dirname(runtime.apiServerKey), { recursive: true });
  fs.writeFileSync(runtime.apiServerKey, "existing-key\n", { mode: 0o600 });
  fs.mkdirSync(runtime.botDir, { recursive: true });
  fs.writeFileSync(path.join(runtime.botDir, "mei.md"), "current persona");
  fs.mkdirSync(runtime.legacyPersonaDir, { recursive: true });
  fs.writeFileSync(path.join(runtime.legacyPersonaDir, "mei.md"), "legacy persona");

  const status = service.initializeRuntimeCore();

  assert.equal(fs.readFileSync(runtime.apiServerKey, "utf8"), "existing-key\n");
  assert.equal(fs.readFileSync(path.join(runtime.botDir, "mei.md"), "utf8"), "current persona");
  assert.equal(status.created.includes("~/.hermes/mia-api-server.key"), false);
  assert.equal(status.created.includes("runtime/engine-home/mia-model.json"), false);
  assert.equal(status.created.includes("runtime/engine-home/bots/mei.md"), false);
});
