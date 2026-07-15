const test = require("node:test");
const assert = require("node:assert/strict");

const { createPostPaintStartup } = require("../src/main/post-paint-startup.js");

test("post-paint startup staggers non-visual work and starts only once", async () => {
  const scheduled = [];
  const calls = [];
  const marks = [];
  const scheduler = createPostPaintStartup({
    startRuntime: () => calls.push("runtime"),
    refreshCloud: () => calls.push("cloud"),
    startMcp: () => calls.push("mcp"),
    startAutoUpdate: () => calls.push("auto-update"),
    timer: { mark: (label, details) => marks.push({ label, details }) },
    setTimeoutFn: (fn, delayMs) => scheduled.push({ fn, delayMs }),
    delays: { runtime: 10, cloud: 20, mcp: 30, autoUpdate: 40 }
  });

  assert.equal(scheduler.start(), true);
  assert.equal(scheduler.start(), false);
  assert.deepEqual(scheduled.map((entry) => entry.delayMs), [10, 20, 30, 40]);
  assert.deepEqual(marks.map((entry) => entry.label), [
    "post-paint:runtime:scheduled",
    "post-paint:cloud:scheduled",
    "post-paint:mcp:scheduled",
    "post-paint:auto-update:scheduled"
  ]);

  for (const entry of scheduled) entry.fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["runtime", "cloud", "mcp", "auto-update"]);
  assert.equal(scheduler.isStarted(), true);
});
