const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createCloudEventsClient } = require("../src/main/cloud/cloud-events-client.js");

function fakeWebSocketClass() {
  const sockets = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;

    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = FakeWebSocket.CONNECTING;
      this.handlers = {};
      this.closed = null;
      sockets.push(this);
    }

    on(name, handler) {
      this.handlers[name] = handler;
    }

    emit(name, arg) {
      if (this.handlers[name]) this.handlers[name](arg);
    }

    close(code, reason) {
      this.readyState = FakeWebSocket.CLOSED;
      this.closed = { code, reason };
    }
  }
  return { FakeWebSocket, sockets };
}

function setup(overrides = {}) {
  const { FakeWebSocket, sockets } = fakeWebSocketClass();
  const calls = {
    broadcasts: [],
    conductor: [],
    fellowConversation: [],
    logs: [],
    responder: [],
    runtimeDispatcher: [],
    settingsWrites: [],
    timers: []
  };
  let settings = {
    enabled: true,
    token: "tok_1",
    url: "https://cloud.example",
    lastEventSeq: 3
  };
  const client = createCloudEventsClient({
    WebSocketImpl: FakeWebSocket,
    getSettings: () => settings,
    writeCloudSettings: (patch) => {
      calls.settingsWrites.push(patch);
      settings = { ...settings, ...patch };
    },
    cloudStatus: () => ({ enabled: settings.enabled }),
    cloudEventsUrl: (s) => `wss://cloud.example/api/events?since_seq=${Number(s.lastEventSeq) || 0}`,
    cloudWebSocketProtocols: (s) => [`mia-token.${s.token}`],
    broadcastRendererEvent: (channel, envelope) => calls.broadcasts.push({ channel, envelope }),
    cloudEventChannel: "cloud:event",
    appendCloudLog: (line) => calls.logs.push(line),
    shouldHandleCloudConversationAi: () => true,
    fellowRuntimeDispatcher: {
      handleCloudEvent: async (message) => calls.runtimeDispatcher.push(message)
    },
    setTimeoutFn: (fn, delayMs) => {
      const timer = { fn, delayMs };
      calls.timers.push(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => {
      timer.cleared = true;
    },
    ...overrides
  });
  return { client, calls, sockets, FakeWebSocket, setSettings: (patch) => { settings = { ...settings, ...patch }; } };
}

test("start opens one /api/events websocket with resume cursor", () => {
  const { client, sockets, FakeWebSocket } = setup();

  client.start();
  client.start();

  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, "wss://cloud.example/api/events?since_seq=3");
  assert.deepEqual(sockets[0].protocols, ["mia-token.tok_1"]);

  sockets[0].readyState = FakeWebSocket.CLOSED;
  client.start();
  assert.equal(sockets.length, 2);
});

test("events_ready updates resume cursor and broadcasts renderer status", () => {
  const { client, calls } = setup();

  client.handleMessage(JSON.stringify({
    type: "events_ready",
    sinceSeq: 20,
    serverSeq: 42
  }));
  client.handleMessage(JSON.stringify({
    type: "events_ready",
    resetTo: 7,
    serverSeq: 100
  }));

  assert.deepEqual(calls.settingsWrites, [{ lastEventSeq: 42 }, { lastEventSeq: 7 }]);
  assert.equal(calls.broadcasts.length, 2);
  assert.equal(calls.broadcasts[0].channel, "cloud:event");
  assert.deepEqual(calls.broadcasts[0].envelope, {
    type: "events_ready",
    cloud: { enabled: true }
  });
});

test("status exposes the cloud events socket health separately from the bridge", () => {
  const { client, sockets, FakeWebSocket } = setup();

  assert.deepEqual(client.status(), {
    enabled: true,
    connecting: false,
    connected: false,
    lastError: "",
    lastEventSeq: 3
  });

  client.start();
  assert.equal(client.status().connecting, true);

  sockets[0].readyState = FakeWebSocket.OPEN;
  sockets[0].emit("message", JSON.stringify({
    type: "events_ready",
    sinceSeq: 3,
    serverSeq: 8
  }));

  assert.deepEqual(client.status(), {
    enabled: true,
    connecting: false,
    connected: true,
    lastError: "",
    lastEventSeq: 8
  });

  sockets[0].emit("close");
  assert.equal(client.status().connected, false);
});

test("start replaces a stale cloud events socket that never became ready", () => {
  let now = 1000;
  const { client, sockets, FakeWebSocket } = setup({
    nowFn: () => now,
    readyTimeoutMs: 5000
  });

  client.start();
  sockets[0].readyState = FakeWebSocket.OPEN;

  now += 6000;
  client.start();

  assert.equal(sockets.length, 2);
  assert.deepEqual(sockets[0].closed, { code: 1000, reason: "cloud events ready timeout" });
  assert.equal(client.status().connecting, true);
});

test("conversation AI events are handled in main and still forwarded to renderer", async () => {
  const { client, calls } = setup();

  client.handleMessage(JSON.stringify({
    type: "conversation.fellow_invocation_requested",
    seq: 4,
    conversationId: "g_1",
    fellowId: "codex",
    triggeringMessage: { id: "m_1", body_md: "@codex 看看" }
  }));
  client.handleMessage(JSON.stringify({
    type: "conversation.message_appended",
    seq: 5,
    conversationId: "g_1",
    message: { id: "m_2", seq: 2, sender_kind: "user", body_md: "大家看看" }
  }));
  await Promise.resolve();

  assert.deepEqual(calls.settingsWrites, [{ lastEventSeq: 4 }, { lastEventSeq: 5 }]);
  assert.deepEqual(calls.runtimeDispatcher.map((message) => message.type), [
    "conversation.fellow_invocation_requested",
    "conversation.message_appended"
  ]);
  assert.equal(calls.runtimeDispatcher[0].fellowId, "codex");
  assert.deepEqual(calls.runtimeDispatcher[1].message, { id: "m_2", seq: 2, sender_kind: "user", body_md: "大家看看" });
  assert.deepEqual(calls.responder, []);
  assert.deepEqual(calls.conductor, []);
  assert.deepEqual(calls.fellowConversation, []);
  assert.equal(calls.broadcasts.map((item) => item.envelope.type).join(","), "conversation.fellow_invocation_requested,conversation.message_appended");
});

test("fellow runtime updates are forwarded to the renderer", () => {
  const { client, calls } = setup();

  client.handleMessage(JSON.stringify({
    type: "fellow.runtime_updated",
    seq: 9,
    binding: {
      fellowId: "mia",
      runtimeKind: "cloud-hermes",
      config: { model: "hermes-agent" }
    }
  }));

  assert.deepEqual(calls.settingsWrites, [{ lastEventSeq: 9 }]);
  assert.equal(calls.broadcasts.length, 1);
  assert.deepEqual(calls.broadcasts[0].envelope, {
    type: "fellow.runtime_updated",
    payload: {
      type: "fellow.runtime_updated",
      seq: 9,
      binding: {
        fellowId: "mia",
        runtimeKind: "cloud-hermes",
        config: { model: "hermes-agent" }
      }
    }
  });
});

test("socket close clears only the active socket and schedules one reconnect", () => {
  const { client, calls, sockets } = setup();

  client.start();
  const first = sockets[0];
  client.stop();
  assert.deepEqual(first.closed, { code: 1000, reason: "cloud disabled" });

  client.start();
  const second = sockets[1];
  first.emit("close");
  assert.equal(calls.timers.length, 0);

  second.emit("close");
  second.emit("close");
  assert.equal(calls.timers.length, 1);
  assert.equal(calls.timers[0].delayMs, 3000);
});
