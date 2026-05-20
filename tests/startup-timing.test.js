const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createStartupTimer } = require("../src/main/startup-timing.js");

test("startup timer records marks and writes scoped log lines", () => {
  const lines = [];
  const timer = createStartupTimer({
    scope: "test",
    logger: { info: (line) => lines.push(line) }
  });

  const mark = timer.mark("window:created", { id: 7 });

  assert.equal(mark.label, "window:created");
  assert.equal(mark.id, 7);
  assert.equal(typeof mark.elapsedMs, "number");
  assert.equal(timer.snapshot().length, 1);
  assert.match(lines[0], /^\[Aimashi:test\] window:created \+\d+ms id=7$/);
});

test("startup timer snapshot is immutable from caller mutations", () => {
  const timer = createStartupTimer({ logger: { info: () => {} } });
  timer.mark("first");
  const snapshot = timer.snapshot();
  snapshot.push({ label: "mutated" });

  assert.deepEqual(timer.snapshot().map((entry) => entry.label), ["first"]);
});
