const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createPerformanceDiagnostics } = require("../src/renderer/performance-diagnostics.js");

function createEventTarget() {
  const listeners = new Map();
  return {
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); },
    emit(name) { listeners.get(name)?.(); }
  };
}

test("performance diagnostics records render and input latency only when enabled", () => {
  let clock = 0;
  const input = createEventTarget();
  const diagnostics = createPerformanceDiagnostics({
    enabled: true,
    performance: {
      now: () => clock,
      memory: { usedJSHeapSize: 1024 }
    },
    document: {
      hidden: false,
      querySelectorAll: () => new Array(42)
    },
    window: {
      setInterval: () => 7,
      clearInterval: () => {}
    }
  });

  diagnostics.measure("render.chat", () => { clock += 8; });
  diagnostics.trackInput(input);
  clock = 20;
  input.emit("beforeinput");
  clock = 25;
  input.emit("input");
  diagnostics.collect(() => ({ cachedMessages: 12 }));

  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.timings["render.chat"].latest, 8);
  assert.equal(snapshot.timings["input.latency"].latest, 5);
  assert.equal(snapshot.gauges.domNodes, 42);
  assert.equal(snapshot.gauges.cachedMessages, 12);
});

test("disabled diagnostics add no timing samples", () => {
  const diagnostics = createPerformanceDiagnostics({ enabled: false });
  const value = diagnostics.measure("render.chat", () => 9);

  assert.equal(value, 9);
  assert.deepEqual(diagnostics.snapshot().timings, {});
});
