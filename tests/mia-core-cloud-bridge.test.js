const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createMiaCore,
  createCoreBotExecution,
  createCoreCloudBridge
} = require("../src/core/mia-core.js");

function mockWebSocketClass() {
  const sockets = [];
  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;

    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = MockWebSocket.CONNECTING;
      this.handlers = {};
      this.sent = [];
      this.closed = null;
      this.pings = 0;
      sockets.push(this);
    }
    on(name, handler) { this.handlers[name] = handler; }
    emit(name, arg) { if (this.handlers[name]) this.handlers[name](arg); }
    send(payload) { this.sent.push(JSON.parse(String(payload))); }
    ping() { this.pings += 1; }
    terminate() { this.terminated = true; this.readyState = MockWebSocket.CLOSED; this.emit("close"); }
    close(code, reason) {
      this.readyState = MockWebSocket.CLOSED;
      this.closed = { code, reason };
    }
  }
  return { MockWebSocket, sockets };
}

function makeRuntimePaths() {
  return () => ({
    botManifest: "/dev/null/does-not-exist",
    botDir: "/dev/null",
    workspace: "/tmp/mia-core-cloud-bridge-workspace"
  });
}

function buildHarness({ enabled = true, token = "tok_core" } = {}) {
  const managerCalls = [];
  const sendHermesChatSeen = [];
  const agentSessionManager = {
    sendUserInput: async (input) => {
      managerCalls.push(input);
      return {
        ok: true,
        mode: "started",
        conversationId: input.conversationId,
        engineId: input.engineId,
        turnId: input.turnId
      };
    },
    cancelActive: async () => true,
    closeAllSessions: async () => {}
  };
  const botExecution = createCoreBotExecution({
    runtimePaths: makeRuntimePaths(),
    settingsStore: { daemonSettings: () => ({ enabled: false }) },
    hermesBaseUrl: "",
    apiKey: "test-key",
    sendHermesChat: async (context) => {
      sendHermesChatSeen.push(context);
      throw new Error("legacy Hermes HTTP path should not run");
    },
    localAgentEngineService: {
      shellCommandPath: () => "",
      processEnvWithCliPath: () => ({ PATH: "" }),
      agentRuntimeEnv: () => ({}),
      resolveAgentRuntime: () => null,
      localAgentEngines: () => ({})
    },
    agentSessionManager
  });

  const localEvents = [];
  const settingsStore = {
    cloudSettings: () => ({ enabled, token, url: "https://cloud.example", user: { id: "u_1" } })
  };
  const { MockWebSocket, sockets } = mockWebSocketClass();
  const bridge = createCoreCloudBridge({
    settingsStore,
    botExecution,
    WebSocketImpl: MockWebSocket,
    emitLocalEvent: (envelope) => localEvents.push(envelope),
    deviceId: "device_core_fixture",
    version: "0.0.0-test",
    log: () => {}
  });

  return { bridge, sockets, MockWebSocket, managerCalls, sendHermesChatSeen, localEvents };
}

test("bridge run frame routes Hermes chat through AgentSession and returns the managed completion envelope", async () => {
  const { bridge, sockets, MockWebSocket, managerCalls, sendHermesChatSeen } = buildHarness({ enabled: true });
  bridge.start();
  assert.equal(sockets.length, 1);
  const ws = sockets[0];
  ws.readyState = MockWebSocket.OPEN;

  ws.emit("message", JSON.stringify({ type: "bridge_ready", deviceId: "dev_1" }));
  bridge.handleMessage(ws, JSON.stringify({
    type: "run",
    runId: "run_1",
    conversationId: "c_1",
    text: "hello core bridge",
    botId: "bot1",
    botName: "Bot One",
    runtimeConfig: { agentEngine: "hermes" }
  }));

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sendHermesChatSeen.length, 0);
  assert.equal(managerCalls.length, 1);
  assert.equal(managerCalls[0].conversationId, "cloud:c_1");
  assert.equal(managerCalls[0].engineId, "hermes");
  assert.equal(managerCalls[0].text, "hello core bridge");
  assert.equal(typeof managerCalls[0].workspacePath, "string");
  assert.ok(
    ws.sent.some((message) => message.type === "run_event" && message.event?.kind === "session_started"),
    "expected session_started run_event from AgentSession-managed bridge run"
  );
  assert.deepEqual(ws.sent.find((message) => message.type === "run_result"), {
    type: "run_result",
    runId: "run_1",
    ok: true,
    text: "本机 Hermes 已完成。",
    attachments: []
  });

  bridge.stop();
  assert.equal(ws.closed?.code, 1000);
});

