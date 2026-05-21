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
const cloudFeatures = [
  "sqlite-store",
  "auth-sessions",
  "authenticated-files",
  "events-websocket",
  "bridge-websocket-subprotocol-token",
  "bridge-run-lifecycle",
  "bridge-run-cancel",
  "bridge-run-progress",
  "desktop-sync"
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

function attachEventSocket(hub, ws, userId) {
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
  sendWsJson(ws, { type: "events_ready" });
}

function broadcastEvent(hub, userId, payload) {
  for (const ws of hub.socketsByUser.get(userId) || []) {
    sendWsJson(ws, payload);
  }
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
      broadcastEvent(device.eventHub, device.userId, {
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
      broadcastEvent(device.eventHub, device.userId, {
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
  return {
    ...message,
    attachments: persistCloudAttachments(
      cloudStore,
      userId,
      Array.isArray(message.attachments) ? message.attachments : []
    )
  };
}

function sanitizeCloudConversationAttachments(cloudStore, userId, conversation = {}) {
  if (!Array.isArray(conversation.messages)) return conversation;
  return {
    ...conversation,
    messages: conversation.messages.map((message) => sanitizeCloudMessageAttachments(cloudStore, userId, message))
  };
}

function sanitizeCloudWorkspaceAttachments(cloudStore, userId, workspace = {}) {
  if (!Array.isArray(workspace.conversations)) return workspace;
  return {
    ...workspace,
    conversations: workspace.conversations.map((conversation) => sanitizeCloudConversationAttachments(cloudStore, userId, conversation))
  };
}

function cleanConversation(input = {}) {
  const idValue = String(input.id || "").trim();
  const idSafe = idValue && /^[a-zA-Z0-9:_-]{1,120}$/.test(idValue) ? idValue : id("conv");
  const timestamp = now();
  return {
    id: idSafe,
    title: String(input.title || "新对话").trim().slice(0, 80) || "新对话",
    meta: String(input.meta || "Aimashi Cloud · 已同步").trim().slice(0, 120) || "Aimashi Cloud · 已同步",
    avatar: String(input.avatar || "./assets/avatar-01.png").trim().slice(0, 240) || "./assets/avatar-01.png",
    updatedAt: String(input.updatedAt || timestamp),
    unread: Number(input.unread || 0),
    messages: Array.isArray(input.messages) ? input.messages : []
  };
}

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

  if (serveWebAsset(req, res, context.webRoot, url.pathname)) return;

  try {
    if (req.method === "POST" && url.pathname === "/api/auth/register") {
      const account = cloudStore.registerUser(await readJson(req));
      return writeJson(res, 201, account);
    }

    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      return writeJson(res, 200, cloudStore.loginUser({ ...(await readJson(req)), ip: clientIp(req) }));
    }

    const auth = cloudStore.authenticateToken(tokenFromRequest(req));
    if (req.method === "GET" && serveAuthorizedFile(req, res, cloudStore, auth, url.pathname)) return;
    if (!auth) return writeError(res, 401, "请先登录。");

    // POST /api/social/friend-requests
    if (req.method === "POST" && url.pathname === "/api/social/friend-requests") {
      const body = await readJson(req);
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
      broadcastEvent(context.eventHub, toUser.id, {
        type: "social.friend_request_received",
        request: { ...created, from: context.cloudStore.getUserPublic(auth.user.id) }
      });
      return writeJson(res, 201, { request: created });
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
        broadcastEvent(context.eventHub, updated.from_user, {
          type: "social.friend_added",
          friend: accepterPublic,
          room
        });
        broadcastEvent(context.eventHub, auth.user.id, {
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
      const rooms = context.socialStore.listRoomsForUser(auth.user.id);
      return writeJson(res, 200, { rooms });
    }

    // POST /api/rooms — create a group room
    if (req.method === "POST" && url.pathname === "/api/rooms") {
      const body = await readJson(req);
      const name = String(body.name || "").trim();
      if (!name || name.length > 80) return writeError(res, 400, "name is required and must be 1..80 chars");
      const memberFellows = Array.isArray(body.memberFellows) ? body.memberFellows : [];
      const memberFriendUserIds = Array.isArray(body.memberFriendUserIds) ? body.memberFriendUserIds : [];
      // Validate friend membership before creating anything
      for (const friendId of memberFriendUserIds) {
        if (!context.socialStore.areFriends(auth.user.id, String(friendId))) {
          return writeError(res, 403, "user is not your friend: " + friendId);
        }
      }
      const roomId = "g_" + require("node:crypto").randomBytes(8).toString("hex");
      context.socialStore.createRoom({ id: roomId, name });
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
          broadcastEvent(context.eventHub, m.member_ref, { type: "social.room_invited", room, invitedBy: creatorPublic });
        }
      }
      return writeJson(res, 201, { room, members });
    }

    const roomAsFellowMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_:-]+)\/messages\/as-fellow$/);
    const roomMembersMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_:-]+)\/members$/);
    const roomMsgsMatch = !roomAsFellowMatch && url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_:-]+)\/messages$/);
    const roomDetailMatch = !roomAsFellowMatch && !roomMembersMatch && !roomMsgsMatch && url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_:-]+)$/);

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
        broadcastEvent(context.eventHub, memberRef, { type: "social.room_invited", room, invitedBy: inviterPublic });
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
      const message = context.messagesStore.appendMessage({
        roomId,
        senderKind: "fellow",
        senderRef: fellowId,
        senderOwnerId: auth.user.id,
        bodyMd: body.bodyMd || "",
        attachments: body.attachments || null,
        mentions: body.mentions || null,
        turnId: body.turnId || null,
        status: "complete",
        errorJson: body.errorJson || null,
      });
      for (const m of context.socialStore.listRoomMembers(roomId)) {
        if (m.member_kind === "user") {
          broadcastEvent(context.eventHub, m.member_ref, { type: "room.message_appended", roomId, message });
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

    if (req.method === "GET" && roomMsgsMatch) {
      const roomId = roomMsgsMatch[1];
      if (!userIsMemberOfRoom(context.socialStore, roomId, auth.user.id)) {
        return writeError(res, 403, "not a member of this room");
      }
      const sinceSeq = Number(url.searchParams.get("since_seq") || 0);
      const limit = Number(url.searchParams.get("limit") || 100);
      const messages = context.messagesStore.listMessagesSince(roomId, sinceSeq, limit);
      return writeJson(res, 200, { messages });
    }

    if (req.method === "POST" && roomMsgsMatch) {
      const roomId = roomMsgsMatch[1];
      if (!userIsMemberOfRoom(context.socialStore, roomId, auth.user.id)) {
        return writeError(res, 403, "not a member of this room");
      }
      const body = await readJson(req);
      // DM rooms are lazy-created on first message (per spec §6)
      if (roomId.startsWith("dm:") && !context.socialStore.getRoom(roomId)) {
        const parts = roomId.split(":");
        const [, a, b] = parts;
        const other = auth.user.id === a ? b : a;
        ensureDmRoom(context.socialStore, auth.user.id, other);
      }
      const message = context.messagesStore.appendMessage({
        roomId,
        senderKind: "user",
        senderRef: auth.user.id,
        bodyMd: body.bodyMd || "",
        attachments: body.attachments || null,
        mentions: body.mentions || null,
        turnId: body.turnId || null,
        status: "complete",
      });
      // 1. Broadcast room.message_appended to all user-members
      const allMembers = context.socialStore.listRoomMembers(roomId);
      for (const m of allMembers) {
        if (m.member_kind === "user") {
          broadcastEvent(context.eventHub, m.member_ref, { type: "room.message_appended", roomId, message });
        }
      }
      // 2. Handle fellow mentions — dispatch invocation request to fellow owner (cross-user)
      const mentions = Array.isArray(body.mentions) ? body.mentions : [];
      for (const mention of mentions) {
        if (!mention || mention.kind !== "fellow") continue;
        const fellowId = String(mention.fellowId || "").trim();
        if (!fellowId) continue;
        const fellowMember = context.socialStore.getRoomMember(roomId, "fellow", fellowId);
        if (!fellowMember) continue;
        // Only dispatch cross-user invocations (owner is not the sender)
        if (fellowMember.owner_id === auth.user.id) continue;
        const recentMessages = context.messagesStore.listMessagesSince(roomId, Math.max(0, message.seq - 6), 6);
        broadcastEvent(context.eventHub, fellowMember.owner_id, {
          type: "room.fellow_invocation_requested",
          roomId,
          fellowId,
          invokedBy: context.cloudStore.getUserPublic(auth.user.id),
          triggeringMessage: message,
          recentMessages,
        });
      }
      return writeJson(res, 201, { message });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      cloudStore.logoutSession(tokenFromRequest(req));
      return writeJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/me") {
      return writeJson(res, 200, { user: auth.user, workspace: cloudStore.getWorkspace(auth.user.id) });
    }

    if (req.method === "GET" && url.pathname === "/api/workspace") {
      return writeJson(res, 200, { workspace: cloudStore.getWorkspace(auth.user.id) });
    }

    if (req.method === "PUT" && url.pathname === "/api/workspace") {
      const body = await readJson(req);
      const rawWorkspace = body.workspace && typeof body.workspace === "object" ? body.workspace : {};
      const incoming = sanitizeCloudWorkspaceAttachments(cloudStore, auth.user.id, rawWorkspace);
      const workspace = cloudStore.putWorkspace(auth.user.id, incoming);
      broadcastEvent(context.eventHub, auth.user.id, { type: "workspace_updated", workspace });
      return writeJson(res, 200, { workspace });
    }

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
      broadcastEvent(context.eventHub, auth.user.id, { type: "bridge_run_updated", run });
      return writeJson(res, wasPending || run.status === "cancelled" ? 200 : 409, { run });
    }

    if (req.method === "POST" && url.pathname === "/api/conversations") {
      const body = await readJson(req);
      const incoming = sanitizeCloudConversationAttachments(
        cloudStore,
        auth.user.id,
        cleanConversation(body.conversation && typeof body.conversation === "object" ? body.conversation : {})
      );
      const current = cloudStore.getWorkspace(auth.user.id);
      const conversations = Array.isArray(current.conversations) ? current.conversations.slice() : [];
      const index = conversations.findIndex((item) => item.id === incoming.id);
      const conversation = index >= 0
        ? { ...conversations[index], ...incoming, messages: conversations[index].messages || [] }
        : incoming;
      if (index >= 0) conversations[index] = conversation;
      else conversations.unshift(conversation);
      const workspace = cloudStore.putWorkspace(auth.user.id, {
        ...current,
        activeConversationId: conversation.id,
        conversations
      });
      broadcastEvent(context.eventHub, auth.user.id, { type: "workspace_updated", workspace });
      return writeJson(res, 201, { workspace, conversation });
    }

    if (req.method === "POST" && url.pathname === "/api/messages") {
      const body = await readJson(req);
      const role = String(body.role || "user") === "assistant" ? "assistant" : "user";
      const attachments = persistCloudAttachments(
        cloudStore,
        auth.user.id,
        Array.isArray(body.attachments) ? body.attachments : []
      );
      const text = String(body.text || "").trim();
      if (!text && !attachments.length) return writeError(res, 400, "消息内容不能为空。");
      // Preserve the client-provided timestamp when present so the
      // workspace echo dedups against the local store's already-persisted
      // copy of this message. Fall back to server now() for legacy clients
      // that don't send one.
      const clientCreatedAt = String(body.createdAt || "").trim();
      const isValidIso = clientCreatedAt
        && !Number.isNaN(new Date(clientCreatedAt).getTime());
      const message = {
        id: id("msg"),
        role,
        text,
        createdAt: isValidIso ? clientCreatedAt : now(),
        attachments
      };
      const appended = cloudStore.appendMessage(auth.user.id, {
        conversationId: String(body.conversationId || ""),
        message
      });
      broadcastEvent(context.eventHub, auth.user.id, { type: "message_created", workspace: appended.workspace, message });
      return writeJson(res, 201, appended);
    }

    if (req.method === "POST" && url.pathname === "/api/bridge/run") {
      const body = await readJson(req);
      const deviceId = String(body.deviceId || "");
      const device = resolveBridgeRunDevice(bridgeHub, auth.user.id, deviceId);
      if (!device) {
        const onlineCount = bridgeDevices(bridgeHub, auth.user.id).length;
        return writeError(res, 409, onlineCount > 1 ? "请选择要连接的本机设备。" : "本机 Agent Bridge 不在线。");
      }
      const requestAttachments = persistCloudAttachments(cloudStore, auth.user.id, Array.isArray(body.attachments) ? body.attachments : []);
      const bridgeRun = cloudStore.createBridgeRun(auth.user.id, {
        deviceId: device.id,
        conversationId: String(body.conversationId || ""),
        text: String(body.text || ""),
        attachments: requestAttachments
      });
      broadcastEvent(context.eventHub, auth.user.id, { type: "bridge_run_updated", run: bridgeRun });
      try {
        const running = cloudStore.startBridgeRun(auth.user.id, bridgeRun.id);
        broadcastEvent(context.eventHub, auth.user.id, { type: "bridge_run_updated", run: running });
        const result = await runBridgeDevice(bridgeHub, device, {
          runId: bridgeRun.id,
          conversationId: bridgeRun.conversationId,
          text: bridgeRun.text,
          attachments: requestAttachments
        });
        const attachments = persistCloudAttachments(cloudStore, auth.user.id, Array.isArray(result.attachments) ? result.attachments : []);
        const completed = cloudStore.completeBridgeRun(auth.user.id, bridgeRun.id, {
          text: result.text,
          attachments
        });
        broadcastEvent(context.eventHub, auth.user.id, { type: "bridge_run_updated", run: completed });
        const message = {
          id: id("msg"),
          role: "assistant",
          text: String(result.text || "").trim() || "本机 Agent 已完成。",
          createdAt: now(),
          attachments
        };
        const appended = cloudStore.appendMessage(auth.user.id, {
          conversationId: String(body.conversationId || ""),
          message
        });
        broadcastEvent(context.eventHub, auth.user.id, { type: "message_created", workspace: appended.workspace, message });
        return writeJson(res, 200, { ...appended, run: completed });
      } catch (error) {
        if (error.code === "AIMASHI_BRIDGE_CANCELLED") {
          const cancelled = cloudStore.getBridgeRun(auth.user.id, bridgeRun.id)
            || cloudStore.cancelBridgeRun(auth.user.id, bridgeRun.id);
          const workspace = cloudStore.getWorkspace(auth.user.id);
          broadcastEvent(context.eventHub, auth.user.id, { type: "bridge_run_updated", run: cancelled });
          return writeJson(res, 200, { workspace, run: cancelled, cancelled: true });
        }
        const failed = error.code === "AIMASHI_BRIDGE_TIMEOUT"
          ? cloudStore.timeoutBridgeRun(auth.user.id, bridgeRun.id, error.message || "本机 Agent 响应超时。")
          : cloudStore.failBridgeRun(auth.user.id, bridgeRun.id, error.message || "本机 Agent 执行失败。");
        broadcastEvent(context.eventHub, auth.user.id, { type: "bridge_run_updated", run: failed });
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
      attachEventSocket(context.eventHub, ws, auth.user.id);
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
    broadcastEvent(context.eventHub, auth.user.id, { type: "device_updated", devices: bridgeDevices(context.bridgeHub, auth.user.id) });
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
    messagesStore: null
  };
  context.socialStore = createSocialStore(context.cloudStore.getDb());
  context.messagesStore = createMessagesStore(context.cloudStore.getDb());
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
