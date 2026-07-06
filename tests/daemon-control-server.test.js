const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { freePort } = require("./helpers/free-port.js");
const { createDaemonControlServer, shouldReuseDaemon } = require("../src/main/daemon/control-server.js");

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
  assert.equal(calls.scheduler, 1);

  server.stop();
});

test("daemon permission routes resolve and list coordinator-owned requests", async (t) => {
  const port = await freePort();
  const permissionCalls = [];
  const { server } = setup(t, {
    agentPermissionCoordinator: {
      resolvePermission: (payload) => {
        permissionCalls.push({ type: "resolve", payload });
        return { ok: true };
      },
      listPending: (filter) => {
        permissionCalls.push({ type: "list", filter });
        return [{ requestId: "perm_1", sessionId: filter.sessionId }];
      }
    }
  });
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
  assert.deepEqual(await respond.json(), { ok: true });

  const list = await fetch(`${status.baseUrl}/api/chat/permissions?sessionId=s1`, {
    headers: { Authorization: "Bearer secret-token" }
  });
  assert.deepEqual(await list.json(), { requests: [{ requestId: "perm_1", sessionId: "s1" }] });
  assert.deepEqual(permissionCalls, [
    { type: "resolve", payload: { requestId: "perm_1", decision: "allow_once" } },
    { type: "list", filter: { sessionId: "s1" } }
  ]);
});

test("daemon chat send delegates to Core and publishes chat events locally", async (t) => {
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

  const received = [];
  const stream = await fetch(`${status.baseUrl}/api/local-events`, {
    headers: { Authorization: "Bearer secret-token" }
  });
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  await reader.read(); // connected comment

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

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    mode: "started",
    conversationId: "conversation:1",
    engineId: "codex",
    turnId: "m1"
  });
  assert.equal(sendCalls.length, 1);
  assert.equal(typeof sendCalls[0].emit, "function");
  const chunk = decoder.decode((await reader.read()).value);
  for (const block of chunk.split("\n\n")) {
    const line = block.split("\n").find((entry) => entry.startsWith("data: "));
    if (!line) continue;
    received.push(JSON.parse(line.slice(6)));
  }
  await reader.cancel();

  assert.deepEqual(received, [{
    type: "chat:event",
    payload: {
      runId: received[0].payload.runId,
      sessionId: "conversation:1",
      seq: 1,
      kind: "text_delta",
      data: { text: "hi" },
      ts: received[0].payload.ts
    }
  }]);
});

test("daemon owns agent workspace read and write routes", async (t) => {
  const port = await freePort();
  const writes = [];
  let customWorkspace = "";
  const { dir, server } = setup(t, {
    getAgentWorkspace: () => ({
      path: customWorkspace || path.join(dir, "home", "workspace"),
      custom: customWorkspace,
      default: path.join(dir, "home", "workspace")
    }),
    writeAgentWorkspace: (workspacePath) => {
      customWorkspace = String(workspacePath || "").trim();
      writes.push(customWorkspace);
      return {
        path: customWorkspace || path.join(dir, "home", "workspace"),
        custom: customWorkspace,
        default: path.join(dir, "home", "workspace")
      };
    }
  });
  t.after(() => server.stop());
  const status = await server.start({ host: "127.0.0.1", port });

  const before = await fetch(`${status.baseUrl}/api/agent-workspace`, {
    headers: { Authorization: "Bearer secret-token" }
  });
  assert.equal(before.status, 200);
  assert.deepEqual(await before.json(), {
    path: path.join(dir, "home", "workspace"),
    custom: "",
    default: path.join(dir, "home", "workspace")
  });

  const picked = path.join(dir, "project");
  const update = await fetch(`${status.baseUrl}/api/agent-workspace`, {
    method: "POST",
    headers: {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ path: picked })
  });

  assert.equal(update.status, 200);
  assert.deepEqual(await update.json(), {
    path: picked,
    custom: picked,
    default: path.join(dir, "home", "workspace")
  });
  assert.deepEqual(writes, [picked]);
});

test("daemon exposes authorized scoped Mia context snapshots for MCP tools", async (t) => {
  const port = await freePort();
  const snapshotCalls = [];
  const { server } = setup(t, {
    getMiaContextSnapshot: (scope) => {
      snapshotCalls.push(scope);
      return {
        botId: scope.botId,
        sessionId: scope.sessionId,
        originMessageId: scope.originMessageId,
        persona: "persona",
        memory: "",
        memoryTools: { enabled: true, search: "memory_search", remember: "memory_remember", update: "memory_update", forget: "memory_forget" }
      };
    }
  });
  t.after(() => server.stop());
  const status = await server.start({ host: "127.0.0.1", port });

  const unauthorized = await fetch(`${status.baseUrl}/api/mia/context?botId=mei&sessionId=s1`);
  assert.equal(unauthorized.status, 401);

  const authorized = await fetch(`${status.baseUrl}/api/mia/context?botId=mei&sessionId=s1&originMessageId=m1`, {
    headers: { Authorization: "Bearer secret-token" }
  });
  assert.deepEqual(await authorized.json(), {
    botId: "mei",
    sessionId: "s1",
    originMessageId: "m1",
    persona: "persona",
    memory: "",
    memoryTools: { enabled: true, search: "memory_search", remember: "memory_remember", update: "memory_update", forget: "memory_forget" }
  });
  assert.deepEqual(snapshotCalls, [{ botId: "mei", sessionId: "s1", originMessageId: "m1" }]);
});

