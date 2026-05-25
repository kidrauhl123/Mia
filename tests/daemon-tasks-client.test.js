const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");

const { createDaemonTasksClient } = require("../src/main/daemon/tasks-client.js");

function createClient(overrides = {}) {
  return createDaemonTasksClient({
    isDaemonProcess: false,
    getDaemonSettings: () => ({ host: "127.0.0.1", port: 27861 }),
    getDaemonStatus: () => ({ baseUrl: "http://127.0.0.1:27862" }),
    daemonToken: () => "daemon-secret",
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    httpRequest: () => {
      throw new Error("unexpected http request");
    },
    httpsRequest: () => {
      throw new Error("unexpected https request");
    },
    setTimeoutImpl: () => 0,
    clearTimeoutImpl: () => {},
    sendTaskEvent: () => {},
    ...overrides
  });
}

test("call sends daemon task requests through the observed daemon base URL", async () => {
  const calls = [];
  const client = createClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ tasks: [{ id: "task-1" }] }) };
    }
  });

  const body = await client.call("/api/tasks", {
    method: "POST",
    headers: { "X-Test": "1" },
    body: JSON.stringify({ title: "Daily" })
  });

  assert.deepEqual(body, { tasks: [{ id: "task-1" }] });
  assert.equal(calls[0].url, "http://127.0.0.1:27862/api/tasks");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Authorization, "Bearer daemon-secret");
  assert.equal(calls[0].options.headers["Content-Type"], "application/json");
  assert.equal(calls[0].options.headers["X-Test"], "1");
});

test("call falls back to configured daemon host and includes daemon error body", async () => {
  const client = createClient({
    getDaemonStatus: () => ({}),
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      statusText: "Unavailable",
      text: async () => "daemon offline"
    })
  });

  await assert.rejects(
    () => client.call("/api/tasks"),
    /daemon 503: daemon offline/
  );
});

test("startEvents parses task SSE events and broadcasts normalized envelopes", () => {
  let requestOptions = null;
  let request = null;
  const sent = [];
  const client = createClient({
    httpRequest: (options) => {
      requestOptions = options;
      request = new EventEmitter();
      request.end = () => {};
      request.destroy = () => {};
      return request;
    },
    sendTaskEvent: (event) => sent.push(event)
  });

  const subscription = client.startEvents();
  const response = new EventEmitter();
  response.statusCode = 200;
  request.emit("response", response);
  response.emit("data", Buffer.from("event: created\ndata: {\"id\":\"task-1\"}\n\n"));
  response.emit("data", Buffer.from("event: ignored\ndata: not-json\n\n"));

  assert.equal(requestOptions.hostname, "127.0.0.1");
  assert.equal(requestOptions.port, "27862");
  assert.equal(requestOptions.path, "/api/tasks/events");
  assert.equal(requestOptions.headers.Authorization, "Bearer daemon-secret");
  assert.equal(requestOptions.headers.Accept, "text/event-stream");
  assert.deepEqual(sent, [{ type: "created", payload: { id: "task-1" } }]);
  subscription.stop();
});

test("startEvents does not subscribe inside the daemon process", () => {
  const client = createClient({
    isDaemonProcess: true,
    httpRequest: () => {
      throw new Error("daemon process should not subscribe to itself");
    }
  });

  const subscription = client.startEvents();

  assert.equal(typeof subscription.stop, "function");
  subscription.stop();
});
