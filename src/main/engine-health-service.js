const net = require("node:net");

function defaultSleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function createEngineHealthService(deps = {}) {
  const createServer = deps.createServer || (() => net.createServer());
  const fetchImpl = deps.fetchImpl || fetch;
  const timeoutSignal = deps.timeoutSignal || ((timeoutMs) => AbortSignal.timeout(timeoutMs));
  const sleep = deps.sleep || defaultSleep;
  const now = deps.now || (() => Date.now());
  const apiKey = deps.apiKey || (() => "");
  const getEngineState = deps.getEngineState || (() => ({}));
  const setEngineState = deps.setEngineState || (() => {});
  const getEngineProcess = deps.getEngineProcess || (() => null);
  const readConfiguredPort = deps.readConfiguredPort || (() => Number(getEngineState()?.port || 0));

  function choosePort(preferred = 18642, attempts = 40) {
    const start = preferred;
    return new Promise((resolve) => {
      let index = 0;
      const tryNext = () => {
        if (index >= attempts) {
          resolve(0);
          return;
        }
        const port = start + index;
        index += 1;
        const server = createServer();
        server.once("error", tryNext);
        server.listen(port, "127.0.0.1", () => {
          const selected = server.address().port;
          server.close(() => resolve(selected));
        });
      };
      tryNext();
    });
  }

  async function isEngineHealthy(baseUrl, timeoutMs = 1200) {
    try {
      const probe = await fetchImpl(`${baseUrl}/v1/runs/_mia_probe/events`, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey()}` },
        signal: timeoutSignal(timeoutMs)
      });
      return probe.status === 404 || probe.status === 200;
    } catch {
      return false;
    }
  }

  async function refreshRunningEngineHealth() {
    const state = getEngineState();
    if (!state?.running || !state.baseUrl) return false;
    if (await isEngineHealthy(state.baseUrl)) return true;
    setEngineState({
      ...state,
      running: false,
      starting: false,
      baseUrl: "",
      managedBy: "",
      lastError: "Hermes API is no longer reachable."
    });
    return false;
  }

  async function adoptRunningEngine() {
    const port = Number(readConfiguredPort() || 0);
    if (!port) return false;
    const baseUrl = `http://127.0.0.1:${port}`;
    if (!(await isEngineHealthy(baseUrl))) return false;
    setEngineState({
      ...getEngineState(),
      running: true,
      starting: false,
      baseUrl,
      managedBy: ""
    });
    return true;
  }

  async function waitForHealth(baseUrl, timeoutMs = 45000, requireChildProcess = false) {
    const started = now();
    while (now() - started < timeoutMs) {
      try {
        const response = await fetchImpl(`${baseUrl}/health`, {
          headers: { Authorization: `Bearer ${apiKey()}` }
        });
        const child = getEngineProcess();
        if (response.ok && (!requireChildProcess || (child && child.exitCode === null))) return true;
      } catch {
        // Keep polling until the process is ready or times out.
      }
      await sleep(500);
    }
    return false;
  }

  return {
    choosePort,
    adoptRunningEngine,
    isEngineHealthy,
    refreshRunningEngineHealth,
    waitForHealth
  };
}

module.exports = {
  createEngineHealthService
};
