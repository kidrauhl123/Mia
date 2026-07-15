(function initIdleScheduler(root) {
  "use strict";

  function schedule(task, options = {}) {
    if (typeof task !== "function") return () => {};
    const delayMs = Number.isFinite(Number(options.delayMs)) ? Math.max(0, Number(options.delayMs)) : 0;
    const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Math.max(0, Number(options.timeoutMs)) : 2_000;
    let cancelled = false;
    let idleId = 0;

    const timerId = root.setTimeout(() => {
      if (cancelled) return;
      const run = () => {
        if (cancelled) return;
        Promise.resolve()
          .then(task)
          .catch((error) => options.onError?.(error));
      };
      if (typeof root.requestIdleCallback === "function") {
        idleId = root.requestIdleCallback(run, { timeout: timeoutMs });
      } else {
        idleId = root.setTimeout(run, 0);
      }
    }, delayMs);

    return () => {
      cancelled = true;
      root.clearTimeout(timerId);
      if (!idleId) return;
      if (typeof root.cancelIdleCallback === "function") root.cancelIdleCallback(idleId);
      else root.clearTimeout(idleId);
    };
  }

  root.miaIdleScheduler = { schedule };
})(typeof window !== "undefined" ? window : globalThis);
