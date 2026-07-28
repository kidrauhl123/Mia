(function initRenderScheduler(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }
  root.miaRenderScheduler = factory();
})(typeof globalThis !== "undefined" ? globalThis : window, function renderSchedulerFactory() {
  "use strict";

  function createRenderScheduler({
    render,
    requestFrame = (callback) => requestAnimationFrame(callback),
    cancelFrame = (id) => cancelAnimationFrame(id)
  } = {}) {
    if (typeof render !== "function") throw new Error("render dependency is required.");
    let frame = 0;
    const pendingScopes = new Set();

    function addScope(scope) {
      if (Array.isArray(scope) || scope instanceof Set) {
        for (const item of scope) addScope(item);
        return;
      }
      pendingScopes.add(String(scope || "default"));
    }

    function takeScopes() {
      const scopes = [...pendingScopes];
      pendingScopes.clear();
      return scopes;
    }

    function schedule(scope = "default") {
      addScope(scope);
      if (frame) return frame;
      frame = requestFrame(() => {
        frame = 0;
        render(takeScopes());
      });
      return frame;
    }

    function flush(scope) {
      if (scope !== undefined) addScope(scope);
      if (!pendingScopes.size) addScope("default");
      if (frame) cancelFrame(frame);
      frame = 0;
      render(takeScopes());
    }

    function cancel() {
      if (frame) cancelFrame(frame);
      frame = 0;
      pendingScopes.clear();
    }

    return {
      cancel,
      flush,
      schedule,
      isScheduled: () => Boolean(frame),
      pendingScopes: () => [...pendingScopes]
    };
  }

  return { createRenderScheduler };
});
