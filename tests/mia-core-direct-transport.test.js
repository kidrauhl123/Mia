"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  createMiaCoreDirectTransport,
  loopbackBaseUrl
} = require("../src/preload/mia-core-direct-transport.js");

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeSocket.CONNECTING;
    this.listeners = new Map();
    FakeSocket.instances.push(this);
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  emit(name, payload = {}) {
    if (name === "open") this.readyState = FakeSocket.OPEN;
    if (name === "close") this.readyState = FakeSocket.CLOSED;
    this.listeners.get(name)?.(payload);
  }

  close() {
    this.closed = true;
    this.readyState = FakeSocket.CLOSED;
  }
}

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => body
  };
}

test("direct transport validates the loopback Core port", () => {
  assert.equal(loopbackBaseUrl(27861), "http://127.0.0.1:27861");
  assert.equal(loopbackBaseUrl(0), "");
  assert.equal(loopbackBaseUrl(65536), "");
  assert.equal(loopbackBaseUrl("not-a-port"), "");
});

test("direct transport owns one Core websocket and splits mapped task/cloud events", () => {
  FakeSocket.instances = [];
  const cloudEvents = [];
  const taskEvents = [];
  const transport = createMiaCoreDirectTransport({
    port: 27861,
    fetch: async () => jsonResponse({ ok: true }),
    WebSocketImpl: FakeSocket,
    setTimeoutFn: () => 0,
    clearTimeoutFn: () => {}
  });

  assert.equal(FakeSocket.instances.length, 0);
  transport.subscribeCloudEvents((event) => cloudEvents.push(event));
  transport.subscribeTaskEvents((event) => taskEvents.push(event));

  assert.equal(FakeSocket.instances.length, 1);
  assert.equal(FakeSocket.instances[0].url, "ws://127.0.0.1:27861/ws");
  FakeSocket.instances[0].emit("open");
  FakeSocket.instances[0].emit("message", {
    data: JSON.stringify({
      name: "conversation.runtimeStdout",
      data: { conversationId: "conv_1", turnId: "turn_1", text: "hello" }
    })
  });
  FakeSocket.instances[0].emit("message", {
    data: JSON.stringify({
      name: "task.updated",
      data: { jobId: "task_1" }
    })
  });

  assert.deepEqual(cloudEvents, [
    {
      type: "daemon.local_events_status",
      payload: { connected: true }
    },
    {
      type: "cloud_agent_run_event",
      payload: {
        conversationId: "conv_1",
        runId: "turn_1",
        turnId: "turn_1",
        event: { type: "text_delta", text: "hello" }
      },
      coreEnvelope: {
        name: "conversation.runtimeStdout",
        data: { conversationId: "conv_1", turnId: "turn_1", text: "hello" }
      }
    }
  ]);
  assert.equal(taskEvents.length, 1);
  assert.equal(taskEvents[0].type, "updated");
  assert.equal(taskEvents[0].payload.taskId, "task_1");

  transport.stop();
  assert.equal(FakeSocket.instances[0].closed, true);
});

test("direct transport sends HTTP to Core without IPC and shares overlapping GETs", async () => {
  FakeSocket.instances = [];
  const calls = [];
  let releaseFetch;
  const fetchGate = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  const transport = createMiaCoreDirectTransport({
    port: 27861,
    WebSocketImpl: FakeSocket,
    fetch: async (url, options) => {
      calls.push({ url, options });
      await fetchGate;
      return jsonResponse({ jobs: [] });
    },
    setTimeoutFn: () => 0,
    clearTimeoutFn: () => {}
  });

  const first = transport.request("GET", "/api/tasks/jobs");
  const second = transport.request("GET", "/api/tasks/jobs");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:27861/api/tasks/jobs");
  releaseFetch();
  assert.deepEqual(await first, { jobs: [] });
  assert.deepEqual(await second, { jobs: [] });

  transport.stop();
});

test("direct transport warms its own websocket before starting a streaming bridge run", async () => {
  FakeSocket.instances = [];
  const calls = [];
  const transport = createMiaCoreDirectTransport({
    port: 27861,
    WebSocketImpl: FakeSocket,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ accepted: true });
    }
  });

  const request = transport.request("POST", "/api/cloud/bridge/run-async", {
    conversationId: "conv_1"
  });
  await Promise.resolve();
  assert.equal(calls.length, 0);

  FakeSocket.instances[0].emit("open");
  assert.deepEqual(await request, { accepted: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:27861/api/cloud/bridge/run-async");

  transport.stop();
});

test("direct transport fails closed without scheduling retries when Core did not start", async () => {
  FakeSocket.instances = [];
  let scheduled = 0;
  const transport = createMiaCoreDirectTransport({
    port: 0,
    fetch: async () => jsonResponse({}),
    WebSocketImpl: FakeSocket,
    setTimeoutFn: () => {
      scheduled += 1;
      return scheduled;
    },
    clearTimeoutFn: () => {}
  });

  await assert.rejects(
    () => transport.request("GET", "/health"),
    /Mia Core is not available/
  );
  assert.equal(FakeSocket.instances.length, 0);
  assert.equal(scheduled, 0);
});
