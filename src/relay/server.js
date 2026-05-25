#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.MIA_RELAY_PORT || 27862);
const HOST = process.env.MIA_RELAY_HOST || "0.0.0.0";
const ROOT = path.join(__dirname, "..");
const MOBILE_ROOT = path.join(ROOT, "mobile");
const ASSET_ROOT = path.join(ROOT, "renderer", "assets");
const SHARED_ROOT = path.join(ROOT, "shared");

const devices = new Map();
const clients = new Map();

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

function sendJson(ws, payload) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function readJson(value) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return null;
  }
}

function publicDevice(device) {
  return {
    deviceId: device.deviceId,
    name: device.name || "Mia Desktop",
    connectedAt: device.connectedAt,
    mobilePeers: device.mobiles.size
  };
}

function serveFile(res, filePath, cache = false) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": contentTypeFor(filePath),
    "Content-Length": body.length,
    "Cache-Control": cache ? "public, max-age=3600" : "no-cache"
  });
  res.end(body);
}

function safeStaticPath(root, requestPath) {
  const filePath = path.normalize(path.join(root, requestPath));
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) return "";
  return filePath;
}

function handleHttp(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  if (url.pathname === "/health") {
    const body = JSON.stringify({
      status: "ok",
      service: "mia-relay",
      devices: devices.size,
      clients: clients.size,
      uptime: Math.round(process.uptime())
    }, null, 2);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Access-Control-Allow-Origin": "*"
    });
    res.end(body);
    return;
  }
  if (url.pathname === "/favicon.ico") {
    res.writeHead(204, { "Cache-Control": "public, max-age=86400" });
    res.end();
    return;
  }
  if (url.pathname === "/" || url.pathname === "/mobile" || url.pathname === "/mobile/") {
    serveFile(res, path.join(MOBILE_ROOT, "index.html"));
    return;
  }
  if (url.pathname === "/mobile/manifest.json") {
    const body = JSON.stringify({
      name: "Mia Mobile",
      short_name: "Mia",
      start_url: "/mobile/",
      scope: "/mobile/",
      display: "standalone",
      orientation: "portrait",
      background_color: "#ffffff",
      theme_color: "#5e5ce6"
    }, null, 2);
    res.writeHead(200, {
      "Content-Type": "application/manifest+json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-cache"
    });
    res.end(body);
    return;
  }
  if (url.pathname === "/shared/engine-contracts.js" || url.pathname === "/shared/time-format.js") {
    serveFile(res, path.join(SHARED_ROOT, path.basename(url.pathname)), true);
    return;
  }
  if (url.pathname.startsWith("/mobile/")) {
    const filePath = safeStaticPath(MOBILE_ROOT, url.pathname.replace(/^\/mobile\//, ""));
    serveFile(res, filePath);
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    const filePath = safeStaticPath(ASSET_ROOT, url.pathname.replace(/^\/assets\//, ""));
    serveFile(res, filePath, true);
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "Not found" }));
}

function cleanupMobile(ws) {
  const client = clients.get(ws);
  if (!client || client.role !== "mobile") return;
  const device = devices.get(client.deviceId);
  if (!device) return;
  device.mobiles.delete(client.clientId);
  sendJson(device.ws, { type: "peer_count", count: device.mobiles.size });
}

function cleanupDesktop(ws) {
  const client = clients.get(ws);
  if (!client || client.role !== "desktop") return;
  const device = devices.get(client.deviceId);
  if (!device || device.ws !== ws) return;
  for (const mobile of device.mobiles.values()) {
    sendJson(mobile.ws, {
      type: "device_offline",
      deviceId: device.deviceId,
      message: "桌面端已断开"
    });
    mobile.ws.close(1012, "desktop offline");
  }
  devices.delete(client.deviceId);
}

function handleHello(ws, message) {
  const role = String(message.role || "");
  const deviceId = String(message.deviceId || "").trim();
  const secret = String(message.secret || "").trim();
  if (!deviceId || !secret || !["desktop", "mobile"].includes(role)) {
    sendJson(ws, { type: "error", error: "Invalid hello." });
    ws.close(1008, "invalid hello");
    return;
  }

  if (role === "desktop") {
    const existing = devices.get(deviceId);
    if (existing && existing.secret !== secret) {
      sendJson(ws, { type: "error", error: "Device already registered with a different secret." });
      ws.close(1008, "desktop secret mismatch");
      return;
    }
    if (existing?.ws && existing.ws !== ws) existing.ws.close(1012, "replaced");
    const device = {
      ws,
      deviceId,
      secret,
      name: String(message.name || "Mia Desktop"),
      connectedAt: new Date().toISOString(),
      mobiles: new Map()
    };
    devices.set(deviceId, device);
    clients.set(ws, { role, deviceId });
    sendJson(ws, { type: "ready", role, device: publicDevice(device) });
    return;
  }

  const device = devices.get(deviceId);
  if (!device || device.secret !== secret) {
    sendJson(ws, { type: "error", error: "Device not found or pairing secret is invalid." });
    ws.close(1008, "pairing failed");
    return;
  }
  const clientId = crypto.randomUUID();
  const mobile = {
    ws,
    clientId,
    deviceId,
    connectedAt: new Date().toISOString()
  };
  device.mobiles.set(clientId, mobile);
  clients.set(ws, { role, deviceId, clientId });
  sendJson(ws, { type: "ready", role, clientId, device: publicDevice(device) });
  sendJson(device.ws, { type: "peer_count", count: device.mobiles.size });
}

function handleMobileRpc(ws, message) {
  const client = clients.get(ws);
  if (!client || client.role !== "mobile") {
    sendJson(ws, { type: "rpc_result", id: message.id, ok: false, error: "Mobile client is not paired." });
    return;
  }
  const device = devices.get(client.deviceId);
  if (!device?.ws || device.ws.readyState !== device.ws.OPEN) {
    sendJson(ws, { type: "rpc_result", id: message.id, ok: false, error: "Desktop is offline." });
    return;
  }
  sendJson(device.ws, {
    type: "rpc",
    id: String(message.id || crypto.randomUUID()),
    clientId: client.clientId,
    method: String(message.method || "GET").toUpperCase(),
    path: String(message.path || "/"),
    body: message.body || null
  });
}

function forwardDesktopMessage(ws, message) {
  const client = clients.get(ws);
  if (!client || client.role !== "desktop") return;
  const device = devices.get(client.deviceId);
  if (!device || device.ws !== ws) return;
  const mobile = device.mobiles.get(String(message.clientId || ""));
  if (!mobile?.ws || mobile.ws.readyState !== mobile.ws.OPEN) return;
  const payload = { ...message };
  delete payload.clientId;
  sendJson(mobile.ws, payload);
}

function handleMessage(ws, raw) {
  const message = readJson(raw);
  if (!message || typeof message !== "object") {
    sendJson(ws, { type: "error", error: "Invalid JSON message." });
    return;
  }
  if (message.type === "hello") {
    handleHello(ws, message);
    return;
  }
  if (message.type === "ping") {
    sendJson(ws, { type: "pong", ts: Date.now() });
    return;
  }
  if (message.type === "rpc") {
    handleMobileRpc(ws, message);
    return;
  }
  if (message.type === "rpc_result" || message.type === "rpc_stream") {
    forwardDesktopMessage(ws, message);
    return;
  }
  sendJson(ws, { type: "error", error: `Unknown message type: ${message.type || ""}` });
}

const server = http.createServer(handleHttp);
const wss = new WebSocketServer({ server, path: "/relay" });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  ws.on("message", (raw) => handleMessage(ws, raw));
  ws.on("close", () => {
    cleanupMobile(ws);
    cleanupDesktop(ws);
    clients.delete(ws);
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000).unref();

server.listen(PORT, HOST, () => {
  const displayHost = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
  console.log(`Mia relay listening at http://${displayHost}:${PORT}`);
});
