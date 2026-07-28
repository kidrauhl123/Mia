(function initComposerInputScheduler(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }
  root.miaComposerInputScheduler = factory();
})(typeof globalThis !== "undefined" ? globalThis : window, function composerInputSchedulerFactory() {
  "use strict";

  function createComposerInputScheduler({
    refresh,
    requestFrame = (callback) => requestAnimationFrame(callback),
    cancelFrame = (id) => cancelAnimationFrame(id)
  } = {}) {
    if (typeof refresh !== "function") throw new Error("refresh dependency is required.");
    let frame = 0;

    function flush() {
      if (frame) {
        cancelFrame(frame);
        frame = 0;
      }
      refresh();
    }

    function schedule() {
      if (frame) return frame;
      frame = requestFrame(() => {
        frame = 0;
        refresh();
      });
      return frame;
    }

    function cancel() {
      if (!frame) return;
      cancelFrame(frame);
      frame = 0;
    }

    return {
      cancel,
      flush,
      schedule,
      isScheduled: () => Boolean(frame)
    };
  }

  return { createComposerInputScheduler };
});
