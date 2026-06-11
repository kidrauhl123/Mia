#!/usr/bin/env node

const WebSocketClient = globalThis.WebSocket;

const requiredFeatures = [
  "sqlite-store",
  "authenticated-files",
  "events-websocket",
  "bridge-websocket-subprotocol-token",
  "bridge-run-lifecycle",
  "bridge-run-cancel",
  "bridge-run-progress",
  "desktop-sync"
];

function usage() {
  return [
    "Usage: node scripts/smoke-cloud.js <cloud-url>",
    "",
    "Example:",
    "  node scripts/smoke-cloud.js https://mia.gifgif.cn",
    "",
    "Environment:",
    "  MIA_CLOUD_TOKEN=<token>        Required smoke account bearer token from WeChat login.",
    "  MIA_CLOUD_PEER_TOKEN=<token>   Optional second account token for cross-account file checks.",
    "  MIA_SMOKE_REQUIRE_BRIDGE=1     Require an online bridge device and run one request through it.",
    "  MIA_SMOKE_BRIDGE_TIMEOUT_MS=120000  Timeout for the bridge run request.",
    "  MIA_SMOKE_EXPECT_RELEASE_COMMIT=<sha>  Require /api/health.release.gitCommit to match.",
    "  MIA_SMOKE_EXPECT_RELEASE_BUILT_AT=<iso>  Require /api/health.release.builtAt to match."
  ].join("\n");
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error(usage());
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Cloud URL must be http or https.");
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function wsUrl(baseUrl, pathname) {
  const url = new URL(pathname, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function jsonRequest(baseUrl, path, { token = "", method = "GET", body = null, signal = null } = {}) {
  const headers = {
    Origin: baseUrl
  };
  if (body !== null) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
    signal: signal || undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status} ${data.error || ""}`.trim());
  return { response, data };
}

async function expectJsonStatus(baseUrl, path, expectedStatus, { token = "", method = "GET", body = null } = {}) {
  const headers = {
    Origin: baseUrl
  };
  if (body !== null) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (response.status !== expectedStatus) {
    throw new Error(`${method} ${path} expected ${expectedStatus}, got ${response.status} ${data.error || ""}`.trim());
  }
  return { response, data };
}

async function assertWebAppServed(baseUrl) {
  const response = await fetch(`${baseUrl}/app/`, {
    headers: { Origin: baseUrl }
  });
  if (!response.ok) throw new Error(`GET /app/ failed: ${response.status}`);
  const html = await response.text();
  if (!/<title>Mia Web<\/title>/.test(html) || !/src="\.\.\/app\.js/.test(html)) {
    throw new Error("Web app HTML did not look like Mia Web.");
  }
  const favicon = await fetch(`${baseUrl}/favicon.ico`, {
    headers: { Origin: baseUrl }
  });
  if (!favicon.ok) throw new Error(`GET /favicon.ico failed: ${favicon.status}`);
  const contentType = favicon.headers.get("content-type") || "";
  if (!/(image\/svg\+xml|image\/x-icon|image\/vnd\.microsoft\.icon)/.test(contentType)) {
    throw new Error(`GET /favicon.ico returned unexpected content type: ${contentType || "missing"}`);
  }
  const touchIcon = await fetch(`${baseUrl}/apple-touch-icon.png`, {
    headers: { Origin: baseUrl }
  });
  if (!touchIcon.ok) throw new Error(`GET /apple-touch-icon.png failed: ${touchIcon.status}`);
  if (!/image\/png/.test(touchIcon.headers.get("content-type") || "")) {
    throw new Error("GET /apple-touch-icon.png returned unexpected content type.");
  }
  const pwaIcon = await fetch(`${baseUrl}/icon-192.png`, {
    headers: { Origin: baseUrl }
  });
  if (!pwaIcon.ok) throw new Error(`GET /icon-192.png failed: ${pwaIcon.status}`);
  if (!/image\/png/.test(pwaIcon.headers.get("content-type") || "")) {
    throw new Error("GET /icon-192.png returned unexpected content type.");
  }
  const manifest = await fetch(`${baseUrl}/manifest.webmanifest`, {
    headers: { Origin: baseUrl }
  });
  if (!manifest.ok) throw new Error(`GET /manifest.webmanifest failed: ${manifest.status}`);
  const manifestContentType = manifest.headers.get("content-type") || "";
  if (!/application\/manifest\+json/.test(manifestContentType)) {
    throw new Error(`GET /manifest.webmanifest returned unexpected content type: ${manifestContentType || "missing"}`);
  }
  const manifestJson = await manifest.json();
  const iconSources = Array.isArray(manifestJson.icons) ? manifestJson.icons.map((icon) => icon.src) : [];
  if (
    manifestJson.name !== "Mia Web" ||
    manifestJson.display !== "standalone" ||
    !iconSources.includes("/icon-192.png") ||
    !iconSources.includes("/icon-512.png") ||
    !iconSources.includes("/favicon.svg")
  ) {
    throw new Error("Web app manifest did not look installable.");
  }
}

async function assertSecurityPolicy(baseUrl, healthResponse) {
  if ((healthResponse.headers.get("x-content-type-options") || "").toLowerCase() !== "nosniff") {
    throw new Error("Health response is missing X-Content-Type-Options: nosniff.");
  }
  if ((healthResponse.headers.get("referrer-policy") || "").toLowerCase() !== "strict-origin-when-cross-origin") {
    throw new Error("Health response is missing Referrer-Policy: strict-origin-when-cross-origin.");
  }
  if (!/camera=\(\), microphone=\(\), geolocation=\(\)/.test(healthResponse.headers.get("permissions-policy") || "")) {
    throw new Error("Health response is missing the expected Permissions-Policy.");
  }
  if ((healthResponse.headers.get("cross-origin-resource-policy") || "").toLowerCase() !== "same-origin") {
    throw new Error("Health response is missing Cross-Origin-Resource-Policy: same-origin.");
  }
  if (new URL(baseUrl).protocol === "https:" && !/max-age=31536000/.test(healthResponse.headers.get("strict-transport-security") || "")) {
    throw new Error("HTTPS health response is missing Strict-Transport-Security with max-age=31536000.");
  }
  if (healthResponse.headers.get("access-control-allow-origin") !== baseUrl) {
    throw new Error("Health response did not allow the public same-origin CORS origin.");
  }

  const rejected = await fetch(`${baseUrl}/api/health`, {
    headers: { Origin: "https://evil.example" }
  });
  if (!rejected.ok) throw new Error(`Foreign-origin health check failed unexpectedly: ${rejected.status}`);
  if (rejected.headers.get("access-control-allow-origin")) {
    throw new Error("Foreign Origin unexpectedly received Access-Control-Allow-Origin.");
  }

  const preflight = await fetch(`${baseUrl}/api/files`, {
    method: "OPTIONS",
    headers: {
      Origin: baseUrl,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, content-type"
    }
  });
  if (preflight.status !== 204) throw new Error(`Allowed CORS preflight returned ${preflight.status}.`);
  if (preflight.headers.get("access-control-allow-origin") !== baseUrl) {
    throw new Error("Allowed CORS preflight did not return Access-Control-Allow-Origin.");
  }
  if (!/authorization, content-type/i.test(preflight.headers.get("access-control-allow-headers") || "")) {
    throw new Error("Allowed CORS preflight did not allow authorization/content-type headers.");
  }

  const rejectedPreflight = await fetch(`${baseUrl}/api/files`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://evil.example",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, content-type"
    }
  });
  if (rejectedPreflight.status !== 204) throw new Error(`Foreign-origin CORS preflight returned ${rejectedPreflight.status}.`);
  if (rejectedPreflight.headers.get("access-control-allow-origin")) {
    throw new Error("Foreign-origin CORS preflight unexpectedly received Access-Control-Allow-Origin.");
  }
}

function timeoutSignal(timeoutMs) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs).unref?.();
  return controller.signal;
}

async function expectWebSocketMessage(url, protocols, predicate, timeoutMs = 5000) {
  if (typeof WebSocketClient !== "function") throw new Error("This smoke script requires a Node.js runtime with global WebSocket support.");
  const ws = new WebSocketClient(url, protocols);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error(`Timed out waiting for ${url}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener?.("message", onMessage);
      ws.removeEventListener?.("error", onError);
      ws.removeEventListener?.("close", onClose);
    };
    const onMessage = (event) => {
      const message = JSON.parse(String(event.data ?? ""));
      if (!predicate(message)) return;
      cleanup();
      ws.close();
      resolve(message);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = (event) => {
      cleanup();
      reject(new Error(`WebSocket closed before expected message: ${event.code || "unknown"}`));
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
  });
}

async function expectWebSocketRejected(url, protocols = [], timeoutMs = 5000) {
  if (typeof WebSocketClient !== "function") throw new Error("This smoke script requires a Node.js runtime with global WebSocket support.");
  if (typeof protocols === "number") {
    timeoutMs = protocols;
    protocols = [];
  }
  const ws = Array.isArray(protocols) && protocols.length
    ? new WebSocketClient(url, protocols)
    : new WebSocketClient(url);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error(`WebSocket unexpectedly stayed open: ${url}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener?.("open", onOpen);
      ws.removeEventListener?.("message", onMessage);
      ws.removeEventListener?.("error", onRejected);
      ws.removeEventListener?.("close", onRejected);
    };
    const onOpen = () => {
      cleanup();
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error(`WebSocket unexpectedly accepted URL token auth: ${url}`));
    };
    const onMessage = () => {
      cleanup();
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error(`WebSocket unexpectedly sent data after URL token auth: ${url}`));
    };
    const onRejected = () => {
      cleanup();
      resolve();
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onRejected);
    ws.addEventListener("close", onRejected);
  });
}

async function main() {
  const baseUrl = normalizeBaseUrl(process.argv[2] || process.env.MIA_CLOUD_URL || "");
  const checks = [];
  const pass = (name, detail = "") => checks.push({ ok: true, name, detail });

  const health = await jsonRequest(baseUrl, "/api/health");
  if (health.data.service !== "mia-cloud") throw new Error("Health endpoint is not Mia Cloud.");
  for (const feature of requiredFeatures) {
    if (!Array.isArray(health.data.features) || !health.data.features.includes(feature)) {
      throw new Error(`Cloud is missing required feature: ${feature}`);
    }
  }
  const release = health.data.release;
  const expectedReleaseCommit = String(process.env.MIA_SMOKE_EXPECT_RELEASE_COMMIT || "").trim();
  const expectedReleaseBuiltAt = String(process.env.MIA_SMOKE_EXPECT_RELEASE_BUILT_AT || "").trim();
  if ((expectedReleaseCommit || expectedReleaseBuiltAt) && (!release || typeof release !== "object")) {
    throw new Error("Cloud health is missing release metadata.");
  }
  if (expectedReleaseCommit && release.gitCommit !== expectedReleaseCommit) {
    throw new Error(`Cloud release commit mismatch: expected ${expectedReleaseCommit}, got ${release.gitCommit || "missing"}`);
  }
  if (expectedReleaseBuiltAt && release.builtAt !== expectedReleaseBuiltAt) {
    throw new Error(`Cloud release builtAt mismatch: expected ${expectedReleaseBuiltAt}, got ${release.builtAt || "missing"}`);
  }
  const releaseDetail = release?.gitCommit ? ` release=${release.gitCommit}${release.gitDirty ? "+dirty" : ""}` : "";
  pass("health", `features=${health.data.features.length}${releaseDetail}`);
  await assertSecurityPolicy(baseUrl, health.response);
  pass("security headers", "CORS and browser policies");

  await assertWebAppServed(baseUrl);
  pass("web app", "index favicon and manifest served");

  const token = String(process.env.MIA_CLOUD_TOKEN || "").trim();
  if (!token) throw new Error("MIA_CLOUD_TOKEN is required.");
  const account = await jsonRequest(baseUrl, "/api/me", { token });
  const userLabel = account.data.user?.displayName || account.data.user?.username || account.data.user?.id || "wechat-user";
  pass("auth", `token ${userLabel}`);

  await expectWebSocketMessage(
    wsUrl(baseUrl, "/api/events"),
    [`mia-token.${token}`],
    (message) => message.type === "events_ready"
  );
  pass("events websocket", "subprotocol token accepted");
  const queryTokenEventsUrl = new URL(wsUrl(baseUrl, "/api/events"));
  queryTokenEventsUrl.searchParams.set("token", token);
  await expectWebSocketRejected(queryTokenEventsUrl.toString());
  pass("events websocket query token", "rejected");
  const queryTokenBridgeUrl = new URL(wsUrl(baseUrl, "/api/bridge"));
  queryTokenBridgeUrl.searchParams.set("token", token);
  queryTokenBridgeUrl.searchParams.set("deviceName", "Smoke URL Token Bridge");
  queryTokenBridgeUrl.searchParams.set("engine", "codex");
  await expectWebSocketRejected(queryTokenBridgeUrl.toString());
  pass("bridge websocket query token", "rejected");

  const pngDataUrl = `data:image/png;base64,${Buffer.from("smoke-png").toString("base64")}`;
  const uploaded = await jsonRequest(baseUrl, "/api/files", {
    token,
    method: "POST",
    body: { name: "smoke.png", dataUrl: pngDataUrl }
  });
  const fileUrl = uploaded.data.file?.url;
  if (!/^\/api\/files\/file_/.test(fileUrl || "")) throw new Error("File upload did not return an authenticated file URL.");
  const fileResponse = await fetch(`${baseUrl}${fileUrl}`, {
    headers: { Authorization: `Bearer ${token}`, Origin: baseUrl }
  });
  if (!fileResponse.ok) throw new Error(`Authenticated file fetch failed: ${fileResponse.status}`);
  pass("files", fileUrl);
  await expectJsonStatus(baseUrl, fileUrl, 401);
  pass("file auth", "anonymous fetch rejected");
  const peerToken = String(process.env.MIA_CLOUD_PEER_TOKEN || "").trim();
  if (peerToken) {
    await expectJsonStatus(baseUrl, fileUrl, 404, { token: peerToken });
    pass("file ownership", "cross-account fetch rejected");
  } else {
    pass("file ownership", "skipped without MIA_CLOUD_PEER_TOKEN");
  }

  await expectJsonStatus(baseUrl, "/api/files", 400, {
    token,
    method: "POST",
    body: {
      name: "active.svg",
      dataUrl: `data:image/svg+xml;base64,${Buffer.from("<svg><script>alert(1)</script></svg>").toString("base64")}`
    }
  });
  pass("file policy", "active svg rejected");

  // (was: POST /api/messages blank-text rejection. Endpoint deleted in
  //  Phase 4 cutover — message validation lives at POST /api/conversations/:id/
  //  messages now, and is covered by the conversation-message integration tests.)

  const devices = await jsonRequest(baseUrl, "/api/bridge/devices", { token });
  if (process.env.MIA_SMOKE_REQUIRE_BRIDGE === "1" && !devices.data.devices?.length) {
    throw new Error("No online bridge devices found.");
  }
  pass("bridge devices", `${devices.data.devices?.length || 0} online`);

  if (process.env.MIA_SMOKE_REQUIRE_BRIDGE === "1") {
    const device = devices.data.devices[0];
    const timeoutMs = Number(process.env.MIA_SMOKE_BRIDGE_TIMEOUT_MS || 120_000);
    const run = await jsonRequest(baseUrl, "/api/bridge/run", {
      token,
      method: "POST",
      signal: timeoutSignal(timeoutMs),
      body: {
        deviceId: device.id,
        conversationId: "conv_mia",
        text: "Mia Cloud smoke: reply with mia-cloud-bridge-smoke-ok"
      }
    });
    if (run.data.run?.status !== "succeeded") throw new Error(`Bridge run did not succeed: ${run.data.run?.status || "missing status"}`);
    const bridgeText = String(run.data.message?.text || run.data.run?.resultText || "");
    if (!bridgeText.trim()) throw new Error("Bridge run returned an empty assistant response.");
    if (!bridgeText.includes("mia-cloud-bridge-smoke-ok")) {
      throw new Error("Bridge run response did not include mia-cloud-bridge-smoke-ok.");
    }
    pass("bridge run", `${device.deviceName || device.id} -> ${run.data.run.id}`);
  }

  await jsonRequest(baseUrl, "/api/auth/logout", {
    token,
    method: "POST",
    body: {}
  });
  await expectJsonStatus(baseUrl, "/api/me", 401, { token });
  pass("logout", "token invalidated");
  await expectWebSocketRejected(wsUrl(baseUrl, "/api/events"), [`mia-token.${token}`]);
  pass("logout websocket", "token rejected");

  for (const check of checks) {
    console.log(`OK ${check.name}${check.detail ? ` - ${check.detail}` : ""}`);
  }
  console.log(`Mia Cloud smoke passed: ${baseUrl}`);
}

main().catch((error) => {
  console.error(`Mia Cloud smoke failed: ${error.message || error}`);
  process.exitCode = 1;
});
