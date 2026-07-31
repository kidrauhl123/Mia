"use strict";

const nodeHttp = require("node:http");

const { createMiaCoreHttpClient } = require("../shared/mia-core-http-client.js");
const { createMiaCoreLocalEventsClient } = require("../shared/mia-core-event-client.js");
const { coreRequestShouldWaitForStreamingEvents } = require("../shared/mia-core-request-policy.js");

function createNodeLoopbackFetch(deps = {}) {
  const http = deps.http || nodeHttp;
  return async function nodeLoopbackFetch(url, options = {}) {
    const target = new URL(String(url || ""));
    if (target.protocol !== "http:" || target.hostname !== "127.0.0.1") {
      throw new Error("Mia Core direct transport only allows 127.0.0.1 HTTP requests.");
    }
    return new Promise((resolve, reject) => {
      const signal = options.signal;
      const request = http.request({
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: String(options.method || "GET").toUpperCase(),
        headers: options.headers || {}
      });
      const removeAbortListener = () => signal?.removeEventListener?.("abort", abort);
      const abort = () => {
        const reason = signal?.reason instanceof Error
          ? signal.reason
          : new Error("Mia Core request aborted.");
        request.destroy(reason);
      };
      request.on("response", (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("error", (error) => {
          removeAbortListener();
          reject(error);
        });
        response.on("end", () => {
          removeAbortListener();
          const body = Buffer.concat(chunks).toString("utf8");
          const status = Number(response.statusCode || 0);
          resolve({
            ok: status >= 200 && status < 300,
            status,
            statusText: String(response.statusMessage || ""),
            headers: {
              get(name) {
                const value = response.headers[String(name || "").toLowerCase()];
                return Array.isArray(value) ? value.join(", ") : String(value || "");
              }
            },
            json: async () => (body ? JSON.parse(body) : null),
            text: async () => body
          });
        });
      });
      request.on("error", (error) => {
        removeAbortListener();
        reject(error);
      });
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener?.("abort", abort, { once: true });
      if (options.body !== undefined && options.body !== null) request.write(options.body);
      request.end();
    });
  };
}

function loopbackBaseUrl(port) {
  const value = Number(port);
  return Number.isInteger(value) && value > 0 && value <= 65535
    ? `http://127.0.0.1:${value}`
    : "";
}

function createListenerSet() {
  const listeners = new Set();

  function emit(payload) {
    for (const listener of [...listeners]) {
      try {
        listener(payload);
      } catch {
        // One UI listener must not interrupt the shared Core event stream.
      }
    }
  }

  function subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { emit, subscribe };
}

function createMiaCoreDirectTransport(deps = {}) {
  const baseUrl = loopbackBaseUrl(deps.port);
  const fetchImpl = deps.fetch || createNodeLoopbackFetch({ http: deps.http });
  const WebSocketImpl = deps.WebSocketImpl || globalThis.WebSocket;
  const setTimeoutFn = deps.setTimeoutFn || setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn || clearTimeout;
  const cloudEvents = createListenerSet();
  const taskEvents = createListenerSet();
  const eventConnectionWaiters = new Set();
  let eventConnected = false;
  let eventsStarted = false;
  let disposed = false;
  const http = baseUrl && typeof fetchImpl === "function"
    ? createMiaCoreHttpClient({
      baseUrl,
      fetch: fetchImpl,
      requestTimeoutMs: deps.requestTimeoutMs
    })
    : null;

  const events = createMiaCoreLocalEventsClient({
    baseUrl: () => baseUrl,
    enabled: () => Boolean(baseUrl),
    WebSocketImpl,
    includeTaskEvents: true,
    setTimeoutFn,
    clearTimeoutFn,
    onEnvelope: (envelope) => {
      const coreType = String(envelope?.coreEnvelope?.name || envelope?.coreEnvelope?.type || "").trim();
      if (coreType.startsWith("task.")) {
        taskEvents.emit(envelope);
        return;
      }
      cloudEvents.emit(envelope);
    },
    onStateChange: (connected) => {
      eventConnected = Boolean(connected);
      if (eventConnected) {
        for (const waiter of [...eventConnectionWaiters]) waiter(true);
      }
      cloudEvents.emit({
        type: "daemon.local_events_status",
        payload: { connected: eventConnected }
      });
    }
  });

  function waitForEventConnection(timeoutMs = 2500) {
    if (eventConnected) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer = null;
      const settle = (connected) => {
        if (!eventConnectionWaiters.delete(settle)) return;
        if (timer) clearTimeoutFn(timer);
        resolve(Boolean(connected));
      };
      eventConnectionWaiters.add(settle);
      timer = setTimeoutFn(() => settle(false), Math.max(0, Number(timeoutMs) || 0));
    });
  }

  async function request(method, route, body) {
    if (!http) {
      throw new Error("Mia Core is not available.");
    }
    if (coreRequestShouldWaitForStreamingEvents({ method, route })) {
      ensureEventsStarted();
      await waitForEventConnection();
    }
    return http.request(method, route, body);
  }

  function ensureEventsStarted() {
    if (disposed || eventsStarted || !baseUrl) return;
    eventsStarted = true;
    events.start();
  }

  function subscribeCloudEvents(listener) {
    const unsubscribe = cloudEvents.subscribe(listener);
    ensureEventsStarted();
    return unsubscribe;
  }

  function subscribeTaskEvents(listener) {
    const unsubscribe = taskEvents.subscribe(listener);
    ensureEventsStarted();
    return unsubscribe;
  }

  function stop() {
    disposed = true;
    for (const waiter of [...eventConnectionWaiters]) waiter(false);
    return events.stop();
  }

  if (!baseUrl) events.stop();

  return {
    request,
    subscribeCloudEvents,
    subscribeTaskEvents,
    status: events.status,
    stop
  };
}

module.exports = {
  createMiaCoreDirectTransport,
  createNodeLoopbackFetch,
  loopbackBaseUrl
};
