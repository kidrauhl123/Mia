const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { freePort } = require("./helpers/free-port.js");
const { createMiaCoreControlServer, shouldReuseCore } = require("../src/main/mia-core/control-server.js");

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-daemon-control-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = {
    initialize: 0,
    settingsWrites: [],
    tasks: []
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
  const server = createMiaCoreControlServer({
    isCoreProcess: true,
    serviceLabel: "ai.mia.daemon",
    pid: () => 1234,
    uptime: () => 12.4,
    networkInterfaces: () => ({}),
    coreToken: () => "secret-token",
    initializeRuntime: () => { calls.initialize += 1; },
    choosePort: async (preferred) => preferred,
    getCoreSettings: () => daemonSettings,
    writeCoreSettings: (settings) => {
      daemonSettings = { ...daemonSettings, ...settings };
      calls.settingsWrites.push({ ...settings });
      return daemonSettings;
    },
    normalizeCoreHost: (host) => String(host || "127.0.0.1"),
    normalizeCorePort: (port) => Number(port) || 27861,
    runtimePaths: () => ({
      home: path.join(dir, "home"),
      daemonLaunchAgent: path.join(dir, "ai.mia.daemon.plist")
    }),
    remoteRouter: () => remoteRouter,
    tasksClient: () => ({
      call: async (requestPath, options = {}) => {
        calls.tasks.push({ path: requestPath, options });
        return { tasks: [{ id: "task_core_1" }] };
      }
    }),
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
    version: "",
    daemonTarget: null
  });
  const probe = await server.ping({ host: "127.0.0.1", port }, 500, { expectedRuntimeHome: path.join(dir, "home") });
  assert.equal(probe.mode, "daemon");

  const unauthorized = await fetch(`${status.baseUrl}/api/runtime/status`);
  assert.equal(unauthorized.status, 401);

  const authorized = await fetch(`${status.baseUrl}/api/runtime/status`, {
    headers: { Authorization: "Bearer secret-token" }
  });
  assert.deepEqual(await authorized.json(), { runtime: true });
  assert.equal(calls.initialize, 1);
  assert.deepEqual(calls.tasks, []);

  server.stop();
});

test("agent permission routes are retired from the compatibility server", async (t) => {
  const port = await freePort();
  const { server } = setup(t);
  t.after(() => server.stop());
  const status = await server.start({ host: "127.0.0.1", port });

  const respond = await fetch(`${status.baseUrl}/api/agent-permissions/respond`, {
    method: "POST",
    headers: {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ requestId: "perm_1", decision: "allow_once" })
  });
  assert.equal(respond.status, 410);
  assert.deepEqual(await respond.json(), {
    error: "Agent permission routes are owned by Rust Core. Use Rust Core /api/agent-permissions."
  });

  const list = await fetch(`${status.baseUrl}/api/agent-permissions?sessionId=s1`, {
    headers: { Authorization: "Bearer secret-token" }
  });
  assert.equal(list.status, 410);
  assert.deepEqual(await list.json(), {
    error: "Agent permission routes are owned by Rust Core. Use Rust Core /api/agent-permissions."
  });
});

test("legacy chat permission routes are retired from the compatibility server", async (t) => {
  const port = await freePort();
  const { server } = setup(t);
  t.after(() => server.stop());
  const status = await server.start({ host: "127.0.0.1", port });

  const respond = await fetch(`${status.baseUrl}/api/chat/permissions/respond`, {
    method: "POST",
    headers: {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ requestId: "perm_1", decision: "allow_once" })
  });
  assert.equal(respond.status, 410);
  assert.deepEqual(await respond.json(), {
    error: "Agent permission routes are owned by Rust Core. Use Rust Core /api/agent-permissions."
  });

  const list = await fetch(`${status.baseUrl}/api/chat/permissions?sessionId=s1`, {
    headers: { Authorization: "Bearer secret-token" }
  });
  assert.equal(list.status, 410);
  assert.deepEqual(await list.json(), {
    error: "Agent permission routes are owned by Rust Core. Use Rust Core /api/agent-permissions."
  });
});

