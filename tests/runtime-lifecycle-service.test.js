const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createRuntimeLifecycleService } = require("../src/main/runtime-lifecycle-service.js");

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate, timeoutMs = 250) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return false;
    await wait(5);
  }
  return true;
}

function createTimer() {
  const marks = [];
  return {
    marks,
    mark: (label, details) => marks.push({ label, ...(details || {}) })
  };
}

test("runtime lifecycle initializes runtime once and reuses status", () => {
  let initCalls = 0;
  let statusCalls = 0;
  const timer = createTimer();
  const service = createRuntimeLifecycleService({
    getRuntimeStatus: () => {
      statusCalls += 1;
      return { created: [], cached: true };
    },
    initializeRuntimeCore: () => {
      initCalls += 1;
      return { created: ["~/.hermes/config.yaml"] };
    },
    timer
  });

  assert.deepEqual(service.initializeRuntime(), { created: ["~/.hermes/config.yaml"] });
  assert.deepEqual(service.initializeRuntime(), { created: [], cached: true });
  assert.equal(initCalls, 1);
  assert.equal(statusCalls, 1);
  assert.equal(service.isRuntimeInitialized(), true);
  assert.deepEqual(timer.marks.map((entry) => entry.label), [
    "runtime:init-start",
    "runtime:init-done",
    "runtime:cache-hit"
  ]);
});

test("runtime lifecycle schedules Core startup and system refresh without foreground Hermes startup", async () => {
  const calls = [];
  const timer = createTimer();
  const service = createRuntimeLifecycleService({
    appendDaemonLog: (line) => calls.push(["daemon-log", line]),
    getRuntimeStatus: () => ({ engineInstalled: true }),
    initializeRuntimeCore: () => ({ created: [] }),
    prepareEngineRuntimeConfigAsync: async () => calls.push(["prepare-runtime-config"]),
    refreshAgentWorkspaceAsync: async () => calls.push(["refresh-agent-workspace"]),
    refreshMemorySettingsAsync: async () => calls.push(["refresh-memory-settings"]),
    refreshSystemHermesAsync: async () => calls.push(["refresh-system-hermes"]),
    startDaemonService: async () => calls.push(["start-daemon"]),
    startEngine: async () => calls.push(["start-engine"]),
    timer
  });

  assert.equal(service.scheduleBackgroundStartup({ delayMs: 0, engineDelayMs: 0 }), true);
  assert.equal(service.scheduleBackgroundStartup({ delayMs: 0, engineDelayMs: 0 }), false);
  await waitUntil(() => calls.length >= 4);

  assert.deepEqual(calls, [
    ["start-daemon"],
    ["refresh-system-hermes"],
    ["prepare-runtime-config"],
    ["refresh-agent-workspace"],
    ["refresh-memory-settings"]
  ]);
  assert.equal(service.isBackgroundStartupScheduled(), true);
  assert.deepEqual(timer.marks.map((entry) => entry.label), [
    "background:scheduled",
    "daemon:start-scheduled",
    "daemon:start-done",
    "system-hermes:refresh-done",
    "engine-runtime-config:prepare-done",
    "agent-workspace:refresh-done",
    "memory-settings:refresh-done"
  ]);
});

test("runtime lifecycle records startup errors without throwing from scheduler", async () => {
  const errors = [];
  const service = createRuntimeLifecycleService({
    appendDaemonLog: (line) => errors.push(["daemon-log", line]),
    appendEngineLog: (line) => errors.push(["engine-log", line]),
    getRuntimeStatus: () => ({ engineInstalled: true }),
    initializeRuntimeCore: () => ({ created: [] }),
    refreshSystemHermesAsync: async () => {},
    setDaemonLastError: (message) => errors.push(["daemon-error", message]),
    startDaemonService: async () => { throw new Error("daemon failed"); },
    startEngine: async () => { throw new Error("engine failed"); }
  });

  service.scheduleBackgroundStartup({ delayMs: 0, engineDelayMs: 0 });
  await wait(50);

  assert.deepEqual(errors, [
    ["daemon-error", "daemon failed"],
    ["daemon-log", "Background daemon registration failed: daemon failed"]
  ]);
});
