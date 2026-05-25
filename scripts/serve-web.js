#!/usr/bin/env node

const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const root = path.join(__dirname, "..", "src", "web");
const sourceRoot = path.join(__dirname, "..", "src");
const host = process.env.MIA_WEB_HOST || "127.0.0.1";
const port = Number(process.env.MIA_WEB_PORT || 4174);
const apiTarget = process.env.MIA_WEB_API_TARGET || "http://127.0.0.1:4175";

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

function safePath(requestPath) {
  const decoded = decodeURIComponent(requestPath.split("?")[0] || "/");
  const target = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const candidates = [{ filePath: path.normalize(path.join(root, target)), base: root }];
  if (target.startsWith("shared/")) {
    candidates.push({ filePath: path.normalize(path.join(sourceRoot, target)), base: sourceRoot });
  } else if (target.startsWith("message-sources/")) {
    candidates.push({ filePath: path.normalize(path.join(sourceRoot, "renderer", target)), base: sourceRoot });
  }
  for (const { filePath, base } of candidates) {
    if (filePath !== base && !filePath.startsWith(`${base}${path.sep}`)) continue;
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return filePath;
  }
  return candidates[0].filePath;
}

const server = http.createServer((req, res) => {
  if (String(req.url || "").startsWith("/api/")) {
    const target = new URL(req.url || "/", apiTarget);
    const proxy = http.request(target, {
      method: req.method,
      headers: { ...req.headers, host: target.host }
    }, (upstream) => {
      res.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(res);
    });
    proxy.on("error", (error) => {
      const body = JSON.stringify({ error: error.message });
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
      res.end(body);
    });
    req.pipe(proxy);
    return;
  }
  const filePath = safePath(req.url || "/");
  const asset = fs.existsSync(filePath) && fs.statSync(filePath).isFile()
    ? filePath
    : path.join(root, "index.html");
  const body = fs.readFileSync(asset);
  res.writeHead(200, {
    "Content-Type": contentType(asset),
    "Content-Length": body.length,
    "Cache-Control": asset.endsWith("index.html") ? "no-cache" : "public, max-age=3600"
  });
  res.end(body);
});

server.on("upgrade", (req, socket, head) => {
  if (!String(req.url || "").startsWith("/api/")) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  const target = new URL(req.url || "/", apiTarget);
  const upstream = net.connect(Number(target.port || 80), target.hostname, () => {
    const headers = { ...req.headers, host: target.host };
    const lines = [
      `${req.method} ${target.pathname}${target.search} HTTP/${req.httpVersion}`,
      ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`)
    ];
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => {
    socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    socket.destroy();
  });
});

server.listen(port, host, () => {
  console.log(`Mia Web listening on http://${host}:${port}`);
});
