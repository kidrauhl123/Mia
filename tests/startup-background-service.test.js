const test = require("node:test");
const assert = require("node:assert/strict");
const { createStartupBackgroundService } = require("../src/main/startup-background-service.js");

test("startup background service runs daemon, system refresh, and engine when installed", async () => {
  const calls = [];
  const service = createStartupBackgroundService({
    getRuntimeStatus: () => ({ engineInstalled: true }),
    startDaemonService: async () => { calls.push("daemon"); return { running: true }; },
    refreshSystemHermesAsync: async () => { calls.push("system-hermes"); },
    startEngine: async () => { calls.push("engine"); return { engineRunning: true }; },
    setDaemonLastError: (message) => calls.push(`daemon-error:${message}`),
    setEngineLastError: (message) => calls.push(`engine-error:${message}`),
    appendDaemonLog: (line) => calls.push(`daemon-log:${line}`),
    appendEngineLog: (line) => calls.push(`engine-log:${line}`)
  });

  const result = await service.run();

  assert.deepEqual(calls, ["daemon", "system-hermes", "engine"]);
  assert.equal(result.ok, true);
  assert.equal(result.steps.daemon.ok, true);
  assert.equal(result.steps.engine.ok, true);
});

test("startup background service skips engine when Hermes is not installed", async () => {
  const calls = [];
  const service = createStartupBackgroundService({
    getRuntimeStatus: () => ({ engineInstalled: false }),
    startDaemonService: async () => { calls.push("daemon"); return { running: true }; },
    refreshSystemHermesAsync: async () => { calls.push("system-hermes"); },
    startEngine: async () => { calls.push("engine"); return {}; },
    appendEngineLog: (line) => calls.push(`engine-log:${line}`)
  });

  const result = await service.run();

  assert.equal(result.ok, true);
  assert.equal(result.steps.engine.skipped, true);
  assert.deepEqual(calls, [
    "daemon",
    "system-hermes",
    "engine-log:No Hermes available (system or managed); waiting for manual setup."
  ]);
});

test("startup background service reports best-effort daemon and engine failures", async () => {
  const calls = [];
  const service = createStartupBackgroundService({
    getRuntimeStatus: () => ({ engineInstalled: true }),
    startDaemonService: async () => { throw new Error("daemon failed"); },
    refreshSystemHermesAsync: async () => { throw new Error("probe failed"); },
    startEngine: async () => { throw new Error("engine failed"); },
    setDaemonLastError: (message) => calls.push(`daemon-error:${message}`),
    setEngineLastError: (message) => calls.push(`engine-error:${message}`),
    appendDaemonLog: (line) => calls.push(`daemon-log:${line}`),
    appendEngineLog: (line) => calls.push(`engine-log:${line}`)
  });

  const result = await service.run();

  assert.equal(result.ok, false);
  assert.match(result.steps.daemon.error, /daemon failed/);
  assert.match(result.steps.systemHermes.error, /probe failed/);
  assert.match(result.steps.engine.error, /engine failed/);
  assert.deepEqual(calls, [
    "daemon-error:daemon failed",
    "daemon-log:Startup daemon registration failed: daemon failed",
    "engine-error:engine failed",
    "engine-log:Startup engine auto-start failed: engine failed"
  ]);
});
