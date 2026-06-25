"use strict";

function createRuntimeLifecycleService({
  appendDaemonLog,
  getRuntimeStatus,
  initializeRuntimeCore,
  isDaemonProcess = false,
  refreshSystemHermesAsync,
  setDaemonLastError,
  startDaemonService,
  timer
}) {
  if (typeof initializeRuntimeCore !== "function") throw new Error("initializeRuntimeCore dependency is required.");
  if (typeof getRuntimeStatus !== "function") throw new Error("getRuntimeStatus dependency is required.");

  let runtimeInitialized = false;
  let backgroundStartupScheduled = false;

  const mark = (label, details) => {
    if (timer && typeof timer.mark === "function") timer.mark(label, details);
  };

  const initializeRuntime = () => {
    if (runtimeInitialized) {
      mark("runtime:cache-hit");
      return getRuntimeStatus();
    }
    mark("runtime:init-start");
    const status = initializeRuntimeCore();
    runtimeInitialized = true;
    mark("runtime:init-done", { created: Array.isArray(status?.created) ? status.created.length : 0 });
    return status;
  };

  const scheduleBackgroundStartup = ({ delayMs = 800 } = {}) => {
    if (isDaemonProcess || backgroundStartupScheduled) return false;
    backgroundStartupScheduled = true;
    mark("background:scheduled", { delayMs });
    setTimeout(() => {
      mark("daemon:start-scheduled");
      Promise.resolve()
        .then(() => startDaemonService?.())
        .then(() => mark("daemon:start-done"))
        .catch((error) => {
          const message = String(error?.message || error);
          setDaemonLastError?.(message);
          appendDaemonLog?.(`Background daemon registration failed: ${message}`);
          mark("daemon:start-error", { message });
        });

      Promise.resolve()
        .then(() => refreshSystemHermesAsync?.())
        .then(() => mark("system-hermes:refresh-done"))
        .catch(() => { /* cached lastError */ });
    }, delayMs);
    return true;
  };

  return {
    initializeRuntime,
    isBackgroundStartupScheduled: () => backgroundStartupScheduled,
    isRuntimeInitialized: () => runtimeInitialized,
    scheduleBackgroundStartup
  };
}

module.exports = {
  createRuntimeLifecycleService
};
