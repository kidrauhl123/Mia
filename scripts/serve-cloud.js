#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { WebSocketServer, WebSocket } = require("ws");
let createCloudStore = null;
try {
  ({ createCloudStore } = require("../src/cloud/sqlite-store.js"));
} catch {
  ({ createCloudStore } = require("./src/cloud/sqlite-store.js"));
}
let createSocialStore = null;
try {
  ({ createSocialStore } = require("../src/cloud/social-store.js"));
} catch {
  ({ createSocialStore } = require("./src/cloud/social-store.js"));
}
let createMessagesStore = null;
try {
  ({ createMessagesStore } = require("../src/cloud/messages-store.js"));
} catch {
  ({ createMessagesStore } = require("./src/cloud/messages-store.js"));
}
let createEventLogStore = null;
try {
  ({ createEventLogStore } = require("../src/cloud/event-log-store.js"));
} catch {
  ({ createEventLogStore } = require("./src/cloud/event-log-store.js"));
}
let createFellowsStore = null;
try {
  ({ createFellowsStore } = require("../src/cloud/fellows-store.js"));
} catch {
  ({ createFellowsStore } = require("./src/cloud/fellows-store.js"));
}
let createUserSettingsStore = null;
try {
  ({ createUserSettingsStore } = require("../src/cloud/user-settings-store.js"));
} catch {
  ({ createUserSettingsStore } = require("./src/cloud/user-settings-store.js"));
}
let createRuntimeBindingsStore = null;
try {
  ({ createRuntimeBindingsStore } = require("../src/cloud-agent/runtime-bindings-store.js"));
} catch {
  ({ createRuntimeBindingsStore } = require("./src/cloud-agent/runtime-bindings-store.js"));
}
let createCloudAgentRunsStore = null;
try {
  ({ createCloudAgentRunsStore } = require("../src/cloud-agent/cloud-agent-runs-store.js"));
} catch {
  ({ createCloudAgentRunsStore } = require("./src/cloud-agent/cloud-agent-runs-store.js"));
}
let ensureDefaultCloudFellow = null;
try {
  ({ ensureDefaultCloudFellow } = require("../src/cloud-agent/default-fellow.js"));
} catch {
  ({ ensureDefaultCloudFellow } = require("./src/cloud-agent/default-fellow.js"));
}
let createHermesWorkerManager = null;
try {
  ({ createHermesWorkerManager } = require("../src/cloud-agent/hermes-worker-manager.js"));
} catch {
  ({ createHermesWorkerManager } = require("./src/cloud-agent/hermes-worker-manager.js"));
}
let createHermesRunsClient = null;
try {
  ({ createHermesRunsClient } = require("../src/cloud-agent/hermes-runs-client.js"));
} catch {
  ({ createHermesRunsClient } = require("./src/cloud-agent/hermes-runs-client.js"));
}
let createAttachmentMaterializer = null;
try {
  ({ createAttachmentMaterializer } = require("../src/cloud-agent/attachment-materializer.js"));
} catch {
  ({ createAttachmentMaterializer } = require("./src/cloud-agent/attachment-materializer.js"));
}
let createCloudAgentDispatcher = null;
try {
  ({ createCloudAgentDispatcher } = require("../src/cloud-agent/dispatcher.js"));
} catch {
  ({ createCloudAgentDispatcher } = require("./src/cloud-agent/dispatcher.js"));
}
let dmRoomId = null;
let ensureDmRoom = null;
try {
  ({ dmRoomId, ensureDmRoom } = require("../src/cloud/dm-room.js"));
} catch {
  ({ dmRoomId, ensureDmRoom } = require("./src/cloud/dm-room.js"));
}

const host = process.env.AIMASHI_CLOUD_HOST || "127.0.0.1";
const port = Number(process.env.AIMASHI_CLOUD_PORT || process.env.PORT || 4175);
const defaultDataDir = process.env.AIMASHI_CLOUD_DATA || path.join(process.cwd(), ".aimashi-cloud");
const maxUploadBytes = 18 * 1024 * 1024;
const maxBodyBytes = Math.ceil(maxUploadBytes * 4 / 3) + 1024 * 1024;
const bridgeRunTimeoutMs = Number(process.env.AIMASHI_BRIDGE_RUN_TIMEOUT_MS || 1000 * 60 * 5);
const litellmAdminBaseUrl = String(process.env.AIMASHI_LITELLM_ADMIN_BASE_URL || "http://127.0.0.1:4000").replace(/\/+$/, "");
const cloudFeatures = [
  "sqlite-store",
  "auth-sessions",
  "authenticated-files",
  "events-websocket",
  "bridge-websocket-subprotocol-token",
  "bridge-run-lifecycle",
  "bridge-run-cancel",
  "bridge-run-progress",
  "desktop-sync",
  "cloud-hermes-agent",
  "cloud-agent-user-isolation"
];
const defaultAllowedOrigins = String(process.env.AIMASHI_CLOUD_ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function defaultReleaseManifest() {
  const candidates = [
    process.env.AIMASHI_CLOUD_RELEASE_MANIFEST || "",
    path.join(__dirname, "release-manifest.json"),
    path.join(__dirname, "..", "manifest.json")
  ].filter(Boolean);
  for (const candidate of candidates) {
    const manifest = readJsonFile(candidate);
    if (manifest && manifest.product === "Aimashi Cloud") return manifest;
  }
  return null;
}

function releaseHealthPayload(manifest) {
  if (!manifest) return null;
  return {
    version: String(manifest.version || ""),
    builtAt: String(manifest.builtAt || ""),
    gitCommit: String(manifest.source?.gitCommit || ""),
    gitDirty: Boolean(manifest.source?.gitDirty),
    fileCount: manifest.files && typeof manifest.files === "object" ? Object.keys(manifest.files).length : 0
  };
}

function createStore(dataDir = defaultDataDir) {
  return {
    dataDir,
    dbPath: path.join(dataDir, "cloud.sqlite"),
    uploadDir: path.join(dataDir, "uploads")
  };
}

function now() {
  return new Date().toISOString();
}

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function id(prefix) {
  return `${prefix}_${base64url(crypto.randomBytes(12))}`;
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload ?? {}, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function writeError(res, status, message) {
  writeJson(res, status, { error: String(message || "Request failed.") });
}

function writeText(res, status, body, contentType = "text/plain; charset=utf-8") {
  const text = String(body || "");
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store"
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        tooLarge = true;
        body = "";
        return;
      }
      if (!tooLarge) body += String(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        const error = new Error("Request body is too large.");
        error.code = "AIMASHI_BODY_TOO_LARGE";
        reject(error);
        return;
      }
      resolve(body);
    });
    req.on("error", reject);
  });
}

async function readJson(req) {
  const body = await readBody(req);
  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error("Invalid JSON.");
    error.code = "AIMASHI_INVALID_JSON";
    throw error;
  }
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

function normalizeOrigin(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.origin;
  } catch {
    return "";
  }
}

function allowedOriginsFromOptions(options = {}) {
  const values = Array.isArray(options.allowedOrigins)
    ? options.allowedOrigins
    : defaultAllowedOrigins;
  return values.map(normalizeOrigin).filter(Boolean);
}

function applySecurityHeaders(req, res, context = {}) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  const requestOrigin = normalizeOrigin(req.headers.origin || "");
  if (!requestOrigin) return;
  res.setHeader("Vary", "Origin");
  if (requestOriginAllowed(req, context)) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin);
    res.setHeader("Access-Control-Allow-Credentials", "false");
  }
}

function isLoopbackHost(hostname) {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(String(hostname || "").toLowerCase());
}

function requestHostName(req) {
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return host.split(":")[0].toLowerCase();
  }
}

function requestOriginAllowed(req, context = {}) {
  const requestOrigin = normalizeOrigin(req.headers.origin || "");
  if (!requestOrigin) return true;
  const allowed = context.allowedOrigins || [];
  if (allowed.length) return allowed.includes(requestOrigin);
  try {
    const originHost = new URL(requestOrigin).hostname.toLowerCase();
    const requestHost = requestHostName(req);
    return originHost === requestHost || isLoopbackHost(originHost);
  } catch {
    return false;
  }
}

function fileContentType(filePath, fallback = "application/octet-stream") {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".webmanifest") return "application/manifest+json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return fallback;
}

function defaultWebRoot() {
  const candidates = [
    process.env.AIMASHI_WEB_ROOT,
    path.join(__dirname, "..", "web"),
    path.join(__dirname, "..", "src", "web")
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "index.html"))) || "";
}

function serveWebAsset(req, res, webRoot, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (!webRoot || pathname.startsWith("/api/")) return false;
  let relative = "";
  try {
    relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.replace(/^\/+/, ""));
  } catch {
    writeError(res, 400, "Bad request.");
    return true;
  }
  if (relative === "favicon.ico") relative = "favicon.svg";
  if (!relative || relative.endsWith("/")) relative = path.join(relative, "index.html");
  const resolved = path.resolve(webRoot, relative);
  const root = path.resolve(webRoot);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    writeError(res, 403, "Forbidden.");
    return true;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return false;
  const body = fs.readFileSync(resolved);
  res.writeHead(200, {
    "Content-Type": fileContentType(resolved),
    "Content-Length": body.length,
    "Cache-Control": path.basename(resolved) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable"
  });
  if (req.method === "HEAD") res.end();
  else res.end(body);
  return true;
}

function adminCredentials(context = {}) {
  return {
    username: String(context.adminUsername || process.env.AIMASHI_CLOUD_ADMIN_USERNAME || "").trim(),
    password: String(context.adminPassword || process.env.AIMASHI_CLOUD_ADMIN_PASSWORD || "").trim()
  };
}

