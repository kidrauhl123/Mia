const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createCoreBotExecution,
  createCoreCloudRouting,
  createCoreCloudEvents
} = require("../src/core/mia-core.js");
const { CloudEvent } = require("../src/shared/cloud-events.js");

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

function makeRuntimePaths() {
  return () => ({
    botManifest: "/dev/null/does-not-exist",
    botDir: "/dev/null",
    workspace: "/tmp/mia-core-cloud-events-workspace"
  });
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

function buildHarness({ enabled = true, token = "tok_core", deviceId = "device_core_fixture" } = {}) {
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
    agentSessionManager
  });

  const posts = [];
  const socialApi = {
    postConversationMessageAsBot: async (conversationId, body) => {
      posts.push({ conversationId, body });
      return { ok: true };
    },
    listConversationMessages: async () => ({ messages: [] })
  };

  const localEvents = [];
  const cloudRouting = createCoreCloudRouting({
    runtimePaths: makeRuntimePaths(),
    settingsStore: { cloudSettings: () => ({ enabled, token }), normalizeCloudUrl: (value) => String(value || "") },
    botExecution,
    socialApi,
    emitLocalEvent: (envelope) => localEvents.push(envelope),
    deviceId,
    log: () => {},
    agentSessionManager
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

  return { events, sockets, MockWebSocket, posts, managerCalls, sendHermesChatSeen, localEvents, settingsWrites };
}

test("cloud events socket forwards Hermes bot invocations into AgentSession instead of Hermes HTTP chat", async () => {
  const deviceId = "device_core_fixture";
  const { events, sockets, MockWebSocket, posts, managerCalls, sendHermesChatSeen } = buildHarness({ enabled: true, deviceId });

  const status = events.start();
  assert.equal(status.connecting, true);
  assert.equal(sockets.length, 1);
  assert.match(sockets[0].url, /\/api\/events\?since_seq=0$/);
  assert.deepEqual(sockets[0].protocols, ["mia-token.tok_core"]);

  const ws = sockets[0];
  ws.readyState = MockWebSocket.OPEN;
  ws.emit("message", JSON.stringify({ type: CloudEvent.EventsReady, sinceSeq: 0, serverSeq: 0 }));
  ws.emit("message", JSON.stringify(botInvocationFrame({ deviceId, seq: 1 })));

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sendHermesChatSeen.length, 0);
  assert.equal(posts.length, 0);
  assert.equal(managerCalls.length, 1);
  assert.equal(managerCalls[0].conversationId, "dm:userA:bot1");
  assert.equal(managerCalls[0].engineId, "hermes");
  assert.equal(managerCalls[0].turnId, "turn_1");
  assert.equal(managerCalls[0].text, "hello core");
  assert.equal(typeof managerCalls[0].workspacePath, "string");

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