test("legacy chat send route is retired without the obsolete local-events route", async (t) => {
  const port = await freePort();
  const sendCalls = [];
  const { server } = setup(t, {
    sendChat: async (payload) => {
      sendCalls.push(payload);
      payload.emit("text_delta", { text: "hi" });
      return { ok: true, mode: "started", conversationId: payload.sessionId, engineId: "codex", turnId: "m1" };
    }
  });
  t.after(() => server.stop());
  const status = await server.start({ host: "127.0.0.1", port });

  const localEvents = await fetch(`${status.baseUrl}/api/local-events`, {
    headers: { Authorization: "Bearer secret-token" }
  });
  assert.equal(localEvents.status, 404);

  const response = await fetch(`${status.baseUrl}/api/chat/send`, {
    method: "POST",
    headers: {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      botKey: "bot-codex",
      sessionId: "conversation:1",
      messages: [{ role: "user", id: "m1", content: "hello" }]
    })
  });

  assert.equal(response.status, 410);
  assert.deepEqual(await response.json(), {
    error: "Legacy chat send is retired. Use Rust Core /api/conversations/{id}/messages."
  });
  assert.deepEqual(sendCalls, []);
  assert.equal(server.publishLocalEvent({ type: "chat:event", payload: {} }), 0);
});

test("legacy chat stream route is retired from the daemon HTTP adapter", async (t) => {
  const port = await freePort();
  const { server } = setup(t);
  t.after(() => server.stop());
  const status = await server.start({ host: "127.0.0.1", port });

  const response = await fetch(`${status.baseUrl}/api/chat/stream`, {
    method: "POST",
    headers: {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ botKey: "bot-codex", text: "hello" })
  });

  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type") || "", /application\/json/);
  assert.deepEqual(await response.json(), { error: "Not found" });
});

