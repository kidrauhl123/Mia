const assert = require("node:assert/strict");
const { test } = require("node:test");

const { createEngineHealthService } = require("../src/main/engine-health-service.js");

function makeServerFactory({ busyPorts = new Set() } = {}) {
  const listened = [];
  return {
    listened,
    createServer: () => {
      let errorHandler = null;
      let selectedPort = 0;
      return {
        once(event, handler) {
          if (event === "error") errorHandler = handler;
        },
        listen(port, host, callback) {
          listened.push([port, host]);
          if (busyPorts.has(port)) {
            errorHandler?.(new Error("busy"));
            return;
          }
          selectedPort = port;
          callback();
        },
        address() {
          return { port: selectedPort };
        },
        close(callback) {
          callback();
        }
      };
    }
  };
}

test("choosePort skips busy ports and returns the first local port that binds", async () => {
  const { createServer, listened } = makeServerFactory({ busyPorts: new Set([18642, 18643]) });
  const service = createEngineHealthService({ createServer });

  assert.equal(await service.choosePort(18642, 4), 18644);
  assert.deepEqual(listened, [
    [18642, "127.0.0.1"],
    [18643, "127.0.0.1"],
    [18644, "127.0.0.1"]
  ]);
});

test("choosePort returns 0 when no candidate port can bind", async () => {
  const { createServer } = makeServerFactory({ busyPorts: new Set([20000, 20001]) });
  const service = createEngineHealthService({ createServer });

  assert.equal(await service.choosePort(20000, 2), 0);
});

test("isEngineHealthy verifies the authenticated Mia probe route", async () => {
  const calls = [];
  const service = createEngineHealthService({
    apiKey: () => "key_1",
    timeoutSignal: (timeoutMs) => `timeout:${timeoutMs}`,
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      return { status: 404 };
    }
  });

  assert.equal(await service.isEngineHealthy("http://127.0.0.1:18642", 1234), true);
  assert.deepEqual(calls, [[
    "http://127.0.0.1:18642/v1/runs/_mia_probe/events",
    {
      method: "GET",
      headers: { Authorization: "Bearer key_1" },
      signal: "timeout:1234"
    }
  ]]);

  const rejected = createEngineHealthService({
    apiKey: () => "key_1",
    fetchImpl: async () => ({ status: 401 })
  });
  assert.equal(await rejected.isEngineHealthy("http://127.0.0.1:18642"), false);
});

test("adoptRunningEngine only probes remembered Mia ports and updates engine state", async () => {
  let state = { running: false, starting: true, port: 19001, baseUrl: "", managedBy: "", lastError: "old" };
  const probes = [];
  const service = createEngineHealthService({
    apiKey: () => "key_1",
    readConfiguredPort: () => 19002,
    getEngineState: () => state,
    setEngineState: (next) => { state = next; },
    fetchImpl: async (url) => {
      probes.push(url);
      return { status: url.includes("19002") ? 404 : 401 };
    }
  });

  assert.equal(await service.adoptRunningEngine(), true);
  assert.deepEqual(probes, [
    "http://127.0.0.1:19001/v1/runs/_mia_probe/events",
    "http://127.0.0.1:19002/v1/runs/_mia_probe/events"
  ]);
  assert.deepEqual(state, {
    running: true,
    starting: false,
    port: 19002,
    baseUrl: "http://127.0.0.1:19002",
    managedBy: "process",
    lastError: ""
  });
});

test("waitForHealth polls /health until the gateway is ready and can require a live child process", async () => {
  let now = 0;
  let attempts = 0;
  const service = createEngineHealthService({
    apiKey: () => "key_1",
    now: () => now,
    sleep: async (delayMs) => { now += delayMs; },
    getEngineProcess: () => ({ exitCode: null }),
    fetchImpl: async (url, options) => {
      attempts += 1;
      assert.equal(url, "http://127.0.0.1:18642/health");
      assert.deepEqual(options.headers, { Authorization: "Bearer key_1" });
      return { ok: attempts >= 3 };
    }
  });

  assert.equal(await service.waitForHealth("http://127.0.0.1:18642", 5000, true), true);
  assert.equal(attempts, 3);

  const exited = createEngineHealthService({
    now: () => now,
    sleep: async (delayMs) => { now += delayMs; },
    getEngineProcess: () => ({ exitCode: 1 }),
    fetchImpl: async () => ({ ok: true })
  });
  assert.equal(await exited.waitForHealth("http://127.0.0.1:18642", 500, true), false);
});
