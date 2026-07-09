"use strict";

function createRuntimeLifecycleService({
  appendDaemonLog,
  getRuntimeStatus,
  initializeRuntimeCore,
  isDaemonProcess = false,
  prepareEngineRuntimeConfigAsync,
  refreshAgentWorkspaceAsync,
  refreshMemorySettingsAsync,
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
        .then(() => {
          if (typeof prepareEngineRuntimeConfigAsync !== "function") return null;
          return Promise.resolve()
            .then(() => prepareEngineRuntimeConfigAsync())
            .then(() => mark("engine-runtime-config:prepare-done"))
            .catch((error) => {
              appendDaemonLog?.(`Hermes runtime Core config refresh failed: ${error?.message || error}`);
              mark("engine-runtime-config:prepare-error", { message: String(error?.message || error) });
            });
        })
        .then(() => {
          if (typeof refreshAgentWorkspaceAsync !== "function") return null;
          return Promise.resolve()
            .then(() => refreshAgentWorkspaceAsync())
            .then(() => mark("agent-workspace:refresh-done"))
            .catch((error) => {
              appendDaemonLog?.(`Agent workspace Core refresh failed: ${error?.message || error}`);
              mark("agent-workspace:refresh-error", { message: String(error?.message || error) });
            });
        })
        .then(() => {
          if (typeof refreshMemorySettingsAsync !== "function") return null;
          return Promise.resolve()
            .then(() => refreshMemorySettingsAsync())
            .then(() => mark("memory-settings:refresh-done"))
            .catch((error) => {
              appendDaemonLog?.(`Memory settings Core refresh failed: ${error?.message || error}`);
              mark("memory-settings:refresh-error", { message: String(error?.message || error) });
            });
        })
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