test("raw setting mutation routes are retired from the daemon HTTP adapter", async (t) => {
  const port = await freePort();
  const { server } = setup(t);
  t.after(() => server.stop());
  const status = await server.start({ host: "127.0.0.1", port });

  for (const route of ["/api/model/save", "/api/effort/save", "/api/permissions/save"]) {
    const response = await fetch(`${status.baseUrl}${route}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ mode: "ask", model: "mia-auto", effort: "high" })
    });
    assert.equal(response.status, 404, `${route} should be retired`);
    assert.deepEqual(await response.json(), { error: "Not found" });
  }
});

test("daemon agent workspace routes are retired from the compatibility adapter", async (t) => {
  const port = await freePort();
  const { dir, server } = setup(t);
  t.after(() => server.stop());
  const status = await server.start({ host: "127.0.0.1", port });

  const before = await fetch(`${status.baseUrl}/api/agent-workspace`, {
    headers: { Authorization: "Bearer secret-token" }
  });
  assert.equal(before.status, 404);
  assert.deepEqual(await before.json(), { error: "Not found" });

  const picked = path.join(dir, "project");
  const update = await fetch(`${status.baseUrl}/api/agent-workspace`, {
    method: "POST",
    headers: {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ path: picked })
  });

  assert.equal(update.status, 404);
  assert.deepEqual(await update.json(), { error: "Not found" });
});

test("Mia MCP context, skill, and memory routes are retired from the compatibility server", async (t) => {
  const port = await freePort();
  const { server } = setup(t);
  t.after(() => server.stop());
  const status = await server.start({ host: "127.0.0.1", port });

  const unauthorized = await fetch(`${status.baseUrl}/api/mia/context?botId=mei`);
  assert.equal(unauthorized.status, 401);

  for (const route of [
    ["/api/mia/context?botId=mei", "GET", null],
    ["/api/mia/skills/current?botId=mei", "GET", null],
    ["/api/mia/skills/current/read?botId=mei&id=demo", "GET", null],
    ["/api/mia/memory/search", "POST", { query: "memory" }],
    ["/api/mia/memory/remember", "POST", { text: "remember this" }],
    ["/api/mia/memory/update", "POST", { memoryId: "mem_1", text: "updated" }],
    ["/api/mia/memory/forget", "POST", { memoryId: "mem_1" }]
  ]) {
    const [pathname, method, body] = route;
    const response = await fetch(`${status.baseUrl}${pathname}`, {
      method,
      headers: {
        Authorization: "Bearer secret-token",
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    assert.equal(response.status, 410, pathname);
    assert.deepEqual(await response.json(), {
      error: "Mia MCP routes are owned by Rust Core. Use Rust Core /api/mia/* endpoints."
    });
  }
});

test("legacy local task routes are retired instead of being remapped in Node", async (t) => {
  const port = await freePort();
  const { calls, server } = setup(t, {
    tasksClient: () => ({
      call: async (requestPath, options = {}) => {
        calls.tasks.push({ path: requestPath, options });
        return { task: { id: "task_core_2" } };
      }
    })
  });
  t.after(() => server.stop());
  const status = await server.start({ host: "127.0.0.1", port });

  const response = await fetch(`${status.baseUrl}/api/tasks/task%2F1/run-now`, {
    method: "POST",
    headers: {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ source: "control-server" })
  });

  assert.equal(response.status, 410);
  assert.deepEqual(await response.json(), {
    error: "Legacy task routes are retired. Use Rust Core /api/tasks/jobs."
  });
  assert.deepEqual(calls.tasks, []);
});

test("local task events SSE is retired in favor of Rust Core websocket events", async (t) => {
  const port = await freePort();
  const { server } = setup(t, {
    getCloudSettings: () => ({
      enabled: true,
      token: "cloud-token",
      url: "https://cloud.example/"
    })
  });
  t.after(() => server.stop());
  const status = await server.start({ host: "127.0.0.1", port });

  const response = await fetch(`${status.baseUrl}/api/tasks/events`, {
    headers: { Authorization: "Bearer secret-token" }
  });

  assert.equal(response.status, 410);
  assert.deepEqual(await response.json(), {
    error: "Legacy task SSE is retired. Subscribe to Rust Core /ws for task events."
  });
});

test("legacy task routes do not proxy to Mia Cloud when Cloud is connected", async (t) => {
  const port = await freePort();
  const upstream = [];
  const { calls, server } = setup(t, {
    getCloudSettings: () => ({
      enabled: true,
      token: "cloud-token",
      url: "https://cloud.example/"
    }),
    normalizeCloudUrl: (value) => String(value || "").replace(/\/+$/, ""),
    fetchImpl: async (url, options = {}) => {
      upstream.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ tasks: [{ id: "t-cloud" }] })
      };
    },
    timeoutSignal: () => undefined
  });

  const status = await server.start({ host: "127.0.0.1", port });
  t.after(() => server.stop());
  assert.deepEqual(calls.tasks, []);

  const response = await fetch(`${status.baseUrl}/api/tasks`, {
    headers: { Authorization: "Bearer secret-token" }
  });
  assert.equal(response.status, 410);
  assert.deepEqual(await response.json(), {
    error: "Legacy task routes are retired. Use Rust Core /api/tasks/jobs."
  });
  assert.deepEqual(calls.tasks, []);
  assert.deepEqual(upstream, []);
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

test("ping returns the answering daemon's target from /health", async (t) => {
  const target = { kind: "rust-core", command: "mia-core", usesGuiAppIdentity: false, workingDirectory: "/repo" };
  const { dir, server, setDaemonSettings } = setup(t, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ status: "ok", service: "mia-daemon", mode: "daemon", version: "1.2.3", pid: 9876, runtimeHome: path.join(dir, "home"), daemonTarget: target })
    })
  });
  const port = await freePort();
  setDaemonSettings({ port });

  const probe = await server.ping(undefined, 500, { expectedRuntimeHome: path.join(dir, "home") });
  assert.equal(probe.ok, true);
  assert.equal(probe.mode, "daemon");
  assert.equal(probe.version, "1.2.3");
  assert.equal(probe.pid, 9876);
  assert.deepEqual(probe.daemonTarget, target);
});

test("ping reports daemonTarget null when /health omits it", async (t) => {
  const { dir, server, setDaemonSettings } = setup(t, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ status: "ok", service: "mia-daemon", mode: "daemon", runtimeHome: path.join(dir, "home") })
    })
  });
  const port = await freePort();
  setDaemonSettings({ port });
  const probe = await server.ping(undefined, 500, { expectedRuntimeHome: path.join(dir, "home") });
  assert.equal(probe.daemonTarget, null);
});

test("shouldReuseCore rejects a GUI-identity daemon and missing/version-mismatched targets", () => {
  const v = "2.0.0";
  const target = { kind: "rust-core", command: "mia-core", usesGuiAppIdentity: false, workingDirectory: "/repo" };
  // Reuse: rust-core, matching version, non-GUI identity.
  assert.equal(shouldReuseCore({ ok: true, mode: "daemon", version: v, daemonTarget: { kind: "rust-core", usesGuiAppIdentity: false } }, v), true);
  assert.equal(shouldReuseCore({ ok: true, mode: "daemon", version: v, daemonTarget: target }, v, { expectedCoreTarget: target }), true);
  assert.equal(shouldReuseCore(
    { ok: true, mode: "daemon", version: v, daemonTarget: { ...target, sourceFingerprint: "old" } },
    v,
    { expectedCoreTarget: { ...target, sourceFingerprint: "new" } }
  ), false);
  assert.equal(shouldReuseCore(
    { ok: true, mode: "daemon", version: v, daemonTarget: { ...target, workingDirectory: "/Applications/Mia.app/Contents/Resources/app.asar.unpacked" } },
    v,
    { expectedCoreTarget: target }
  ), false);
  assert.equal(shouldReuseCore(
    { ok: true, mode: "daemon", version: v, daemonTarget: { ...target, parentPid: 111 } },
    v,
    { expectedCoreTarget: { ...target, parentPid: 222 } }
  ), false);
  // Reject: GUI app identity (old Electron --daemon) must migrate to rust-core.
  assert.equal(shouldReuseCore({ ok: true, mode: "daemon", version: v, daemonTarget: { kind: "legacy-gui", usesGuiAppIdentity: true } }, v), false);
  // Reject: no daemonTarget reported (pre-migration build).
  assert.equal(shouldReuseCore({ ok: true, mode: "daemon", version: v }, v), false);
  // Reject: version mismatch.
  assert.equal(shouldReuseCore({ ok: true, mode: "daemon", version: "1.0.0", daemonTarget: { kind: "rust-core", usesGuiAppIdentity: false } }, v), false);
  // Reject: not reachable / not a daemon.
  assert.equal(shouldReuseCore({ ok: false }, v), false);
  assert.equal(shouldReuseCore({ ok: true, mode: "desktop", version: v, daemonTarget: { kind: "rust-core", usesGuiAppIdentity: false } }, v), false);
});

test("status and health report the resolved daemon target", async (t) => {
  const target = { kind: "packaged-helper", command: "Mia Core", usesGuiAppIdentity: false, workingDirectory: "/x" };
  const { server } = setup(t, { describeCoreTarget: () => target });

  assert.deepEqual(server.status().daemonTarget, target);

  const port = await freePort();
  await server.start({ host: "127.0.0.1", port });
  t.after(() => server.stop());
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  const body = await res.json();
  assert.deepEqual(body.daemonTarget, target);
});
