const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createEngineRuntimeConfigService } = require("../src/main/engine-runtime-config-service.js");

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-engine-runtime-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = {
    home: path.join(dir, "engine-home"),
    hermesHome: path.join(dir, ".hermes"),
    apiServerKey: path.join(dir, ".hermes", "mia-api-server.key"),
    config: path.join(dir, ".hermes", "config.yaml"),
    botManifest: path.join(dir, "engine-home", "bots", "manifest.json")
  };
  const calls = [];
  const service = createEngineRuntimeConfigService({
    runtimePaths: () => runtime,
    permissionSettings: () => ({ mode: "ask" }),
    effortSettings: () => ({ level: "high" }),
    getMiaAppMcpSpec: () => ({ command: "/bin/node", args: ["mia-app.js"], env: { A: "1" } }),
    getSchedulerMcpSpec: () => ({ command: "/bin/node", args: ["scheduler.js"], env: { B: "2" } }),
    getUserMcpSpecs: () => ({ xhs: { url: "http://127.0.0.1:18060/mcp", headers: {} } }),
    prepareRuntimeConfigRequest: async (request) => {
      calls.push(request);
      return { ok: true, apiServerKey: "server-key-from-core", configPath: runtime.config };
    },
    ...overrides
  });
  return { calls, dir, runtime, service };
}

test("prepareRuntimeConfig delegates Hermes config rendering to Rust Core", async (t) => {
  const { calls, runtime, service } = setup(t);

  const response = await service.prepareRuntimeConfig(19191);

  assert.deepEqual(response, {
    ok: true,
    apiServerKey: "server-key-from-core",
    configPath: runtime.config
  });
  assert.equal(service.apiServerKey(), "server-key-from-core");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    method: "POST",
    route: "/api/engines/hermes/runtime-config",
    body: {
      port: 19191,
      paths: {
        home: runtime.home,
        hermesHome: runtime.hermesHome,
        config: runtime.config,
        apiServerKey: runtime.apiServerKey,
        botManifest: runtime.botManifest
      },
      permissionSettings: { mode: "ask" },
      effortSettings: { level: "high" },
      miaAppMcpSpec: { command: "/bin/node", args: ["mia-app.js"], env: { A: "1" } },
      schedulerMcpSpec: { command: "/bin/node", args: ["scheduler.js"], env: { B: "2" } },
      userMcpSpecs: { xhs: { url: "http://127.0.0.1:18060/mcp", headers: {} } }
    }
  });
});

test("apiServerKey reads the Core-created Hermes API server key when not cached", (t) => {
  const { runtime, service } = setup(t);
  fs.mkdirSync(path.dirname(runtime.apiServerKey), { recursive: true });
  fs.writeFileSync(runtime.apiServerKey, "existing-server-key\n");

  assert.equal(service.apiServerKey(), "existing-server-key");
});

test("readConfiguredPort returns the configured API server port or the Mia default", (t) => {
  const { runtime, service } = setup(t);

  assert.equal(service.readConfiguredPort(), 18642);
  fs.mkdirSync(path.dirname(runtime.config), { recursive: true });
  fs.writeFileSync(runtime.config, [
    "platforms:",
    "  api_server:",
    "    port: 20001"
  ].join("\n"));

  assert.equal(service.readConfiguredPort(), 20001);
});
