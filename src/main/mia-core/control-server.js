"use strict";

const http = require("node:http");
const os = require("node:os");

const LEGACY_CHAT_SEND_ROUTE = "/api/chat/send";

function createMiaCoreControlServer({
  isCoreProcess = false,
  serviceLabel = "ai.mia.daemon",
  pid = () => process.pid,
  uptime = () => process.uptime(),
  networkInterfaces = () => os.networkInterfaces(),
  coreToken,
  appVersion = () => "",
  initializeRuntime,
  choosePort,
  getCoreSettings,
  writeCoreSettings,
  normalizeCoreHost,
  normalizeCorePort,
  runtimePaths,
  remoteRouter,
  fetchImpl = fetch,
  timeoutSignal = (timeoutMs) => AbortSignal.timeout(timeoutMs),
  describeCoreTarget = () => null
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
    const clean = replaceLiteral(line, coreToken(), "[REDACTED]");
    state.logs.push(clean);
    if (state.logs.length > 200) state.logs = state.logs.slice(-200);
  }

  function setLastError(message) {
    state.lastError = String(message || "");
  }

  function coreConnectUrls(settings = getCoreSettings()) {
    const port = normalizeCorePort(settings.port);
    const host = normalizeCoreHost(settings.host);
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

  function corePingUrls(settings = getCoreSettings()) {
    const urls = coreConnectUrls(settings);
    const port = normalizeCorePort(settings.port);
    const host = normalizeCoreHost(settings.host);
    const localUrl = `http://127.0.0.1:${port}`;
    const candidates = host === "0.0.0.0" || host === "::" || host === "localhost"
      ? [localUrl, ...urls]
      : urls;
    return candidates.filter((url, index, list) => url && list.indexOf(url) === index);
  }

  function status() {
    const settings = getCoreSettings();
    const paths = runtimePaths();
    return {
      processMode: isCoreProcess ? "daemon" : "desktop",
      serviceLabel,
      settings,
      running: Boolean(state.running),
      starting: Boolean(state.starting),
      host: state.host || settings.host,
      port: state.port || settings.port,
      baseUrl: state.baseUrl || `http://${settings.host}:${settings.port}`,
      connectUrls: coreConnectUrls(settings),
      runtimeHome: paths.home,
      launchAgent: paths.daemonLaunchAgent,
      daemonTarget: describeCoreTarget(),
      lastError: state.lastError,
      logs: state.logs.slice(-80)
    };
  }

  async function observedStatus(timeoutMs = 500) {
    const current = status();
    if (state.running) return current;
    const probe = await ping(getCoreSettings(), timeoutMs, { expectedRuntimeHome: runtimePaths().home });
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
    return requestAuthToken(req, url) === coreToken();
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

  function publishLocalEvent() {
    return 0;
  }

  function isRetiredMiaRoute(pathname) {
    return pathname === "/api/mia/context"
      || pathname === "/api/mia/skills/current"
      || pathname === "/api/mia/skills/current/read"
      || pathname.startsWith("/api/mia/memory/");
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
        mode: isCoreProcess ? "daemon" : "desktop",
        runtimeHome: runtimePaths().home,
        version: String(appVersion() || ""),
        daemonTarget: describeCoreTarget()
      });
      return;
    }
    if (!isAuthorized(req, url)) {
      writeJson(res, 401, { error: "Unauthorized" });
      return;
    }
    try {
      if (
        (url.pathname === "/api/chat/permissions/respond" && req.method === "POST")
        || (url.pathname === "/api/chat/permissions" && req.method === "GET")
        || (url.pathname === "/api/agent-permissions/respond" && req.method === "POST")
        || (url.pathname === "/api/agent-permissions" && req.method === "GET")
      ) {
        writeJson(res, 410, {
          error: "Agent permission routes are owned by Rust Core. Use Rust Core /api/agent-permissions."
        });
        return;
      }
      if (url.pathname === LEGACY_CHAT_SEND_ROUTE && req.method === "POST") {
        writeJson(res, 410, {
          error: "Legacy chat send is retired. Use Rust Core /api/conversations/{id}/messages."
        });
        return;
      }
      if (isRetiredMiaRoute(url.pathname)) {
        writeJson(res, 410, {
          error: "Mia MCP routes are owned by Rust Core. Use Rust Core /api/mia/* endpoints."
        });
        return;
      }
      const routePath = `${url.pathname}${url.search || ""}`;
      const router = remoteRouter();
      if (router?.matches({ method: req.method, path: routePath })) {
        const body = req.method === "POST" ? await readBody(req) : {};
        const routed = await router.route({ method: req.method, path: routePath, body });
        if (routed.handled) {
          writeJson(res, 200, routed.data);
          return;
        }
        writeJson(res, 404, { error: "Not found" });
        return;
      }
      if (url.pathname === "/api/tasks/events" && req.method === "GET") {
        writeJson(res, 410, {
          error: "Legacy task SSE is retired. Subscribe to Rust Core /ws for task events."
        });
        return;
      }
      if (url.pathname.startsWith("/api/tasks")) {
        writeJson(res, 410, {
          error: "Legacy task routes are retired. Use Rust Core /api/tasks/jobs."
        });
        return;
      }
      writeJson(res, 404, { error: "Not found" });
    } catch (error) {
      writeJson(res, 500, { error: String(error?.message || error) });
    }
  }

  async function start(options = {}) {
    initializeRuntime();
    if (controlServer && state.running) return status();
    const settings = { ...getCoreSettings(), ...options };
    const host = normalizeCoreHost(settings.host);
    const preferredPort = normalizeCorePort(settings.port);
    const port = await choosePort(preferredPort, 20);
    if (!port) throw new Error("No available local port for Mia Core.");
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
    state.running = true;
    state.starting = false;
    writeCoreSettings({ ...settings, host, port });
    appendLog(`Mia Core listening at ${state.baseUrl}`);
    return status();
  }

  function stop() {
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
    appendLog("Mia Core stopped");
    return status();
  }

  async function ping(settings = getCoreSettings(), timeoutMs = 1200, options = {}) {
    const urls = corePingUrls(settings);
    const expectedRuntimeHome = String(options.expectedRuntimeHome || "");
    for (const baseUrl of urls) {
      try {
        const response = await fetchImpl(`${baseUrl}/health`, { signal: timeoutSignal(timeoutMs) });
        if (!response.ok) continue;
        let body = null;
        try { body = await response.json(); } catch { body = null; }
        if (expectedRuntimeHome && String(body?.runtimeHome || "") !== expectedRuntimeHome) continue;
        return {
          ok: true,
          baseUrl,
          pid: Number(body?.pid) || 0,
          version: String(body?.version || ""),
          mode: String(body?.mode || ""),
          // Expose the answering Core's own target identity so callers can
          // decide whether to migrate it (e.g. reject reuse of a GUI-identity
          // process and replace it with rust-core). closes NO-SHIP #2/#4.
          daemonTarget: body && typeof body.daemonTarget === "object" ? body.daemonTarget : null
        };
      } catch {
        // Try the next candidate URL.
      }
    }
    return { ok: false, baseUrl: urls[0] || "" };
  }

  return {
    appendLog,
    setLastError,
    connectUrls: coreConnectUrls,
    pingUrls: corePingUrls,
    publishLocalEvent,
    status,
    observedStatus,
    handleRequest,
    start,
    stop,
    ping
  };
}

