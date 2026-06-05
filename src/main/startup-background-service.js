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
  setDaemonLastError = () => {},
  setEngineLastError = () => {},
  appendDaemonLog = () => {},
  appendEngineLog = () => {}
} = {}) {
  if (typeof getRuntimeStatus !== "function") throw new Error("getRuntimeStatus dependency is required.");

  async function runDaemon() {
    if (typeof startDaemonService !== "function") return createStepResult(true, { skipped: true });
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
    if (!runtime?.engineInstalled) {
      appendEngineLog("No Hermes available (system or managed); waiting for manual setup.");
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
