const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createCoreBotExecution,
  createCoreCloudRouting,
  createCoreCloudEvents
} = require("../src/core/mia-core.js");
const { CloudEvent } = require("../src/shared/cloud-events.js");

// Minimal mock matching exactly what cloud-events-client.js drives on the socket:
// constructor(url, protocols); on(name, handler) for open/pong/message/error/close;
// readyState against the static CONNECTING/OPEN/CLOSED; ping(); close(code, reason).
// We drive it directly (emit) — no real network, no wall-clock waits.
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
      this.closed = null;
      this.pings = 0;
      sockets.push(this);
    }
    on(name, handler) { this.handlers[name] = handler; }
    emit(name, arg) { if (this.handlers[name]) this.handlers[name](arg); }
    ping() { this.pings += 1; }
    close(code, reason) {
      this.readyState = MockWebSocket.CLOSED;
      this.closed = { code, reason };
      this.emit("close");
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

function botInvocationFrame({ deviceId, seq }) {
  return {
    type: CloudEvent.ConversationBotInvocationRequested,
    seq,
    conversationId: "dm:userA:bot1",
    botId: "bot1",
    targetDeviceId: deviceId,
    runtimeConfig: { agentEngine: "hermes", deviceId },
    triggeringMessage: {
      id: "msg_1",
      seq: 1,
      sender_kind: "user",
      sender_ref: "userA",
      body_md: "hello core",
      turn_id: "turn_1"
    },
    members: [
      { member_kind: "bot", member_ref: "bot1", bot_name: "Bot One" },
      { member_kind: "user", member_ref: "userA", username: "userA" }
    ],
    recentMessages: []
  };
}

function buildHarness({ enabled = true, token = "tok_core", deviceId = "mia-core-device" } = {}) {
  const sendChatSeen = [];
  const botExecution = createCoreBotExecution({
    runtimePaths: makeRuntimePaths(),
    settingsStore: { daemonSettings: () => ({ enabled: false }) },
    hermesBaseUrl: "",
    apiKey: "test-key",
    sendHermesChat: async (context) => {
      sendChatSeen.push(context);
      return fakeHermesResponse("hi from core");
    }
  });

  const posts = [];
  const socialApi = {
    postConversationMessageAsBot: async (conversationId, body) => {
      posts.push({ conversationId, body });
      return { ok: true, message: { id: "posted_1", body_md: body.bodyMd } };
    },
    listConversationMessages: async () => ({ messages: [] })
  };

  const localEvents = [];
  const cloudRouting = createCoreCloudRouting({
    runtimePaths: makeRuntimePaths(),
    settingsStore: { cloudSettings: () => ({ enabled, token }), normalizeCloudUrl: (v) => String(v || "") },
    botExecution,
    socialApi,
    emitLocalEvent: (envelope) => localEvents.push(envelope),
    deviceId,
    log: () => {}
  });

  const settingsWrites = [];
  const settingsStore = {
    cloudSettings: () => ({ enabled, token, url: "https://cloud.example", lastEventSeq: 0 }),
    writeCloudSettings: (patch) => settingsWrites.push(patch)
  };

  const { MockWebSocket, sockets } = mockWebSocketClass();
  const events = createCoreCloudEvents({
    settingsStore,
    cloudRouting,
    WebSocketImpl: MockWebSocket,
    emitLocalEvent: (envelope) => localEvents.push(envelope),
    log: () => {}
  });

  return { events, sockets, MockWebSocket, posts, sendChatSeen, localEvents, settingsWrites };
}

test("cloud events socket → dispatcher → Core sendChat (Hermes) → socialApi post, node-only mock transport", async () => {
  const deviceId = "mia-core-device";
  const { events, sockets, MockWebSocket, posts, sendChatSeen } = buildHarness({ enabled: true, deviceId });

  // Connect: opens exactly one /api/events socket with the resume cursor + token.
  const status = events.start();
  assert.equal(status.connecting, true);
  assert.equal(sockets.length, 1);
  assert.match(sockets[0].url, /\/api\/events\?since_seq=0$/);
  assert.deepEqual(sockets[0].protocols, ["mia-token.tok_core"]);

  const ws = sockets[0];
  ws.readyState = MockWebSocket.OPEN;

  // Server completes the handshake, then delivers a bot-invocation frame.
  ws.emit("message", JSON.stringify({ type: CloudEvent.EventsReady, sinceSeq: 0, serverSeq: 0 }));
  ws.emit("message", JSON.stringify(botInvocationFrame({ deviceId, seq: 1 })));

  // The dispatcher returns a promise; let the routing graph settle.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  // (a) The frame reached dispatcher.handleCloudEvent → Core's real sendChat ran
  // (only the lowest-level Hermes HTTP send is faked).
  assert.equal(sendChatSeen.length, 1);
  assert.equal(sendChatSeen[0].bot.key, "bot1");
  assert.equal(sendChatSeen[0].bot.agentEngine, "hermes");

  // (b) The reply was posted as the bot through the mock socialApi.
  assert.equal(posts.length, 1);
  assert.equal(posts[0].conversationId, "dm:userA:bot1");
  assert.equal(posts[0].body.botId, "bot1");
  assert.equal(posts[0].body.bodyMd, "hi from core");

  // Teardown: no lingering socket/reconnect timer so node --test exits.
  events.stop();
  assert.equal(ws.closed?.code, 1000);
});

test("createCoreCloudEvents does NOT connect when cloud is disabled", () => {
  const { events, sockets } = buildHarness({ enabled: false });
  const status = events.start();
  assert.equal(sockets.length, 0);
  assert.equal(status.enabled, false);
  assert.equal(status.connecting, false);
  events.stop();
});

test("createCoreCloudEvents does NOT connect when cloud is enabled but has no token", () => {
  const { events, sockets } = buildHarness({ enabled: true, token: "" });
  events.start();
  assert.equal(sockets.length, 0);
  events.stop();
});