function safeEqualString(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function parseBasicAuth(req) {
  const header = String(req.headers.authorization || "");
  const match = header.match(/^Basic\s+(.+)$/i);
  if (!match) return null;
  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const index = decoded.indexOf(":");
    if (index < 0) return null;
    return { username: decoded.slice(0, index), password: decoded.slice(index + 1) };
  } catch {
    return null;
  }
}

function requireAdmin(req, res, context) {
  const expected = adminCredentials(context);
  if (!expected.username || !expected.password) {
    writeError(res, 503, "管理后台还没有配置管理员账号。");
    return false;
  }
  const provided = parseBasicAuth(req);
  if (
    provided &&
    safeEqualString(provided.username, expected.username) &&
    safeEqualString(provided.password, expected.password)
  ) {
    return true;
  }
  res.setHeader("WWW-Authenticate", 'Basic realm="Aimashi Admin", charset="UTF-8"');
  writeError(res, 401, "需要管理员账号。");
  return false;
}

function serveAdminModelPage(req, res, context) {
  if (!requireAdmin(req, res, context)) return true;
  const filePath = path.join(context.webRoot || defaultWebRoot(), "admin-model.html");
  if (!fs.existsSync(filePath)) {
    writeError(res, 404, "Admin page not found.");
    return true;
  }
  writeText(res, 200, fs.readFileSync(filePath, "utf8"), "text/html; charset=utf-8");
  return true;
}

function litellmAdminKey(context = {}) {
  return String(context.litellmAdminKey || process.env.LITELLM_MASTER_KEY || process.env.AIMASHI_LITELLM_MASTER_KEY || "").trim();
}

function litellmServiceKey(context = {}) {
  return String(
    context.litellmServiceKey ||
    process.env.AIMASHI_CLOUD_AGENT_MODEL_API_KEY ||
    process.env.AIMASHI_LITELLM_API_KEY ||
    ""
  ).trim();
}

function redactModelInfo(row = {}) {
  const params = { ...(row.litellm_params || {}) };
  if (params.api_key) params.api_key = "configured";
  return {
    model_name: row.model_name || "",
    model_info: row.model_info || {},
    litellm_params: params
  };
}

async function litellmRequest(context, pathname, { method = "GET", key = "", body = null } = {}) {
  const token = key || litellmAdminKey(context);
  if (!token) {
    const error = new Error("LiteLLM 管理 key 未配置。");
    error.status = 503;
    throw error;
  }
  const response = await fetch(`${litellmAdminBaseUrl}${pathname}`, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(data?.error?.message || data?.detail || data?.message || `LiteLLM request failed (${response.status}).`);
    error.status = response.status;
    error.payload = data;
    throw error;
  }
  return data;
}

function normalizeAdminModelInput(input = {}) {
  const upstreamModel = String(input.upstreamModel || input.model || "").trim();
  const apiKey = String(input.apiKey || "").trim();
  const apiBase = String(input.apiBase || "").trim();
  const apiVersion = String(input.apiVersion || "").trim();
  if (!upstreamModel) throw new Error("请填写真实模型。");
  if (!apiKey) throw new Error("请填写供应商 API Key。");
  if (!/^[a-z0-9_.-]+\/[A-Za-z0-9_.:/@-]+$/i.test(upstreamModel)) {
    throw new Error("真实模型格式不对，例如 deepseek/deepseek-chat。");
  }
  if (apiBase) {
    try {
      const url = new URL(apiBase);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("bad protocol");
    } catch {
      throw new Error("API Base URL 格式不对。");
    }
  }
  return {
    provider: String(input.provider || "").trim(),
    modelName: "aimashi-default",
    upstreamModel,
    apiKey,
    apiBase,
    apiVersion
  };
}

async function listAimashiLiteLLMModels(context) {
  const info = await litellmRequest(context, "/model/info");
  const rows = Array.isArray(info?.data) ? info.data : [];
  return rows.filter((row) => row?.model_name === "aimashi-default");
}

async function handleAdminModelGateway(req, res, context, url) {
  if (!requireAdmin(req, res, context)) return;
  if (req.method === "GET" && url.pathname === "/api/admin/model-gateway") {
    const models = await listAimashiLiteLLMModels(context);
    return writeJson(res, 200, {
      ok: true,
      gateway: {
        baseUrl: litellmAdminBaseUrl,
        adminConfigured: Boolean(litellmAdminKey(context)),
        serviceKeyConfigured: Boolean(litellmServiceKey(context))
      },
      modelName: "aimashi-default",
      models: models.map(redactModelInfo)
    });
  }
  if (req.method === "POST" && url.pathname === "/api/admin/model-gateway") {
    const input = normalizeAdminModelInput(await readJson(req));
    const existing = await listAimashiLiteLLMModels(context);
    for (const row of existing) {
      const id = String(row?.model_info?.id || row?.model_id || "").trim();
      if (id) {
        await litellmRequest(context, "/model/delete", { method: "POST", body: { id } });
      }
    }
    const litellmParams = {
      model: input.upstreamModel,
      api_key: input.apiKey
    };
    if (input.apiBase) litellmParams.api_base = input.apiBase;
    if (input.apiVersion) litellmParams.api_version = input.apiVersion;
    const created = await litellmRequest(context, "/model/new", {
      method: "POST",
      body: {
        model_name: input.modelName,
        litellm_params: litellmParams,
        model_info: {
          id: input.modelName,
          base_model: input.upstreamModel,
          provider: input.provider || undefined
        }
      }
    });
    return writeJson(res, 200, {
      ok: true,
      model: redactModelInfo(created),
      message: "模型配置已保存。"
    });
  }
  if (req.method === "POST" && url.pathname === "/api/admin/model-gateway/test") {
    const serviceKey = litellmServiceKey(context) || litellmAdminKey(context);
    const result = await litellmRequest(context, "/v1/chat/completions", {
      method: "POST",
      key: serviceKey,
      body: {
        model: "aimashi-default",
        messages: [{ role: "user", content: "Reply with exactly: aimashi-ok" }],
        max_tokens: 20
      }
    });
    return writeJson(res, 200, {
      ok: true,
      reply: result?.choices?.[0]?.message?.content || "",
      model: result?.model || "aimashi-default"
    });
  }
  writeError(res, 404, "Not found.");
}

function createBridgeHub(runTimeoutMs = bridgeRunTimeoutMs) {
  return {
    devicesByUser: new Map(),
    pendingRuns: new Map(),
    runTimeoutMs
  };
}

function createEventHub() {
  return {
    socketsByUser: new Map()
  };
}

function sendWsJson(ws, payload) {
  const body = JSON.stringify(payload);
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(body);
    return;
  }
  setImmediate(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(body);
  });
}

function attachEventSocket(hub, ws, userId, { eventLog, sinceSeq = 0 } = {}) {
  if (!hub.socketsByUser.has(userId)) hub.socketsByUser.set(userId, new Set());
  hub.socketsByUser.get(userId).add(ws);
  ws.on("close", () => {
    const sockets = hub.socketsByUser.get(userId);
    sockets?.delete(ws);
    if (sockets && !sockets.size) hub.socketsByUser.delete(userId);
  });
  ws.on("error", () => {
    const sockets = hub.socketsByUser.get(userId);
    sockets?.delete(ws);
    if (sockets && !sockets.size) hub.socketsByUser.delete(userId);
  });

  // Replay any events the client missed while disconnected. Stream in
  // 500-row batches so a multi-day-offline client doesn't choke a single
  // socket frame. The server's current seq is sent in events_ready so
  // the client can detect "I'm up to date" even with no replay.
  //
  // Defensive clamp: if a client thinks its cursor is AHEAD of the
  // server (which can happen after a server data wipe / DB restore),
  // we tell the client to reset its cursor to serverSeq via `resetTo`
  // so it doesn't sit forever waiting for events that no longer exist.
  let cursorStart = Number.isFinite(Number(sinceSeq)) ? Math.max(0, Number(sinceSeq)) : 0;
  let serverSeq = cursorStart;
  if (eventLog && typeof eventLog.maxSeqForUser === "function") {
    try { serverSeq = eventLog.maxSeqForUser(userId); } catch { /* fall through with cursorStart */ }
  }
  const resetTo = cursorStart > serverSeq ? serverSeq : null;
  if (resetTo !== null) cursorStart = serverSeq;
  sendWsJson(ws, { type: "events_ready", sinceSeq: cursorStart, serverSeq, resetTo });

  if (eventLog && serverSeq > cursorStart) {
    let cursor = cursorStart;
    const BATCH = 500;
    while (cursor < serverSeq) {
      let batch = [];
      try { batch = eventLog.listEventsSince(userId, cursor, BATCH); }
      catch (err) {
        console.error("[event-log] replay failed", { userId, cursor, err: err?.message });
        break;
      }
      if (!batch.length) break;
      for (const ev of batch) {
        sendWsJson(ws, { ...(ev.payload || {}), seq: ev.seq, eventId: ev.id, replay: true });
      }
      cursor = batch[batch.length - 1].seq;
      if (batch.length < BATCH) break;
    }
  }
}

