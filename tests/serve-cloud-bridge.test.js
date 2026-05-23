const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const WebSocket = require("ws");

const { createAimashiCloudServer } = require("../scripts/serve-cloud");

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aimashi-cloud-bridge-"));
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function jsonFetch(baseUrl, requestPath, options = {}) {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function rawFetch(baseUrl, requestPath, options = {}) {
  return fetch(`${baseUrl}${requestPath}`, {
    ...options,
    headers: { ...(options.headers || {}) }
  });
}

function waitForMessage(ws, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for websocket message.")), 2000);
    ws.on("message", function onMessage(raw) {
      const message = JSON.parse(String(raw));
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(message);
    });
    ws.on("error", reject);
  });
}

function waitForNoMessage(ws, ms = 150) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      resolve();
    }, ms);
    function onMessage(raw) {
      clearTimeout(timer);
      ws.off("message", onMessage);
      reject(new Error(`Unexpected websocket message: ${String(raw)}`));
    }
    ws.on("message", onMessage);
    ws.on("error", reject);
  });
}

function waitForWsClose(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for websocket close.")), 2000);
    ws.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    ws.on("error", () => {
      // Node ws emits an error for failed handshakes before close on some platforms.
    });
  });
}

function closeWs(ws) {
  if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) return;
  try {
    if (ws.readyState === WebSocket.CONNECTING) return;
    ws.close();
  } catch {
    // Test cleanup should not mask the assertion failure.
  }
}

function wsTokenProtocol(token) {
  return [`aimashi-token.${token}`];
}

function wsBaseUrl(baseUrl) {
  return baseUrl.replace(/^http:/, "ws:");
}

function eventsWsUrl(baseUrl) {
  return `${wsBaseUrl(baseUrl)}/api/events`;
}

