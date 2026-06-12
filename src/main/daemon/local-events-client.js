"use strict";

// P0 of ADR 2026-06-12 desktop-single-owner-daemon: the window subscribes to
// the daemon's /api/local-events SSE stream and re-broadcasts every envelope
// to its renderers. The daemon is the sole executor, so this is the only way
// bot run streams (typing indicator, token streaming, tool traces) reach the
// window; in P2 it also becomes the window's cloud-event path.
const { request: defaultHttpRequest } = require("node:http");

const MAX_RECONNECT_DELAY_MS = 15000;

function parseSseBuffer(buffer, onEnvelope) {
  let rest = buffer;
  let separator;
  while ((separator = rest.indexOf("\n\n")) !== -1) {
    const block = rest.slice(0, separator);
    rest = rest.slice(separator + 2);
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6))
      .join("\n");
    if (!data) continue;
    let envelope = null;
    try {
      envelope = JSON.parse(data);
    } catch {
      continue;
    }
    if (envelope && envelope.type) onEnvelope(envelope);
  }
  return rest;
}

function createLocalEventsClient({
  baseUrl,
  daemonToken,
  enabled = () => true,
  onEnvelope = () => {},
  onStateChange = () => {},
  requestImpl = defaultHttpRequest,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  initialReconnectDelayMs = 1000
}) {
  let stopped = false;
  let timer = null;
  let activeRequest = null;
  let connected = false;
  let reconnectDelay = initialReconnectDelayMs;

  function setConnected(next) {
    if (connected === next) return;
    connected = next;
    try {
      onStateChange(connected);
    } catch { /* listener errors must not kill the stream */ }
  }

  function scheduleReconnect() {
    setConnected(false);
    activeRequest = null;
    if (stopped || timer) return;
    timer = setTimeoutFn(() => {
      timer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }

  function connect() {
    if (stopped || activeRequest) return;
    if (!enabled()) {
      // Daemon disabled: the window is the sole owner and runs everything
      // itself — keep idling cheaply until the toggle flips back.
      scheduleReconnect();
      return;
    }
    let url;
    try {
      url = new URL("/api/local-events", baseUrl());
    } catch {
      scheduleReconnect();
      return;
    }
    const request = requestImpl({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "GET",
      headers: {
        Authorization: `Bearer ${daemonToken()}`,
        Accept: "text/event-stream"
      }
    });
    activeRequest = request;
    request.on("response", (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        response.on("end", scheduleReconnect);
        return;
      }
      reconnectDelay = initialReconnectDelayMs;
      setConnected(true);
      let buffer = "";
      response.on("data", (chunk) => {
        buffer = parseSseBuffer(buffer + String(chunk), onEnvelope);
      });
      response.on("end", scheduleReconnect);
      response.on("error", scheduleReconnect);
    });
    request.on("error", scheduleReconnect);
    request.end();
  }

  function start() {
    if (!stopped && !activeRequest && !timer) connect();
    return status();
  }

  function stop() {
    stopped = true;
    if (timer) {
      clearTimeoutFn(timer);
      timer = null;
    }
    const request = activeRequest;
    activeRequest = null;
    try {
      request?.destroy?.();
    } catch { /* ignore teardown failures */ }
    setConnected(false);
    return status();
  }

  function status() {
    return { connected, stopped };
  }

  return { start, stop, status };
}

module.exports = { createLocalEventsClient, parseSseBuffer };