test("a codex bridge run also routes through AgentSession instead of local bridge-side CLI execution", async () => {
  const { bridge, sockets, MockWebSocket, managerCalls } = buildHarness({ enabled: true });
  bridge.start();
  const ws = sockets[0];
  ws.readyState = MockWebSocket.OPEN;

  bridge.handleMessage(ws, JSON.stringify({
    type: "run",
    runId: "run_codex",
    conversationId: "c_2",
    text: "run codex",
    botId: "bot2",
    botName: "Bot Two",
    runtimeConfig: { agentEngine: "codex" }
  }));

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(managerCalls.length, 1);
  assert.equal(managerCalls[0].engineId, "codex");
  assert.equal(managerCalls[0].conversationId, "cloud:c_2");
  const result = ws.sent.find((message) => message.type === "run_result");
  assert.ok(result);
  assert.deepEqual(result, {
    type: "run_result",
    runId: "run_codex",
    ok: true,
    text: "本机 Codex 已完成。",
    attachments: []
  });

  bridge.stop();
});

test("createCoreCloudBridge does NOT connect when cloud is disabled", () => {
  const { bridge, sockets } = buildHarness({ enabled: false });
  bridge.start();
  assert.equal(sockets.length, 0);
  bridge.stop();
});

test("createCoreCloudBridge does NOT connect when cloud is enabled but has no token", () => {
  const { bridge, sockets } = buildHarness({ enabled: true, token: "" });
  bridge.start();
  assert.equal(sockets.length, 0);
  bridge.stop();
});

test("createCoreCloudBridge requires an explicit persisted device id", () => {
  const { MockWebSocket } = mockWebSocketClass();
  assert.throws(() => createCoreCloudBridge({
    settingsStore: { cloudSettings: () => ({ enabled: true, token: "tok_core", url: "https://cloud.example" }) },
    botExecution: { sendChat: async () => ({ ok: true }) },
    WebSocketImpl: MockWebSocket
  }), /deviceId/);
});

test("createMiaCore cloud bridge reuses the persisted desktop device identity", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-bridge-identity-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, "mia-device.json"), JSON.stringify({
    id: "device_existing_air7",
    createdAt: "2026-06-18T03:09:46.142Z"
  }, null, 2));
  fs.writeFileSync(path.join(home, "mia-cloud.json"), JSON.stringify({
    enabled: true,
    token: "tok_core",
    url: "https://cloud.example"
  }, null, 2));

  const { MockWebSocket, sockets } = mockWebSocketClass();
  const core = createMiaCore({ env: { MIA_HOME: home }, version: "0.0.0-test" });
  const bridge = core.cloudBridge({
    WebSocketImpl: MockWebSocket,
    botExecution: { sendChat: async () => ({ ok: true }) }
  });
  t.after(() => bridge.stop());

  bridge.start();

  assert.equal(sockets.length, 1);
  const url = new URL(sockets[0].url);
  assert.equal(url.searchParams.get("deviceId"), "device_existing_air7");
  assert.notEqual(url.searchParams.get("deviceId"), "mia-core");
});

test("createMiaCore cloud bridge rereads the persisted device identity after reset", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-bridge-reset-identity-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const identityPath = path.join(home, "mia-device.json");
  fs.writeFileSync(identityPath, JSON.stringify({
    id: "device_existing_air7",
    createdAt: "2026-06-18T03:09:46.142Z"
  }, null, 2));
  fs.writeFileSync(path.join(home, "mia-cloud.json"), JSON.stringify({
    enabled: true,
    token: "tok_core",
    url: "https://cloud.example"
  }, null, 2));

  const { MockWebSocket, sockets } = mockWebSocketClass();
  const core = createMiaCore({ env: { MIA_HOME: home }, version: "0.0.0-test" });
  const bridge = core.cloudBridge({
    WebSocketImpl: MockWebSocket,
    botExecution: { sendChat: async () => ({ ok: true }) }
  });
  t.after(() => bridge.stop());

  bridge.start();
  assert.equal(new URL(sockets[0].url).searchParams.get("deviceId"), "device_existing_air7");

  sockets[0].readyState = MockWebSocket.OPEN;
  bridge.handleMessage(sockets[0], JSON.stringify({
    type: "device_identity_conflict",
    message: "conflict"
  }));
  const resetIdentity = JSON.parse(fs.readFileSync(identityPath, "utf8"));
  assert.notEqual(resetIdentity.id, "device_existing_air7");

  bridge.start();
  assert.equal(sockets.length, 2);
  assert.equal(new URL(sockets[1].url).searchParams.get("deviceId"), resetIdentity.id);
});
