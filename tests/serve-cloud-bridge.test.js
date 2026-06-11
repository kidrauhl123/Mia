const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const WebSocket = require("ws");

const { createMiaCloudServer } = require("../scripts/serve-cloud");
const { loginCloudUser } = require("./helpers/cloud-auth.js");

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mia-cloud-bridge-"));
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
  return [`mia-token.${token}`];
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

function createAccount(server, name) {
  return loginCloudUser(server.mia.cloudStore, name);
}

function wechatMpSignature(token, timestamp, nonce) {
  return crypto
    .createHash("sha1")
    .update([token, timestamp, nonce].sort().join(""))
    .digest("hex");
}

test("wechat mp event endpoint verifies server token without bearer auth", async () => {
  const dataDir = tempDataDir();
  const token = "MiaCloudMpTestToken";
  const server = createMiaCloudServer({ dataDir, wechatMpToken: token });
  const baseUrl = await listen(server);
  try {
    const timestamp = "1780000000";
    const nonce = "mp_nonce";
    const echostr = "wechat-check-ok";
    const signature = wechatMpSignature(token, timestamp, nonce);
    const ok = await rawFetch(
      baseUrl,
      `/api/auth/wechat/mp/events?signature=${signature}&timestamp=${timestamp}&nonce=${nonce}&echostr=${echostr}`
    );
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), echostr);

    const rejected = await rawFetch(
      baseUrl,
      `/api/auth/wechat/mp/events?signature=bad&timestamp=${timestamp}&nonce=${nonce}&echostr=${echostr}`
    );
    assert.equal(rejected.status, 403);
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("wechat start uses mp scene qr and completes from subscribe event", async () => {
  const dataDir = tempDataDir();
  const mpToken = "MiaCloudMpLoginToken";
  const fetchCalls = [];
  const fetchImpl = async (url, options = {}) => {
    const href = String(url);
    fetchCalls.push({ url: href, options });
    if (href.startsWith("https://api.weixin.qq.com/cgi-bin/token")) {
      return new Response(JSON.stringify({ access_token: "mp_access_token", expires_in: 7200 }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (href.startsWith("https://api.weixin.qq.com/cgi-bin/qrcode/create")) {
      const body = JSON.parse(String(options.body || "{}"));
      return new Response(JSON.stringify({ ticket: `ticket_${body.action_info.scene.scene_str}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ errmsg: `unexpected ${href}` }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  };
  const server = createMiaCloudServer({
    dataDir,
    fetchImpl,
    publicUrl: "https://mia.test",
    wechatMpAppId: "wx_test_app",
    wechatMpAppSecret: "mp_secret",
    wechatMpToken: mpToken
  });
  const baseUrl = await listen(server);
  try {
    const started = await jsonFetch(baseUrl, "/api/auth/wechat/start", {
      method: "POST",
      body: { client: "web" }
    });
    assert.equal(started.mode, "wechat_mp");
    assert.match(started.state, /^wx_/);
    assert.equal(started.authorizationUrl, `https://mia.test/api/auth/wechat/mp/qr?state=${encodeURIComponent(started.state)}`);
    assert.equal(started.qrCodeUrl, `https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=ticket_${encodeURIComponent(started.state)}`);

    const tokenCall = fetchCalls.find((call) => call.url.startsWith("https://api.weixin.qq.com/cgi-bin/token"));
    assert.ok(tokenCall);
    assert.match(tokenCall.url, /appid=wx_test_app/);
    const qrCall = fetchCalls.find((call) => call.url.startsWith("https://api.weixin.qq.com/cgi-bin/qrcode/create"));
    assert.ok(qrCall);
    const qrBody = JSON.parse(String(qrCall.options.body || "{}"));
    assert.equal(qrBody.action_name, "QR_STR_SCENE");
    assert.equal(qrBody.action_info.scene.scene_str, started.state);

    const qrPage = await rawFetch(baseUrl, `/api/auth/wechat/mp/qr?state=${encodeURIComponent(started.state)}`);
    assert.equal(qrPage.status, 200);
    assert.match(await qrPage.text(), /微信扫码登录 Mia/);

    const timestamp = "1780000001";
    const nonce = "mp_scan_nonce";
    const signature = wechatMpSignature(mpToken, timestamp, nonce);
    const xml = `<xml>
<ToUserName><![CDATA[gh_test]]></ToUserName>
<FromUserName><![CDATA[openid_test]]></FromUserName>
<CreateTime>${timestamp}</CreateTime>
<MsgType><![CDATA[event]]></MsgType>
<Event><![CDATA[subscribe]]></Event>
<EventKey><![CDATA[qrscene_${started.state}]]></EventKey>
<Ticket><![CDATA[ticket]]></Ticket>
</xml>`;
    const event = await rawFetch(
      baseUrl,
      `/api/auth/wechat/mp/events?signature=${signature}&timestamp=${timestamp}&nonce=${nonce}`,
      { method: "POST", headers: { "Content-Type": "text/xml" }, body: xml }
    );
    assert.equal(event.status, 200);
    assert.equal(await event.text(), "success");

    const completed = await jsonFetch(baseUrl, "/api/auth/wechat/complete", {
      method: "POST",
      body: { state: started.state }
    });
    assert.equal(completed.ok, true);
    assert.equal(completed.status, "complete");
    assert.ok(completed.token);
    assert.match(completed.user.username, /^wx_[a-f0-9]{12}$/);
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("auth accepts WeChat login through the cloud store", async () => {
  const dataDir = tempDataDir();
  const server = createMiaCloudServer({ dataDir });
  const baseUrl = await listen(server);
  try {
    const profile = { openid: "serve_cloud_bridge_jung", unionid: "serve_cloud_bridge_jung_union", nickname: "Jung" };
    const account = server.mia.cloudStore.loginWithWechat(profile);
    assert.match(account.user.username, /^wx_[a-f0-9]{12}$/);
    assert.ok(account.token);

    const login = server.mia.cloudStore.loginWithWechat(profile);
    assert.equal(login.user.id, account.user.id);
    assert.ok(login.token);
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud logout invalidates bearer sessions", async () => {
  const dataDir = tempDataDir();
  const server = createMiaCloudServer({ dataDir });
  const baseUrl = await listen(server);
  try {
    const account = createAccount(server, "logout");
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
  const server = createMiaCloudServer({
    dataDir,
    allowedOrigins: ["https://mia.gifgif.cn"],
    releaseManifest: {
      product: "Mia Cloud",
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
        Origin: "https://mia.gifgif.cn",
        "X-Forwarded-Proto": "https"
      }
    });
    assert.equal(allowed.status, 200);
    const health = await allowed.json();
    assert.equal(health.service, "mia-cloud");
    assert.deepEqual(health.release, {
      version: "0.1.0",
      builtAt: "2026-05-21T00:00:00.000Z",
      gitCommit: "abc123",
      gitDirty: true,
      fileCount: 2
    });
    assert.ok(health.features.includes("sqlite-store"));
    assert.ok(health.features.includes("bridge-websocket-subprotocol-token"));
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://mia.gifgif.cn");
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
  const server = createMiaCloudServer({
    dataDir,
    allowedOrigins: ["https://mia.gifgif.cn"]
  });
  const baseUrl = await listen(server);
  try {
    const allowed = await rawFetch(baseUrl, "/api/files", {
      method: "OPTIONS",
      headers: {
        Origin: "https://mia.gifgif.cn",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type"
      }
    });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://mia.gifgif.cn");
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
  const server = createMiaCloudServer({ dataDir });
  const baseUrl = await listen(server);
  try {
    const malformed = await rawFetch(baseUrl, "/api/auth/wechat/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{"
    });
    assert.equal(malformed.status, 400);
    assert.match((await malformed.json()).error, /Invalid JSON/);

    const oversized = await rawFetch(baseUrl, "/api/auth/wechat/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client: "test", padding: "x".repeat(28 * 1024 * 1024) })
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
  const server = createMiaCloudServer({ dataDir });
  const baseUrl = await listen(server);
  try {
    const account = createAccount(server, "large-upload");
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
  const server = createMiaCloudServer({ dataDir });
  const baseUrl = await listen(server);
  try {
    const account = createAccount(server, "svg-upload");
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
  const server = createMiaCloudServer({ dataDir });
  const baseUrl = await listen(server);
  try {
    const index = await rawFetch(baseUrl, "/");
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type") || "", /text\/html/);
    assert.match(await index.text(), /<title>Mia — 把一群 AI 当同事用<\/title>/);

    const appShell = await rawFetch(baseUrl, "/app/");
    assert.equal(appShell.status, 200);
    assert.match(appShell.headers.get("content-type") || "", /text\/html/);
    assert.match(await appShell.text(), /<title>Mia Web<\/title>/);

    const app = await rawFetch(baseUrl, "/app.js");
    assert.equal(app.status, 200);
    assert.match(app.headers.get("content-type") || "", /javascript/);

    const shared = await rawFetch(baseUrl, "/shared/engine-contracts.js");
    assert.equal(shared.status, 200);
    assert.match(shared.headers.get("content-type") || "", /javascript/);
    assert.match(await shared.text(), /miaEngineContracts/);

    const messageSource = await rawFetch(baseUrl, "/message-sources/cloud-conversation-source.js");
    assert.equal(messageSource.status, 200);
    assert.match(messageSource.headers.get("content-type") || "", /javascript/);
    assert.match(await messageSource.text(), /miaCloudConversationSource/);

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
    assert.equal(manifestJson.name, "Mia Web");
    assert.equal(manifestJson.display, "standalone");
    assert.deepEqual(manifestJson.icons?.map((icon) => icon.src), ["/icon-192.png", "/icon-512.png", "/favicon.svg"]);

    const badgeManifest = await rawFetch(baseUrl, "/api/status-badge-assets");
    assert.equal(badgeManifest.status, 200);
    assert.match(badgeManifest.headers.get("content-type") || "", /application\/json/);
    const badgeAssets = await badgeManifest.json();
    assert.ok(badgeAssets.assets.some((asset) => asset.assetId === "rainbow" && /\/api\/status-badge-assets\/rainbow\.json$/.test(asset.url)));
    const catAsset = badgeAssets.assets.find((asset) => asset.assetId === "surprised-cat");
    assert.ok(catAsset, "surprised cat TGS badge should be exposed in the public asset manifest");
    assert.equal(catAsset.format, "tgs");
    assert.ok(catAsset.bytes > 0 && catAsset.bytes < 100_000, "TGS asset should stay compressed in the release bundle");
    assert.match(catAsset.url, /\/api\/status-badge-assets\/surprised-cat\.json$/);

    const badgeJson = await rawFetch(baseUrl, "/api/status-badge-assets/rainbow.json");
    assert.equal(badgeJson.status, 200);
    assert.match(badgeJson.headers.get("content-type") || "", /application\/json/);
    assert.match(badgeJson.headers.get("cache-control") || "", /immutable/);
    assert.ok((await badgeJson.json()).v);

    const catJson = await rawFetch(baseUrl, "/api/status-badge-assets/surprised-cat.json");
    assert.equal(catJson.status, 200);
    assert.match(catJson.headers.get("content-type") || "", /application\/json/);
    const catLottie = await catJson.json();
    assert.equal(catLottie.w, 512);
    assert.equal(catLottie.h, 512);
    assert.equal(catLottie.op, 180);

    const badgeTraversal = await rawFetch(baseUrl, "/api/status-badge-assets/..%2Fpackage.json");
    assert.equal(badgeTraversal.status, 404);

    const traversal = await rawFetch(baseUrl, "/%2e%2e/package.json");
    assert.notEqual(traversal.status, 200);
    assert.doesNotMatch(await traversal.text(), /"mia"/);

    const malformed = await rawFetch(baseUrl, "/%E0%A4%A");
    assert.equal(malformed.status, 400);
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud rejects websocket upgrades from disallowed browser origins", async () => {
  const dataDir = tempDataDir();
  const server = createMiaCloudServer({
    dataDir,
    allowedOrigins: ["https://mia.gifgif.cn"]
  });
  const baseUrl = await listen(server);
  let allowedWs = null;
  let rejectedWs = null;
  try {
    const account = createAccount(server, "origin");
    allowedWs = new WebSocket(eventsWsUrl(baseUrl), wsTokenProtocol(account.token), {
      headers: { Origin: "https://mia.gifgif.cn" }
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
  const server = createMiaCloudServer({ dataDir });
  const baseUrl = await listen(server);
  let sameHostWs = null;
  let rejectedWs = null;
  try {
    const account = createAccount(server, "default-origin");
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
  const server = createMiaCloudServer({ dataDir });
  const baseUrl = await listen(server);
  let ws = null;
  try {
    const account = createAccount(server, "protocol");
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
  const server = createMiaCloudServer({ dataDir });
  const baseUrl = await listen(server);
  let eventsWs = null;
  let bridgeWs = null;
  try {
    const account = createAccount(server, "query-token");
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


test("cloud bridge forwards run progress events to authenticated event sockets", async () => {
  const dataDir = tempDataDir();
  const server = createMiaCloudServer({ dataDir });
  const baseUrl = await listen(server);
  let bridgeWs = null;
  let eventsWs = null;
  try {
    const account = createAccount(server, "progress");
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
        conversationId: "conv_test_default",
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

test("cloud bridge run forwards selected runtime config to the desktop device", async () => {
  const dataDir = tempDataDir();
  const server = createMiaCloudServer({ dataDir });
  const baseUrl = await listen(server);
  let bridgeWs = null;
  try {
    const account = createAccount(server, "runtime-forward");
    const headers = { Authorization: `Bearer ${account.token}` };
    bridgeWs = new WebSocket(bridgeWsUrl(baseUrl, {
      deviceName: "Mac",
      engine: "codex",
      capabilities: JSON.stringify({ engines: ["claude-code", "codex"] })
    }), wsTokenProtocol(account.token));
    await waitForMessage(bridgeWs, (message) => message.type === "bridge_ready");
    const devices = await jsonFetch(baseUrl, "/api/bridge/devices", { headers });

    const runMessagePromise = waitForMessage(bridgeWs, (message) => message.type === "run");
    const runRequest = jsonFetch(baseUrl, "/api/bridge/run", {
      method: "POST",
      headers,
      body: {
        deviceId: devices.devices[0].id,
        conversationId: "conv_runtime_forward",
        text: "用 Claude Code 跑",
        runtimeConfig: {
          agentEngine: "claude-code",
          permissionMode: "bypassPermissions",
          model: "sonnet"
        },
        botId: "helper",
        botName: "Helper"
      }
    });
    const runMessage = await runMessagePromise;
    assert.equal(runMessage.agentEngine, "claude-code");
    assert.equal(runMessage.runtimeConfig.agentEngine, "claude-code");
    assert.equal(runMessage.runtimeConfig.permissionMode, "bypassPermissions");
    assert.equal(runMessage.runtimeConfig.model, "sonnet");
    assert.equal(runMessage.botId, "helper");
    assert.equal(runMessage.botName, "Helper");
    assert.equal(runMessage.text, "用 Claude Code 跑");

    bridgeWs.send(JSON.stringify({
      type: "run_result",
      runId: runMessage.runId,
      ok: true,
      text: "完成",
      attachments: []
    }));
    const run = await runRequest;
    assert.equal(run.run.status, "succeeded");
  } finally {
    closeWs(bridgeWs);
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud bridge broadcasts device removal when a desktop disconnects", async () => {
  const dataDir = tempDataDir();
  const server = createMiaCloudServer({ dataDir });
  const baseUrl = await listen(server);
  let bridgeWs = null;
  let eventsWs = null;
  try {
    const account = createAccount(server, "device-removal");
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
  const server = createMiaCloudServer({ dataDir });
  const baseUrl = await listen(server);
  let bridgeWs = null;
  try {
    const account = createAccount(server, "live-devices");
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

test("cloud bridge preserves stable device ids and can list offline history explicitly", async () => {
  const dataDir = tempDataDir();
  const server = createMiaCloudServer({ dataDir });
  const baseUrl = await listen(server);
  let bridgeWs = null;
  try {
    const account = createAccount(server, "stable-device");
    const headers = { Authorization: `Bearer ${account.token}` };
    bridgeWs = new WebSocket(bridgeWsUrl(baseUrl, {
      deviceId: "device_windows_1",
      deviceName: "Windows PC",
      engine: "codex",
      capabilities: JSON.stringify({ engines: ["codex"] })
    }), wsTokenProtocol(account.token));
    const ready = await waitForMessage(bridgeWs, (message) => message.type === "bridge_ready");
    assert.equal(ready.deviceId, "device_windows_1");

    const online = await jsonFetch(baseUrl, "/api/bridge/devices", { headers });
    assert.equal(online.devices.length, 1);
    assert.equal(online.devices[0].id, "device_windows_1");
    assert.equal(online.devices[0].deviceName, "Windows PC");

    bridgeWs.close();
    await waitForWsClose(bridgeWs);
    const defaultList = await jsonFetch(baseUrl, "/api/bridge/devices", { headers });
    assert.equal(defaultList.devices.length, 0);
    const all = await jsonFetch(baseUrl, "/api/bridge/devices?include=all", { headers });
    assert.equal(all.devices.length, 1);
    assert.equal(all.devices[0].id, "device_windows_1");
    assert.equal(all.devices[0].status, "offline");
  } finally {
    closeWs(bridgeWs);
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud bridge stable device reconnect keeps the replacement online", async () => {
  const dataDir = tempDataDir();
  const server = createMiaCloudServer({ dataDir });
  const baseUrl = await listen(server);
  let firstWs = null;
  let secondWs = null;
  try {
    const account = createAccount(server, "stable-reconnect");
    const headers = { Authorization: `Bearer ${account.token}` };
    const params = {
      deviceId: "device_mac_reconnect",
      deviceName: "Mac",
      engine: "codex"
    };
    firstWs = new WebSocket(bridgeWsUrl(baseUrl, params), wsTokenProtocol(account.token));
    await waitForMessage(firstWs, (message) => message.type === "bridge_ready");

    secondWs = new WebSocket(bridgeWsUrl(baseUrl, params), wsTokenProtocol(account.token));
    await waitForMessage(secondWs, (message) => message.type === "bridge_ready");
    await waitForWsClose(firstWs);

    const online = await jsonFetch(baseUrl, "/api/bridge/devices", { headers });
    assert.equal(online.devices.length, 1);
    assert.equal(online.devices[0].id, "device_mac_reconnect");
    assert.equal(online.devices[0].status, "online");
  } finally {
    closeWs(firstWs);
    closeWs(secondWs);
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});



test("cloud bridge requires explicit device selection when multiple devices are online", async () => {
  const dataDir = tempDataDir();
  const server = createMiaCloudServer({ dataDir });
  const baseUrl = await listen(server);
  let wsOne = null;
  let wsTwo = null;
  try {
    const account = createAccount(server, "requires-device");
    const headers = { Authorization: `Bearer ${account.token}` };
    wsOne = new WebSocket(bridgeWsUrl(baseUrl, { deviceName: "Mac One", engine: "codex" }), wsTokenProtocol(account.token));
    wsTwo = new WebSocket(bridgeWsUrl(baseUrl, { deviceName: "Mac Two", engine: "codex" }), wsTokenProtocol(account.token));
    await waitForMessage(wsOne, (message) => message.type === "bridge_ready");
    await waitForMessage(wsTwo, (message) => message.type === "bridge_ready");

    const response = await rawFetch(baseUrl, "/api/bridge/run", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: "conv_test_default",
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
  const server = createMiaCloudServer({ dataDir });
  const baseUrl = await listen(server);
  try {
    const alice = createAccount(server, "alice");
    const bob = createAccount(server, "bob");
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






test("cloud can cancel a pending bridge run", async () => {
  const dataDir = tempDataDir();
  const server = createMiaCloudServer({ dataDir });
  const baseUrl = await listen(server);
  let ws = null;
  try {
    const account = createAccount(server, "cancel");
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
        conversationId: "conv_test_default",
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
    // Phase 4: bridge response no longer carries a workspace snapshot.
  } finally {
    closeWs(ws);
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud marks bridge runs as timed_out when a device never responds", async () => {
  const dataDir = tempDataDir();
  const server = createMiaCloudServer({ dataDir, bridgeRunTimeoutMs: 20 });
  const baseUrl = await listen(server);
  let ws = null;
  try {
    const account = createAccount(server, "timeout");
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
        conversationId: "conv_test_default",
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