// Push a state-changing event: persist it in the user_events log so that
// disconnected clients can replay it on reconnect via since_seq, AND
// broadcast it to currently-connected sockets with the assigned seq
// attached. ALL caller paths that mutate shared state (social.*, room.*,
// workspace_updated, message_created) must go through this — bridges
// only see the seq-tagged version so duplicate detection works.
//
// Returns the persisted event (so callers may use its seq in responses).
function broadcastPersistedEvent(context, userId, payload) {
  if (!userId || !payload || !payload.type) return null;
  let event = null;
  try {
    event = context.eventLog.appendEvent(userId, {
      kind: payload.type,
      scopeKind: payload.scopeKind || null,
      scopeRef: payload.scopeRef || null,
      payload
    });
  } catch (err) {
    // Persistence is the source of truth — if we can't write the event we
    // should not advertise it either, otherwise reconnect replay would
    // miss it forever.
    console.error("[event-log] appendEvent failed", { userId, kind: payload.type, err: err?.message });
    return null;
  }
  const tagged = { ...payload, seq: event.seq, eventId: event.id };
  for (const ws of context.eventHub.socketsByUser.get(userId) || []) {
    sendWsJson(ws, tagged);
  }
  return event;
}

// Push a transient event (no replay needed): bridge run progress, device
// online/offline. These describe momentary process state, not durable
// user-facing state, so persistence would just inflate the event log
// without value. If the client missed it, the next bridge_run_updated /
// device_updated supersedes anyway.
function broadcastTransientEvent(hub, userId, payload) {
  for (const ws of hub.socketsByUser.get(userId) || []) {
    sendWsJson(ws, payload);
  }
}

// ── write idempotency (Phase 1.D) ─────────────────────────────────────────
//
// Wrap any state-mutating handler so an identical request body
// (clientOpId) replays the same response instead of executing again.
// Necessary because the network can deliver the same POST twice (mobile
// switching networks, browser auto-retry, our own auto-reconnect) and
// we don't want to create two friend requests / two rooms / two
// messages from one user intent.
//
// Usage at top of a POST/PATCH/DELETE handler, AFTER reading body:
//   if (await replayIfCached(context, res, auth.user.id, body)) return;
// And after building the response:
//   rememberOp(context, auth.user.id, body, status, payload);
//   return writeJson(res, status, payload);
//
// Bodies without clientOpId pass through transparently (no caching).
function replayIfCached(context, res, userId, body) {
  if (!body || !body.clientOpId) return false;
  const cached = context.eventLog.getCachedOp(userId, body.clientOpId);
  if (!cached) return false;
  writeJson(res, cached.statusCode, cached.result);
  return true;
}
function rememberOp(context, userId, body, statusCode, payload) {
  if (!body || !body.clientOpId) return;
  context.eventLog.cacheOp(userId, body.clientOpId, { result: payload, statusCode });
}

function sanitizeBridgeRunEvent(event = {}) {
  const kind = String(event.kind || event.type || "status").trim().slice(0, 60) || "status";
  const out = { kind };
  if (event.text != null) out.text = String(event.text).slice(0, 8000);
  if (event.id != null) out.id = String(event.id).slice(0, 120);
  if (event.name != null) out.name = String(event.name).slice(0, 120);
  if (event.preview != null) out.preview = String(event.preview).slice(0, 1000);
  if (event.status != null) out.status = String(event.status).slice(0, 80);
  if (event.error != null) out.error = Boolean(event.error);
  if (typeof event.duration === "number" && Number.isFinite(event.duration)) out.duration = event.duration;
  if (event.finishReason != null) out.finishReason = String(event.finishReason).slice(0, 80);
  if (event.sessionId != null) out.sessionId = String(event.sessionId).slice(0, 160);
  return out;
}

function bridgeDevices(hub, userId) {
  return [...(hub.devicesByUser.get(userId)?.values() || [])]
    .filter((device) => device.ws.readyState === WebSocket.OPEN)
    .map((device) => ({
      id: device.id,
      deviceName: device.deviceName,
      engine: device.engine,
      capabilities: device.capabilities || {},
      connectedAt: device.connectedAt,
      lastSeenAt: device.lastSeenAt,
      status: "online"
    }));
}

function removeBridgeDevice(hub, device) {
  const userDevices = hub.devicesByUser.get(device.userId);
  if (userDevices?.get(device.id) === device) {
    userDevices.delete(device.id);
    if (!userDevices.size) hub.devicesByUser.delete(device.userId);
  }
  try {
    device.cloudStore?.removeBridgeDevice(device.userId, device.id);
    if (device.eventHub) {
      broadcastTransientEvent(device.eventHub, device.userId, {
        type: "device_updated",
        devices: bridgeDevices(hub, device.userId)
      });
    }
  } catch {
    // Server shutdown can close SQLite before late websocket close callbacks drain.
  }
  for (const [runId, pending] of hub.pendingRuns) {
    if (pending.deviceId !== device.id) continue;
    clearTimeout(pending.timer);
    hub.pendingRuns.delete(runId);
    pending.reject(new Error("本机 Agent Bridge 已断开。"));
  }
}

function attachBridgeDevice(hub, ws, { userId, deviceName, engine, capabilities, cloudStore, eventHub }) {
  const device = {
    id: id("bridge"),
    userId,
    deviceName: String(deviceName || "").trim().slice(0, 80) || "本机 Agent",
    engine: String(engine || "").trim().slice(0, 40) || "codex",
    capabilities: capabilities || {},
    cloudStore,
    eventHub,
    ws,
    connectedAt: now(),
    lastSeenAt: now()
  };
  cloudStore?.upsertBridgeDevice(userId, {
    id: device.id,
    deviceName: device.deviceName,
    engine: device.engine,
    capabilities: device.capabilities
  });
  if (!hub.devicesByUser.has(userId)) hub.devicesByUser.set(userId, new Map());
  hub.devicesByUser.get(userId).set(device.id, device);

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    device.lastSeenAt = now();
    if (message.type === "pong") return;
    if (message.type === "run_event") {
      const pending = hub.pendingRuns.get(String(message.runId || ""));
      if (!pending || pending.deviceId !== device.id) return;
      broadcastTransientEvent(device.eventHub, device.userId, {
        type: "bridge_run_event",
        runId: pending.runId,
        event: sanitizeBridgeRunEvent(message.event)
      });
      return;
    }
    if (message.type !== "run_result") return;
    const pending = hub.pendingRuns.get(String(message.runId || ""));
    if (!pending || pending.deviceId !== device.id) return;
    clearTimeout(pending.timer);
    hub.pendingRuns.delete(pending.runId);
    if (message.ok === false) {
      pending.reject(new Error(String(message.error || "本机 Agent 执行失败。")));
      return;
    }
    pending.resolve(message);
  });

  ws.on("close", () => removeBridgeDevice(hub, device));
  ws.on("error", () => removeBridgeDevice(hub, device));
  ws.send(JSON.stringify({ type: "bridge_ready", deviceId: device.id, connectedAt: device.connectedAt }));
  return device;
}

function runBridgeDevice(hub, device, payload) {
  if (!device || device.ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("本机 Agent Bridge 不在线。"));
  }
  const runId = String(payload.runId || "") || id("run");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      hub.pendingRuns.delete(runId);
      const timeout = new Error("本机 Agent 响应超时。");
      timeout.code = "AIMASHI_BRIDGE_TIMEOUT";
      reject(timeout);
    }, hub.runTimeoutMs || bridgeRunTimeoutMs);
    hub.pendingRuns.set(runId, { runId, userId: device.userId, deviceId: device.id, device, resolve, reject, timer });
    device.ws.send(JSON.stringify({ type: "run", runId, ...payload }), (error) => {
      if (!error) return;
      clearTimeout(timer);
      hub.pendingRuns.delete(runId);
      reject(error);
    });
  });
}

function resolveBridgeRunDevice(hub, userId, requestedDeviceId = "") {
  const onlineDevices = [...(hub.devicesByUser.get(userId)?.values() || [])]
    .filter((device) => device.ws.readyState === WebSocket.OPEN);
  const deviceId = String(requestedDeviceId || "");
  if (deviceId) return onlineDevices.find((device) => device.id === deviceId) || null;
  if (onlineDevices.length === 1) return onlineDevices[0];
  return null;
}

function cancelBridgeRunDevice(hub, userId, runId) {
  const pending = hub.pendingRuns.get(runId);
  if (!pending || pending.userId !== userId) return false;
  clearTimeout(pending.timer);
  hub.pendingRuns.delete(runId);
  if (pending.device?.ws?.readyState === WebSocket.OPEN) {
    pending.device.ws.send(JSON.stringify({ type: "cancel", runId }));
  }
  const cancelled = new Error("本机 Agent 运行已取消。");
  cancelled.code = "AIMASHI_BRIDGE_CANCELLED";
  pending.reject(cancelled);
  return true;
}

function safeAttachmentUrl(value) {
  const raw = String(value || "").trim();
  if (/^\/api\/files\/[a-zA-Z0-9_-]+$/.test(raw)) return raw;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.toString();
  } catch {
    // Relative or local filesystem-looking URLs are intentionally rejected.
  }
  return "";
}

function userIsMemberOfRoom(socialStore, roomId, userId) {
  if (roomId.startsWith("dm:")) {
    const parts = roomId.split(":");
    if (parts.length !== 3) return false;
    const [, a, b] = parts;
    if (userId !== a && userId !== b) return false;
    const other = userId === a ? b : a;
    return socialStore.areFriends(userId, other);
  }
  return socialStore.listRoomMembers(roomId).some(
    (m) => m.member_kind === "user" && m.member_ref === userId
  );
}

function tokenFromRequest(req) {
  const auth = String(req.headers.authorization || "");
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
}

function tokenFromWebSocketProtocol(req) {
  const header = String(req.headers["sec-websocket-protocol"] || "");
  const prefix = "aimashi-token.";
  return header.split(",")
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix))
    ?.slice(prefix.length) || "";
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "")
    .split(",")[0]
    .trim();
}

