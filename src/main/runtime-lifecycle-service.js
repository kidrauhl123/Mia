"use strict";

function createRuntimeLifecycleService({
  appendDaemonLog,
  appendEngineLog,
  getRuntimeStatus,
  initializeRuntimeCore,
  isDaemonProcess = false,
  refreshSystemHermesAsync,
  setDaemonLastError,
  setEngineLastError,
  startDaemonService,
  startEngine,
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

  const scheduleBackgroundStartup = ({ delayMs = 800, engineDelayMs = 1500 } = {}) => {
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

      setTimeout(async () => {
        try {
          if (!getRuntimeStatus().engineInstalled) {
            appendEngineLog?.("No Hermes available from the user's system install; waiting for manual setup.");
            mark("engine:auto-start-skipped");
            return;
          }
          mark("engine:auto-start-begin");
          await startEngine?.();
          mark("engine:auto-start-done");
        } catch (error) {
          const message = String(error?.message || error);
          setEngineLastError?.(message);
          appendEngineLog?.(`Auto-start failed: ${message}`);
          mark("engine:auto-start-error", { message });
        }
      }, engineDelayMs);
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
