"use strict";

function errorMessage(error) {
  return String(error?.message || error || "Unknown error");
}

function createStartupMcpInitializer({
  initializeMcp,
  timeoutMs = 5000,
  appendEngineLog = () => {}
} = {}) {
  if (typeof initializeMcp !== "function") throw new Error("initializeMcp dependency is required.");

  let pendingPromise = null;
  let startupPromise = null;

  function pending() {
    return pendingPromise;
  }

  function ensurePending() {
    if (!pendingPromise) {
      pendingPromise = Promise.resolve()
        .then(() => initializeMcp())
        .then((result) => {
          if (!result?.success && result?.error) {
            appendEngineLog(`MCP bridge initialization failed: ${result.error}`);
          }
          return result;
        })
        .catch((error) => {
          const message = errorMessage(error);
          appendEngineLog(`MCP bridge initialization failed: ${message}`);
          return { success: false, data: null, error: message };
        });
    }
    return pendingPromise;
  }

  function start() {
    if (startupPromise) return startupPromise;
    const pendingInit = ensurePending();
    startupPromise = new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        appendEngineLog(`MCP bridge initialization timed out after ${timeoutMs}ms; continuing app startup.`);
        resolve({
          success: false,
          data: null,
          error: `Timed out after ${timeoutMs}ms waiting for MCP initialization.`,
          timedOut: true
        });
      }, timeoutMs);
      pendingInit.then((result) => {
        if (settled) return;
        clearTimeout(timer);
        resolve(result);
      });
    });
    return startupPromise;
  }

  return {
    pending,
    start
  };
}

module.exports = {
  createStartupMcpInitializer
};