function clientFile(file) {
  if (!file) return null;
  return {
    id: file.id,
    type: file.type || "image",
    name: file.name,
    mimeType: file.mimeType,
    size: file.size || 0,
    url: file.url
  };
}

function persistCloudAttachments(cloudStore, userId, attachments = []) {
  return attachments.map((attachment) => {
    if (attachment?.dataUrl) return clientFile(cloudStore.saveImageDataUrl(userId, attachment));
    const url = safeAttachmentUrl(attachment?.url);
    const cloudFileId = url.match(/^\/api\/files\/([a-zA-Z0-9_-]+)$/)?.[1] || "";
    if (cloudFileId) {
      const file = cloudStore.getFileForUser(userId, cloudFileId);
      return file ? clientFile(file) : null;
    }
    if (url) return {
      id: String(attachment.id || id("att")),
      type: attachment.type || "file",
      name: String(attachment.name || "附件"),
      mimeType: attachment.mimeType || attachment.mime || "",
      url
    };
    return null;
  }).filter(Boolean);
}

function sanitizeCloudMessageAttachments(cloudStore, userId, message = {}) {
  const sanitized = {
    ...message,
    attachments: persistCloudAttachments(
      cloudStore,
      userId,
      Array.isArray(message.attachments) ? message.attachments : []
    )
  };
  const commandResult = sanitizeCommandResult(message.commandResult);
  if (commandResult) sanitized.commandResult = commandResult;
  else delete sanitized.commandResult;
  return sanitized;
}

function sanitizeCommandResult(commandResult) {
  if (!commandResult || typeof commandResult !== "object" || commandResult.type !== "session-list") return null;
  const rows = Array.isArray(commandResult.rows)
    ? commandResult.rows
      .map((row) => ({
        id: String(row?.id || "").trim(),
        title: String(row?.title || "").trim().slice(0, 160),
        preview: String(row?.preview || "").trim().slice(0, 240),
        project: String(row?.project || "").trim().slice(0, 240),
        updatedAt: Number(row?.updatedAt) || 0
      }))
      .filter((row) => row.id)
      .slice(0, 20)
    : [];
  if (!rows.length) return null;
  const normalized = {
    type: "session-list",
    command: String(commandResult.command || "/resume").trim() || "/resume",
    engine: String(commandResult.engine || "").trim(),
    rows
  };
  const sourceDeviceId = String(commandResult.sourceDeviceId || "").trim();
  const sourceDeviceName = String(commandResult.sourceDeviceName || "").trim().slice(0, 120);
  if (sourceDeviceId) normalized.sourceDeviceId = sourceDeviceId;
  if (sourceDeviceName) normalized.sourceDeviceName = sourceDeviceName;
  return normalized;
}

// (sanitizeCloudConversationAttachments / sanitizeCloudWorkspaceAttachments
//  / cleanConversation removed in Phase 4 cutover — their callers (the
//  workspace + conversations + messages endpoints) are gone. Per-message
//  attachment sanitization still happens via sanitizeCloudMessageAttachments
//  above and persistCloudAttachments at the room-message POST path.)

function serveAuthorizedFile(req, res, cloudStore, auth, pathname) {
  const match = pathname.match(/^\/api\/files\/([a-zA-Z0-9_-]+)$/);
  if (!match) return false;
  if (!auth) {
    writeError(res, 401, "请先登录。");
    return true;
  }
  const file = cloudStore.getFileForUser(auth.user.id, match[1]);
  if (!file) {
    writeError(res, 404, "File not found.");
    return true;
  }
  if (!fs.existsSync(file.path)) {
    writeError(res, 404, "File not found on disk.");
    return true;
  }
  const body = fs.readFileSync(file.path);
  res.writeHead(200, {
    "Content-Type": file.mimeType || fileContentType(file.path),
    "Content-Length": body.length,
    "Cache-Control": "private, max-age=31536000, immutable"
  });
  res.end(body);
  return true;
}

function ensureCloudAgentBootstrap(context, userId) {
  if (!context?.fellowsStore || !context?.runtimeBindingsStore || !context?.socialStore) return null;
  return ensureDefaultCloudFellow(context, userId);
}

