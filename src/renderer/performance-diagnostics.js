(function initPerformanceDiagnostics(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }
  root.miaPerformanceDiagnostics = factory();
})(typeof globalThis !== "undefined" ? globalThis : window, function performanceDiagnosticsFactory() {
  "use strict";

  function createPerformanceDiagnostics({
    enabled = false,
    performance: performanceRef = typeof performance !== "undefined" ? performance : null,
    document: documentRef = typeof document !== "undefined" ? document : null,
    window: windowRef = typeof window !== "undefined" ? window : null,
    sampleLimit = 120,
    sampleIntervalMs = 15_000
  } = {}) {
    const samples = new Map();
    const gauges = {};
    let interval = 0;
    let inputStartedAt = 0;
    let baselineHeap = 0;
    let inputElement = null;

    function now() {
      const value = Number(performanceRef?.now?.());
      return Number.isFinite(value) ? value : Date.now();
    }

    function record(name, value) {
      if (!enabled) return Number(value) || 0;
      const key = String(name || "sample");
      const values = samples.get(key) || [];
      values.push(Number(value) || 0);
      if (values.length > sampleLimit) values.splice(0, values.length - sampleLimit);
      samples.set(key, values);
      return values[values.length - 1];
    }

    function measure(name, operation) {
      if (typeof operation !== "function") return undefined;
      if (!enabled) return operation();
      const startedAt = now();
      try {
        return operation();
      } finally {
        record(name, now() - startedAt);
      }
    }

    async function measureAsync(name, operation) {
      if (typeof operation !== "function") return undefined;
      if (!enabled) return operation();
      const startedAt = now();
      try {
        return await operation();
      } finally {
        record(name, now() - startedAt);
      }
    }

    function summarize(values) {
      if (!values?.length) return { count: 0, latest: 0, average: 0, max: 0, p95: 0 };
      const sorted = [...values].sort((a, b) => a - b);
      const sum = values.reduce((total, value) => total + value, 0);
      return {
        count: values.length,
        latest: values[values.length - 1],
        average: sum / values.length,
        max: sorted[sorted.length - 1],
        p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
      };
    }

    function snapshot(extra = {}) {
      const timings = {};
      for (const [name, values] of samples.entries()) timings[name] = summarize(values);
      return {
        enabled,
        capturedAt: new Date().toISOString(),
        timings,
        gauges: { ...gauges },
        ...extra
      };
    }

    function onBeforeInput() {
      inputStartedAt = now();
    }

    function onInput() {
      if (!inputStartedAt) return;
      record("input.latency", Math.max(0, now() - inputStartedAt));
      inputStartedAt = 0;
    }

    function trackInput(element) {
      if (!enabled || inputElement === element) return;
      if (inputElement) {
        inputElement.removeEventListener?.("beforeinput", onBeforeInput, true);
        inputElement.removeEventListener?.("input", onInput, true);
      }
      inputElement = element || null;
      inputElement?.addEventListener?.("beforeinput", onBeforeInput, true);
      inputElement?.addEventListener?.("input", onInput, true);
    }

    function collect(getExtraGauges) {
      if (!enabled || documentRef?.hidden) return;
      const memory = performanceRef?.memory;
      const usedHeap = Number(memory?.usedJSHeapSize) || 0;
      if (usedHeap && !baselineHeap) baselineHeap = usedHeap;
      gauges.domNodes = Number(documentRef?.querySelectorAll?.("*")?.length) || 0;
      gauges.heapBytes = usedHeap;
      gauges.heapGrowthBytes = usedHeap && baselineHeap ? usedHeap - baselineHeap : 0;
      Object.assign(gauges, getExtraGauges?.() || {});
    }

    function start({ input, getGauges } = {}) {
      if (!enabled || interval) return;
      trackInput(input);
      collect(getGauges);
      interval = windowRef?.setInterval?.(() => collect(getGauges), sampleIntervalMs) || 0;
    }

    function stop() {
      if (interval) windowRef?.clearInterval?.(interval);
      interval = 0;
      trackInput(null);
    }

    return {
      collect,
      enabled,
      measure,
      measureAsync,
      record,
      snapshot,
      start,
      stop,
      trackInput
    };
  }

  return { createPerformanceDiagnostics };
});
