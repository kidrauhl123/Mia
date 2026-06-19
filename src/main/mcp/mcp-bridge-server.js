"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const net = require("node:net");

const { SENSITIVE_KEY_PATTERN } = require("../../shared/mcp-contracts.js");

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function freePort(host) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, host, () => {
      const address = srv.address();
      srv.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function redactStructured(value, seen = new WeakSet()) {
  if (Array.isArray(value)) return value.map((entry) => redactStructured(entry, seen));
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key) && child != null && String(child)) {
      out[key] = "••••••••";
      continue;
    }
    out[key] = redactStructured(child, seen);
  }
  return out;
}

function redactText(text, secrets = []) {
  let output = String(text || "");
  for (const secret of secrets) {
    const value = String(secret || "");
    if (!value) continue;
    output = output.split(value).join("[REDACTED]");
  }
  return output
    .replace(/\b((?:api[_-]?key|auth(?:orization)?|auth[_-]?token|token|password|secret)\s*[:=]\s*)(?:"[^"]+"|'[^']+'|[^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/\b(Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]");
}

function safeEqualSecret(actual, expected) {
  const left = Buffer.from(String(actual || ""));
  const right = Buffer.from(String(expected || ""));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function createMcpBridgeServer({ manager, secret, host = "127.0.0.1", appendLog = () => {} } = {}) {
  if (!manager) throw new Error("manager dependency is required.");
  if (!secret) throw new Error("secret dependency is required.");

  let server = null;
  let port = 0;

  function log(line, meta) {
    const payload = meta && typeof meta === "object" ? ` ${JSON.stringify(redactStructured(meta))}` : "";
    appendLog(redactText(`${String(line || "")}${payload}`, [secret]));
  }

  function baseUrl() {
    return port ? `http://${host}:${port}` : "";
  }

  function callbackUrl() {
    return baseUrl() ? `${baseUrl()}/mcp/execute` : "";
  }

  function manifestUrl() {
    return baseUrl() ? `${baseUrl()}/mcp/manifest` : "";
  }

  async function handleManifest(res) {
    writeJson(res, 200, { tools: manager.toolManifest() });
  }

  async function handleExecute(req, res) {
    const rawBody = await readBody(req);
    let body = {};
    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      writeJson(res, 400, { error: "Invalid JSON body" });
      return;
    }

    const result = await manager.callTool(
      String(body.server || ""),
      String(body.tool || ""),
      body.args && typeof body.args === "object" ? body.args : {},
      { source: "bridge" }
    );
    writeJson(res, 200, result);
  }

  async function handle(req, res) {
    if (req.method !== "POST") {
      writeJson(res, 404, { error: "Not found" });
      return;
    }

    if (!safeEqualSecret(req.headers["x-mia-mcp-bridge-secret"], secret)) {
      writeJson(res, 401, { error: "Unauthorized" });
      return;
    }

    if (req.url === "/mcp/manifest") {
      await handleManifest(res);
      return;
    }
    if (req.url === "/mcp/execute") {
      await handleExecute(req, res);
      return;
    }

    writeJson(res, 404, { error: "Not found" });
  }

  async function start() {
    if (server) {
      return { port, callbackUrl: callbackUrl(), manifestUrl: manifestUrl(), secret };
    }

    port = await freePort(host);
    server = http.createServer((req, res) => {
      handle(req, res).catch((error) => {
        log("[MCP] bridge request failed", { error: error?.message || error });
        writeJson(res, 500, { error: "Internal server error" });
      });
    });

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });

    return { port, callbackUrl: callbackUrl(), manifestUrl: manifestUrl(), secret };
  }

  async function stop() {
    if (!server) return;
    const closing = server;
    server = null;
    port = 0;
    await new Promise((resolve) => closing.close(resolve));
  }

  return {
    callbackUrl,
    manifestUrl,
    start,
    stop
  };
}

module.exports = {
  createMcpBridgeServer,
  freePort
};
