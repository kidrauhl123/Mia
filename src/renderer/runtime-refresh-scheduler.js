(function initRuntimeRefreshScheduler(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }
  root.miaRuntimeRefreshScheduler = factory();
})(typeof globalThis !== "undefined" ? globalThis : window, function runtimeRefreshSchedulerFactory() {
  "use strict";

  function createRuntimeRefreshScheduler(options = {}) {
    const refresh = typeof options.refresh === "function" ? options.refresh : null;
    if (!refresh) throw new Error("refresh dependency is required.");
    const intervalMs = Number.isFinite(Number(options.intervalMs)) ? Number(options.intervalMs) : 2000;
    const setIntervalImpl = typeof options.setInterval === "function" ? options.setInterval : setInterval;
    const clearIntervalImpl = typeof options.clearInterval === "function" ? options.clearInterval : clearInterval;
    const onError = typeof options.onError === "function" ? options.onError : () => {};

    let timer = 0;
    let inFlight = null;
    let queued = false;
    let stopped = false;

    function report(error) {
      try { onError(error); } catch { /* ignore reporter failures */ }
    }

    function finish(current) {
      if (inFlight !== current) return;
      inFlight = null;
      if (!queued || stopped) {
        queued = false;
        return;
      }
      queued = false;
      launch().catch(report);
    }

    function launch() {
      let current;
      try {
        current = Promise.resolve(refresh());
      } catch (error) {
        current = Promise.reject(error);
      }
      inFlight = current;
      current.then(
        () => finish(current),
        () => finish(current)
      );
      return current;
    }

    function runNow(runOptions = {}) {
      if (inFlight) {
        if (runOptions.queueIfRunning) queued = true;
        return inFlight;
      }
      return launch();
    }

    function start() {
      if (timer) return timer;
      stopped = false;
      timer = setIntervalImpl(() => {
        runNow({ queueIfRunning: true }).catch(report);
      }, intervalMs);
      return timer;
    }

    function stop() {
      stopped = true;
      queued = false;
      if (!timer) return;
      clearIntervalImpl(timer);
      timer = 0;
    }

    return {
      runNow,
      start,
      stop,
      isRunning: () => Boolean(inFlight)
    };
  }

  return {
    createRuntimeRefreshScheduler
  };
});
