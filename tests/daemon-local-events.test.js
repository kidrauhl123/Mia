const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { freePort } = require("./helpers/free-port.js");
const { createDaemonControlServer } = require("../src/main/daemon/control-server.js");
const { createLocalEventsClient, parseSseBuffer } = require("../src/main/daemon/local-events-client.js");

function setupServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-local-events-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let daemonSettings = { enabled: true, host: "127.0.0.1", port: 0 };
  const server = createDaemonControlServer({
    isDaemonProcess: true,
    serviceLabel: "ai.mia.daemon",
    pid: () => 1234,
    uptime: () => 1,
    networkInterfaces: () => ({}),
    daemonToken: () => "secret-token",
    initializeRuntime: () => {},
    choosePort: async (preferred) => preferred,
    getDaemonSettings: () => daemonSettings,
    writeDaemonSettings: (settings) => { daemonSettings = { ...daemonSettings, ...settings }; return daemonSettings; },
    normalizeDaemonHost: (host) => String(host || "127.0.0.1"),
    normalizeDaemonPort: (port) => Number(port) || 27861,
    runtimePaths: () => ({ home: path.join(dir, "home") }),
    remoteRouter: () => null,
    initSchedulerSubsystem: () => {},
    tasksRoutes: () => ({ handle: async () => false, handleEventsStream: () => {} }),
    fetchImpl: fetch,
    timeoutSignal: (timeoutMs) => AbortSignal.timeout(timeoutMs)
  });
  return { server };
}

function waitFor(predicate, timeoutMs = 3000, intervalMs = 25) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error("waitFor timed out"));
      }
    }, intervalMs);
  });
}

test("window receives daemon-published envelopes over the local channel", async (t) => {
  const port = await freePort();
  const { server } = setupServer(t);
  const status = await server.start({ host: "127.0.0.1", port });
  t.after(() => server.stop());

  const received = [];
  const client = createLocalEventsClient({
    baseUrl: () => status.baseUrl,
    daemonToken: () => "secret-token",
    onEnvelope: (envelope) => received.push(envelope)
  });
  t.after(() => client.stop());
  client.start();
  await waitFor(() => client.status().connected);

  server.publishLocalEvent({ type: "cloud_agent_run_started", payload: { runId: "r1" } });
  server.publishLocalEvent({ type: "cloud_agent_run_event", payload: { runId: "r1", event: { type: "reasoning_delta", text: "想" } } });
  await waitFor(() => received.length === 2);

  assert.deepEqual(received.map((envelope) => envelope.type), [
    "cloud_agent_run_started",
    "cloud_agent_run_event"
  ]);
  assert.equal(received[1].payload.event.text, "想");
});

test("local events stream rejects a missing or wrong daemon token", async (t) => {
  const port = await freePort();
  const { server } = setupServer(t);
  const status = await server.start({ host: "127.0.0.1", port });
  t.after(() => server.stop());

  const response = await fetch(`${status.baseUrl}/api/local-events`);
  assert.equal(response.status, 401);

  const received = [];
  const client = createLocalEventsClient({
    baseUrl: () => status.baseUrl,
    daemonToken: () => "wrong-token",
    onEnvelope: (envelope) => received.push(envelope)
  });
  t.after(() => client.stop());
  client.start();
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(client.status().connected, false);
  server.publishLocalEvent({ type: "cloud_agent_run_started", payload: {} });
  assert.deepEqual(received, []);
});

test("client stays idle while the daemon toggle is off", () => {
  let requests = 0;
  const timers = [];
  const client = createLocalEventsClient({
    baseUrl: () => "http://127.0.0.1:1",
    daemonToken: () => "secret-token",
    enabled: () => false,
    requestImpl: () => { requests += 1; throw new Error("must not request"); },
    setTimeoutFn: (fn, delayMs) => { timers.push({ fn, delayMs }); return timers.length; },
    clearTimeoutFn: () => {}
  });

  client.start();
  assert.equal(requests, 0);
  assert.equal(timers.length, 1);
  timers[0].fn();
  assert.equal(requests, 0);
  assert.equal(timers.length, 2);
});

