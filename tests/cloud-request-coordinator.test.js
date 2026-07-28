const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createCloudRequestCoordinator
} = require("../src/main/cloud/request-coordinator.js");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("cloud request coordinator coalesces identical in-flight reads", async () => {
  const gate = deferred();
  let calls = 0;
  const coordinator = createCloudRequestCoordinator({
    execute: async () => {
      calls += 1;
      await gate.promise;
      return { ok: true };
    }
  });

  const first = coordinator.request({ method: "GET", baseUrl: "https://cloud", path: "/api/me", token: "t" });
  const second = coordinator.request({ method: "GET", baseUrl: "https://cloud", path: "/api/me", token: "t" });

  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  gate.resolve();
  assert.deepEqual(await first, { ok: true });
});

test("cloud request coordinator applies a hard concurrency ceiling", async () => {
  const gate = deferred();
  let active = 0;
  let peak = 0;
  const coordinator = createCloudRequestCoordinator({
    maxConcurrent: 3,
    execute: async ({ id }) => {
      active += 1;
      peak = Math.max(peak, active);
      await gate.promise;
      active -= 1;
      return id;
    }
  });

  const requests = Array.from({ length: 12 }, (_, id) => (
    coordinator.request({ method: "POST", path: `/write/${id}`, body: {}, id })
  ));
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(coordinator.status().active, 3);
  assert.equal(coordinator.status().queued, 9);
  gate.resolve();
  assert.deepEqual(await Promise.all(requests), Array.from({ length: 12 }, (_, id) => id));
  assert.equal(peak, 3);
});