test("daemon exposes current-bot scoped Mia skill routes for MCP tools", async (t) => {
  const port = await freePort();
  const skillCalls = [];
  const { server } = setup(t, {
    getMiaCurrentSkills: (scope) => {
      skillCalls.push(scope);
      if (scope.skillId === "missing") throw new Error("Skill is not enabled for the current bot.");
      if (scope.skillId) {
        return {
          botId: scope.botId || "mia",
          skill: {
            id: scope.skillId,
            name: "Demo Skill",
            description: "Demo.",
            bodyChars: 13,
            body: "# Demo Skill"
          }
        };
      }
      return {
        botId: scope.botId || "mia",
        skills: [{ id: "demo", name: "Demo Skill", description: "Demo.", bodyChars: 13 }]
      };
    }
  });
  t.after(() => server.stop());
  const status = await server.start({ host: "127.0.0.1", port });

  const unauthorized = await fetch(`${status.baseUrl}/api/mia/skills/current?botId=mei`);
  assert.equal(unauthorized.status, 401);

  const list = await fetch(`${status.baseUrl}/api/mia/skills/current?botId=mei`, {
    headers: { Authorization: "Bearer secret-token" }
  });
  assert.deepEqual(await list.json(), {
    botId: "mei",
    skills: [{ id: "demo", name: "Demo Skill", description: "Demo.", bodyChars: 13 }]
  });

  const read = await fetch(`${status.baseUrl}/api/mia/skills/current/read?botId=mei&id=demo`, {
    headers: { Authorization: "Bearer secret-token" }
  });
  assert.deepEqual(await read.json(), {
    botId: "mei",
    skill: {
      id: "demo",
      name: "Demo Skill",
      description: "Demo.",
      bodyChars: 13,
      body: "# Demo Skill"
    }
  });

  const missing = await fetch(`${status.baseUrl}/api/mia/skills/current/read?botId=mei&id=missing`, {
    headers: { Authorization: "Bearer secret-token" }
  });
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /not enabled/);

  assert.deepEqual(skillCalls, [
    { botId: "mei" },
    { botId: "mei", skillId: "demo" },
    { botId: "mei", skillId: "missing" }
  ]);
});

test("daemon memory search prefers async deep search when available", async (t) => {
  const port = await freePort();
  const memoryCalls = [];
  const { server } = setup(t, {
    miaMemoryService: {
      searchMemories: () => {
        throw new Error("sync search should not be used");
      },
      searchMemoriesDeep: async (input) => {
        memoryCalls.push(input);
        return [{ id: "mem_semantic", text: "semantic memory", scope: "bot" }];
      }
    }
  });
  t.after(() => server.stop());
  const status = await server.start({ host: "127.0.0.1", port });

  const response = await fetch(`${status.baseUrl}/api/mia/memory/search`, {
    method: "POST",
    headers: {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      context: { userId: "u_ctx", botId: "mei", sessionId: "s1" },
      botId: "malicious-bot",
      sessionId: "malicious-session",
      query: "food preference",
      limit: 7
    })
  });

  assert.deepEqual(await response.json(), {
    memories: [{ id: "mem_semantic", text: "semantic memory", scope: "bot" }]
  });
  assert.deepEqual(memoryCalls, [{
    query: "food preference",
    limit: 7,
    scopes: undefined,
    kinds: undefined,
    status: "active",
    userId: "u_ctx",
    botId: "mei",
    sessionId: "s1"
  }]);
});