// A KeepAlive launchd daemon outlives app updates, so a freshly-updated window
// can find an old-version daemon still holding the single-owner role. Decide
// whether to replace it: only when it is reachable AND its version differs from
// (or is older/absent than) this app's. A missing daemon version means a
// pre-reconciliation build — treat it as stale. An unknown app version never
// triggers churn.
function coreNeedsReplacement(probe, appVersion) {
  if (!probe || !probe.ok) return false;
  const current = String(appVersion || "").trim();
  if (!current) return false;
  return String(probe.version || "").trim() !== current;
}

// Decide whether to reuse an already-running Core process instead of replacing
// it. Versions must match (coreNeedsReplacement), AND — for the Rust Core
// migration — the answering Core must NOT be running under the GUI app
// identity: an old `Electron --daemon` (usesGuiAppIdentity:true) or a daemon
// that does not report a target at all is migrated to rust-core, not kept
// (closes NO-SHIP #3). A rust-core (or any non-GUI) target with a matching
// version is reused. Reachable but non-daemon processes are never reused.
function coreTargetMatchesExpected(target = {}, expected = {}) {
  if (!expected || typeof expected !== "object") return true;
  const expectedKind = String(expected.kind || "").trim();
  const expectedCommand = String(expected.command || "").trim();
  const expectedWorkingDirectory = String(expected.workingDirectory || "").trim();
  const expectedSourceFingerprint = String(expected.sourceFingerprint || "").trim();
  const expectedParentPid = Number(expected.parentPid);
  if (expectedKind && String(target.kind || "").trim() !== expectedKind) return false;
  if (expectedCommand && String(target.command || "").trim() !== expectedCommand) return false;
  if (expectedWorkingDirectory && String(target.workingDirectory || "").trim() !== expectedWorkingDirectory) return false;
  if (expectedSourceFingerprint && String(target.sourceFingerprint || "").trim() !== expectedSourceFingerprint) return false;
  if (Number.isInteger(expectedParentPid) && expectedParentPid > 0 && Number(target.parentPid) !== expectedParentPid) return false;
  if (
    Object.prototype.hasOwnProperty.call(expected, "usesGuiAppIdentity")
    && Boolean(target.usesGuiAppIdentity) !== Boolean(expected.usesGuiAppIdentity)
  ) {
    return false;
  }
  return true;
}

function shouldReuseCore(probe, appVersion, options = {}) {
  if (!probe || !probe.ok) return false;
  if (String(probe.mode || "") !== "daemon") return false;
  if (coreNeedsReplacement(probe, appVersion)) return false;
  const target = probe.daemonTarget;
  if (!target || typeof target !== "object") return false;
  if (target.usesGuiAppIdentity === true) return false;
  if (!coreTargetMatchesExpected(target, options.expectedCoreTarget)) return false;
  return true;
}

module.exports = {
  createMiaCoreControlServer,
  coreNeedsReplacement,
  coreTargetMatchesExpected,
  shouldReuseCore
};
