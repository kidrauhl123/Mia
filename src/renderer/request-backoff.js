(function initRequestBackoff(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }
  root.miaRequestBackoff = factory();
})(typeof globalThis !== "undefined" ? globalThis : window, function requestBackoffFactory() {
  "use strict";

  function createRequestBackoff(options = {}) {
    const now = typeof options.now === "function" ? options.now : Date.now;
    const baseDelayMs = Math.max(0, Number(options.baseDelayMs) || 1_000);
    const maxDelayMs = Math.max(baseDelayMs, Number(options.maxDelayMs) || 30_000);
    const stateByKey = new Map();

    function stateFor(key) {
      return stateByKey.get(String(key || "")) || { failures: 0, retryAt: 0 };
    }

    function canRun(key) {
      return now() >= stateFor(key).retryAt;
    }

    function succeed(key) {
      stateByKey.delete(String(key || ""));
    }

    function fail(key) {
      const normalizedKey = String(key || "");
      const previous = stateFor(normalizedKey);
      const failures = previous.failures + 1;
      const delayMs = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, failures - 1)));
      const next = { failures, retryAt: now() + delayMs, delayMs };
      stateByKey.set(normalizedKey, next);
      return next;
    }

    function reset(key) {
      stateByKey.delete(String(key || ""));
    }

    function resetAll() {
      stateByKey.clear();
    }

    return {
      canRun,
      fail,
      reset,
      resetAll,
      state: stateFor,
      succeed
    };
  }

  return { createRequestBackoff };
});
