const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createRemoteControlRouter } = require("../src/main/remote/remote-control-router.js");

function setup(overrides = {}) {
  const calls = {
    effortWrites: [],
    permissionWrites: [],
    modelSelections: [],
    remoteChats: [],
    stream: []
  };
  const router = createRemoteControlRouter({
    isDaemonProcess: false,
    getRuntimeStatus: () => ({ runtime: true }),
    loadFellowManifest: () => ({ fellows: [{ key: "codex" }], default_fellow: "codex" }),
    loadChatSessions: () => ({ sessions: [] }),
    loadHermesModelCatalog: async () => ["hermes-model"],
    loadCodexModels: () => ["codex-model"],
    loadEngineCapabilities: async () => ({ hermes: true }),
    loadHermesSlashCommands: async () => [{ name: "/help" }],
    loadExternalAgentCommands: async (input) => ({ commands: [], input }),
    newChatSession: (body) => ({ newSession: body }),
    saveChatSession: (body) => ({ savedSession: body }),
    saveChatAttachment: (body) => ({ attachment: body }),
    readLocalFileAttachment: (body) => ({ file: body }),
    executeExternalAgentCommand: (body) => ({ command: body }),
    saveFellowEngineConfig: (body) => ({ fellowEngine: body }),
    saveModelSelection: async (body) => {
      calls.modelSelections.push(body);
      return { runtime: true };
    },
    writeEffortSettings: (body) => calls.effortWrites.push(body),
    writePermissionSettings: (body) => calls.permissionWrites.push(body),
    stopChat: () => ({ stopped: true }),
    runRemoteChatRequest: async (body, eventSink = null) => {
      calls.remoteChats.push({ body, eventSink });
      if (eventSink) eventSink.send("chat", { delta: "hello" });
      return { fellow: { key: "codex" }, session: { id: "s_1" }, response: { text: "done" } };
    },
    ...overrides
  });
  return { calls, router };
}

test("routes health and read endpoints through one remote control router", async () => {
  const { router } = setup();

  assert.deepEqual(await router.route({ method: "GET", path: "/health" }), {
    handled: true,
    data: { status: "ok", service: "aimashi-daemon", mode: "desktop" }
  });
  assert.deepEqual(await router.route({ method: "GET", path: "/api/fellows" }), {
    handled: true,
    data: { fellows: [{ key: "codex" }], defaultFellow: "codex" }
  });
  assert.deepEqual(await router.route({ method: "GET", path: "/api/commands/agent-list?engine=codex" }), {
    handled: true,
    data: { commands: [], input: { engine: "codex" } }
  });
});

test("routes model, effort, and permission mutations without duplicating adapters", async () => {
  const { calls, router } = setup();

  assert.deepEqual(await router.route({
    method: "POST",
    path: "/api/model/save",
    body: { provider: "anthropic", model: "claude", baseUrl: "https://api.example" }
  }), { handled: true, data: { runtime: true } });
  await router.route({ method: "POST", path: "/api/effort/save", body: { effort: "high" } });
  await router.route({ method: "POST", path: "/api/permissions/save", body: { mode: "ask" } });

  assert.deepEqual(calls.modelSelections, [{
    provider: "anthropic",
    model: "claude",
    baseUrl: "https://api.example"
  }]);
  assert.deepEqual(calls.effortWrites, [{ effort: "high" }]);
  assert.deepEqual(calls.permissionWrites, [{ mode: "ask" }]);
});

test("routes chat stream by emitting chat and result events before done", async () => {
  const { calls, router } = setup();

  const result = await router.route({
    method: "POST",
    path: "/api/chat/stream",
    body: { fellowKey: "codex", text: "hello" },
    emitStream: (event, data) => calls.stream.push({ event, data })
  });

  assert.equal(calls.remoteChats.length, 1);
  assert.deepEqual(calls.stream, [
    { event: "chat", data: { delta: "hello" } },
    { event: "result", data: { fellow: { key: "codex" }, session: { id: "s_1" }, response: { text: "done" } } }
  ]);
  assert.deepEqual(result, { handled: true, data: { done: true } });
});

test("returns handled=false for unknown routes instead of choosing an adapter response", async () => {
  const { router } = setup();

  assert.deepEqual(await router.route({ method: "GET", path: "/api/nope" }), { handled: false });
});
