const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { freePort } = require("./helpers/free-port.js");
const { createDaemonControlServer, daemonNeedsReplacement } = require("../src/main/daemon/control-server.js");
const { createLocalEventsClient, parseSseBuffer } = require("../src/main/daemon/local-events-client.js");

function setupServer(t, overrides = {}) {
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
    timeoutSignal: (timeoutMs) => AbortSignal.timeout(timeoutMs),
    ...overrides
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

test("daemon emits SSE heartbeats so a healthy idle stream stays alive", async (t) => {
  const port = await freePort();
  let heartbeatFn = null;
  const { server } = setupServer(t, {
    setIntervalFn: (fn) => { heartbeatFn = fn; return 1; },
    clearIntervalFn: () => {}
  });
  const status = await server.start({ host: "127.0.0.1", port });
  t.after(() => server.stop());

  const res = await fetch(`${status.baseUrl}/api/local-events`, {
    headers: { Authorization: "Bearer secret-token" }
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const first = decoder.decode((await reader.read()).value);
  assert.match(first, /: connected/);

  assert.ok(heartbeatFn, "heartbeat interval registered on start");
  heartbeatFn();
  const next = decoder.decode((await reader.read()).value);
  assert.match(next, /:hb/);
  await reader.cancel();
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

test("client recycles a silent stream after the idle timeout", () => {
  const timers = [];
  let destroyed = 0;
  let responseHandler = null;
  let dataHandler = null;
  const fakeReq = {
    on(event, cb) { if (event === "response") responseHandler = cb; return fakeReq; },
    end() {},
    destroy() { destroyed += 1; }
  };
  const fakeRes = {
    statusCode: 200,
    on(event, cb) { if (event === "data") dataHandler = cb; return fakeRes; },
    resume() {}
  };
  const client = createLocalEventsClient({
    baseUrl: () => "http://127.0.0.1:9",
    daemonToken: () => "secret-token",
    requestImpl: () => fakeReq,
    setTimeoutFn: (fn, delayMs) => { timers.push({ fn, delayMs }); return timers.length; },
    clearTimeoutFn: () => {},
    idleTimeoutMs: 5000
  });

  client.start();
  responseHandler(fakeRes);
  assert.equal(client.status().connected, true);

  const watchdog = timers.find((tmr) => tmr.delayMs === 5000);
  assert.ok(watchdog, "idle watchdog scheduled on connect");

  watchdog.fn();
  assert.equal(destroyed, 1, "silent stream is destroyed so it reconnects");
});

test("inbound traffic re-arms the idle watchdog instead of killing a healthy stream", () => {
  const timers = [];
  const cancelled = new Set();
  let destroyed = 0;
  let responseHandler = null;
  let dataHandler = null;
  const fakeReq = {
    on(event, cb) { if (event === "response") responseHandler = cb; return fakeReq; },
    end() {},
    destroy() { destroyed += 1; }
  };
  const fakeRes = {
    statusCode: 200,
    on(event, cb) { if (event === "data") dataHandler = cb; return fakeRes; },
    resume() {}
  };
  const client = createLocalEventsClient({
    baseUrl: () => "http://127.0.0.1:9",
    daemonToken: () => "secret-token",
    requestImpl: () => fakeReq,
    setTimeoutFn: (fn) => { const id = timers.length + 1; timers.push({ fn, id }); return id; },
    clearTimeoutFn: (id) => { cancelled.add(id); },
    idleTimeoutMs: 5000
  });

  client.start();
  responseHandler(fakeRes);
  assert.equal(timers.length, 1, "watchdog armed on connect");

  // A heartbeat arrives before the timeout: the stale watchdog must be cancelled
  // and a fresh one armed, so a live stream is never recycled.
  dataHandler(": hb\n\n");
  assert.equal(timers.length, 2, "watchdog re-armed on inbound data");
  assert.ok(cancelled.has(1), "stale watchdog cancelled — real clearTimeout stops it firing");

  // Fire only the timers a real clearTimeout would still run: the cancelled
  // stale one stays silent (no destroy); the live one recycles after true silence.
  for (const tmr of timers) if (!cancelled.has(tmr.id)) tmr.fn();
  assert.equal(destroyed, 1, "only the live watchdog recycles, and only after genuine idle");
});

test("daemon /health and ping report the app version for reconciliation", async (t) => {
  const port = await freePort();
  const { server } = setupServer(t, { appVersion: () => "9.9.9" });
  const status = await server.start({ host: "127.0.0.1", port });
  t.after(() => server.stop());

  const health = await (await fetch(`${status.baseUrl}/health`)).json();
  assert.equal(health.version, "9.9.9");

  const probe = await server.ping({ host: "127.0.0.1", port }, 1000, { expectedRuntimeHome: status.runtimeHome });
  assert.equal(probe.ok, true);
  assert.equal(probe.version, "9.9.9");
});

test("daemonNeedsReplacement replaces only a reachable daemon whose version differs", () => {
  assert.equal(daemonNeedsReplacement({ ok: false }, "1.2.0"), false);
  assert.equal(daemonNeedsReplacement({ ok: true, version: "1.2.0" }, "1.2.0"), false);
  assert.equal(daemonNeedsReplacement({ ok: true, version: "1.1.0" }, "1.2.0"), true);
  // a pre-feature daemon reports no version → treat as stale → replace
  assert.equal(daemonNeedsReplacement({ ok: true, version: "" }, "1.2.0"), true);
  // unknown app version → never churn
  assert.equal(daemonNeedsReplacement({ ok: true, version: "1.1.0" }, ""), false);
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
