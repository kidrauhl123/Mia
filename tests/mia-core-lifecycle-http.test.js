"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  createMiaCoreHttpClient,
  createMiaCoreHttpClientCache
} = require("../src/main/mia-core/http-client.js");

test("Mia Core HTTP client builds typed loopback requests", async () => {
  const calls = [];
  const client = createMiaCoreHttpClient({
    baseUrl: "http://127.0.0.1:51234",
    fetch: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: async () => ({ ok: true, dataDir: "/tmp/mia" })
      };
    }
  });

  assert.deepEqual(await client.health(), { ok: true, dataDir: "/tmp/mia" });
  assert.equal(calls[0].url, "http://127.0.0.1:51234/health");
  assert.equal(calls[0].options.method, "GET");
  assert.equal("connection" in calls[0].options.headers, false);
});

test("Mia Core HTTP client shares overlapping read-only requests without caching results", async () => {
  const calls = [];
  let resolveFetch;
  const fetchResult = new Promise((resolve) => {
    resolveFetch = resolve;
  });
  const client = createMiaCoreHttpClient({
    baseUrl: "http://127.0.0.1:51234",
    fetch: async (url, options) => {
      calls.push({ url, options });
      await fetchResult;
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: async () => ({ ok: true })
      };
    }
  });

  const first = client.get("/status");
  const second = client.get("/status");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);

  resolveFetch();
  assert.deepEqual(await Promise.all([first, second]), [{ ok: true }, { ok: true }]);

  await client.get("/status");
  assert.equal(calls.length, 2);
});

test("Mia Core HTTP client attaches a bounded timeout to requests", async () => {
  const signals = [];
  const client = createMiaCoreHttpClient({
    baseUrl: "http://127.0.0.1:51234",
    requestTimeoutMs: 1234,
    timeoutSignal: (timeoutMs) => {
      signals.push(timeoutMs);
      return { timeoutMs };
    },
    fetch: async (_url, options) => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ signal: options.signal })
    })
  });

  assert.deepEqual(await client.health(), { signal: { timeoutMs: 1234 } });
  assert.deepEqual(signals, [1234]);
});

test("Mia Core HTTP client cache reuses a client until the Core address changes", () => {
  const clients = createMiaCoreHttpClientCache({ fetch: async () => null });
  const first = clients.get("http://127.0.0.1:51234/");

  assert.equal(clients.get("http://127.0.0.1:51234"), first);
  assert.notEqual(clients.get("http://127.0.0.1:51235"), first);
});

test("Mia Core HTTP client throws parsed response errors", async () => {
  const client = createMiaCoreHttpClient({
    baseUrl: "http://127.0.0.1:51234/",
    fetch: async () => ({
      ok: false,
      status: 503,
      headers: { get: () => "application/json" },
      json: async () => ({ error: "warming_up" }),
      text: async () => "warming_up"
    })
  });

  await assert.rejects(() => client.health(), /Mia Core HTTP GET \/health failed 503: warming_up/);
});