async function handleRequest(req, res, context) {
  const cloudStore = context.cloudStore;
  const bridgeHub = context.bridgeHub;
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  applySecurityHeaders(req, res, context);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS"
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    writeJson(res, 200, {
      ok: true,
      service: "aimashi-cloud",
      version: String(process.env.AIMASHI_CLOUD_VERSION || ""),
      release: releaseHealthPayload(context.releaseManifest),
      features: cloudFeatures
    });
    return;
  }

  if (url.pathname === "/admin") {
    res.writeHead(308, { "Location": "/admin/model" });
    res.end();
    return;
  }
  if (req.method === "GET" && (url.pathname === "/admin/model" || url.pathname === "/admin/model/")) {
    serveAdminModelPage(req, res, context);
    return;
  }
  if (url.pathname.startsWith("/api/admin/")) {
    try {
      await handleAdminModelGateway(req, res, context, url);
    } catch (error) {
      writeError(res, error.status || 500, error.message || "Admin request failed.");
    }
    return;
  }

  if (serveWebAsset(req, res, context.webRoot, url.pathname)) return;

  try {
    if (req.method === "POST" && url.pathname === "/api/auth/register") {
      const account = cloudStore.registerUser(await readJson(req));
      ensureCloudAgentBootstrap(context, account.user.id);
      return writeJson(res, 201, account);
    }

    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      const account = cloudStore.loginUser({ ...(await readJson(req)), ip: clientIp(req) });
      ensureCloudAgentBootstrap(context, account.user.id);
      return writeJson(res, 200, account);
    }

    const auth = cloudStore.authenticateToken(tokenFromRequest(req));
    if (req.method === "GET" && serveAuthorizedFile(req, res, cloudStore, auth, url.pathname)) return;
    if (!auth) return writeError(res, 401, "请先登录。");

    // POST /api/social/friend-requests
    if (req.method === "POST" && url.pathname === "/api/social/friend-requests") {
      const body = await readJson(req);
      if (replayIfCached(context, res, auth.user.id, body)) return;
      const toUsername = String(body.toUsername || "").trim();
      if (!toUsername) return writeError(res, 400, "toUsername is required");
      const toUser = context.cloudStore.getUserByUsername(toUsername);
      if (!toUser) return writeError(res, 404, "user not found");
      if (toUser.id === auth.user.id) return writeError(res, 400, "cannot add yourself");
      if (context.socialStore.areFriends(auth.user.id, toUser.id)) {
        return writeError(res, 409, "already friends");
      }
      let created;
      try {
        created = context.socialStore.createFriendRequestByUsername({ fromUserId: auth.user.id, toUserId: toUser.id });
      } catch (e) {
        return writeError(res, 409, e.message);
      }
      // notify the addressee
      broadcastPersistedEvent(context, toUser.id, {
        type: "social.friend_request_received",
        request: { ...created, from: context.cloudStore.getUserPublic(auth.user.id) }
      });
      const payload = { request: created };
      rememberOp(context, auth.user.id, body, 201, payload);
      return writeJson(res, 201, payload);
    }

    // GET /api/social/friend-requests?direction=incoming|outgoing
    if (req.method === "GET" && url.pathname === "/api/social/friend-requests") {
      const direction = url.searchParams.get("direction") || "incoming";
      let rows;
      if (direction === "outgoing") {
        rows = context.socialStore.listOutgoingPending(auth.user.id);
      } else {
        rows = context.socialStore.listIncomingPending(auth.user.id);
      }
      // hydrate with public user info on the other side
      const hydrated = rows.map((row) => {
        const otherId = direction === "outgoing" ? row.to_user : row.from_user;
        return { ...row, other: context.cloudStore.getUserPublic(otherId) };
      });
      return writeJson(res, 200, { requests: hydrated });
    }

    // POST /api/social/friend-requests/:id/respond
    const respondMatch = url.pathname.match(/^\/api\/social\/friend-requests\/([a-zA-Z0-9_-]+)\/respond$/);
    if (req.method === "POST" && respondMatch) {
      const requestId = respondMatch[1];
      const body = await readJson(req);
      const action = String(body.action || "");
      if (action !== "accept" && action !== "reject") {
        return writeError(res, 400, "action must be 'accept' or 'reject'");
      }
      let updated;
      try {
        updated = context.socialStore.respondToFriendRequest(requestId, auth.user.id, action);
      } catch (e) {
        return writeError(res, 400, e.message);
      }
      if (action === "accept") {
        const room = ensureDmRoom(context.socialStore, updated.from_user, auth.user.id);
        const senderPublic = context.cloudStore.getUserPublic(updated.from_user);
        const accepterPublic = context.cloudStore.getUserPublic(auth.user.id);
        // notify both
        broadcastPersistedEvent(context, updated.from_user, {
          type: "social.friend_added",
          friend: accepterPublic,
          room
        });
        broadcastPersistedEvent(context, auth.user.id, {
          type: "social.friend_added",
          friend: senderPublic,
          room
        });
        return writeJson(res, 200, { request: updated, friend: senderPublic, room });
      }
      // reject: do NOT notify sender (QQ-style)
      return writeJson(res, 200, { request: updated });
    }

    // DELETE /api/social/friend-requests/:id  (cancel by sender)
    const cancelFrMatch = url.pathname.match(/^\/api\/social\/friend-requests\/([a-zA-Z0-9_-]+)$/);
    if (req.method === "DELETE" && cancelFrMatch) {
      const requestId = cancelFrMatch[1];
      try {
        const updated = context.socialStore.cancelFriendRequest(requestId, auth.user.id);
        return writeJson(res, 200, { request: updated });
      } catch (e) {
        return writeError(res, 400, e.message);
      }
    }

    if (req.method === "GET" && url.pathname === "/api/social/friends") {
      const friendIds = context.socialStore.listFriends(auth.user.id);
      const friends = friendIds
        .map((id) => context.cloudStore.getUserPublic(id))
        .filter(Boolean);
      return writeJson(res, 200, { friends });
    }

    const unfriendMatch = url.pathname.match(/^\/api\/social\/friends\/([a-zA-Z0-9_-]+)$/);
    if (req.method === "DELETE" && unfriendMatch) {
      context.socialStore.removeFriendship(auth.user.id, unfriendMatch[1]);
      return writeJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/rooms") {
      ensureCloudAgentBootstrap(context, auth.user.id);
      const rooms = context.socialStore.listRoomsForUser(auth.user.id);
      return writeJson(res, 200, { rooms });
    }

    // POST /api/rooms — create a group room. Idempotent on optional
    // `clientGroupId`: if any room this user is in already has decorations
    // .clientGroupId === clientGroupId, return that room instead of creating
    // a new one. This prevents the desktop sync from re-creating duplicates
    // when the local group was uploaded earlier through a different path.
    if (req.method === "POST" && url.pathname === "/api/rooms") {
      const body = await readJson(req);
      if (replayIfCached(context, res, auth.user.id, body)) return;
      const name = String(body.name || "").trim();
      if (!name || name.length > 80) return writeError(res, 400, "name is required and must be 1..80 chars");
      const memberFellows = Array.isArray(body.memberFellows) ? body.memberFellows : [];
      const memberFriendUserIds = Array.isArray(body.memberFriendUserIds) ? body.memberFriendUserIds : [];
      const clientGroupId = String(body.clientGroupId || "").trim() || null;

      // Idempotency check
      if (clientGroupId) {
        const userRooms = context.socialStore.listRoomsForUser(auth.user.id);
        const existing = userRooms.find((r) => r && r.decorations && r.decorations.clientGroupId === clientGroupId);
        if (existing) {
          const members = context.socialStore.listRoomMembers(existing.id);
          return writeJson(res, 200, { room: existing, members, reused: true });
        }
      }

      // Validate friend membership before creating anything
      for (const friendId of memberFriendUserIds) {
        if (!context.socialStore.areFriends(auth.user.id, String(friendId))) {
          return writeError(res, 403, "user is not your friend: " + friendId);
        }
      }
      const roomId = "g_" + require("node:crypto").randomBytes(8).toString("hex");
      const decorations = clientGroupId ? { clientGroupId } : null;
      context.socialStore.createRoom({ id: roomId, name, decorations });
      context.socialStore.addRoomMember({ roomId, memberKind: "user", memberRef: auth.user.id });
      for (const fellow of memberFellows) {
        const fellowId = String(fellow.fellowId || "").trim();
        if (!fellowId) continue;
        context.socialStore.addRoomMember({ roomId, memberKind: "fellow", memberRef: fellowId, ownerId: auth.user.id });
      }
      for (const friendId of memberFriendUserIds) {
        context.socialStore.addRoomMember({ roomId, memberKind: "user", memberRef: String(friendId) });
      }
      const room = context.socialStore.getRoom(roomId);
      const members = context.socialStore.listRoomMembers(roomId);
      const creatorPublic = context.cloudStore.getUserPublic(auth.user.id);
      // Broadcast social.room_invited to all user-members except creator
      for (const m of members) {
        if (m.member_kind === "user" && m.member_ref !== auth.user.id) {
          broadcastPersistedEvent(context, m.member_ref, { type: "social.room_invited", room, invitedBy: creatorPublic });
        }
      }
      const payload = { room, members };
      rememberOp(context, auth.user.id, body, 201, payload);
      return writeJson(res, 201, payload);
    }

    const roomAsFellowMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_:-]+)\/messages\/as-fellow$/);
    const roomMembersMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_:-]+)\/members$/);
    const roomMsgDeleteMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_:-]+)\/messages\/([A-Za-z0-9_-]+)$/);
    const roomMsgsMatch = !roomAsFellowMatch && url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_:-]+)\/messages$/);
    const roomDetailMatch = !roomAsFellowMatch && !roomMembersMatch && !roomMsgsMatch && !roomMsgDeleteMatch && url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_:-]+)$/);

    // POST /api/rooms/:id/members — add member to existing group
    if (req.method === "POST" && roomMembersMatch) {
      const roomId = roomMembersMatch[1];
      if (roomId.startsWith("dm:")) return writeError(res, 400, "DM rooms cannot be modified");
      if (!userIsMemberOfRoom(context.socialStore, roomId, auth.user.id)) {
        return writeError(res, 403, "not a member of this room");
      }
      const body = await readJson(req);
      const memberKind = String(body.memberKind || "");
      const memberRef = String(body.memberRef || "").trim();
      if (!memberKind || !memberRef) return writeError(res, 400, "memberKind and memberRef are required");
      if (memberKind !== "user" && memberKind !== "fellow") return writeError(res, 400, "memberKind must be 'user' or 'fellow'");
      if (memberKind === "user") {
        if (!context.socialStore.areFriends(auth.user.id, memberRef)) {
          return writeError(res, 403, "user is not your friend: " + memberRef);
        }
        context.socialStore.addRoomMember({ roomId, memberKind: "user", memberRef });
        const member = context.socialStore.getRoomMember(roomId, "user", memberRef);
        const room = context.socialStore.getRoom(roomId);
        const inviterPublic = context.cloudStore.getUserPublic(auth.user.id);
        broadcastPersistedEvent(context, memberRef, { type: "social.room_invited", room, invitedBy: inviterPublic });
        return writeJson(res, 201, { ok: true, member });
      }
      // memberKind === 'fellow'
      const ownerId = String(body.ownerId || "").trim();
      if (ownerId !== auth.user.id) {
        return writeError(res, 403, "you can only add your own fellows");
      }
      context.socialStore.addRoomMember({ roomId, memberKind: "fellow", memberRef, ownerId: auth.user.id });
      const member = context.socialStore.getRoomMember(roomId, "fellow", memberRef);
      return writeJson(res, 201, { ok: true, member });
    }

    // DELETE /api/rooms/:id/members — remove a member by {memberKind, memberRef}.
    // Same lenient "any member can edit" rule as PATCH; the operation is
    // bounded by the room scope and doesn't expose other rooms' state.
    if (req.method === "DELETE" && roomMembersMatch) {
      const roomId = roomMembersMatch[1];
      if (roomId.startsWith("dm:")) return writeError(res, 400, "DM rooms cannot be modified");
      if (!userIsMemberOfRoom(context.socialStore, roomId, auth.user.id)) {
        return writeError(res, 403, "not a member of this room");
      }
      const body = await readJson(req);
      const memberKind = String(body.memberKind || "");
      const memberRef = String(body.memberRef || "").trim();
      if (!memberKind || !memberRef) return writeError(res, 400, "memberKind and memberRef are required");
      context.socialStore.removeRoomMember(roomId, memberKind, memberRef);
      // Broadcast room.updated so every client refreshes its member cache.
      const room = context.socialStore.getRoom(roomId);
      for (const m of context.socialStore.listRoomMembers(roomId)) {
        if (m.member_kind === "user") {
          broadcastPersistedEvent(context, m.member_ref, { type: "room.updated", room });
        }
      }
      return writeJson(res, 200, { ok: true });
    }

    // POST /api/rooms/:id/messages/as-fellow — post AS a fellow
    if (req.method === "POST" && roomAsFellowMatch) {
      const roomId = roomAsFellowMatch[1];
      const body = await readJson(req);
      const fellowId = String(body.fellowId || "").trim();
      if (!fellowId) return writeError(res, 400, "fellowId is required");
      const fellowMember = context.socialStore.getRoomMember(roomId, "fellow", fellowId);
      if (!fellowMember || fellowMember.owner_id !== auth.user.id) {
        return writeError(res, 403, "you are not the owner of this fellow in this room");
      }
      const attachments = persistCloudAttachments(
        context.cloudStore,
        auth.user.id,
        Array.isArray(body.attachments) ? body.attachments : []
      );
      const message = context.messagesStore.appendMessage({
        roomId,
        senderKind: "fellow",
        senderRef: fellowId,
        senderOwnerId: auth.user.id,
        bodyMd: body.bodyMd || "",
        attachments: attachments.length ? attachments : null,
        mentions: body.mentions || null,
        turnId: body.turnId || null,
        status: "complete",
        errorJson: body.errorJson || null,
      });
      for (const m of context.socialStore.listRoomMembers(roomId)) {
        if (m.member_kind === "user") {
          broadcastPersistedEvent(context, m.member_ref, { type: "room.message_appended", roomId, message });
        }
      }
      return writeJson(res, 201, { message });
    }

    if (req.method === "GET" && roomDetailMatch) {
      const roomId = roomDetailMatch[1];
      if (!userIsMemberOfRoom(context.socialStore, roomId, auth.user.id)) {
        return writeError(res, 403, "not a member of this room");
      }
      const room = context.socialStore.getRoom(roomId);
      if (!room) return writeError(res, 404, "room not found");
      const members = context.socialStore.listRoomMembers(roomId);
      // M1: enrich fellow members with owner public user so renderer shows username
      const enriched = members.map((m) => {
        if (m.member_kind === "fellow" && m.owner_id) {
          return { ...m, owner: context.cloudStore.getUserPublic(m.owner_id) };
        }
        return m;
      });
      return writeJson(res, 200, { room, members: enriched });
    }

    // PATCH /api/rooms/:id — update room metadata (name, decorations).
    // Used by sidebar context menu for rename and pin. Any member of the
    // room can edit metadata; this is intentionally lenient because the
    // operations are non-destructive and aimashi has no group-admin model.
    if (req.method === "PATCH" && roomDetailMatch) {
      const roomId = roomDetailMatch[1];
      if (!userIsMemberOfRoom(context.socialStore, roomId, auth.user.id)) {
        return writeError(res, 403, "not a member of this room");
      }
      const existing = context.socialStore.getRoom(roomId);
      if (!existing) return writeError(res, 404, "room not found");
      const body = await readJson(req);
      if (replayIfCached(context, res, auth.user.id, body)) return;
      const patch = {};
      if (Object.prototype.hasOwnProperty.call(body, "name")) {
        const name = String(body.name || "").trim();
        if (!name || name.length > 80) return writeError(res, 400, "name must be 1..80 chars");
        if (roomId.startsWith("dm:")) return writeError(res, 400, "DM rooms cannot be renamed");
        patch.name = name;
      }
      if (Object.prototype.hasOwnProperty.call(body, "decorations")) {
        patch.decorations = body.decorations && typeof body.decorations === "object" ? body.decorations : null;
      }
      const room = context.socialStore.updateRoom(roomId, patch);
      const members = context.socialStore.listRoomMembers(roomId);
      // Broadcast room.updated to all user-members so other devices/clients refresh.
      for (const m of members) {
        if (m.member_kind === "user") {
          broadcastPersistedEvent(context, m.member_ref, { type: "room.updated", room });
        }
      }
      const payload = { room };
      rememberOp(context, auth.user.id, body, 200, payload);
      return writeJson(res, 200, payload);
    }

    // DELETE /api/rooms/:id — remove the room. ON DELETE CASCADE in the
    // schema removes room_members + messages automatically. Any member can
    // initiate (same lenient rule as PATCH).
    if (req.method === "DELETE" && roomDetailMatch) {
      const roomId = roomDetailMatch[1];
      if (!userIsMemberOfRoom(context.socialStore, roomId, auth.user.id)) {
        return writeError(res, 403, "not a member of this room");
      }
      const existing = context.socialStore.getRoom(roomId);
      if (!existing) return writeError(res, 404, "room not found");
      // DELETE bodies are usually empty, but the client can pass a body
      // with a clientOpId. Reading it is best-effort.
      let body = {};
      try { body = await readJson(req); } catch { /* empty body is fine */ }
      if (replayIfCached(context, res, auth.user.id, body)) return;
      const members = context.socialStore.listRoomMembers(roomId);
      context.socialStore.deleteRoom(roomId);
      // Broadcast room.deleted BEFORE removing connections — let clients
      // close any open subscriptions on this room.
      for (const m of members) {
        if (m.member_kind === "user") {
          broadcastPersistedEvent(context, m.member_ref, { type: "room.deleted", roomId });
        }
      }
      const payload = { ok: true };
      rememberOp(context, auth.user.id, body, 200, payload);
      return writeJson(res, 200, payload);
    }

    if (req.method === "GET" && roomMsgsMatch) {
      const roomId = roomMsgsMatch[1];
      if (!userIsMemberOfRoom(context.socialStore, roomId, auth.user.id)) {
        return writeError(res, 403, "not a member of this room");
      }
      const sinceSeq = Number(url.searchParams.get("since_seq") || 0);
      const limit = Number(url.searchParams.get("limit") || 100);
      // Pass the requesting user so messages they've locally deleted (hidden)
      // are excluded — survives re-sync and new devices.
      const messages = context.messagesStore.listMessagesSince(roomId, sinceSeq, limit, auth.user.id);
      return writeJson(res, 200, { messages });
    }

    if (req.method === "POST" && roomMsgsMatch) {
      const roomId = roomMsgsMatch[1];
      if (!userIsMemberOfRoom(context.socialStore, roomId, auth.user.id)) {
        return writeError(res, 403, "not a member of this room");
      }
      const body = await readJson(req);
      if (replayIfCached(context, res, auth.user.id, body)) return;
      // DM rooms are lazy-created on first message (per spec §6)
      if (roomId.startsWith("dm:") && !context.socialStore.getRoom(roomId)) {
        const parts = roomId.split(":");
        const [, a, b] = parts;
        const other = auth.user.id === a ? b : a;
        ensureDmRoom(context.socialStore, auth.user.id, other);
      }
      const attachments = persistCloudAttachments(
        context.cloudStore,
        auth.user.id,
        Array.isArray(body.attachments) ? body.attachments : []
      );
      const message = context.messagesStore.appendMessage({
        roomId,
        senderKind: "user",
        senderRef: auth.user.id,
        bodyMd: body.bodyMd || "",
        attachments: attachments.length ? attachments : null,
        mentions: body.mentions || null,
        turnId: body.turnId || null,
        status: "complete",
      });
      // 1. Broadcast room.message_appended to all user-members
      const allMembers = context.socialStore.listRoomMembers(roomId);
      for (const m of allMembers) {
        if (m.member_kind === "user") {
          broadcastPersistedEvent(context, m.member_ref, { type: "room.message_appended", roomId, message });
        }
      }
      // 2. Handle fellow mentions — dispatch invocation request to fellow
      //    owner. Includes self-owned fellows; the local agent runtime
      //    lives on the owner's machine regardless of whether the sender
      //    is the owner. (Skipping owner === sender meant every fellow in
      //    a single-user group was silently dropped.)
      const mentions = Array.isArray(body.mentions) ? body.mentions : [];
      for (const mention of mentions) {
        if (!mention || mention.kind !== "fellow") continue;
        const fellowId = String(mention.fellowId || "").trim();
        if (!fellowId) continue;
        const fellowMember = context.socialStore.getRoomMember(roomId, "fellow", fellowId);
        if (!fellowMember) continue;
        const recentMessages = context.messagesStore.listMessagesSince(roomId, Math.max(0, message.seq - 6), 6);
        broadcastPersistedEvent(context, fellowMember.owner_id, {
          type: "room.fellow_invocation_requested",
          roomId,
          fellowId,
          invokedBy: context.cloudStore.getUserPublic(auth.user.id),
          triggeringMessage: message,
          recentMessages,
        });
      }
      if (context.cloudAgentDispatcher) {
        context.cloudAgentDispatcher.handleUserMessage({
          userId: auth.user.id,
          roomId,
          message
        }).catch((error) => {
          console.warn("[cloud-agent] dispatch failed:", error?.message || error);
        });
      }
      const payload = { message };
      rememberOp(context, auth.user.id, body, 201, payload);
      return writeJson(res, 201, payload);
    }

    // DELETE /api/rooms/:id/messages/:msgId — WeChat-style local delete: hide
    // the message from THIS user's view only, then tell their other devices to
    // drop it too. Other room members keep their copy; a member can never
    // delete a message out of someone else's history. (A future "recall" would
    // be a separate, sender-only, broadcast-to-all action.)
    if (req.method === "DELETE" && roomMsgDeleteMatch) {
      const roomId = roomMsgDeleteMatch[1];
      const messageId = roomMsgDeleteMatch[2];
      if (!userIsMemberOfRoom(context.socialStore, roomId, auth.user.id)) {
        return writeError(res, 403, "not a member of this room");
      }
      const existing = context.messagesStore.getMessage(messageId);
      if (!existing || existing.room_id !== roomId) {
        return writeError(res, 404, "message not found");
      }
      context.messagesStore.hideMessageForUser(roomId, messageId, auth.user.id);
      // Only the deleting user's own devices learn about it — never broadcast
      // to the other members.
      broadcastPersistedEvent(context, auth.user.id, { type: "room.message_deleted", roomId, messageId });
      return writeJson(res, 200, { ok: true, roomId, messageId });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      cloudStore.logoutSession(tokenFromRequest(req));
      return writeJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/me") {
      ensureCloudAgentBootstrap(context, auth.user.id);
      return writeJson(res, 200, { user: auth.user });
    }

    // PATCH /api/me/profile — update the signed-in user's display avatar so
    // friends (and the user themself, from other devices) see the same image
    // their desktop uses. Body: { avatarImage?, avatarCrop?, avatarColor? }
    if (req.method === "PATCH" && url.pathname === "/api/me/profile") {
      const body = await readJson(req);
      if (replayIfCached(context, res, auth.user.id, body)) return;
      const updated = cloudStore.updateUserProfile(auth.user.id, {
        avatarImage: typeof body.avatarImage === "string" ? body.avatarImage : undefined,
        avatarCrop: body.avatarCrop === null || (body.avatarCrop && typeof body.avatarCrop === "object") ? body.avatarCrop : undefined,
        avatarColor: typeof body.avatarColor === "string" ? body.avatarColor : undefined
      });
      const payload = { user: updated };
      rememberOp(context, auth.user.id, body, 200, payload);
      return writeJson(res, 200, payload);
    }

    // PUT /api/me/fellows/:fellowId/room — ensure the stable private room
    // for a fellow exists. Unlike the legacy session endpoint below, this
    // room id is tied to the fellow identity, not a local chat session.
    const stableFellowRoomMatch = url.pathname.match(/^\/api\/me\/fellows\/([A-Za-z0-9_.-]+)\/room$/);
    if (req.method === "PUT" && stableFellowRoomMatch) {
      const fellowId = stableFellowRoomMatch[1];
      const body = await readJson(req);
      if (replayIfCached(context, res, auth.user.id, body)) return;
      const existingFellow = context.fellowsStore.getFellow(auth.user.id, fellowId);
      const runtimeKind = String(body.runtimeKind || "").trim() || undefined;
      const name = String(body.title || "").trim() || existingFellow?.name || fellowId;
      const decorations = runtimeKind ? { fellowKey: fellowId, runtimeKind } : { fellowKey: fellowId };
      const roomId = `fellow:${auth.user.id}:${fellowId}`;
      let room = context.socialStore.getRoom(roomId);
      const created = !room;
      let changed = false;
      const sameJson = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
      const hasMember = (members, kind, ref, ownerId = null) => members.some((member) =>
        member.member_kind === kind &&
        member.member_ref === ref &&
        (ownerId == null || member.owner_id === ownerId)
      );

      if (created) {
        room = context.socialStore.createRoom({ id: roomId, type: "fellow", name, decorations });
        changed = true;
      } else if (room.name !== name || !sameJson(room.decorations, decorations)) {
        room = context.socialStore.updateRoom(roomId, { name, decorations });
        changed = true;
      }
      let members = context.socialStore.listRoomMembers(roomId);
      if (!hasMember(members, "user", auth.user.id)) {
        context.socialStore.addRoomMember({ roomId, memberKind: "user", memberRef: auth.user.id });
        changed = true;
      }
      if (!hasMember(members, "fellow", fellowId, auth.user.id)) {
        context.socialStore.addRoomMember({ roomId, memberKind: "fellow", memberRef: fellowId, ownerId: auth.user.id });
        changed = true;
      }
      room = context.socialStore.getRoom(roomId);
      members = context.socialStore.listRoomMembers(roomId);
      if (changed) {
        broadcastPersistedEvent(context, auth.user.id, { type: "room.updated", room });
      }
      const payload = { ok: true, room, members, created };
      rememberOp(context, auth.user.id, body, 200, payload);
      return writeJson(res, 200, payload);
    }

    // PUT /api/me/fellow-rooms/:sessionId — upsert a single-owner
    // fellow-chat room. Phase 4 conversation-model unification: fellow
    // private chats now live in the same rooms+messages tables as
    // cloud DMs and groups. Each fellow chat session becomes a room
    // with id "fellow:<userId>:<sessionId>", type "fellow", and two
    // member rows: the owner (kind=user) and the fellow (kind=fellow,
    // ownerId=userId).
    //
    // Body: { fellowKey, title?, clientOpId? }
    //
    // Idempotent on (owner, sessionId): repeated calls return the same
    // room. Updates to name only happen if `title` is provided and
    // differs.
    const fellowRoomMatch = url.pathname.match(/^\/api\/me\/fellow-rooms\/([A-Za-z0-9_.:-]+)$/);
    if (req.method === "PUT" && fellowRoomMatch) {
      const sessionId = fellowRoomMatch[1];
      const body = await readJson(req);
      if (replayIfCached(context, res, auth.user.id, body)) return;
      const fellowKey = String(body.fellowKey || "").trim();
      if (!fellowKey) return writeError(res, 400, "fellowKey is required");
      const title = String(body.title || "").trim();
      const roomId = `fellow:${auth.user.id}:${sessionId}`;
      let room = context.socialStore.getRoom(roomId);
      if (!room) {
        context.socialStore.createRoom({
          id: roomId,
          type: "fellow",
          name: title || null,
          decorations: { fellowKey, sessionId }
        });
        context.socialStore.addRoomMember({ roomId, memberKind: "user", memberRef: auth.user.id });
        context.socialStore.addRoomMember({ roomId, memberKind: "fellow", memberRef: fellowKey, ownerId: auth.user.id });
        room = context.socialStore.getRoom(roomId);
      } else if (title && title !== room.name) {
        room = context.socialStore.updateRoom(roomId, { name: title });
      }
      const members = context.socialStore.listRoomMembers(roomId);
      const payload = { room, members };
      rememberOp(context, auth.user.id, body, 200, payload);
      return writeJson(res, 200, payload);
    }

    // GET /api/me/fellows — list this user's cloud-mirrored fellow
    // definitions. Phase 2 of the sync redesign: fellow identity (name +
    // avatar + persona + capabilities) lives in cloud so web / a freshly-
    // installed desktop / another machine can render fellow chats with
    // proper attribution. Runtime config (engine, model) stays local.
    if (req.method === "GET" && url.pathname === "/api/me/fellows") {
      const fellows = context.fellowsStore.listFellows(auth.user.id);
      return writeJson(res, 200, { fellows });
    }

    // PUT /api/me/fellows/:id — upsert one fellow. Body shape mirrors the
    // desktop fellow-manifest's identity fields (key→id is supplied via
    // URL). Broadcasts fellow.upserted so other devices stream it in.
    const fellowDetailMatch = url.pathname.match(/^\/api\/me\/fellows\/([A-Za-z0-9_.-]+)$/);
    if (req.method === "PUT" && fellowDetailMatch) {
      const id = fellowDetailMatch[1];
      const body = await readJson(req);
      if (replayIfCached(context, res, auth.user.id, body)) return;
      if (!body.name || typeof body.name !== "string") return writeError(res, 400, "name is required");
      const fellow = context.fellowsStore.upsertFellow(auth.user.id, {
        id,
        name: body.name,
        color: body.color,
        avatarImage: body.avatarImage,
        avatarCrop: body.avatarCrop,
        bio: body.bio,
        capabilities: body.capabilities,
        personaText: body.personaText
      });
      broadcastPersistedEvent(context, auth.user.id, { type: "fellow.upserted", fellow });
      const payload = { fellow };
      rememberOp(context, auth.user.id, body, 200, payload);
      return writeJson(res, 200, payload);
    }

    // GET /api/me/settings — cross-device user settings (pin / read marks
    // / appearance). Phase 3. Clients fetch on bootstrap + subscribe to
    // user_settings.updated to stay in sync.
    if (req.method === "GET" && url.pathname === "/api/me/settings") {
      return writeJson(res, 200, { settings: context.userSettingsStore.getSettings(auth.user.id) });
    }

    // PUT /api/me/settings — CAS-aware whole-bag replace. Body MAY
    // include expectedVersion; missing → server uses current version
    // (treats request as best-effort). On conflict (some other device
    // wrote between caller's GET and PUT) returns 409 with current
    // settings so client can merge + retry. Broadcasts user_settings
    // .updated only on actual write.
    if (req.method === "PUT" && url.pathname === "/api/me/settings") {
      const body = await readJson(req);
      if (replayIfCached(context, res, auth.user.id, body)) return;
      const out = context.userSettingsStore.putSettings(auth.user.id, {
        pins: body.pins,
        readMarks: body.readMarks,
        appearance: body.appearance,
        expectedVersion: body.expectedVersion
      });
      if (!out.ok) {
        const conflictPayload = { error: "version conflict", settings: out.settings };
        // Don't cache conflicts in op_idempotency — caller will retry
        // with a new expectedVersion and a new clientOpId.
        return writeJson(res, 409, conflictPayload);
      }
      broadcastPersistedEvent(context, auth.user.id, { type: "user_settings.updated", settings: out.settings });
      const payload = { settings: out.settings };
      rememberOp(context, auth.user.id, body, 200, payload);
      return writeJson(res, 200, payload);
    }

    // DELETE /api/me/fellows/:id
    if (req.method === "DELETE" && fellowDetailMatch) {
      const id = fellowDetailMatch[1];
      let body = {};
      try { body = await readJson(req); } catch { /* empty */ }
      if (replayIfCached(context, res, auth.user.id, body)) return;
      const existing = context.fellowsStore.getFellow(auth.user.id, id);
      if (!existing) return writeError(res, 404, "fellow not found");
      context.fellowsStore.deleteFellow(auth.user.id, id);
      broadcastPersistedEvent(context, auth.user.id, { type: "fellow.deleted", fellowId: id });
      const payload = { ok: true };
      rememberOp(context, auth.user.id, body, 200, payload);
      return writeJson(res, 200, payload);
    }

    // /api/workspace, /api/workspace/sync removed. Fellow chats live in
    // rooms+messages now (Phase 4); all conversations route through
    // /api/rooms[/...]. The legacy workspaces table is left in place
    // but no endpoint reads or writes it anymore.

    if (req.method === "GET" && url.pathname === "/api/bridge/devices") {
      return writeJson(res, 200, { devices: bridgeDevices(bridgeHub, auth.user.id) });
    }

    if (req.method === "GET" && url.pathname === "/api/bridge/runs") {
      return writeJson(res, 200, { runs: cloudStore.listBridgeRuns(auth.user.id) });
    }

    const cancelMatch = url.pathname.match(/^\/api\/bridge\/runs\/([a-zA-Z0-9_-]+)\/cancel$/);
    if (req.method === "POST" && cancelMatch) {
      const runId = cancelMatch[1];
      const wasPending = cancelBridgeRunDevice(bridgeHub, auth.user.id, runId);
      const run = cloudStore.cancelBridgeRun(auth.user.id, runId);
      if (!run) return writeError(res, 404, "Bridge run not found.");
      broadcastTransientEvent(context.eventHub, auth.user.id, { type: "bridge_run_updated", run });
      return writeJson(res, wasPending || run.status === "cancelled" ? 200 : 409, { run });
    }

    // /api/conversations + /api/messages also removed — all writes go
    // through /api/rooms/:id/messages now. Bridge still uses an
    // internal storage path; see the /api/bridge/run handler.

    if (req.method === "POST" && url.pathname === "/api/bridge/run") {
      const body = await readJson(req);
      const deviceId = String(body.deviceId || "");
      const device = resolveBridgeRunDevice(bridgeHub, auth.user.id, deviceId);
      if (!device) {
        const onlineCount = bridgeDevices(bridgeHub, auth.user.id).length;
        return writeError(res, 409, onlineCount > 1 ? "请选择要连接的本机设备。" : "本机 Agent Bridge 不在线。");
      }
      // Phase 4 cutover: conversationId is now interpreted as a fellow
      // room id (rooms+messages). The bridge writes the assistant reply
      // through messagesStore.appendMessage into that room, and the
      // standard room.message_appended event is broadcast as part of
      // the room sequence so other devices see it consistently.
      const conversationId = String(body.conversationId || "");
      const requestAttachments = persistCloudAttachments(cloudStore, auth.user.id, Array.isArray(body.attachments) ? body.attachments : []);
      const bridgeRun = cloudStore.createBridgeRun(auth.user.id, {
        deviceId: device.id,
        conversationId,
        text: String(body.text || ""),
        attachments: requestAttachments
      });
      broadcastTransientEvent(context.eventHub, auth.user.id, { type: "bridge_run_updated", run: bridgeRun });
      try {
        const running = cloudStore.startBridgeRun(auth.user.id, bridgeRun.id);
        broadcastTransientEvent(context.eventHub, auth.user.id, { type: "bridge_run_updated", run: running });
        const result = await runBridgeDevice(bridgeHub, device, {
          runId: bridgeRun.id,
          conversationId,
          text: bridgeRun.text,
          attachments: requestAttachments
        });
        const attachments = persistCloudAttachments(cloudStore, auth.user.id, Array.isArray(result.attachments) ? result.attachments : []);
        const completed = cloudStore.completeBridgeRun(auth.user.id, bridgeRun.id, {
          text: result.text,
          attachments
        });
        broadcastTransientEvent(context.eventHub, auth.user.id, { type: "bridge_run_updated", run: completed });
        // Persist the assistant reply into rooms+messages if the
        // conversationId looks like a real room id.
        let message = null;
        if (conversationId && context.socialStore.getRoom(conversationId)) {
          const text = String(result.text || "").trim() || "本机 Agent 已完成。";
          message = context.messagesStore.appendMessage({
            roomId: conversationId,
            senderKind: "fellow",
            senderRef: (context.socialStore.getRoom(conversationId)?.decorations?.fellowKey || "agent"),
            senderOwnerId: auth.user.id,
            bodyMd: text,
            attachments,
            status: "complete"
          });
          broadcastPersistedEvent(context, auth.user.id, { type: "room.message_appended", roomId: conversationId, message });
        }
        return writeJson(res, 200, { run: completed, message });
      } catch (error) {
        if (error.code === "AIMASHI_BRIDGE_CANCELLED") {
          const cancelled = cloudStore.getBridgeRun(auth.user.id, bridgeRun.id)
            || cloudStore.cancelBridgeRun(auth.user.id, bridgeRun.id);
          broadcastTransientEvent(context.eventHub, auth.user.id, { type: "bridge_run_updated", run: cancelled });
          return writeJson(res, 200, { run: cancelled, cancelled: true });
        }
        const failed = error.code === "AIMASHI_BRIDGE_TIMEOUT"
          ? cloudStore.timeoutBridgeRun(auth.user.id, bridgeRun.id, error.message || "本机 Agent 响应超时。")
          : cloudStore.failBridgeRun(auth.user.id, bridgeRun.id, error.message || "本机 Agent 执行失败。");
        broadcastTransientEvent(context.eventHub, auth.user.id, { type: "bridge_run_updated", run: failed });
        return writeError(res, 500, error.message || "本机 Agent 执行失败。");
      }
    }

    if (req.method === "POST" && url.pathname === "/api/files") {
      const body = await readJson(req);
      const file = cloudStore.saveImageDataUrl(auth.user.id, { name: body.name, dataUrl: body.dataUrl });
      return writeJson(res, 201, { file: clientFile(file) });
    }

    writeError(res, 404, "Not found.");
  } catch (error) {
    const message = error.message || "Internal error.";
    if (error.code === "AIMASHI_INVALID_JSON") return writeError(res, 400, message);
    if (error.code === "AIMASHI_BODY_TOO_LARGE") return writeError(res, 413, message);
    if (/账号已存在/.test(message)) return writeError(res, 409, message);
    if (/登录尝试过多/.test(message)) return writeError(res, 429, message);
    if (/用户名或密码不正确/.test(message)) return writeError(res, 401, message);
    if (/用户名需要|密码至少|Invalid image|Unsupported image/.test(message)) return writeError(res, 400, message);
    writeError(res, 500, message);
  }
}

