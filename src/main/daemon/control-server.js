"use strict";

const http = require("node:http");
const os = require("node:os");

function createDaemonControlServer({
  isDaemonProcess = false,
  serviceLabel = "ai.mia.daemon",
  pid = () => process.pid,
  uptime = () => process.uptime(),
  networkInterfaces = () => os.networkInterfaces(),
  daemonToken,
  initializeRuntime,
  choosePort,
  getDaemonSettings,
  writeDaemonSettings,
  normalizeDaemonHost,
  normalizeDaemonPort,
  runtimePaths,
  remoteRouter,
  initSchedulerSubsystem,
  tasksRoutes,
  fetchImpl = fetch,
  timeoutSignal = (timeoutMs) => AbortSignal.timeout(timeoutMs)
}) {
  let controlServer = null;
  let state = {
    running: false,
    starting: false,
    host: "",
    port: 0,
    baseUrl: "",
    lastError: "",
    logs: []
  };

  function replaceLiteral(value, needle, replacement) {
    const text = String(value || "");
    const find = String(needle || "");
    if (!find) return text;
    return text.split(find).join(replacement);
  }

  function appendLog(line) {
    const clean = replaceLiteral(line, daemonToken(), "[REDACTED]");
    state.logs.push(clean);
    if (state.logs.length > 200) state.logs = state.logs.slice(-200);
  }

  function setLastError(message) {
    state.lastError = String(message || "");
  }

  function daemonConnectUrls(settings = getDaemonSettings()) {
    const port = normalizeDaemonPort(settings.port);
    const host = normalizeDaemonHost(settings.host);
    if (host !== "0.0.0.0" && host !== "::") {
      return [`http://${host}:${port}`];
    }
    const urls = [];
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries || []) {
        if (!entry || entry.internal || entry.family !== "IPv4") continue;
        if (/^169\.254\./.test(entry.address)) continue;
        if (/^198\.(18|19)\./.test(entry.address)) continue;
        urls.push(`http://${entry.address}:${port}`);
      }
    }
    return urls.length ? urls : [`http://127.0.0.1:${port}`];
  }

  function daemonPingUrls(settings = getDaemonSettings()) {
    const urls = daemonConnectUrls(settings);
    const port = normalizeDaemonPort(settings.port);
    const host = normalizeDaemonHost(settings.host);
    const localUrl = `http://127.0.0.1:${port}`;
    const candidates = host === "0.0.0.0" || host === "::" || host === "localhost"
      ? [localUrl, ...urls]
      : urls;
    return candidates.filter((url, index, list) => url && list.indexOf(url) === index);
  }

  function status() {
    const settings = getDaemonSettings();
    const paths = runtimePaths();
    return {
      processMode: isDaemonProcess ? "daemon" : "desktop",
      serviceLabel,
      settings,
      running: Boolean(state.running),
      starting: Boolean(state.starting),
      host: state.host || settings.host,
      port: state.port || settings.port,
      baseUrl: state.baseUrl || `http://${settings.host}:${settings.port}`,
      connectUrls: daemonConnectUrls(settings),
      runtimeHome: paths.home,
      launchAgent: paths.daemonLaunchAgent,
      lastError: state.lastError,
      logs: state.logs.slice(-80)
    };
  }

  async function observedStatus(timeoutMs = 500) {
    const current = status();
    if (state.running) return current;
    const probe = await ping(getDaemonSettings(), timeoutMs, { expectedRuntimeHome: runtimePaths().home });
    return {
      ...current,
      running: probe.ok,
      baseUrl: probe.baseUrl || current.baseUrl
    };
  }

  function requestAuthToken(req, url) {
    const header = String(req.headers.authorization || "");
    const bearer = header.match(/^Bearer\s+(.+)$/i);
    if (bearer) return bearer[1].trim();
    const explicit = req.headers["x-mia-token"];
    if (typeof explicit === "string") return explicit.trim();
    const query = url.searchParams.get("token");
    if (query) return query;
    return "";
  }

  function isAuthorized(req, url) {
    return requestAuthToken(req, url) === daemonToken();
  }

  function writeJson(res, statusCode, payload) {
    const body = JSON.stringify(payload ?? {}, null, 2);
    res.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, content-type, x-mia-token",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Cache-Control": "no-store"
    });
    res.end(body);
  }

  function writeText(res, statusCode, text, contentType) {
    const body = String(text || "");
    res.writeHead(statusCode, {
      "Content-Type": contentType,
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store"
    });
    res.end(body);
  }

  function readBody(req, maxBytes = 48 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      let body = "";
      let size = 0;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          reject(new Error("Request body is too large."));
          req.destroy();
          return;
        }
        body += String(chunk);
      });
      req.on("end", () => {
        if (!body.trim()) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error("Request body must be valid JSON."));
        }
      });
      req.on("error", reject);
    });
  }

  // P0 of ADR 2026-06-12 desktop-single-owner-daemon: the daemon pushes
  // renderer-bound events (bot run streams now, all cloud events in P2) to the
  // window over this local SSE stream, since the window no longer executes
  // runs itself and would otherwise lose typing/streaming UI.
  const localEventSubscribers = new Set();

  function handleLocalEventsStream(req, res) {
    // Defense in depth: this stream carries the user's full run/cloud event
    // feed, so never rely solely on handleRequest's guard ordering.
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    if (!isAuthorized(req, url)) {
      writeJson(res, 401, { error: "Unauthorized" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });
    res.write(": connected\n\n");
    localEventSubscribers.add(res);
    req.on("close", () => localEventSubscribers.delete(res));
  }

  function closeLocalEventSubscribers() {
    for (const subscriber of [...localEventSubscribers]) {
      try {
        subscriber.end();
      } catch { /* already gone */ }
    }
    localEventSubscribers.clear();
  }

  function publishLocalEvent(envelope = {}) {
    if (!envelope || !envelope.type) return 0;
    let payload;
    try {
      payload = `data: ${JSON.stringify(envelope)}\n\n`;
    } catch {
      return 0;
    }
    for (const subscriber of [...localEventSubscribers]) {
      if (subscriber.destroyed || subscriber.writableEnded) {
        localEventSubscribers.delete(subscriber);
        continue;
      }
      try {
        subscriber.write(payload);
      } catch {
        localEventSubscribers.delete(subscriber);
      }
    }
    return localEventSubscribers.size;
  }

  async function handleRequest(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    if (req.method === "OPTIONS") {
      writeJson(res, 204, {});
      return;
    }
    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      res.writeHead(204, { "Cache-Control": "public, max-age=86400" });
      res.end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      writeJson(res, 200, {
        status: "ok",
        service: "mia-daemon",
        pid: pid(),
        uptime: Math.round(uptime()),
        mode: isDaemonProcess ? "daemon" : "desktop",
        runtimeHome: runtimePaths().home
      });
      return;
    }
    if (!isAuthorized(req, url)) {
      writeJson(res, 401, { error: "Unauthorized" });
      return;
    }
    try {
      const routePath = `${url.pathname}${url.search || ""}`;
      const router = remoteRouter();
      if (router?.matches({ method: req.method, path: routePath })) {
        const body = req.method === "POST" ? await readBody(req) : {};
        if (req.method === "POST" && url.pathname === "/api/chat/stream") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*"
          });
          try {
            await router.route({
              method: req.method,
              path: routePath,
              body,
              emitStream: (event, data) => {
                if (res.destroyed || res.writableEnded) return;
                res.write(`event: ${event}\n`);
                res.write(`data: ${JSON.stringify(data)}\n\n`);
              },
              isStreamDestroyed: () => res.destroyed || res.writableEnded
            });
            if (!res.destroyed && !res.writableEnded) res.end();
          } catch (error) {
            if (!res.destroyed && !res.writableEnded) {
              res.write(`event: error\n`);
              res.write(`data: ${JSON.stringify({ error: String(error?.message || error) })}\n\n`);
              res.end();
            }
          }
          return;
        }
        const routed = await router.route({ method: req.method, path: routePath, body });
        if (routed.handled) {
          writeJson(res, 200, routed.data);
          return;
        }
        writeJson(res, 404, { error: "Not found" });
        return;
      }
      if (url.pathname === "/api/tasks/events" && req.method === "GET") {
        initSchedulerSubsystem();
        tasksRoutes().handleEventsStream(req, res);
        return;
      }
      if (url.pathname === "/api/local-events" && req.method === "GET") {
        handleLocalEventsStream(req, res);
        return;
      }
      if (url.pathname.startsWith("/api/tasks")) {
        initSchedulerSubsystem();
        const body = ["POST", "PATCH"].includes(req.method) ? await readBody(req) : null;
        const handled = await tasksRoutes().handle(req, res, body);
        if (handled) return;
      }
      writeJson(res, 404, { error: "Not found" });
    } catch (error) {
      writeJson(res, 500, { error: String(error?.message || error) });
    }
  }

  async function start(options = {}) {
    initializeRuntime();
    if (controlServer && state.running) return status();
    const settings = { ...getDaemonSettings(), ...options };
    const host = normalizeDaemonHost(settings.host);
    const preferredPort = normalizeDaemonPort(settings.port);
    const port = await choosePort(preferredPort, 20);
    if (!port) throw new Error("No available local port for Mia daemon.");
    state = {
      ...state,
      running: false,
      starting: true,
      host,
      port,
      baseUrl: `http://${host}:${port}`,
      lastError: ""
    };
    controlServer = http.createServer((req, res) => {
      handleRequest(req, res).catch((error) => {
        writeJson(res, 500, { error: String(error?.message || error) });
      });
    });
    await new Promise((resolve, reject) => {
      controlServer.once("error", reject);
      controlServer.listen(port, host, resolve);
    });
    initSchedulerSubsystem();
    state.running = true;
    state.starting = false;
    writeDaemonSettings({ ...settings, host, port });
    appendLog(`Mia daemon listening at ${state.baseUrl}`);
    return status();
  }

  function stop() {
    closeLocalEventSubscribers();
    if (!controlServer) {
      state.running = false;
      state.starting = false;
      return status();
    }
    const server = controlServer;
    controlServer = null;
    server.close(() => {});
    state.running = false;
    state.starting = false;
    appendLog("Mia daemon stopped");
    return status();
  }

  async function ping(settings = getDaemonSettings(), timeoutMs = 1200, options = {}) {
    const urls = daemonPingUrls(settings);
    const expectedRuntimeHome = String(options.expectedRuntimeHome || "");
    for (const baseUrl of urls) {
      try {
        const response = await fetchImpl(`${baseUrl}/health`, { signal: timeoutSignal(timeoutMs) });
        if (!response.ok) continue;
        if (expectedRuntimeHome) {
          let body = null;
          try { body = await response.json(); } catch { body = null; }
          if (String(body?.runtimeHome || "") !== expectedRuntimeHome) continue;
        }
        return { ok: true, baseUrl };
      } catch {
        // Try the next candidate URL.
      }
    }
    return { ok: false, baseUrl: urls[0] || "" };
  }

  return {
    appendLog,
    setLastError,
    connectUrls: daemonConnectUrls,
    pingUrls: daemonPingUrls,
    publishLocalEvent,
    status,
    observedStatus,
    handleRequest,
    start,
    stop,
    ping
  };
}

module.exports = {
  createDaemonControlServer
};
