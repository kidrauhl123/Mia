const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createCoreBotExecution,
  createCoreCloudBridge
} = require("../src/core/mia-core.js");

// Minimal mock matching exactly what cloud-bridge-client.js drives on the socket:
// constructor(url, protocols); on(name, handler) for open/pong/message/error/close;
// readyState against the static CONNECTING/OPEN/CLOSED; send(json); ping();
// terminate(); close(code, reason). We drive it directly (emit / handleMessage) —
// no real network, no wall-clock waits.
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

function fakeHermesResponse(content) {
  return {
    id: "run_fake",
    object: "chat.completion",
    created: 1,
    model: "hermes-agent",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    mia: { transport: "runs", run_id: "run_fake", bot_id: "bot1", events: [] }
  };
}

function makeRuntimePaths() {
  return () => ({ botManifest: "/dev/null/does-not-exist", botDir: "/dev/null" });
}

function buildHarness({ enabled = true, token = "tok_core" } = {}) {
  const sendChatSeen = [];
  const botExecution = createCoreBotExecution({
    runtimePaths: makeRuntimePaths(),
    settingsStore: { daemonSettings: () => ({ enabled: false }) },
    hermesBaseUrl: "",
    apiKey: "test-key",
    sendHermesChat: async (context) => {
      sendChatSeen.push(context);
      return fakeHermesResponse("hi from core bridge");
    },
    // PART B: a non-Hermes bridge run now routes through the REAL engine adapter.
    // Inject a CLI-absent service so a codex bridge run deterministically surfaces
    // the real codex adapter's own guard (no real CLI spawn in tests).
    localAgentEngineService: {
      shellCommandPath: () => "",
      processEnvWithCliPath: () => ({ PATH: "" }),
      agentRuntimeEnv: () => ({}),
      resolveAgentRuntime: () => null,
      localAgentEngines: () => ({})
    }
  });

  const localEvents = [];
  const { MockWebSocket, sockets } = mockWebSocketClass();
  const settingsStore = {
    cloudSettings: () => ({ enabled, token, url: "https://cloud.example", user: { id: "u_1" } })
  };

  const bridge = createCoreCloudBridge({
    settingsStore,
    botExecution,
    WebSocketImpl: MockWebSocket,
    emitLocalEvent: (envelope) => localEvents.push(envelope),
    deviceId: "mia-core-device",
    version: "0.0.0-test",
    log: () => {}
  });

  return { bridge, sockets, MockWebSocket, sendChatSeen, localEvents };
}

test("bridge run frame → Core sendChat (Hermes) → run_result over the mock socket", async () => {
  const { bridge, sockets, MockWebSocket, sendChatSeen } = buildHarness({ enabled: true });

  // Connect: opens exactly one /api/bridge socket with deviceId + token protocol.
  bridge.start();
  assert.equal(sockets.length, 1);
  assert.match(sockets[0].url, /\/api\/bridge\?/);
  assert.match(sockets[0].url, /deviceId=mia-core-device/);
  assert.match(sockets[0].url, /engine=hermes/);
  assert.deepEqual(sockets[0].protocols, ["mia-token.tok_core"]);

  const ws = sockets[0];
  ws.readyState = MockWebSocket.OPEN;

  // Server completes the handshake, then delivers a Hermes "remote run" request.
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

  // The run promise settles asynchronously; let the routing graph drain.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  // (a) The run reached Core's real sendChat (only the lowest Hermes HTTP send is faked).
  assert.equal(sendChatSeen.length, 1);
  assert.equal(sendChatSeen[0].bot.key, "bot1");
  assert.equal(sendChatSeen[0].bot.agentEngine, "hermes");
  assert.equal(sendChatSeen[0].messages[0].content, "hello core bridge");
  assert.equal(sendChatSeen[0].sessionId, "cloud:c_1");

  // (b) The opening status event, the real run-stream events (session_started is
  // emitted by Core's genuine adapter graph through the bridge's emit sink), and
  // the final run_result were all sent back over the socket.
  assert.deepEqual(ws.sent[0], {
    type: "run_event", runId: "run_1", event: { kind: "status", text: "本机 Hermes 已开始运行。" }
  });
  assert.ok(
    ws.sent.some((m) => m.type === "run_event" && m.event?.kind === "session_started"),
    "expected the real adapter graph's session_started stream event over the socket"
  );
  const runResult = ws.sent.find((m) => m.type === "run_result");
  assert.deepEqual(runResult, {
    type: "run_result", runId: "run_1", ok: true, text: "hi from core bridge", attachments: []
  });

  // Teardown: no lingering socket/reconnect timer so node --test exits.
  bridge.stop();
  assert.equal(ws.closed?.code, 1000);
});

test("a codex bridge run routes through the REAL codex adapter (engineUnavailable throw is gone)", async () => {
  const { bridge, sockets, MockWebSocket, sendChatSeen } = buildHarness({ enabled: true });
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

  // The run routes into botExecution.sendChat → the REAL codex adapter (engine
  // selected by runtimeConfig). The Hermes HTTP send is never reached (codex path).
  assert.equal(sendChatSeen.length, 0);

  const result = ws.sent.find((m) => m.type === "run_result");
  assert.ok(result, "expected a run_result frame");
  assert.equal(result.ok, false);
  // PART B: the error is now the REAL codex adapter's own CLI guard, NOT the
  // legacy "engine not available in Mia Core yet" throw.
  assert.match(result.error, /没有检测到 Codex CLI/);
  assert.doesNotMatch(result.error, /engine not available in Mia Core yet/);

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
