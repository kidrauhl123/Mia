const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createHermesGatewayClient } = require("../src/cloud-agent/hermes-gateway-client.js");

function createFakeWebSocketHarness() {
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
      sockets.push(this);
    }

    on(name, handler) {
      this.handlers[name] = handler;
    }

    emit(name, value) {
      if (this.handlers[name]) this.handlers[name](value);
    }

    send(frame) {
      this.sent.push(frame);
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED;
      this.emit("close");
    }
  }

  return { FakeWebSocket, sockets };
}

function createFakeTimers() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeoutFn(fn, delay) {
      const id = nextId++;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeoutFn(id) {
      timers.delete(id);
    },
    runTimer(id) {
      const timer = timers.get(id);
      if (!timer) return;
      timers.delete(id);
      timer.fn();
    },
    timerIds() {
      return [...timers.keys()];
    }
  };
}

test("request sends a JSON-RPC frame with method, params, and id", async () => {
  const { FakeWebSocket, sockets } = createFakeWebSocketHarness();
  const client = createHermesGatewayClient({ WebSocketImpl: FakeWebSocket });
  const connectPromise = client.connect("ws://gateway.test/socket");
  const socket = sockets[0];
  socket.readyState = FakeWebSocket.OPEN;
  socket.emit("open");
  await connectPromise;

  const requestPromise = client.request("session.start", { session_id: "sess_1", mode: "chat" });

  assert.deepEqual(JSON.parse(socket.sent[0]), {
    jsonrpc: "2.0",
    id: 1,
    method: "session.start",
    params: { session_id: "sess_1", mode: "chat" }
  });

  socket.emit("message", JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { ok: true }
  }));
  await requestPromise;
});

test("request resolves when a matching JSON-RPC response arrives", async () => {
  const { FakeWebSocket, sockets } = createFakeWebSocketHarness();
  const client = createHermesGatewayClient({ WebSocketImpl: FakeWebSocket });
  const connectPromise = client.connect("ws://gateway.test/socket");
  const socket = sockets[0];
  socket.readyState = FakeWebSocket.OPEN;
  socket.emit("open");
  await connectPromise;

  const resultPromise = client.request("session.start", { session_id: "sess_1" });
  const sentFrame = JSON.parse(socket.sent[0]);

  socket.emit("message", JSON.stringify({
    jsonrpc: "2.0",
    id: sentFrame.id,
    result: { ok: true, session_id: "sess_1" }
  }));

  assert.deepEqual(await resultPromise, { ok: true, session_id: "sess_1" });
});

test("request rejects when the gateway responds with an error", async () => {
  const { FakeWebSocket, sockets } = createFakeWebSocketHarness();
  const client = createHermesGatewayClient({ WebSocketImpl: FakeWebSocket });
  const connectPromise = client.connect("ws://gateway.test/socket");
  const socket = sockets[0];
  socket.readyState = FakeWebSocket.OPEN;
  socket.emit("open");
  await connectPromise;

  const resultPromise = client.request("session.start", { session_id: "sess_1" });
  const sentFrame = JSON.parse(socket.sent[0]);

  socket.emit("message", JSON.stringify({
    jsonrpc: "2.0",
    id: sentFrame.id,
    error: { code: 401, message: "denied" }
  }));

  await assert.rejects(resultPromise, /denied/);
});

test("gateway event frames dispatch exact handlers and wildcard handlers", async () => {
  const { FakeWebSocket, sockets } = createFakeWebSocketHarness();
  const client = createHermesGatewayClient({ WebSocketImpl: FakeWebSocket });
  const connectPromise = client.connect("ws://gateway.test/socket");
  const socket = sockets[0];
  socket.readyState = FakeWebSocket.OPEN;
  socket.emit("open");
  await connectPromise;

  const seen = [];
  client.on("message.delta", (event) => seen.push({ kind: "exact", event }));
  client.on("*", (event) => seen.push({ kind: "all", event }));

  socket.emit("message", JSON.stringify({
    jsonrpc: "2.0",
    method: "event",
    params: {
      type: "message.delta",
      session_id: "sess_1",
      payload: { text: "hello" }
    }
  }));

  assert.deepEqual(seen, [
    {
      kind: "exact",
      event: {
        type: "message.delta",
        session_id: "sess_1",
        payload: { text: "hello" }
      }
    },
    {
      kind: "all",
      event: {
        type: "message.delta",
        session_id: "sess_1",
        payload: { text: "hello" }
      }
    }
  ]);
});

test("client parses multiple newline-delimited JSON frames from one WebSocket message", async () => {
  const { FakeWebSocket, sockets } = createFakeWebSocketHarness();
  const client = createHermesGatewayClient({ WebSocketImpl: FakeWebSocket });
  const connectPromise = client.connect("ws://gateway.test/socket");
  const socket = sockets[0];
  socket.readyState = FakeWebSocket.OPEN;
  socket.emit("open");
  await connectPromise;

  const seen = [];
  client.on("message.delta", (event) => seen.push(event.payload.text));

  socket.emit("message", [
    JSON.stringify({
      jsonrpc: "2.0",
      method: "event",
      params: { type: "message.delta", session_id: "sess_1", payload: { text: "hel" } }
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      method: "event",
      params: { type: "message.delta", session_id: "sess_1", payload: { text: "lo" } }
    })
  ].join("\n"));

  assert.deepEqual(seen, ["hel", "lo"]);
});

test("request timeout rejects and clears pending state", async () => {
  const { FakeWebSocket, sockets } = createFakeWebSocketHarness();
  const timers = createFakeTimers();
  const client = createHermesGatewayClient({
    WebSocketImpl: FakeWebSocket,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    requestTimeoutMs: 25
  });
  const connectPromise = client.connect("ws://gateway.test/socket");
  const socket = sockets[0];
  socket.readyState = FakeWebSocket.OPEN;
  socket.emit("open");
  await connectPromise;

  const resultPromise = client.request("session.start", { session_id: "sess_1" });
  const sentFrame = JSON.parse(socket.sent[0]);
  const [timerId] = timers.timerIds();

  timers.runTimer(timerId);

  await assert.rejects(resultPromise, /timed out/i);

  socket.emit("message", JSON.stringify({
    jsonrpc: "2.0",
    id: sentFrame.id,
    result: { ok: true }
  }));
});

test("close rejects pending requests", async () => {
  const { FakeWebSocket, sockets } = createFakeWebSocketHarness();
  const client = createHermesGatewayClient({ WebSocketImpl: FakeWebSocket });
  const connectPromise = client.connect("ws://gateway.test/socket");
  const socket = sockets[0];
  socket.readyState = FakeWebSocket.OPEN;
  socket.emit("open");
  await connectPromise;

  const resultPromise = client.request("session.start", { session_id: "sess_1" });

  client.close();

  await assert.rejects(resultPromise, /closed/i);
});