test("daemon Mia memory tools no-op when Mia memory is disabled", async (t) => {
  const port = await freePort();
  const memoryCalls = [];
  const { server } = setup(t, {
    isMemoryEnabled: () => false,
    miaMemoryService: {
      searchMemories: (input) => {
        memoryCalls.push({ type: "search", input });
        return [];
      },
      rememberMemory: (input) => {
        memoryCalls.push({ type: "remember", input });
        return { status: "active" };
      },
      updateMemory: (input) => {
        memoryCalls.push({ type: "update", input });
        return { status: "active" };
      },
      forgetMemory: (input) => {
        memoryCalls.push({ type: "forget", input });
        return { status: "deleted" };
      }
    }
  });
  t.after(() => server.stop());
  const status = await server.start({ host: "127.0.0.1", port });

  async function post(pathname, body) {
    return fetch(`${status.baseUrl}${pathname}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }).then((response) => response.json());
  }

  assert.deepEqual(await post("/api/mia/memory/search", { query: "food" }), {
    memories: [],
    disabled: true,
    reason: "mia_memory_disabled"
  });

  const disabled = {
    status: "disabled",
    disabled: true,
    reason: "mia_memory_disabled",
    error: "Mia memory is disabled."
  };
  assert.deepEqual(await post("/api/mia/memory/remember", { text: "remember this" }), disabled);
  assert.deepEqual(await post("/api/mia/memory/update", { memoryId: "mem_1", text: "updated" }), disabled);
  assert.deepEqual(await post("/api/mia/memory/forget", { memoryId: "mem_1" }), disabled);
  assert.deepEqual(memoryCalls, []);
});

test("daemon exposes scoped Mia memory routes for MCP tools", async (t) => {
  const port = await freePort();
  const memoryCalls = [];
  const { server } = setup(t, {
    miaMemoryService: {
      searchMemories: (input) => {
        memoryCalls.push({ type: "search", input });
        return [{ id: "mem_1", text: "visible memory", scope: "bot" }];
      },
      rememberMemory: (input) => {
        memoryCalls.push({ type: "remember", input });
        return { status: "active", effectiveScope: input.scope, memoryId: "mem_2" };
      },
      updateMemory: (input) => {
        memoryCalls.push({ type: "update", input });
        return { status: "active", effectiveScope: "bot", memoryId: input.memoryId };
      },
      forgetMemory: (input) => {
        memoryCalls.push({ type: "forget", input });
        return { status: "deleted", effectiveScope: "bot", memoryId: input.memoryId };
      }
    }
  });
  t.after(() => server.stop());
  const status = await server.start({ host: "127.0.0.1", port });

  const search = await fetch(`${status.baseUrl}/api/mia/memory/search`, {
    method: "POST",
    headers: {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      context: { userId: "u_ctx", botId: "mei", sessionId: "s1", originMessageId: "msg_1" },
      botId: "malicious-bot",
      sessionId: "malicious-session",
      query: "memory",
      scopes: ["bot"],
      limit: 5
    })
  });
  assert.deepEqual(await search.json(), { memories: [{ id: "mem_1", text: "visible memory", scope: "bot" }] });

  const remember = await fetch(`${status.baseUrl}/api/mia/memory/remember`, {
    method: "POST",
    headers: {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      context: { userId: "u_ctx", botId: "mei", sessionId: "s1", originMessageId: "msg_1", engine: "hermes" },
      botId: "malicious-bot",
      sessionId: "malicious-session",
      text: "remember this",
      scope: "bot",
      kind: "fact",
      confidence: 0.9,
      priority: 25
    })
  });
  assert.deepEqual(await remember.json(), { status: "active", effectiveScope: "bot", memoryId: "mem_2" });

  const update = await fetch(`${status.baseUrl}/api/mia/memory/update`, {
    method: "POST",
    headers: {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      context: { userId: "u_ctx", botId: "mei", sessionId: "s1", originMessageId: "msg_2", engine: "hermes" },
      botId: "malicious-bot",
      sessionId: "malicious-session",
      memoryId: "mem_2",
      text: "updated memory",
      kind: "preference",
      confidence: 0.8,
      priority: 40
    })
  });
  assert.deepEqual(await update.json(), { status: "active", effectiveScope: "bot", memoryId: "mem_2" });

  const forget = await fetch(`${status.baseUrl}/api/mia/memory/forget`, {
    method: "POST",
    headers: {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      context: { userId: "u_ctx", botId: "mei", sessionId: "s1", originMessageId: "msg_4" },
      botId: "malicious-bot",
      sessionId: "malicious-session",
      memoryId: "mem_2",
      reason: "obsolete"
    })
  });
  assert.deepEqual(await forget.json(), { status: "deleted", effectiveScope: "bot", memoryId: "mem_2" });

  assert.deepEqual(memoryCalls, [
    {
      type: "search",
      input: {
        query: "memory",
        limit: 5,
        scopes: ["bot"],
        kinds: undefined,
        status: "active",
        userId: "u_ctx",
        botId: "mei",
        sessionId: "s1"
      }
    },
    {
      type: "remember",
      input: {
        text: "remember this",
        scope: "bot",
        kind: "fact",
        confidence: 0.9,
        priority: 25,
        reason: undefined,
        source: "agent_tool",
        originEngine: "hermes",
        originNativeSessionId: "",
        sourceMessageIds: ["msg_1"],
        linkedMemoryIds: undefined,
        metadata: {},
        userId: "u_ctx",
        botId: "mei",
        sessionId: "s1"
      }
    },
    {
      type: "update",
      input: {
        memoryId: "mem_2",
        oldText: undefined,
        text: "updated memory",
        scope: undefined,
        kind: "preference",
        confidence: 0.8,
        priority: 40,
        reason: undefined,
        source: "agent_tool",
        originEngine: "hermes",
        originNativeSessionId: "",
        sourceMessageIds: ["msg_2"],
        linkedMemoryIds: undefined,
        metadata: {},
        userId: "u_ctx",
        botId: "mei",
        sessionId: "s1"
      }
    },
    {
      type: "forget",
      input: {
        memoryId: "mem_2",
        oldText: undefined,
        scope: undefined,
        reason: "obsolete",
        userId: "u_ctx",
        botId: "mei",
        sessionId: "s1"
      }
    }
  ]);
});

test("cloud task proxy forwards daemon task calls without starting local scheduler", async (t) => {
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
  assert.equal(calls.scheduler, 0);

  const response = await fetch(`${status.baseUrl}/api/tasks`, {
    headers: { Authorization: "Bearer secret-token" }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { tasks: [{ id: "t-cloud" }] });
  assert.equal(upstream[0].url, "https://cloud.example/api/tasks");
  assert.equal(upstream[0].options.headers.Authorization, "Bearer cloud-token");
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
  const target = { kind: "node-core", command: "node", usesGuiAppIdentity: false, workingDirectory: "/repo/src/core" };
  const { dir, server, setDaemonSettings } = setup(t, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ status: "ok", service: "mia-daemon", mode: "daemon", version: "1.2.3", runtimeHome: path.join(dir, "home"), daemonTarget: target })
    })
  });
  const port = await freePort();
  setDaemonSettings({ port });

  const probe = await server.ping(undefined, 500, { expectedRuntimeHome: path.join(dir, "home") });
  assert.equal(probe.ok, true);
  assert.equal(probe.mode, "daemon");
  assert.equal(probe.version, "1.2.3");
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

test("shouldReuseDaemon rejects a GUI-identity daemon and missing/version-mismatched targets", () => {
  const v = "2.0.0";
  const target = { kind: "node-core", command: "node", usesGuiAppIdentity: false, workingDirectory: "/repo/src/core" };
  // Reuse: node-core, matching version, non-GUI identity.
  assert.equal(shouldReuseDaemon({ ok: true, mode: "daemon", version: v, daemonTarget: { kind: "node-core", usesGuiAppIdentity: false } }, v), true);
  assert.equal(shouldReuseDaemon({ ok: true, mode: "daemon", version: v, daemonTarget: target }, v, { expectedDaemonTarget: target }), true);
  assert.equal(shouldReuseDaemon(
    { ok: true, mode: "daemon", version: v, daemonTarget: { ...target, sourceFingerprint: "old" } },
    v,
    { expectedDaemonTarget: { ...target, sourceFingerprint: "new" } }
  ), false);
  assert.equal(shouldReuseDaemon(
    { ok: true, mode: "daemon", version: v, daemonTarget: { ...target, workingDirectory: "/Applications/Mia.app/Contents/Resources/app.asar.unpacked/src/core" } },
    v,
    { expectedDaemonTarget: target }
  ), false);
  // Reject: GUI app identity (old Electron --daemon) → must migrate to node-core.
  assert.equal(shouldReuseDaemon({ ok: true, mode: "daemon", version: v, daemonTarget: { kind: "legacy-gui", usesGuiAppIdentity: true } }, v), false);
  // Reject: no daemonTarget reported (pre-migration build).
  assert.equal(shouldReuseDaemon({ ok: true, mode: "daemon", version: v }, v), false);
  // Reject: version mismatch.
  assert.equal(shouldReuseDaemon({ ok: true, mode: "daemon", version: "1.0.0", daemonTarget: { kind: "node-core", usesGuiAppIdentity: false } }, v), false);
  // Reject: not reachable / not a daemon.
  assert.equal(shouldReuseDaemon({ ok: false }, v), false);
  assert.equal(shouldReuseDaemon({ ok: true, mode: "desktop", version: v, daemonTarget: { kind: "node-core", usesGuiAppIdentity: false } }, v), false);
});

test("status and health report the resolved daemon target", async (t) => {
  const target = { kind: "packaged-helper", command: "Mia Core", usesGuiAppIdentity: false, workingDirectory: "/x" };
  const { server } = setup(t, { describeDaemonTarget: () => target });

  assert.deepEqual(server.status().daemonTarget, target);

  const port = await freePort();
  await server.start({ host: "127.0.0.1", port });
  t.after(() => server.stop());
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  const body = await res.json();
  assert.deepEqual(body.daemonTarget, target);
});
