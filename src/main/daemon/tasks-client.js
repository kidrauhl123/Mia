"use strict";

const http = require("node:http");
const https = require("node:https");

function createDaemonTasksClient({
  isDaemonProcess = false,
  getDaemonSettings,
  getDaemonStatus,
  daemonToken,
  fetchImpl = fetch,
  httpRequest = http.request,
  httpsRequest = https.request,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  sendTaskEvent = () => {}
}) {
  function baseUrl() {
    const settings = getDaemonSettings();
    const status = getDaemonStatus();
    return status.baseUrl || `http://${settings.host}:${settings.port}`;
  }

  async function call(pathSegment, opts = {}) {
    const response = await fetchImpl(`${baseUrl()}${pathSegment}`, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${daemonToken()}`,
        ...(opts.headers || {})
      }
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`daemon ${response.status}: ${body || response.statusText}`);
    }
    return response.json();
  }

  function parseSseChunk(buffer, chunk) {
    let nextBuffer = buffer + chunk.toString("utf8");
    const events = nextBuffer.split("\n\n");
    nextBuffer = events.pop() || "";
    for (const eventText of events) {
      const lines = eventText.split("\n");
      let type = "";
      let data = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) type = line.slice(7).trim();
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (!type) continue;
      try {
        sendTaskEvent({ type, payload: JSON.parse(data || "null") });
      } catch {
        // Ignore malformed daemon SSE payloads; the stream should stay alive.
      }
    }
    return nextBuffer;
  }

  function startEvents() {
    if (isDaemonProcess) return { stop() {} };

    let stopped = false;
    let reconnectDelay = 1000;
    let timer = null;
    let activeRequest = null;

    function scheduleReconnect() {
      if (stopped) return;
      timer = setTimeoutImpl(connect, reconnectDelay);
    }

    function connect() {
      if (stopped) return;
      const urlObj = new URL(`${baseUrl()}/api/tasks/events`);
      const requestImpl = urlObj.protocol === "https:" ? httpsRequest : httpRequest;
      activeRequest = requestImpl({
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: `${urlObj.pathname}${urlObj.search || ""}`,
        method: "GET",
        headers: {
          Authorization: `Bearer ${daemonToken()}`,
          Accept: "text/event-stream"
        }
      });
      activeRequest.on("response", (res) => {
        if (res.statusCode >= 400) {
          reconnectDelay = Math.min(reconnectDelay * 2, 15000);
          res.resume();
          res.on("end", scheduleReconnect);
          return;
        }
        reconnectDelay = 1000;
        let buffer = "";
        res.on("data", (chunk) => {
          buffer = parseSseChunk(buffer, chunk);
        });
        res.on("end", scheduleReconnect);
        res.on("error", scheduleReconnect);
      });
      activeRequest.on("error", () => {
        reconnectDelay = Math.min(reconnectDelay * 2, 15000);
        scheduleReconnect();
      });
      activeRequest.end();
    }

    connect();

    return {
      stop() {
        stopped = true;
        if (timer) clearTimeoutImpl(timer);
        if (activeRequest?.destroy) activeRequest.destroy();
      }
    };
  }

  return {
    call,
    startEvents
  };
}

module.exports = {
  createDaemonTasksClient
};