function bridgeWsUrl(baseUrl, params = {}) {
  const url = new URL(`${wsBaseUrl(baseUrl)}/api/bridge`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return url.toString();
}

test("auth accepts username registration with six character password", async () => {
  const dataDir = tempDataDir();
  const server = createAimashiCloudServer({ dataDir });
  const baseUrl = await listen(server);
  let ws = null;
  try {
    const account = await jsonFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { username: "jung", password: "123456" }
    });
    assert.equal(account.user.username, "jung");
    assert.ok(account.token);

    const login = await jsonFetch(baseUrl, "/api/auth/login", {
      method: "POST",
      body: { username: "JUNG", password: "123456" }
    });
    assert.equal(login.user.username, "jung");
    assert.ok(login.token);
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud logout invalidates bearer sessions", async () => {
  const dataDir = tempDataDir();
  const server = createAimashiCloudServer({ dataDir });
  const baseUrl = await listen(server);
  try {
    const account = await jsonFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { username: "logout", password: "secret1" }
    });
    const headers = { Authorization: `Bearer ${account.token}` };
    const beforeLogout = await rawFetch(baseUrl, "/api/me", { headers });
    assert.equal(beforeLogout.status, 200);

    const logout = await rawFetch(baseUrl, "/api/auth/logout", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: "{}"
    });
    assert.equal(logout.status, 200);

    const afterLogout = await rawFetch(baseUrl, "/api/me", { headers });
    assert.equal(afterLogout.status, 401);
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud applies security headers and restricts browser CORS origins", async () => {
  const dataDir = tempDataDir();
  const server = createAimashiCloudServer({
    dataDir,
    allowedOrigins: ["https://aiweb.buytb01.com"],
    releaseManifest: {
      product: "Aimashi Cloud",
      version: "0.1.0",
      builtAt: "2026-05-21T00:00:00.000Z",
      source: { gitCommit: "abc123", gitDirty: true },
      files: {
        "api/server.js": "hash",
        "web/app.js": "hash"
      }
    }
  });
  const baseUrl = await listen(server);
  try {
    const allowed = await rawFetch(baseUrl, "/api/health", {
      headers: {
        Origin: "https://aiweb.buytb01.com",
        "X-Forwarded-Proto": "https"
      }
    });
    assert.equal(allowed.status, 200);
    const health = await allowed.json();
    assert.equal(health.service, "aimashi-cloud");
    assert.deepEqual(health.release, {
      version: "0.1.0",
      builtAt: "2026-05-21T00:00:00.000Z",
      gitCommit: "abc123",
      gitDirty: true,
      fileCount: 2
    });
    assert.ok(health.features.includes("sqlite-store"));
    assert.ok(health.features.includes("bridge-websocket-subprotocol-token"));
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://aiweb.buytb01.com");
    assert.equal(allowed.headers.get("x-content-type-options"), "nosniff");
    assert.equal(allowed.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    assert.match(allowed.headers.get("strict-transport-security") || "", /max-age=31536000/);

    const rejected = await rawFetch(baseUrl, "/api/health", {
      headers: { Origin: "https://evil.example" }
    });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.headers.get("access-control-allow-origin"), null);
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud handles browser CORS preflight for allowed origins only", async () => {
  const dataDir = tempDataDir();
  const server = createAimashiCloudServer({
    dataDir,
    allowedOrigins: ["https://aiweb.buytb01.com"]
  });
  const baseUrl = await listen(server);
  try {
    const allowed = await rawFetch(baseUrl, "/api/files", {
      method: "OPTIONS",
      headers: {
        Origin: "https://aiweb.buytb01.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type"
      }
    });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://aiweb.buytb01.com");
    assert.match(allowed.headers.get("access-control-allow-methods") || "", /POST/);
    assert.match(allowed.headers.get("access-control-allow-headers") || "", /authorization/);

    const rejected = await rawFetch(baseUrl, "/api/files", {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type"
      }
    });
    assert.equal(rejected.status, 204);
    assert.equal(rejected.headers.get("access-control-allow-origin"), null);
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud returns client errors for malformed or oversized JSON bodies", async () => {
  const dataDir = tempDataDir();
  const server = createAimashiCloudServer({ dataDir });
  const baseUrl = await listen(server);
  try {
    const malformed = await rawFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{"
    });
    assert.equal(malformed.status, 400);
    assert.match((await malformed.json()).error, /Invalid JSON/);

    const oversized = await rawFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "oversized", password: "secret1", padding: "x".repeat(28 * 1024 * 1024) })
    });
    assert.equal(oversized.status, 413);
    assert.match((await oversized.json()).error, /too large/);
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud accepts image uploads at the documented eighteen megabyte limit", async () => {
  const dataDir = tempDataDir();
  const server = createAimashiCloudServer({ dataDir });
  const baseUrl = await listen(server);
  try {
    const account = await jsonFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { username: "large-upload", password: "secret1" }
    });
    const image = Buffer.alloc(18 * 1024 * 1024, 1);
    const upload = await jsonFetch(baseUrl, "/api/files", {
      method: "POST",
      headers: { Authorization: `Bearer ${account.token}` },
      body: {
        name: "large.png",
        dataUrl: `data:image/png;base64,${image.toString("base64")}`
      }
    });
    assert.match(upload.file.url, /^\/api\/files\/file_/);
    assert.equal(upload.file.size, image.length);
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud rejects active-content image uploads", async () => {
  const dataDir = tempDataDir();
  const server = createAimashiCloudServer({ dataDir });
  const baseUrl = await listen(server);
  try {
    const account = await jsonFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { username: "svg-upload", password: "secret1" }
    });
    const svg = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>");
    const upload = await rawFetch(baseUrl, "/api/files", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name: "script.svg",
        dataUrl: `data:image/svg+xml;base64,${svg.toString("base64")}`
      })
    });
    assert.equal(upload.status, 400);
    assert.match(await upload.text(), /Unsupported image type/);
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud can serve bundled web assets without exposing path traversal", async () => {
  const dataDir = tempDataDir();
  const server = createAimashiCloudServer({ dataDir });
  const baseUrl = await listen(server);
  try {
    const index = await rawFetch(baseUrl, "/");
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type") || "", /text\/html/);
    assert.match(await index.text(), /<title>Aimashi Web<\/title>/);

    const app = await rawFetch(baseUrl, "/app.js");
    assert.equal(app.status, 200);
    assert.match(app.headers.get("content-type") || "", /javascript/);

    const favicon = await rawFetch(baseUrl, "/favicon.ico");
    assert.equal(favicon.status, 200);
    assert.match(favicon.headers.get("content-type") || "", /image\/svg\+xml/);
    assert.match(await favicon.text(), /<svg/);

    const touchIcon = await rawFetch(baseUrl, "/apple-touch-icon.png");
    assert.equal(touchIcon.status, 200);
    assert.match(touchIcon.headers.get("content-type") || "", /image\/png/);

    const pwaIcon = await rawFetch(baseUrl, "/icon-192.png");
    assert.equal(pwaIcon.status, 200);
    assert.match(pwaIcon.headers.get("content-type") || "", /image\/png/);

    const manifest = await rawFetch(baseUrl, "/manifest.webmanifest");
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get("content-type") || "", /application\/manifest\+json/);
    const manifestJson = await manifest.json();
    assert.equal(manifestJson.name, "Aimashi Web");
    assert.equal(manifestJson.display, "standalone");
    assert.deepEqual(manifestJson.icons?.map((icon) => icon.src), ["/icon-192.png", "/icon-512.png", "/favicon.svg"]);

    const traversal = await rawFetch(baseUrl, "/%2e%2e/package.json");
    assert.notEqual(traversal.status, 200);
    assert.doesNotMatch(await traversal.text(), /"aimashi"/);

    const malformed = await rawFetch(baseUrl, "/%E0%A4%A");
    assert.equal(malformed.status, 400);
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud rejects websocket upgrades from disallowed browser origins", async () => {
  const dataDir = tempDataDir();
  const server = createAimashiCloudServer({
    dataDir,
    allowedOrigins: ["https://aiweb.buytb01.com"]
  });
  const baseUrl = await listen(server);
  let allowedWs = null;
  let rejectedWs = null;
  try {
    const account = await jsonFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { username: "origin", password: "secret1" }
    });
    allowedWs = new WebSocket(eventsWsUrl(baseUrl), wsTokenProtocol(account.token), {
      headers: { Origin: "https://aiweb.buytb01.com" }
    });
    await waitForMessage(allowedWs, (message) => message.type === "events_ready");

    rejectedWs = new WebSocket(eventsWsUrl(baseUrl), wsTokenProtocol(account.token), {
      headers: { Origin: "https://evil.example" }
    });
    await waitForWsClose(rejectedWs);
    assert.equal(rejectedWs.readyState, WebSocket.CLOSED);
  } finally {
    closeWs(allowedWs);
    closeWs(rejectedWs);
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud default origin policy allows same host and rejects foreign websocket origins", async () => {
  const dataDir = tempDataDir();
  const server = createAimashiCloudServer({ dataDir });
  const baseUrl = await listen(server);
  let sameHostWs = null;
  let rejectedWs = null;
  try {
    const account = await jsonFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { username: "default-origin", password: "secret1" }
    });
    sameHostWs = new WebSocket(eventsWsUrl(baseUrl), wsTokenProtocol(account.token), {
      headers: { Origin: baseUrl }
    });
    await waitForMessage(sameHostWs, (message) => message.type === "events_ready");

    rejectedWs = new WebSocket(eventsWsUrl(baseUrl), wsTokenProtocol(account.token), {
      headers: { Origin: "https://evil.example" }
    });
    await waitForWsClose(rejectedWs);
    assert.equal(rejectedWs.readyState, WebSocket.CLOSED);
  } finally {
    closeWs(sameHostWs);
    closeWs(rejectedWs);
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud websocket auth accepts subprotocol tokens without query tokens", async () => {
  const dataDir = tempDataDir();
  const server = createAimashiCloudServer({ dataDir });
  const baseUrl = await listen(server);
  let ws = null;
  try {
    const account = await jsonFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { username: "protocol", password: "secret1" }
    });
    ws = new WebSocket(eventsWsUrl(baseUrl), wsTokenProtocol(account.token));
    await waitForMessage(ws, (message) => message.type === "events_ready");
    assert.equal(ws.url.includes("token="), false);
  } finally {
    closeWs(ws);
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud websocket auth rejects query token auth by default", async () => {
  const dataDir = tempDataDir();
  const server = createAimashiCloudServer({ dataDir });
  const baseUrl = await listen(server);
  let eventsWs = null;
  let bridgeWs = null;
  try {
    const account = await jsonFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { username: "query-token", password: "secret1" }
    });
    eventsWs = new WebSocket(`${eventsWsUrl(baseUrl)}?token=${encodeURIComponent(account.token)}`);
    assert.equal(await waitForWsClose(eventsWs), 1006);

    const bridgeUrl = bridgeWsUrl(baseUrl, {
      token: account.token,
      deviceName: "URL Token Mac",
      engine: "codex"
    });
    bridgeWs = new WebSocket(bridgeUrl);
    assert.equal(await waitForWsClose(bridgeWs), 1006);
  } finally {
    closeWs(eventsWs);
    closeWs(bridgeWs);
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud bridge lists online local devices and writes run results to the workspace", async () => {
  const dataDir = tempDataDir();
  const server = createAimashiCloudServer({ dataDir });
  const baseUrl = await listen(server);
  try {
    const account = await jsonFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { email: "bridge@example.com", password: "password123" }
    });
    const headers = { Authorization: `Bearer ${account.token}` };
    const capabilities = { streaming: true, generatedImages: true, appVersion: "0.1.0", hostname: "mac.local" };
    ws = new WebSocket(bridgeWsUrl(baseUrl, {
      deviceName: "Mac Studio",
      engine: "codex",
      capabilities: JSON.stringify(capabilities)
    }), wsTokenProtocol(account.token));
    await waitForMessage(ws, (message) => message.type === "bridge_ready");

    const devices = await jsonFetch(baseUrl, "/api/bridge/devices", { headers });
    assert.equal(devices.devices.length, 1);
    assert.equal(devices.devices[0].deviceName, "Mac Studio");
    assert.equal(devices.devices[0].engine, "codex");
    assert.equal(devices.devices[0].status, "online");
    assert.deepEqual(devices.devices[0].capabilities, capabilities);

    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type !== "run") return;
      ws.send(JSON.stringify({
        type: "run_result",
        runId: message.runId,
        ok: true,
        text: `本机 Codex 已收到：${message.text}`,
        attachments: [
          { id: "unsafe_path", type: "image", name: "secret.png", url: "/Users/jung/secret.png" },
          { id: "unsafe_file", type: "image", name: "secret2.png", url: "file:///Users/jung/secret2.png" },
          { id: "safe_remote", type: "image", name: "remote.png", url: "https://cdn.example.com/remote.png" }
        ]
      }));
    });

    const run = await jsonFetch(baseUrl, "/api/bridge/run", {
      method: "POST",
      headers,
      body: {
        deviceId: devices.devices[0].id,
        conversationId: account.workspace.activeConversationId,
        text: "你好"
      }
    });

    const conversation = run.workspace.conversations.find((item) => item.id === account.workspace.activeConversationId);
    const lastMessage = conversation.messages[conversation.messages.length - 1];
    assert.equal(lastMessage.role, "assistant");
    assert.equal(lastMessage.text, "本机 Codex 已收到：你好");
    assert.equal(run.message.id, lastMessage.id);
    assert.deepEqual(run.message.attachments.map((item) => item.id), ["safe_remote"]);
    assert.equal(run.message.attachments[0].url, "https://cdn.example.com/remote.png");

    const runs = await jsonFetch(baseUrl, "/api/bridge/runs", { headers });
    assert.equal(runs.runs.length, 1);
    assert.equal(runs.runs[0].status, "succeeded");
    assert.equal(runs.runs[0].resultText, "本机 Codex 已收到：你好");
    assert.deepEqual(runs.runs[0].attachments.map((item) => item.id), ["safe_remote"]);

    const cancelCompleted = await rawFetch(baseUrl, `/api/bridge/runs/${run.run.id}/cancel`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: "{}"
    });
    assert.equal(cancelCompleted.status, 409);
    const stillCompleted = await cancelCompleted.json();
    assert.equal(stillCompleted.run.status, "succeeded");
  } finally {
    ws?.close();
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud bridge forwards run progress events to authenticated event sockets", async () => {
  const dataDir = tempDataDir();
  const server = createAimashiCloudServer({ dataDir });
  const baseUrl = await listen(server);
  let bridgeWs = null;
  let eventsWs = null;
  try {
    const account = await jsonFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { username: "progress", password: "secret1" }
    });
    const headers = { Authorization: `Bearer ${account.token}` };
    eventsWs = new WebSocket(eventsWsUrl(baseUrl), wsTokenProtocol(account.token));
    await waitForMessage(eventsWs, (message) => message.type === "events_ready");

    bridgeWs = new WebSocket(bridgeWsUrl(baseUrl, {
      deviceName: "Mac",
      engine: "codex",
      capabilities: JSON.stringify({ streaming: true })
    }), wsTokenProtocol(account.token));
    await waitForMessage(bridgeWs, (message) => message.type === "bridge_ready");
    const devices = await jsonFetch(baseUrl, "/api/bridge/devices", { headers });
    assert.equal(devices.devices[0].capabilities.streaming, true);

    bridgeWs.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type !== "run") return;
      bridgeWs.send(JSON.stringify({
        type: "run_event",
        runId: message.runId,
        event: { kind: "text_delta", id: "msg_1", text: "进度" }
      }));
      bridgeWs.send(JSON.stringify({
        type: "run_result",
        runId: message.runId,
        ok: true,
        text: "完成",
        attachments: []
      }));
    });

    const progressEvent = waitForMessage(eventsWs, (message) => message.type === "bridge_run_event" && message.event?.text === "进度");
    const run = await jsonFetch(baseUrl, "/api/bridge/run", {
      method: "POST",
      headers,
      body: {
        deviceId: devices.devices[0].id,
        conversationId: account.workspace.activeConversationId,
        text: "跑一下"
      }
    });
    const streamed = await progressEvent;
    assert.equal(streamed.runId, run.run.id);
    assert.equal(streamed.event.kind, "text_delta");
  } finally {
    closeWs(bridgeWs);
    closeWs(eventsWs);
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud bridge broadcasts device removal when a desktop disconnects", async () => {
  const dataDir = tempDataDir();
  const server = createAimashiCloudServer({ dataDir });
  const baseUrl = await listen(server);
  let bridgeWs = null;
  let eventsWs = null;
  try {
    const account = await jsonFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { username: "device-removal", password: "secret1" }
    });
    const headers = { Authorization: `Bearer ${account.token}` };
    eventsWs = new WebSocket(eventsWsUrl(baseUrl), wsTokenProtocol(account.token));
    await waitForMessage(eventsWs, (message) => message.type === "events_ready");

    bridgeWs = new WebSocket(bridgeWsUrl(baseUrl, { deviceName: "Mac", engine: "codex" }), wsTokenProtocol(account.token));
    await waitForMessage(bridgeWs, (message) => message.type === "bridge_ready");
    const devices = await jsonFetch(baseUrl, "/api/bridge/devices", { headers });
    assert.equal(devices.devices.length, 1);

    const offlineEvent = waitForMessage(eventsWs, (message) => message.type === "device_updated" && Array.isArray(message.devices) && message.devices.length === 0);
    bridgeWs.close();
    await offlineEvent;
    const afterClose = await jsonFetch(baseUrl, "/api/bridge/devices", { headers });
    assert.equal(afterClose.devices.length, 0);
  } finally {
    closeWs(bridgeWs);
    closeWs(eventsWs);
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud bridge device listing follows live websocket state instead of stale sqlite rows", async () => {
  const dataDir = tempDataDir();
  const server = createAimashiCloudServer({ dataDir });
  const baseUrl = await listen(server);
  let bridgeWs = null;
  try {
    const account = await jsonFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { username: "live-devices", password: "secret1" }
    });
    const headers = { Authorization: `Bearer ${account.token}` };
    bridgeWs = new WebSocket(bridgeWsUrl(baseUrl, {
      deviceName: "Live Mac",
      engine: "codex",
      capabilities: JSON.stringify({ streaming: true })
    }), wsTokenProtocol(account.token));
    await waitForMessage(bridgeWs, (message) => message.type === "bridge_ready");
    const online = await jsonFetch(baseUrl, "/api/bridge/devices", { headers });
    assert.equal(online.devices.length, 1);
    assert.equal(online.devices[0].status, "online");
    assert.equal(online.devices[0].capabilities.streaming, true);

    bridgeWs.terminate();
    await waitForWsClose(bridgeWs);
    const offline = await jsonFetch(baseUrl, "/api/bridge/devices", { headers });
    assert.equal(offline.devices.length, 0);
  } finally {
    closeWs(bridgeWs);
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud bridge runs on the explicitly selected online device", async () => {
  const dataDir = tempDataDir();
  const server = createAimashiCloudServer({ dataDir });
  const baseUrl = await listen(server);
  let wsOne = null;
  let wsTwo = null;
  try {
    const account = await jsonFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { username: "multi-device", password: "secret1" }
    });
    const headers = { Authorization: `Bearer ${account.token}` };
    wsOne = new WebSocket(bridgeWsUrl(baseUrl, { deviceName: "Mac One", engine: "codex" }), wsTokenProtocol(account.token));
    wsTwo = new WebSocket(bridgeWsUrl(baseUrl, { deviceName: "Mac Two", engine: "codex" }), wsTokenProtocol(account.token));
    await waitForMessage(wsOne, (message) => message.type === "bridge_ready");
    await waitForMessage(wsTwo, (message) => message.type === "bridge_ready");
    const devices = await jsonFetch(baseUrl, "/api/bridge/devices", { headers });
    assert.equal(devices.devices.length, 2);
    const selected = devices.devices.find((device) => device.deviceName === "Mac Two");
    assert.ok(selected);

    let firstDeviceSawRun = false;
    wsOne.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "run") firstDeviceSawRun = true;
    });
    wsTwo.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type !== "run") return;
      wsTwo.send(JSON.stringify({
        type: "run_result",
        runId: message.runId,
        ok: true,
        text: `selected:${message.text}`,
        attachments: []
      }));
    });

    const run = await jsonFetch(baseUrl, "/api/bridge/run", {
      method: "POST",
      headers,
      body: {
        deviceId: selected.id,
        conversationId: account.workspace.activeConversationId,
        text: "hello selected"
      }
    });
    assert.equal(run.message.text, "selected:hello selected");
    assert.equal(run.run.deviceId, selected.id);
    assert.equal(firstDeviceSawRun, false);
  } finally {
    closeWs(wsOne);
    closeWs(wsTwo);
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud bridge auto-selects the only online device when deviceId is omitted", async () => {
  const dataDir = tempDataDir();
  const server = createAimashiCloudServer({ dataDir });
  const baseUrl = await listen(server);
  let ws = null;
  try {
    const account = await jsonFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { username: "single-device", password: "secret1" }
    });
    const headers = { Authorization: `Bearer ${account.token}` };
    ws = new WebSocket(bridgeWsUrl(baseUrl, { deviceName: "Only Mac", engine: "codex" }), wsTokenProtocol(account.token));
    await waitForMessage(ws, (message) => message.type === "bridge_ready");
    const devices = await jsonFetch(baseUrl, "/api/bridge/devices", { headers });
    assert.equal(devices.devices.length, 1);

    let receivedRunAttachments = null;
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type !== "run") return;
      receivedRunAttachments = message.attachments;
      ws.send(JSON.stringify({
        type: "run_result",
        runId: message.runId,
        ok: true,
        text: `auto:${message.text}`,
        attachments: []
      }));
    });

    const requestDataUrl = `data:image/png;base64,${Buffer.from("request-image").toString("base64")}`;
    const run = await jsonFetch(baseUrl, "/api/bridge/run", {
      method: "POST",
      headers,
      body: {
        conversationId: account.workspace.activeConversationId,
        text: "hello default device",
        attachments: [{ name: "request.png", type: "image", dataUrl: requestDataUrl }]
      }
    });
    assert.equal(run.message.text, "auto:hello default device");
    assert.equal(run.run.deviceId, devices.devices[0].id);
    assert.equal(run.run.requestAttachments.length, 1);
    assert.match(run.run.requestAttachments[0].url, /^\/api\/files\/file_/);
    assert.equal(Object.hasOwn(run.run.requestAttachments[0], "dataUrl"), false);
    assert.deepEqual(receivedRunAttachments, run.run.requestAttachments);
  } finally {
    closeWs(ws);
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud bridge requires explicit device selection when multiple devices are online", async () => {
  const dataDir = tempDataDir();
  const server = createAimashiCloudServer({ dataDir });
  const baseUrl = await listen(server);
  let wsOne = null;
  let wsTwo = null;
  try {
    const account = await jsonFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { username: "requires-device", password: "secret1" }
    });
    const headers = { Authorization: `Bearer ${account.token}` };
    wsOne = new WebSocket(bridgeWsUrl(baseUrl, { deviceName: "Mac One", engine: "codex" }), wsTokenProtocol(account.token));
    wsTwo = new WebSocket(bridgeWsUrl(baseUrl, { deviceName: "Mac Two", engine: "codex" }), wsTokenProtocol(account.token));
    await waitForMessage(wsOne, (message) => message.type === "bridge_ready");
    await waitForMessage(wsTwo, (message) => message.type === "bridge_ready");

    const response = await rawFetch(baseUrl, "/api/bridge/run", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: account.workspace.activeConversationId,
        text: "hello ambiguous device"
      })
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, "请选择要连接的本机设备。");
  } finally {
    closeWs(wsOne);
    closeWs(wsTwo);
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud files require owner authentication", async () => {
  const dataDir = tempDataDir();
  const server = createAimashiCloudServer({ dataDir });
  const baseUrl = await listen(server);
  try {
    const alice = await jsonFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { username: "alice", password: "secret1" }
    });
    const bob = await jsonFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { username: "bob", password: "secret1" }
    });
    const dataUrl = `data:image/png;base64,${Buffer.from("png-data").toString("base64")}`;
    const upload = await jsonFetch(baseUrl, "/api/files", {
      method: "POST",
      headers: { Authorization: `Bearer ${alice.token}` },
      body: { name: "dog.png", dataUrl }
    });

    const unauthenticated = await rawFetch(baseUrl, upload.file.url);
    assert.equal(unauthenticated.status, 401);

    const crossUser = await rawFetch(baseUrl, upload.file.url, {
      headers: { Authorization: `Bearer ${bob.token}` }
    });
    assert.equal(crossUser.status, 404);

    const owner = await rawFetch(baseUrl, upload.file.url, {
      headers: { Authorization: `Bearer ${alice.token}` }
    });
    assert.equal(owner.status, 200);
    assert.equal(owner.headers.get("content-type"), "image/png");
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud events broadcast workspace updates only to the authenticated user", async () => {
  const dataDir = tempDataDir();
  const server = createAimashiCloudServer({ dataDir });
  const baseUrl = await listen(server);
  let aliceEvents = null;
  let bobEvents = null;
  try {
    const alice = await jsonFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { username: "alice", password: "secret1" }
    });
    const bob = await jsonFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { username: "bob", password: "secret1" }
    });
    aliceEvents = new WebSocket(eventsWsUrl(baseUrl), wsTokenProtocol(alice.token));
    bobEvents = new WebSocket(eventsWsUrl(baseUrl), wsTokenProtocol(bob.token));
    await waitForMessage(aliceEvents, (message) => message.type === "events_ready");
    await waitForMessage(bobEvents, (message) => message.type === "events_ready");

    const updatedWorkspace = {
      ...alice.workspace,
      activeConversationId: "conv_live",
      conversations: [{ id: "conv_live", title: "实时同步", messages: [] }]
    };
    const aliceUpdate = waitForMessage(aliceEvents, (message) => message.type === "workspace_updated");
    await jsonFetch(baseUrl, "/api/workspace", {
      method: "PUT",
      headers: { Authorization: `Bearer ${alice.token}` },
      body: { workspace: updatedWorkspace }
    });

    const event = await aliceUpdate;
    assert.equal(event.workspace.activeConversationId, "conv_live");
    await waitForNoMessage(bobEvents);
  } finally {
    closeWs(aliceEvents);
    closeWs(bobEvents);
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud workspace updates sanitize message attachments", async () => {
  const dataDir = tempDataDir();
  const server = createAimashiCloudServer({ dataDir });
  const baseUrl = await listen(server);
  try {
    const account = await jsonFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { username: "workspace-attachments", password: "secret1" }
    });
    const headers = { Authorization: `Bearer ${account.token}` };
    const dataUrl = `data:image/png;base64,${Buffer.from("workspace-png").toString("base64")}`;
    const uploaded = await jsonFetch(baseUrl, "/api/files", {
      method: "POST",
      headers,
      body: { name: "cloud.png", dataUrl }
    });
    const updated = await jsonFetch(baseUrl, "/api/workspace", {
      method: "PUT",
      headers,
      body: {
        workspace: {
          ...account.workspace,
          conversations: [{
            id: "conv_workspace",
            title: "Workspace",
            messages: [{
              id: "msg_workspace",
              role: "assistant",
              text: "workspace attach",
              attachments: [
                { id: "unsafe_abs", name: "secret.png", url: "/Users/jung/secret.png" },
                { id: "unsafe_file", name: "secret2.png", url: "file:///Users/jung/secret2.png" },
                { id: "other_file", name: "other.png", url: "/api/files/file_missing" },
                { id: "safe_file", name: "cloud.png", url: uploaded.file.url },
                { id: "data_image", name: "workspace.png", dataUrl }
              ]
            }]
          }]
        }
      }
    });
    const message = updated.workspace.conversations[0].messages[0];
    assert.equal(message.attachments.length, 2);
    assert.equal(message.attachments[0].id, uploaded.file.id);
    assert.equal(message.attachments[0].url, uploaded.file.url);
    assert.match(message.attachments[1].url, /^\/api\/files\/file_/);
    assert.equal(Object.hasOwn(message.attachments[1], "dataUrl"), false);
    const serialized = JSON.stringify(updated.workspace);
    assert.equal(serialized.includes("/Users/jung"), false);
    assert.equal(serialized.includes("file:///"), false);
    assert.equal(serialized.includes("data:image"), false);
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud appends user messages atomically and broadcasts them", async () => {
  const dataDir = tempDataDir();
  const server = createAimashiCloudServer({ dataDir });
  const baseUrl = await listen(server);
  let events = null;
  try {
    const account = await jsonFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { username: "writer", password: "secret1" }
    });
    events = new WebSocket(eventsWsUrl(baseUrl), wsTokenProtocol(account.token));
    await waitForMessage(events, (message) => message.type === "events_ready");

    const nextMessage = waitForMessage(events, (message) => message.type === "message_created");
    const appended = await jsonFetch(baseUrl, "/api/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${account.token}` },
      body: {
        conversationId: account.workspace.activeConversationId,
        role: "user",
        text: "服务端追加",
        attachments: []
      }
    });

    assert.equal(appended.message.role, "user");
    assert.equal(appended.message.text, "服务端追加");
    const event = await nextMessage;
    assert.equal(event.message.id, appended.message.id);
    const conversation = event.workspace.conversations.find((item) => item.id === account.workspace.activeConversationId);
    assert.equal(conversation.messages.at(-1).text, "服务端追加");

    const commandResult = {
      type: "session-list",
      command: "/resume",
      engine: "codex",
      sourceDeviceId: "aimashi-device-a",
      rows: [{
        id: "019e53ab-cb8a-71a2-a2a4-ca7bdf0520d6",
        title: "Indexed title",
        preview: "hello",
        project: "/repo",
        updatedAt: 1779525746671
      }]
    };
    const commandMessage = await jsonFetch(baseUrl, "/api/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${account.token}` },
      body: {
        conversationId: account.workspace.activeConversationId,
        role: "assistant",
        text: "选择一个会话继续：",
        commandResult,
        attachments: []
      }
    });
    assert.deepEqual(commandMessage.message.commandResult, commandResult);

    const newConversation = await jsonFetch(baseUrl, "/api/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${account.token}` },
      body: {
        conversationId: "desktop_new_session",
        role: "user",
        text: "桌面端新会话",
        attachments: []
      }
    });
    const created = newConversation.workspace.conversations.find((item) => item.id === "desktop_new_session");
    assert.equal(created.title, "桌面端新会话");
    assert.equal(created.messages.at(-1).text, "桌面端新会话");
    assert.equal(newConversation.workspace.activeConversationId, "desktop_new_session");

    const blank = await rawFetch(baseUrl, "/api/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        conversationId: account.workspace.activeConversationId,
        role: "user",
        text: "   ",
        attachments: []
      })
    });
    assert.equal(blank.status, 400);
    assert.match(await blank.text(), /消息内容不能为空/);
  } finally {
    closeWs(events);
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud upserts desktop conversations and persists message data-url attachments", async () => {
  const dataDir = tempDataDir();
  const server = createAimashiCloudServer({ dataDir });
  const baseUrl = await listen(server);
  try {
    const account = await jsonFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { username: "desktop", password: "secret1" }
    });
    const headers = { Authorization: `Bearer ${account.token}` };
    const upserted = await jsonFetch(baseUrl, "/api/conversations", {
      method: "POST",
      headers,
      body: {
        conversation: {
          id: "desktop_session_1",
          title: "Desktop Session",
          meta: "Aimashi Desktop · 已同步",
          avatar: "./assets/avatar-08.png"
        }
      }
    });
    assert.equal(upserted.conversation.id, "desktop_session_1");
    assert.equal(upserted.workspace.activeConversationId, "desktop_session_1");

    const dataUrl = `data:image/png;base64,${Buffer.from("desktop-png").toString("base64")}`;
    const appended = await jsonFetch(baseUrl, "/api/messages", {
      method: "POST",
      headers,
      body: {
        conversationId: "desktop_session_1",
        role: "assistant",
        text: "桌面端图片",
        attachments: [{ name: "desktop.png", type: "image", dataUrl }]
      }
    });
    assert.equal(appended.message.attachments.length, 1);
    assert.match(appended.message.attachments[0].url, /^\/api\/files\/file_/);
    assert.equal(Object.hasOwn(appended.message.attachments[0], "dataUrl"), false);
    assert.equal(Object.hasOwn(appended.message.attachments[0], "path"), false);

    const owner = await rawFetch(baseUrl, appended.message.attachments[0].url, { headers });
    assert.equal(owner.status, 200);
    assert.equal(owner.headers.get("content-type"), "image/png");
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud drops unsafe local-path attachment urls from messages", async () => {
  const dataDir = tempDataDir();
  const server = createAimashiCloudServer({ dataDir });
  const baseUrl = await listen(server);
  try {
    const account = await jsonFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { username: "unsafe-attachment", password: "secret1" }
    });
    const headers = { Authorization: `Bearer ${account.token}` };
    const dataUrl = `data:image/png;base64,${Buffer.from("safe-png").toString("base64")}`;
    const uploaded = await jsonFetch(baseUrl, "/api/files", {
      method: "POST",
      headers,
      body: { name: "cloud.png", dataUrl }
    });
    const appended = await jsonFetch(baseUrl, "/api/messages", {
      method: "POST",
      headers,
      body: {
        conversationId: account.workspace.activeConversationId,
        role: "assistant",
        text: "附件过滤",
        attachments: [
          { id: "unsafe_abs", name: "secret.png", url: "/Users/jung/secret.png" },
          { id: "unsafe_file", name: "secret2.png", url: "file:///Users/jung/secret2.png" },
          { id: "other_file", name: "other.png", url: "/api/files/file_missing" },
          { id: "safe_file", name: "cloud.png", url: uploaded.file.url },
          { id: "safe_http", name: "remote.png", url: "https://cdn.example.com/remote.png" }
        ]
      }
    });
    assert.deepEqual(appended.message.attachments.map((item) => item.id), [uploaded.file.id, "safe_http"]);
    assert.deepEqual(appended.message.attachments.map((item) => item.url), [uploaded.file.url, "https://cdn.example.com/remote.png"]);
    const serialized = JSON.stringify(appended);
    assert.equal(serialized.includes("/Users/jung"), false);
    assert.equal(serialized.includes("file:///"), false);
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud can cancel a pending bridge run", async () => {
  const dataDir = tempDataDir();
  const server = createAimashiCloudServer({ dataDir });
  const baseUrl = await listen(server);
  let ws = null;
  try {
    const account = await jsonFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { username: "cancel", password: "secret1" }
    });
    const headers = { Authorization: `Bearer ${account.token}` };
    ws = new WebSocket(bridgeWsUrl(baseUrl, { deviceName: "Mac", engine: "codex" }), wsTokenProtocol(account.token));
    await waitForMessage(ws, (message) => message.type === "bridge_ready");
    const devices = await jsonFetch(baseUrl, "/api/bridge/devices", { headers });

    let receivedRunId = "";
    const receivedRun = waitForMessage(ws, (message) => {
      if (message.type !== "run") return false;
      receivedRunId = message.runId;
      return true;
    });
    const runRequest = jsonFetch(baseUrl, "/api/bridge/run", {
      method: "POST",
      headers,
      body: {
        deviceId: devices.devices[0].id,
        conversationId: account.workspace.activeConversationId,
        text: "取消我"
      }
    }).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error })
    );
    await receivedRun;
    const cancelMessage = waitForMessage(ws, (message) => message.type === "cancel" && message.runId === receivedRunId);
    const cancelled = await jsonFetch(baseUrl, `/api/bridge/runs/${receivedRunId}/cancel`, {
      method: "POST",
      headers,
      body: {}
    });
    assert.equal(cancelled.run.status, "cancelled");
    await cancelMessage;
    const runResult = await runRequest;
    assert.equal(runResult.ok, true);
    assert.equal(runResult.value.cancelled, true);
    assert.equal(runResult.value.run.status, "cancelled");
    assert.match(runResult.value.run.error, /已取消/);
    assert.equal(runResult.value.workspace.activeConversationId, account.workspace.activeConversationId);
  } finally {
    closeWs(ws);
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud marks bridge runs as timed_out when a device never responds", async () => {
  const dataDir = tempDataDir();
  const server = createAimashiCloudServer({ dataDir, bridgeRunTimeoutMs: 20 });
  const baseUrl = await listen(server);
  let ws = null;
  try {
    const account = await jsonFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { username: "timeout", password: "secret1" }
    });
    const headers = { Authorization: `Bearer ${account.token}` };
    ws = new WebSocket(bridgeWsUrl(baseUrl, { deviceName: "Mac", engine: "codex" }), wsTokenProtocol(account.token));
    await waitForMessage(ws, (message) => message.type === "bridge_ready");
    const devices = await jsonFetch(baseUrl, "/api/bridge/devices", { headers });

    const receivedRun = waitForMessage(ws, (message) => message.type === "run");
    const result = await jsonFetch(baseUrl, "/api/bridge/run", {
      method: "POST",
      headers,
      body: {
        deviceId: devices.devices[0].id,
        conversationId: account.workspace.activeConversationId,
        text: "别回复"
      }
    }).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error })
    );
    await receivedRun;
    assert.equal(result.ok, false);
    assert.match(result.error.message, /超时/);
    const runs = await jsonFetch(baseUrl, "/api/bridge/runs", { headers });
    assert.equal(runs.runs[0].status, "timed_out");
    assert.match(runs.runs[0].error, /超时/);
  } finally {
    closeWs(ws);
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
