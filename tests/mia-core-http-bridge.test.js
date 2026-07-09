const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  createMiaCoreEventBridge,
  miaCoreBaseUrl,
  miaCoreWsUrl,
  rendererEventForCoreEnvelope
} = require("../src/shared/mia-core-http.js");

test("mia-core shared HTTP helpers derive loopback HTTP and WS URLs from startup state", () => {
  const root = { __miaCorePort: 45678 };
  assert.equal(miaCoreBaseUrl(root), "http://127.0.0.1:45678");
  assert.equal(miaCoreWsUrl(root), "ws://127.0.0.1:45678/ws");
  assert.equal(miaCoreBaseUrl({}), "");
  assert.equal(miaCoreWsUrl({ location: { protocol: "https:", host: "mia.local" } }), "wss://mia.local/ws");
});

test("rendererEventForCoreEnvelope maps Core domains onto existing renderer event channels", () => {
  assert.deepEqual(rendererEventForCoreEnvelope({ name: "conversation.messageCreated", data: { id: "m1" } }), {
    channel: "chat:event",
    payload: { name: "conversation.messageCreated", data: { id: "m1" } }
  });
  assert.deepEqual(rendererEventForCoreEnvelope({ name: "task.updated", data: { id: "t1" } }), {
    channel: "tasks:event",
    payload: { name: "task.updated", data: { id: "t1" } }
  });
  assert.deepEqual(rendererEventForCoreEnvelope({ name: "cloud.statusChanged", data: { connected: true } }), {
    channel: "cloud:event",
    payload: { name: "cloud.statusChanged", data: { connected: true } }
  });
});

test("createMiaCoreEventBridge opens /ws and dispatches parsed Core events", () => {
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      sockets.push(this);
    }
    addEventListener(name, handler) {
      this.listeners[name] = handler;
    }
    close() {
      this.closed = true;
    }
  }
  const seen = [];
  const bridge = createMiaCoreEventBridge({
    WebSocketImpl: FakeWebSocket,
    root: { __miaCorePort: 34567 },
    dispatch: (event) => seen.push(event)
  });

  bridge.start();
  assert.equal(sockets[0].url, "ws://127.0.0.1:34567/ws");
  sockets[0].listeners.message({ data: JSON.stringify({ name: "task.runStarted", data: { id: "job1" } }) });
  sockets[0].listeners.message({ data: "not json" });
  bridge.stop();

  assert.deepEqual(seen, [
    {
      channel: "tasks:event",
      payload: { name: "task.runStarted", data: { id: "job1" } }
    }
  ]);
  assert.equal(sockets[0].closed, true);
});