function handleBridgeUpgrade(req, socket, head, context, wss) {
  const cloudStore = context.cloudStore;
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  if (url.pathname !== "/api/bridge" && url.pathname !== "/api/events") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  if (!requestOriginAllowed(req, context)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  const token = tokenFromWebSocketProtocol(req)
    || (context.allowQueryTokenAuth ? url.searchParams.get("token") : "");
  const auth = cloudStore.authenticateToken(token);
  if (!auth) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (url.pathname === "/api/events") {
      const sinceSeq = Number(url.searchParams.get("since_seq") || 0);
      attachEventSocket(context.eventHub, ws, auth.user.id, { eventLog: context.eventLog, sinceSeq });
      return;
    }
    attachBridgeDevice(context.bridgeHub, ws, {
      userId: auth.user.id,
      deviceName: url.searchParams.get("deviceName"),
      engine: url.searchParams.get("engine"),
      capabilities: parseJson(url.searchParams.get("capabilities"), {}),
      cloudStore,
      eventHub: context.eventHub
    });
    broadcastTransientEvent(context.eventHub, auth.user.id, { type: "device_updated", devices: bridgeDevices(context.bridgeHub, auth.user.id) });
  });
}

function createAimashiCloudServer(options = {}) {
  const storePaths = createStore(options.dataDir || defaultDataDir);
  const context = {
    store: storePaths,
    cloudStore: options.cloudStore || createCloudStore(storePaths),
    bridgeHub: createBridgeHub(options.bridgeRunTimeoutMs || bridgeRunTimeoutMs),
    eventHub: createEventHub(),
    allowedOrigins: allowedOriginsFromOptions(options),
    allowQueryTokenAuth: Boolean(options.allowQueryTokenAuth || process.env.AIMASHI_CLOUD_ALLOW_QUERY_TOKEN === "1"),
    webRoot: options.webRoot || defaultWebRoot(),
    releaseManifest: options.releaseManifest === undefined ? defaultReleaseManifest() : options.releaseManifest,
    socialStore: null,
    messagesStore: null,
    runtimeBindingsStore: null,
    cloudAgentRunsStore: null,
    cloudAgentDispatcher: null
  };
  context.socialStore = createSocialStore(context.cloudStore.getDb());
  context.messagesStore = createMessagesStore(context.cloudStore.getDb());
  context.eventLog = createEventLogStore(context.cloudStore.getDb());
  context.fellowsStore = createFellowsStore(context.cloudStore.getDb());
  context.runtimeBindingsStore = createRuntimeBindingsStore(context.cloudStore.getDb());
  context.cloudAgentRunsStore = createCloudAgentRunsStore(context.cloudStore.getDb());
  // Inject fellowsStore so listRoomMembers can enrich fellow members
  // with name/avatar from the owner's fellow definitions in one shot.
  context.socialStore._attachFellowsStore?.(context.fellowsStore);
  // Hourly purge of stale idempotency cache rows (Phase 1.D). Without
  // this the table grows monotonically. Default cutoff 24h matches the
  // store helper's default; tunable via env if pathological retries
  // ever require a larger window.
  context.eventLogPurgeTimer = setInterval(() => {
    try { context.eventLog.purgeStaleOps(); } catch (err) {
      console.warn("[event-log] purgeStaleOps failed:", err?.message || err);
    }
  }, 60 * 60 * 1000);
  if (context.eventLogPurgeTimer.unref) context.eventLogPurgeTimer.unref();
  context.userSettingsStore = createUserSettingsStore(context.cloudStore.getDb());
  const workerManager = options.cloudAgentWorkerManager || createHermesWorkerManager({
    rootDir: options.cloudAgentRootDir,
    mode: options.cloudAgentMode,
    staticBaseUrl: options.cloudAgentHermesBaseUrl,
    apiKey: options.cloudAgentHermesApiKey
  });
  const hermesRunsClient = options.cloudAgentHermesClient || createHermesRunsClient();
  const attachmentMaterializer = options.cloudAgentAttachmentMaterializer || createAttachmentMaterializer({
    cloudStore: context.cloudStore
  });
  context.cloudAgentDispatcher = createCloudAgentDispatcher({
    socialStore: context.socialStore,
    messagesStore: context.messagesStore,
    fellowsStore: context.fellowsStore,
    runtimeBindingsStore: context.runtimeBindingsStore,
    cloudAgentRunsStore: context.cloudAgentRunsStore,
    workerManager,
    hermesRunsClient,
    attachmentMaterializer,
    broadcastTransientEvent: (userId, payload) => broadcastTransientEvent(context.eventHub, userId, payload),
    broadcastPersistedEvent: (userId, payload) => broadcastPersistedEvent(context, userId, payload)
  });
  const server = http.createServer((req, res) => handleRequest(req, res, context));
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => handleBridgeUpgrade(req, socket, head, context, wss));
  server.on("close", () => context.cloudStore.close?.());
  server.aimashi = context;
  return server;
}

if (require.main === module) {
  const server = createAimashiCloudServer();
  server.listen(port, host, () => {
    console.log(`Aimashi Cloud API listening on http://${host}:${port}`);
  });
}

module.exports = {
  createAimashiCloudServer
};
