"use strict";

const DEFAULT_MAX_CONCURRENT_REQUESTS = 6;

function createCloudRequestCoordinator({
  execute,
  maxConcurrent = DEFAULT_MAX_CONCURRENT_REQUESTS
} = {}) {
  if (typeof execute !== "function") throw new Error("execute dependency is required.");
  const concurrency = Math.max(1, Number.parseInt(String(maxConcurrent || ""), 10) || DEFAULT_MAX_CONCURRENT_REQUESTS);
  const pendingReads = new Map();
  const queue = [];
  let active = 0;

  function drain() {
    while (active < concurrency && queue.length) {
      const entry = queue.shift();
      active += 1;
      Promise.resolve()
        .then(() => execute(entry.request))
        .then(entry.resolve, entry.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }

  function enqueue(request) {
    return new Promise((resolve, reject) => {
      queue.push({ request, resolve, reject });
      drain();
    });
  }

  function request(input = {}) {
    const method = String(input.method || "GET").toUpperCase();
    const canShare = (method === "GET" || method === "HEAD") && input.body === undefined;
    if (!canShare) return enqueue({ ...input, method });
    const key = [
      method,
      String(input.baseUrl || ""),
      String(input.path || ""),
      String(input.token || "")
    ].join(" ");
    if (pendingReads.has(key)) return pendingReads.get(key);
    const current = enqueue({ ...input, method });
    pendingReads.set(key, current);
    current.then(
      () => {
        if (pendingReads.get(key) === current) pendingReads.delete(key);
      },
      () => {
        if (pendingReads.get(key) === current) pendingReads.delete(key);
      }
    );
    return current;
  }

  return {
    request,
    status: () => ({ active, queued: queue.length, pendingReads: pendingReads.size })
  };
}

module.exports = {
  DEFAULT_MAX_CONCURRENT_REQUESTS,
  createCloudRequestCoordinator
};
