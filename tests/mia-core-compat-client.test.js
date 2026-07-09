const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  createMiaCoreCompatibilityClient
} = require("../src/main/mia-core/compat-client.js");

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    headers: { get: () => "application/json" },
    json: async () => body
  };
}

function createClient(overrides = {}) {
  return createMiaCoreCompatibilityClient({
    getCoreSettings: () => ({ host: "127.0.0.1", port: 27861 }),
    getCoreStatus: () => ({ baseUrl: "http://127.0.0.1:27862" }),
    fetchImpl: async () => jsonResponse({ ok: true }),
    ...overrides
  });
}

test("compat client retires legacy task routes without touching Core", async () => {
  const calls = [];
  const client = createClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ ok: true });
    }
  });

  const create = await client.call("/api/tasks", {
    method: "POST",
    body: JSON.stringify({ title: "Daily" })
  });
  const list = await client.call("/api/tasks?status=active", { method: "GET" });
  const run = await client.call("/api/tasks/task_1/run-now", { method: "POST", body: "{}" });

  assert.deepEqual(calls, []);
  assert.deepEqual(create, { ok: false, error: "Legacy task routes are retired. Use Rust Core /api/tasks/jobs." });
  assert.deepEqual(list, { ok: false, error: "Legacy task routes are retired. Use Rust Core /api/tasks/jobs." });
  assert.deepEqual(run, { ok: false, error: "Legacy task routes are retired. Use Rust Core /api/tasks/jobs." });
});

test("compat client rejects retired legacy chat stop without touching Core", async () => {
  const calls = [];
  const client = createClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ ok: true, cancelled: true });
    }
  });

  const result = await client.call("/api/chat/stop", {
    method: "POST",
    body: JSON.stringify({ conversationId: "conv/1", turnId: "turn/1" })
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(result, { ok: false, error: "Legacy chat stop is retired. Use Core turn cancellation." });
});

test("compat client rejects retired legacy chat send without touching Core", async () => {
  const calls = [];
  const client = createClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ ok: true });
    }
  });

  const result = await client.call("/api/chat/send", {
    method: "POST",
    body: JSON.stringify({ sessionId: "conversation:1", body: "hello" })
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(result, {
    ok: false,
    error: "Legacy chat send is retired. Use Rust Core /api/conversations/{id}/messages."
  });
});

test("compat client passes typed Core turn cancellation through unchanged", async () => {
  const calls = [];
  const client = createClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ ok: true, cancelled: true });
    }
  });

  const result = await client.call("/api/conversations/conv%2F1/turns/turn%2F1/cancel", {
    method: "POST",
    body: JSON.stringify({})
  });

  assert.equal(calls[0].url, "http://127.0.0.1:27862/api/conversations/conv%2F1/turns/turn%2F1/cancel");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {});
  assert.deepEqual(result, { ok: true, cancelled: true });
});
