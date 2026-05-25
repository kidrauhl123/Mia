const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createRelayClient } = require("../src/main/relay/relay-client.js");
const { createRemoteControlRouter } = require("../src/main/remote/remote-control-router.js");

function fakeWebSocketClass() {
  const sockets = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.handlers = {};
      this.sent = [];
      this.closed = null;
      sockets.push(this);
    }

    on(name, handler) {
      this.handlers[name] = handler;
    }

    emit(name, arg) {
      if (this.handlers[name]) this.handlers[name](arg);
    }

    send(payload) {
      this.sent.push(JSON.parse(String(payload)));
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
  const { remoteRouter: remoteRouterOverrides, ...clientOverrides } = overrides;
  const calls = { runtime: 0, timers: [], modelSelections: [], effortWrites: [], permissionWrites: [], remoteChats: [] };
  let settings = {
    enabled: true,
    url: "wss://relay.example/ws",
    deviceId: "dev_1",
    secret: "sec_1"
  };
  const remoteRouter = createRemoteControlRouter({
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
    ...remoteRouterOverrides
  });
  const client = createRelayClient({
    WebSocketImpl: FakeWebSocket,
    getSettings: () => settings,
    mobileAssetVersion: "asset_1",
    daemonToken: () => "daemon_1",
    initializeRuntime: () => { calls.runtime += 1; },
    hostname: () => "MacBook",
    randomUUID: () => "uuid_1",
    remoteRouter,
    setTimeoutFn: (fn, delayMs) => {
      const timer = { fn, delayMs };
      calls.timers.push(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => { timer.cleared = true; },
    ...clientOverrides
  });
  return { calls, client, sockets, FakeWebSocket, setSettings: (patch) => { settings = { ...settings, ...patch }; } };
}

test("status builds the relay pairing link and redacts secrets in logs", () => {
  const { client } = setup();

  client.appendLog("secret sec_1 daemon daemon_1 visible");
  const status = client.status(true);

  assert.equal(status.enabled, true);
  assert.equal(status.url, "wss://relay.example/ws");
  assert.equal(status.deviceId, "dev_1");
  assert.equal(status.secret, "sec_1");
  assert.match(status.pairingLink, /^https:\/\/relay\.example\/mobile\/\?/);
  assert.match(status.pairingLink, /mode=relay/);
  assert.match(status.pairingLink, /device=dev_1/);
  assert.match(status.pairingLink, /v=asset_1/);
  assert.match(status.pairingLink, /#secret=sec_1$/);
  assert.deepEqual(status.logs, ["secret [REDACTED] daemon [REDACTED] visible"]);
});

test("start opens one relay socket and sends hello when it opens", async () => {
  const { calls, client, sockets, FakeWebSocket } = setup();

  await client.start();
  await client.start();

  assert.equal(calls.runtime, 2);
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, "wss://relay.example/ws");

  sockets[0].readyState = FakeWebSocket.OPEN;
  sockets[0].emit("open");
  assert.deepEqual(sockets[0].sent, [{
    type: "hello",
    role: "desktop",
    deviceId: "dev_1",
    secret: "sec_1",
    name: "MacBook"
  }]);
});

test("ready, peer_count, invalid json, and close update relay state locally", async () => {
  const { calls, client, sockets } = setup();

  await client.start();
  const ws = sockets[0];
  ws.emit("message", JSON.stringify({ type: "ready", device: { mobilePeers: 2 } }));
  assert.equal(client.status().connected, true);
  assert.equal(client.status().mobilePeers, 2);

  ws.emit("message", JSON.stringify({ type: "peer_count", count: 4 }));
  assert.equal(client.status().mobilePeers, 4);

  ws.emit("message", "{");
  assert.match(client.status().logs.at(-1), /invalid JSON/);

  ws.emit("close");
  ws.emit("close");
  assert.equal(client.status().connected, false);
  assert.equal(client.status().mobilePeers, 0);
  assert.equal(calls.timers.length, 1);
  assert.equal(calls.timers[0].delayMs, 2500);
});

test("rpc requests route through the relay Module and return normalized envelopes", async () => {
  const { client, sockets, FakeWebSocket } = setup();
  await client.start();
  const ws = sockets[0];
  ws.readyState = FakeWebSocket.OPEN;

  client.handleMessage(JSON.stringify({ type: "rpc", clientId: "mobile_1", id: "rpc_1", method: "GET", path: "/health" }));
  await Promise.resolve();
  client.handleMessage(JSON.stringify({ type: "rpc", clientId: "mobile_1", id: "rpc_2", method: "GET", path: "/missing" }));
  await Promise.resolve();

  assert.deepEqual(ws.sent, [
    {
      type: "rpc_result",
      clientId: "mobile_1",
      id: "rpc_1",
      ok: true,
      data: { status: "ok", service: "aimashi-daemon", mode: "desktop" }
    },
    {
      type: "rpc_result",
      clientId: "mobile_1",
      id: "rpc_2",
      ok: false,
      error: "Not found."
    }
  ]);
});

test("chat stream rpc forwards chat events before the final rpc result", async () => {
  const { calls, client, sockets, FakeWebSocket } = setup();
  await client.start();
  const ws = sockets[0];
  ws.readyState = FakeWebSocket.OPEN;

  client.handleMessage(JSON.stringify({
    type: "rpc",
    clientId: "mobile_1",
    id: "rpc_stream",
    method: "POST",
    path: "/api/chat/stream",
    body: { fellowKey: "codex", text: "hello" }
  }));
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(calls.remoteChats.length, 1);
  assert.equal(calls.remoteChats[0].eventSink.isDestroyed(), false);
  assert.deepEqual(ws.sent, [
    { type: "rpc_stream", clientId: "mobile_1", id: "rpc_stream", event: "chat", data: { delta: "hello" } },
    {
      type: "rpc_stream",
      clientId: "mobile_1",
      id: "rpc_stream",
      event: "result",
      data: { fellow: { key: "codex" }, session: { id: "s_1" }, response: { text: "done" } }
    },
    { type: "rpc_result", clientId: "mobile_1", id: "rpc_stream", ok: true, data: { done: true } }
  ]);
});