test("parseSseBuffer handles split chunks, batches, and malformed payloads", () => {
  const seen = [];
  let rest = parseSseBuffer('data: {"type":"a"}\n\ndata: {bad json}\n\ndata: {"ty', (e) => seen.push(e.type));
  assert.deepEqual(seen, ["a"]);
  rest = parseSseBuffer(rest + 'pe":"b"}\n\n: comment\n\n', (e) => seen.push(e.type));
  assert.deepEqual(seen, ["a", "b"]);
  assert.equal(rest, "");
});

test("POST /api/cloud-settings applies the patch through the injected writer", async (t) => {
  const port = await freePort();
  const writes = [];
  const { server } = setupServer(t);
  // setupServer doesn't pass writeCloudSettings; exercise via a second server.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-cloud-settings-route-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const routed = require("../src/main/daemon/control-server.js").createDaemonControlServer({
    isDaemonProcess: true,
    serviceLabel: "ai.mia.daemon",
    pid: () => 1,
    uptime: () => 1,
    networkInterfaces: () => ({}),
    daemonToken: () => "secret-token",
    initializeRuntime: () => {},
    choosePort: async (preferred) => preferred,
    getDaemonSettings: () => ({ enabled: true, host: "127.0.0.1", port: 0 }),
    writeDaemonSettings: (s) => s,
    normalizeDaemonHost: (host) => String(host || "127.0.0.1"),
    normalizeDaemonPort: (p) => Number(p) || 27861,
    runtimePaths: () => ({ home: path.join(dir, "home") }),
    remoteRouter: () => null,
    initSchedulerSubsystem: () => {},
    tasksRoutes: () => ({ handle: async () => false, handleEventsStream: () => {} }),
    writeCloudSettings: (patch) => { writes.push(patch); return { ...patch, ok: true }; },
    fetchImpl: fetch,
    timeoutSignal: (timeoutMs) => AbortSignal.timeout(timeoutMs)
  });
  const status = await routed.start({ host: "127.0.0.1", port });
  t.after(() => routed.stop());
  server.stop();

  const unauthorized = await fetch(`${status.baseUrl}/api/cloud-settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patch: { token: "tok" } })
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(writes.length, 0);

  const authorized = await fetch(`${status.baseUrl}/api/cloud-settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer secret-token" },
    body: JSON.stringify({ patch: { token: "tok", enabled: true } })
  });
  const data = await authorized.json();
  assert.equal(authorized.status, 200);
  assert.deepEqual(writes, [{ token: "tok", enabled: true }]);
  assert.equal(data.settings.ok, true);
});

test("POST /api/cloud-settings awaits an async writer and surfaces its failure", async (t) => {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-cloud-settings-async-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const routed = require("../src/main/daemon/control-server.js").createDaemonControlServer({
    isDaemonProcess: true,
    serviceLabel: "ai.mia.daemon",
    pid: () => 1,
    uptime: () => 1,
    networkInterfaces: () => ({}),
    daemonToken: () => "secret-token",
    initializeRuntime: () => {},
    choosePort: async (preferred) => preferred,
    getDaemonSettings: () => ({ enabled: true, host: "127.0.0.1", port: 0 }),
    writeDaemonSettings: (s) => s,
    normalizeDaemonHost: (host) => String(host || "127.0.0.1"),
    normalizeDaemonPort: (p) => Number(p) || 27861,
    runtimePaths: () => ({ home: path.join(dir, "home") }),
    remoteRouter: () => null,
    initSchedulerSubsystem: () => {},
    tasksRoutes: () => ({ handle: async () => false, handleEventsStream: () => {} }),
    writeCloudSettings: async (patch) => {
      if (patch.boom) throw new Error("disk full");
      return { applied: patch };
    },
    fetchImpl: fetch,
    timeoutSignal: (timeoutMs) => AbortSignal.timeout(timeoutMs)
  });
  const status = await routed.start({ host: "127.0.0.1", port });
  t.after(() => routed.stop());

  const ok = await fetch(`${status.baseUrl}/api/cloud-settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer secret-token" },
    body: JSON.stringify({ patch: { token: "tok" } })
  });
  assert.equal((await ok.json()).settings.applied.token, "tok");

  const failed = await fetch(`${status.baseUrl}/api/cloud-settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer secret-token" },
    body: JSON.stringify({ patch: { boom: true } })
  });
  assert.equal(failed.status, 500);
  assert.match((await failed.json()).error, /disk full/);
});
