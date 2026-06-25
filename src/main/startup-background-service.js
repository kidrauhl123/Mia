"use strict";

function createStepResult(ok, extra = {}) {
  return {
    ok: Boolean(ok),
    ...extra
  };
}

function errorMessage(error) {
  return String(error?.message || error || "Unknown error");
}

function createStartupBackgroundService({
  getRuntimeStatus,
  startDaemonService,
  refreshSystemHermesAsync,
  startEngine,
  shouldStartEngine = () => true,
  isDaemonEnabled = () => true,
  setDaemonLastError = () => {},
  setEngineLastError = () => {},
  appendDaemonLog = () => {},
  appendEngineLog = () => {}
} = {}) {
  if (typeof getRuntimeStatus !== "function") throw new Error("getRuntimeStatus dependency is required.");

  async function runDaemon() {
    if (typeof startDaemonService !== "function") return createStepResult(true, { skipped: true });
    // The daemon is Mia's single runtime owner. There is no foreground fallback;
    // still call the predicate so embedders can surface diagnostics, but never
    // skip startup because of a stale disabled setting.
    isDaemonEnabled();
    try {
      const status = await startDaemonService();
      return createStepResult(true, { status });
    } catch (error) {
      const message = errorMessage(error);
      setDaemonLastError(message);
      appendDaemonLog(`Startup daemon registration failed: ${message}`);
      return createStepResult(false, { error: message });
    }
  }

  async function refreshSystemHermes() {
    if (typeof refreshSystemHermesAsync !== "function") return createStepResult(true, { skipped: true });
    try {
      await refreshSystemHermesAsync();
      return createStepResult(true);
    } catch (error) {
      return createStepResult(false, { error: errorMessage(error) });
    }
  }

  async function runEngine() {
    const runtime = getRuntimeStatus();
    if (!shouldStartEngine()) {
      appendEngineLog("Hermes startup skipped here; Mia Core owns local engine runs.");
      return createStepResult(true, { skipped: true });
    }
    if (!runtime?.engineInstalled) {
      appendEngineLog("No Hermes available from the user's system install; waiting for manual setup.");
      return createStepResult(true, { skipped: true });
    }
    if (typeof startEngine !== "function") return createStepResult(true, { skipped: true });
    try {
      const status = await startEngine();
      return createStepResult(true, { status });
    } catch (error) {
      const message = errorMessage(error);
      setEngineLastError(message);
      appendEngineLog(`Startup engine auto-start failed: ${message}`);
      return createStepResult(false, { error: message });
    }
  }

  async function run() {
    const steps = {
      daemon: await runDaemon(),
      systemHermes: await refreshSystemHermes(),
      engine: await runEngine()
    };
    return {
      ok: Object.values(steps).every((step) => step.ok),
      steps
    };
  }

  return { run };
}

module.exports = {
  createStartupBackgroundService
};
