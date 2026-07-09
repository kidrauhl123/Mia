const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createRemoteControlRouter } = require("../src/main/remote/remote-control-router.js");

function setup(overrides = {}) {
  const calls = {
    effortWrites: [],
    permissionWrites: [],
    modelSelections: [],
    cancellations: [],
    remoteChats: [],
    stream: [],
    attachments: [],
    files: [],
    commands: []
  };
  const router = createRemoteControlRouter({
    isDaemonProcess: false,
    getRuntimeStatus: () => {
      calls.status = true;
      return { runtime: true };
    },
    loadHermesModelCatalog: async () => {
      calls.catalog = true;
      return ["hermes-model"];
    },
    loadCodexModels: () => {
      calls.codexModels = true;
      return ["codex-model"];
    },
    loadEngineCapabilities: async () => {
      calls.capabilities = true;
      return { hermes: true };
    },
    loadHermesSlashCommands: async () => {
      calls.slash = true;
      return [{ name: "/help" }];
    },
    loadExternalAgentCommands: async (input) => {
      calls.agentList = input;
      return { commands: [], input };
    },
    saveChatAttachment: (body) => calls.attachments.push(body),
    readLocalFileAttachment: (body) => calls.files.push(body),
    executeExternalAgentCommand: (body) => calls.commands.push(body),
    saveModelSelection: async (body) => calls.modelSelections.push(body),
    writeEffortSettings: (body) => calls.effortWrites.push(body),
    writePermissionSettings: (body) => calls.permissionWrites.push(body),
    cancelConversationTurn: async (input) => {
      calls.cancellations.push(input);
      return { ok: true, cancelled: true, conversationId: input.conversationId, turnId: input.turnId };
    },
    ...overrides
  });
  return { calls, router };
}

test("retired remote status, catalog, attachment, and command routes are not exposed", async () => {
  const { calls, router } = setup();

  for (const route of [
    { method: "GET", path: "/health" },
    { method: "GET", path: "/api/runtime/status" },
    { method: "GET", path: "/api/model/catalog" },
    { method: "GET", path: "/api/codex/models" },
    { method: "GET", path: "/api/engine/capabilities" },
    { method: "GET", path: "/api/commands/slash" },
    { method: "GET", path: "/api/commands/agent-list?engine=codex" },
    { method: "POST", path: "/api/chat/attachment", body: { dataUrl: "data:text/plain;base64,aGk=" } },
    { method: "POST", path: "/api/file/fetch", body: { path: "/tmp/file.txt" } },
    { method: "POST", path: "/api/commands/agent-execute", body: { command: "/resume" } }
  ]) {
    assert.deepEqual(await router.route(route), { handled: false }, route.path);
  }

  assert.equal(calls.status, undefined);
  assert.equal(calls.catalog, undefined);
  assert.equal(calls.codexModels, undefined);
  assert.equal(calls.capabilities, undefined);
  assert.equal(calls.slash, undefined);
  assert.equal(calls.agentList, undefined);
  assert.deepEqual(calls.attachments, []);
  assert.deepEqual(calls.files, []);
  assert.deepEqual(calls.commands, []);
});

test("retired local bot identity routes are not exposed through remote control", async () => {
  const { router } = setup();

  assert.deepEqual(await router.route({ method: "GET", path: "/api/bots" }), { handled: false });
  assert.deepEqual(await router.route({ method: "POST", path: "/api/bot/engine", body: { key: "codex" } }), { handled: false });
});

test("retired model, effort, and permission mutation routes are not exposed through remote control", async () => {
  const { calls, router } = setup();

  assert.deepEqual(await router.route({
    method: "POST",
    path: "/api/model/save",
    body: { provider: "anthropic", model: "claude", baseUrl: "https://api.example" }
  }), { handled: false });
  assert.deepEqual(await router.route({
    method: "POST",
    path: "/api/effort/save",
    body: { effort: "high" }
  }), { handled: false });
  assert.deepEqual(await router.route({
    method: "POST",
    path: "/api/permissions/save",
    body: { mode: "ask" }
  }), { handled: false });

  assert.deepEqual(calls.modelSelections, []);
  assert.deepEqual(calls.effortWrites, []);
  assert.deepEqual(calls.permissionWrites, []);
});

test("retired chat stop compatibility route is not exposed through remote control", async () => {
  const { calls, router } = setup();

  const result = await router.route({
    method: "POST",
    path: "/api/chat/stop",
    body: { conversationId: "g_1", runId: "local_1" }
  });

  assert.deepEqual(calls.remoteChats, []);
  assert.deepEqual(result, { handled: false });
});

test("retired chat send compatibility route is not exposed through remote control", async () => {
  const { calls, router } = setup();

  const result = await router.route({
    method: "POST",
    path: "/api/chat/send",
    body: { sessionId: "conversation:1", body: "hello" }
  });

  assert.deepEqual(calls.remoteChats, []);
  assert.deepEqual(result, { handled: false });
});

test("routes typed Core turn cancellation without the retired chat stop adapter", async () => {
  const { calls, router } = setup();

  const result = await router.route({
    method: "POST",
    path: "/api/conversations/conv%2F1/turns/turn%2F1/cancel",
    body: { ignored: true }
  });

  assert.deepEqual(calls.cancellations, [{
    conversationId: "conv/1",
    turnId: "turn/1",
    body: { ignored: true }
  }]);
  assert.deepEqual(result, {
    handled: true,
    data: {
      ok: true,
      cancelled: true,
      conversationId: "conv/1",
      turnId: "turn/1"
    }
  });
});

test("retired chat stream compatibility route is not exposed through remote control", async () => {
  const { calls, router } = setup();

  const result = await router.route({
    method: "POST",
    path: "/api/chat/stream",
    body: { botKey: "codex", text: "hello" },
    emitStream: (event, data) => calls.stream.push({ event, data })
  });

  assert.deepEqual(calls.remoteChats, []);
  assert.deepEqual(calls.stream, []);
  assert.deepEqual(result, { handled: false });
});

test("returns handled=false for unknown routes instead of choosing an adapter response", async () => {
  const { router } = setup();

  assert.deepEqual(await router.route({ method: "GET", path: "/api/nope" }), { handled: false });
});

test("does not expose legacy local chat session store routes", async () => {
  const { router } = setup();

  assert.deepEqual(await router.route({ method: "GET", path: "/api/chat/sessions" }), { handled: false });
  assert.deepEqual(await router.route({ method: "POST", path: "/api/chat/session", body: { personaKey: "f" } }), { handled: false });
  assert.deepEqual(await router.route({ method: "POST", path: "/api/chat/session/save", body: { personaKey: "f" } }), { handled: false });
  assert.deepEqual(await router.route({ method: "POST", path: "/api/chat/session/rename", body: { personaKey: "f" } }), { handled: false });
  assert.deepEqual(await router.route({ method: "POST", path: "/api/chat/read-state/save", body: { readAt: { f: "t" } } }), { handled: false });
});
