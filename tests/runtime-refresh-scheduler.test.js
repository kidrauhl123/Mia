const assert = require("node:assert/strict");
const { test } = require("node:test");

const { createRuntimeRefreshScheduler } = require("../src/renderer/runtime-refresh-scheduler.js");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("runtime refresh scheduler coalesces overlapping interval ticks", async () => {
  const timers = [];
  const runs = [];
  const first = deferred();
  const second = deferred();
  const scheduler = createRuntimeRefreshScheduler({
    intervalMs: 2000,
    setInterval: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearInterval: () => {},
    refresh: () => {
      const run = runs.length === 0 ? first : second;
      runs.push(run);
      return run.promise;
    }
  });

  scheduler.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 2000);

  timers[0].fn();
  timers[0].fn();
  timers[0].fn();
  assert.equal(runs.length, 1);

  first.resolve("one");
  await first.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs.length, 2);

  second.resolve("two");
  await second.promise;
});

test("runtime refresh scheduler shares an in-flight manual refresh", async () => {
  const first = deferred();
  let calls = 0;
  const scheduler = createRuntimeRefreshScheduler({
    intervalMs: 2000,
    refresh: () => {
      calls += 1;
      return first.promise;
    }
  });

  const a = scheduler.runNow();
  const b = scheduler.runNow();
  assert.equal(calls, 1);
  assert.equal(a, b);

  first.resolve("done");
  assert.equal(await a, "done");
});
