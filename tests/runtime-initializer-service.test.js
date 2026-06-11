const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createRuntimeInitializerService } = require("../src/main/runtime-initializer-service.js");

function runtimeFor(dir) {
  const home = path.join(dir, "runtime", "engine-home");
  const engine = path.join(dir, "runtime", "hermes-engine");
  return {
    root: dir,
    runtime: path.join(dir, "runtime"),
    engine,
    home,
    pluginsDir: path.join(dir, "runtime", "mia-plugins"),
    botManifest: path.join(home, "bots", "manifest.json"),
    botDir: path.join(home, "bots"),
    legacyPersonaDir: path.join(home, "personas", "accounts"),
    apiKey: path.join(home, "api-server.key"),
    config: path.join(home, "config.yaml"),
    modelSettings: path.join(home, "mia-model.json"),
    providerConnections: path.join(home, "mia-providers.json"),
    permissionSettings: path.join(home, "mia-permissions.json"),
    effortSettings: path.join(home, "mia-effort.json"),
    daemonSettings: path.join(home, "mia-daemon.json"),
    daemonToken: path.join(home, "mia-daemon.key"),
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
    writeRuntimeConfig: (port) => {
      calls.push(["write-config", port]);
      fs.mkdirSync(path.dirname(runtime.config), { recursive: true });
      fs.writeFileSync(runtime.config, `port: ${port}\n`);
    },
    readConfiguredPort: () => 18777,
    defaultModelSettings: () => ({ provider: "", model: "" }),
    defaultProviderStore: () => ({ providers: {} }),
    defaultPermissionSettings: () => ({ mode: "ask" }),
    defaultEffortSettings: () => ({ level: "medium" }),
    defaultDaemonSettings: () => ({ enabled: true }),
    defaultUserProfile: () => ({ displayName: "Boss" }),
    defaultAppearanceSettings: () => ({ theme: "system" }),
    ensureClaudeBridgePlugin: () => calls.push(["claude-bridge"]),
    appendEngineLog: (line) => calls.push(["log", line]),
    getRuntimeStatus: (created) => ({ created, ok: true }),
    ...overrides
  });
  return { calls, dir, runtime, service };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

test("initializeRuntimeCore creates runtime directories, default files, and bridge plugins", (t) => {
  const { calls, runtime, service } = setup(t);

  const status = service.initializeRuntimeCore();

  assert.equal(status.ok, true);
  assert.equal(fs.existsSync(runtime.engine), true);
  assert.equal(fs.existsSync(runtime.pluginsDir), true);
  assert.equal(fs.existsSync(runtime.petDir), true);
  assert.equal(fs.readFileSync(runtime.apiKey, "utf8").trim(), "c".repeat(64));
  assert.equal(fs.statSync(runtime.apiKey).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(runtime.config, "utf8"), "port: 18777\n");
  assert.deepEqual(readJson(runtime.modelSettings), { provider: "", model: "" });
  assert.deepEqual(readJson(runtime.providerConnections), { providers: {} });
  assert.deepEqual(readJson(runtime.permissionSettings), { mode: "ask" });
  assert.deepEqual(readJson(runtime.effortSettings), { level: "medium" });
  assert.deepEqual(readJson(runtime.daemonSettings), { enabled: true });
  assert.deepEqual(readJson(runtime.userProfile), { displayName: "Boss" });
  assert.deepEqual(readJson(runtime.appearanceSettings), { theme: "system" });
  assert.equal(fs.existsSync(path.join(runtime.home, "mia-sessions.json")), false);
  assert.match(fs.readFileSync(runtime.soul, "utf8"), /Mia Shared Soul/);
  assert.equal(fs.existsSync(path.join(runtime.botDir, "manifest.json")), false);
  assert.equal(fs.readdirSync(runtime.botDir).length, 0);
  assert.deepEqual(calls, [
    ["engine-plugins"],
    ["write-config", 18777],
    ["claude-bridge"]
  ]);
  assert.ok(status.created.includes("runtime/hermes-engine/README.md"));
  assert.ok(status.created.includes("runtime/engine-home/api-server.key"));
  assert.equal(status.created.some((entry) => entry.startsWith("runtime/engine-home/bots/")), false);
});

test("initializeRuntimeCore does not overwrite existing user-owned runtime files", (t) => {
  const { runtime, service } = setup(t);
  fs.mkdirSync(path.dirname(runtime.apiKey), { recursive: true });
  fs.writeFileSync(runtime.apiKey, "existing-key\n", { mode: 0o600 });
  fs.writeFileSync(runtime.modelSettings, JSON.stringify({ provider: "openai" }) + "\n", { mode: 0o600 });
  fs.mkdirSync(runtime.botDir, { recursive: true });
  fs.writeFileSync(path.join(runtime.botDir, "mei.md"), "current persona");
  fs.mkdirSync(runtime.legacyPersonaDir, { recursive: true });
  fs.writeFileSync(path.join(runtime.legacyPersonaDir, "mei.md"), "legacy persona");

  const status = service.initializeRuntimeCore();

  assert.equal(fs.readFileSync(runtime.apiKey, "utf8"), "existing-key\n");
  assert.deepEqual(readJson(runtime.modelSettings), { provider: "openai" });
  assert.equal(fs.readFileSync(path.join(runtime.botDir, "mei.md"), "utf8"), "current persona");
  assert.equal(status.created.includes("runtime/engine-home/api-server.key"), false);
  assert.equal(status.created.includes("runtime/engine-home/mia-model.json"), false);
  assert.equal(status.created.includes("runtime/engine-home/bots/mei.md"), false);
});

test("initializeRuntimeCore logs Claude bridge setup failure without aborting runtime initialization", (t) => {
  const { calls, service } = setup(t, {
    ensureClaudeBridgePlugin: () => { throw new Error("bridge denied"); }
  });

  const status = service.initializeRuntimeCore();

  assert.equal(status.ok, true);
  assert.deepEqual(calls.filter((call) => call[0] === "log"), [
    ["log", "Claude bridge plugin setup failed: bridge denied"]
  ]);
});
