const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { freePort } = require("./helpers/free-port.js");
const { createDaemonControlServer } = require("../src/main/daemon/control-server.js");

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-daemon-control-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = {
    initialize: 0,
    settingsWrites: [],
    scheduler: 0
  };
  let daemonSettings = { enabled: true, host: "127.0.0.1", port: 27861 };
  const remoteRouter = {
    matches({ method, path: requestPath }) {
      return method === "GET" && requestPath === "/api/runtime/status";
    },
    async route() {
      return { handled: true, data: { runtime: true } };
    }
  };
  const server = createDaemonControlServer({
    isDaemonProcess: true,
    serviceLabel: "ai.mia.daemon",
    pid: () => 1234,
    uptime: () => 12.4,
    networkInterfaces: () => ({}),
    daemonToken: () => "secret-token",
    initializeRuntime: () => { calls.initialize += 1; },
    choosePort: async (preferred) => preferred,
    getDaemonSettings: () => daemonSettings,
    writeDaemonSettings: (settings) => {
      daemonSettings = { ...daemonSettings, ...settings };
      calls.settingsWrites.push({ ...settings });
      return daemonSettings;
    },
    normalizeDaemonHost: (host) => String(host || "127.0.0.1"),
    normalizeDaemonPort: (port) => Number(port) || 27861,
    runtimePaths: () => ({
      home: path.join(dir, "home"),
      daemonLaunchAgent: path.join(dir, "ai.mia.daemon.plist")
    }),
    remoteRouter: () => remoteRouter,
    initSchedulerSubsystem: () => { calls.scheduler += 1; },
    tasksRoutes: () => ({ handle: async () => false, handleEventsStream: () => {} }),
    fetchImpl: fetch,
    timeoutSignal: (timeoutMs) => AbortSignal.timeout(timeoutMs),
    ...overrides
  });
  return { calls, dir, server, setDaemonSettings: (patch) => { daemonSettings = { ...daemonSettings, ...patch }; } };
}

test("status is owned by the daemon control server runtime", () => {
  const { server } = setup({ after: () => {} });

  server.appendLog("secret-token visible");
  const status = server.status();

  assert.equal(status.processMode, "daemon");
  assert.equal(status.serviceLabel, "ai.mia.daemon");
  assert.equal(status.running, false);
  assert.deepEqual(status.logs, ["[REDACTED] visible"]);
});

test("start serves health, protects remote routes, and delegates authorized remote routes", async (t) => {
  const port = await freePort();
  const { calls, dir, server } = setup(t);

  const status = await server.start({ host: "127.0.0.1", port });
  assert.equal(status.running, true);
  assert.equal(status.baseUrl, `http://127.0.0.1:${port}`);

  const health = await fetch(`${status.baseUrl}/health`).then((response) => response.json());
  assert.deepEqual(health, {
    status: "ok",
    service: "mia-daemon",
    pid: 1234,
    uptime: 12,
    mode: "daemon",
    runtimeHome: path.join(dir, "home"),
    version: ""
  });

  const unauthorized = await fetch(`${status.baseUrl}/api/runtime/status`);
  assert.equal(unauthorized.status, 401);

  const authorized = await fetch(`${status.baseUrl}/api/runtime/status`, {
    headers: { Authorization: "Bearer secret-token" }
  });
  assert.deepEqual(await authorized.json(), { runtime: true });
  assert.equal(calls.initialize, 1);
  assert.equal(calls.scheduler, 1);

  server.stop();
});

test("ping rejects a daemon running from a different runtime home", async (t) => {
  const port = await freePort();
  const { dir, server, setDaemonSettings } = setup(t, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ status: "ok", service: "mia-daemon", runtimeHome: "/tmp/wrong-home" })
    })
  });
  setDaemonSettings({ port });

  const result = await server.ping(undefined, 500, { expectedRuntimeHome: path.join(dir, "home") });

  assert.deepEqual(result, { ok: false, baseUrl: `http://127.0.0.1:${port}` });
});
