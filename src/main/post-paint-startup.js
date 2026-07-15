"use strict";

function createPostPaintStartup({
  startRuntime,
  startMcp,
  refreshCloud,
  startAutoUpdate,
  timer,
  setTimeoutFn = setTimeout,
  delays = {}
} = {}) {
  let started = false;
  const runtimeDelayMs = Number.isFinite(Number(delays.runtime)) ? Number(delays.runtime) : 350;
  const mcpDelayMs = Number.isFinite(Number(delays.mcp)) ? Number(delays.mcp) : 2_500;
  const cloudDelayMs = Number.isFinite(Number(delays.cloud)) ? Number(delays.cloud) : 1_200;
  const autoUpdateDelayMs = Number.isFinite(Number(delays.autoUpdate)) ? Number(delays.autoUpdate) : 5_000;

  const mark = (label, details) => timer?.mark?.(label, details);

  function schedule(label, delayMs, task) {
    if (typeof task !== "function") return;
    mark(`${label}:scheduled`, { delayMs });
    setTimeoutFn(() => {
      mark(`${label}:start`);
      Promise.resolve()
        .then(task)
        .then(() => mark(`${label}:done`))
        .catch((error) => mark(`${label}:error`, { message: String(error?.message || error) }));
    }, delayMs);
  }

  function start() {
    if (started) return false;
    started = true;
    schedule("post-paint:runtime", runtimeDelayMs, startRuntime);
    schedule("post-paint:cloud", cloudDelayMs, refreshCloud);
    schedule("post-paint:mcp", mcpDelayMs, startMcp);
    schedule("post-paint:auto-update", autoUpdateDelayMs, startAutoUpdate);
    return true;
  }

  return {
    isStarted: () => started,
    start
  };
}

module.exports = {
  createPostPaintStartup
};
