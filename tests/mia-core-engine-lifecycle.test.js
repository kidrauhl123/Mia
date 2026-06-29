const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const { createCoreEngineSupervisor } = require("../src/core/mia-core.js");

// BLOCKER #2: Core must be able to ENSURE the Hermes engine is running when it
// runs GUI-less. These tests fake the spawn + health HTTP so the real adapter
// graph / process management is exercised without running the Python engine.

function makeRuntimePaths(home) {
  const hermesHome = path.join(home, ".hermes");
  return () => ({
    home,
    hermesHome,
    engine: path.join(home, "runtime", "hermes-engine"),
    pluginsDir: path.join(home, "runtime", "mia-plugins")
  });
}

// A fake child process that satisfies the supervisor's stdout/stderr/exit/kill
// contract and stays "alive" (exitCode null) until killed.
function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.kill = (signal) => {
    child.killed = true;
    child.exitCode = 0;
    child.emit("exit", 0, signal);
    return true;
  };
  return child;
}

function spawnSyncOk() {
  return { status: 0, stdout: "import OK\n", stderr: "" };
}

test("ensureRunning adopts an already-healthy engine without spawning", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-engine-adopt-"));
  try {
    // Pre-write the api key + a config.yaml port so adoption probes a known port.
    const hermesHome = path.join(home, ".hermes");
    fs.mkdirSync(hermesHome, { recursive: true });
    fs.writeFileSync(path.join(hermesHome, "mia-api-server.key"), "adopt-key\n");
    fs.writeFileSync(path.join(hermesHome, "config.yaml"), "platforms:\n  api_server:\n    port: 18642\n");

    let spawnCalls = 0;
    // isEngineHealthy probes /v1/runs/_mia_probe/events → 404/200 means healthy.
    const fetchImpl = async (url) => {
      if (String(url).includes("/v1/runs/")) return { status: 404 };
      return { ok: true, status: 200 };
    };

    const supervisor = createCoreEngineSupervisor({
      runtimePaths: makeRuntimePaths(home),
      buildPythonPath: () => "/x/mia-plugins",
      hermesHome: () => hermesHome,
      fetchImpl,
      spawnImpl: () => { spawnCalls += 1; return makeFakeChild(); },
      systemHermesPython: () => "/usr/bin/python3"
    });

    const result = await supervisor.ensureRunning();
    assert.equal(result.adopted, true, "must adopt the already-running engine");
    assert.equal(result.spawned, false);
    assert.equal(spawnCalls, 0, "must NOT spawn a second engine when one is healthy");
    assert.equal(supervisor.isManaged(), false, "an adopted engine is not Core-managed");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("ensureRunning spawns the correct gateway command + env when no engine is reachable", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-engine-spawn-"));
  try {
    const hermesHome = path.join(home, ".hermes");

    let healthyAfterSpawn = false;
    let recorded = null;
    const fetchImpl = async (url) => {
      if (String(url).includes("/v1/runs/")) {
        // adoptRunningEngine probe: unhealthy until we've "spawned".
        return healthyAfterSpawn ? { status: 404 } : Promise.reject(new Error("ECONNREFUSED"));
      }
      // waitForHealth /health probe.
      return healthyAfterSpawn ? { ok: true, status: 200 } : Promise.reject(new Error("ECONNREFUSED"));
    };

    const fakeChild = makeFakeChild();
    const supervisor = createCoreEngineSupervisor({
      runtimePaths: makeRuntimePaths(home),
      buildPythonPath: () => path.join(home, "runtime", "mia-plugins"),
      hermesHome: () => hermesHome,
      env: { CUSTOM: "1" },
      modelEnv: () => ({ MIA_CLOUD_MODEL_TOKEN: "cloud-token" }),
      modelRuntimeConfig: () => ({
        provider: "mia",
        providerLabel: "Mia",
        model: "mia-auto",
        apiKeyEnv: "MIA_CLOUD_MODEL_TOKEN",
        apiKey: "cloud-token",
        baseUrl: "https://mia.example/api/me/model-proxy/v1",
        apiMode: "chat_completions"
      }),
      fetchImpl,
      spawnImpl: (command, args, options) => {
        recorded = { command, args, options };
        // The engine becomes healthy once spawned.
        healthyAfterSpawn = true;
        return fakeChild;
      },
      spawnSyncImpl: spawnSyncOk,
      systemHermesPython: () => "/opt/hermes/bin/python3",
      waitForHealthMs: 3000
    });

    const result = await supervisor.ensureRunning();
    assert.equal(result.spawned, true, "must spawn when no engine is reachable");
    assert.equal(result.adopted, false);
    assert.equal(supervisor.isManaged(), true, "a Core-spawned engine is Core-managed");

    // Exact spawned command (system hermes python) + gateway args.
    assert.equal(recorded.command, "/opt/hermes/bin/python3");
    assert.deepEqual(recorded.args, ["-m", "mia_plugins", "gateway", "run", "--replace", "--accept-hooks"]);

    // Env carries the API_SERVER_* + home + PYTHONPATH the engine needs.
    const env = recorded.options.env;
    assert.equal(env.API_SERVER_ENABLED, "true");
    assert.equal(env.API_SERVER_HOST, "127.0.0.1");
    assert.ok(Number(env.API_SERVER_PORT) > 0, "chose a real port");
    assert.equal(env.API_SERVER_PORT, String(result.port));
    assert.ok(env.API_SERVER_KEY, "an api-server key was created + passed");
    assert.equal(env.HERMES_HOME, hermesHome);
    assert.equal(env.MIA_HOME, home);
    assert.equal(env.HERMES_ACCEPT_HOOKS, "1");
    assert.equal(env.PYTHONPATH, path.join(home, "runtime", "mia-plugins"));
    assert.equal(env.CUSTOM, "1", "base env is preserved");
    assert.equal(env.MIA_CLOUD_MODEL_TOKEN, "cloud-token");
    assert.equal(recorded.options.cwd, path.join(home, "runtime", "hermes-engine"));

    // The api key + minimal config.yaml were persisted under hermesHome.
    assert.ok(fs.existsSync(path.join(hermesHome, "mia-api-server.key")));
    const config = require("js-yaml").load(fs.readFileSync(path.join(hermesHome, "config.yaml"), "utf8"));
    assert.equal(config.platforms.api_server.port, result.port);
    assert.equal(config.platforms.api_server.key, env.API_SERVER_KEY);
    assert.equal(config.model.provider, "mia");
    assert.equal(config.model.default, "mia-auto");
    assert.equal(config.providers.mia.key_env, "MIA_CLOUD_MODEL_TOKEN");
    assert.equal(config.providers.mia.api_key, "cloud-token");

    // The mia_plugins overlay was written (so `-m mia_plugins` can import).
    assert.ok(fs.existsSync(path.join(home, "runtime", "mia-plugins", "mia_plugins", "__init__.py")));

    // stop() kills the Core-spawned engine.
    supervisor.stop();
    assert.equal(fakeChild.killed, true, "core.stop() kills a Core-spawned engine");
    assert.equal(supervisor.isManaged(), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("ensureRunning fails before spawn when Hermes API runtime dependency is missing", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-engine-runtime-missing-"));
  try {
    const hermesHome = path.join(home, ".hermes");
    let spawnCalls = 0;
    const supervisor = createCoreEngineSupervisor({
      runtimePaths: makeRuntimePaths(home),
      buildPythonPath: () => path.join(home, "runtime", "mia-plugins"),
      hermesHome: () => hermesHome,
      fetchImpl: async () => Promise.reject(new Error("ECONNREFUSED")),
      spawnImpl: () => {
        spawnCalls += 1;
        return makeFakeChild();
      },
      spawnSyncImpl: () => ({
        status: 1,
        stdout: "",
        stderr: "ModuleNotFoundError: No module named 'aiohttp'"
      }),
      systemHermesPython: () => "/opt/hermes/bin/python3"
    });

    await assert.rejects(
      () => supervisor.ensureRunning(),
      /Hermes API runtime is incomplete[\s\S]*aiohttp/
    );
    assert.equal(spawnCalls, 0, "must not spawn Hermes when API runtime imports fail");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("stop() does NOT kill an adopted engine (Core is not its owner)", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-engine-adopt-stop-"));
  try {
    const hermesHome = path.join(home, ".hermes");
    fs.mkdirSync(hermesHome, { recursive: true });
    fs.writeFileSync(path.join(hermesHome, "mia-api-server.key"), "k\n");
    fs.writeFileSync(path.join(hermesHome, "config.yaml"), "platforms:\n  api_server:\n    port: 18642\n");

    let spawnCalls = 0;
    const supervisor = createCoreEngineSupervisor({
      runtimePaths: makeRuntimePaths(home),
      buildPythonPath: () => "",
      hermesHome: () => hermesHome,
      fetchImpl: async (url) => (String(url).includes("/v1/runs/") ? { status: 200 } : { ok: true, status: 200 }),
      spawnImpl: () => { spawnCalls += 1; return makeFakeChild(); },
      systemHermesPython: () => "/usr/bin/python3"
    });

    await supervisor.ensureRunning();
    assert.equal(spawnCalls, 0);
    // stop() on an adopted engine is a no-op (no child to kill).
    assert.doesNotThrow(() => supervisor.stop());
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
