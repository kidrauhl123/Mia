const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { test } = require("node:test");
const WebSocket = require("ws");

const { createAimashiCloudServer } = require("../scripts/serve-cloud");

const execFile = promisify(childProcess.execFile);

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aimashi-smoke-script-"));
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

function closeWs(ws) {
  if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) return;
  try {
    if (ws.readyState === WebSocket.CONNECTING) return;
    ws.close();
  } catch {
    // Cleanup should not hide assertion failures.
  }
}

function waitForProcessOutput(child, pattern, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for process output ${pattern}. Output:\n${output}`));
    }, timeoutMs);
    function onData(chunk) {
      output += String(chunk);
      if (!pattern.test(output)) return;
      cleanup();
      resolve(output);
    }
    function onExit(code, signal) {
      cleanup();
      reject(new Error(`Process exited before ${pattern}: code=${code} signal=${signal}\n${output}`));
    }
    function cleanup() {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
    }
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", onExit);
  });
}

test("cloud smoke script can require and execute a bridge run", async () => {
  const dataDir = tempDataDir();
  const server = createAimashiCloudServer({
    dataDir,
    releaseManifest: {
      product: "Aimashi Cloud",
      version: "0.1.0",
      builtAt: "2026-05-21T01:23:45.000Z",
      source: { gitCommit: "smokecommit", gitDirty: false },
      files: { "api/server.js": "hash" }
    }
  });
  const baseUrl = await listen(server);
  let bridgeWs = null;
  try {
    await jsonFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { username: "smoketest", password: "secret1" }
    });
    const login = await jsonFetch(baseUrl, "/api/auth/login", {
      method: "POST",
      body: { username: "smoketest", password: "secret1" }
    });
    const bridgeUrl = new URL("/api/bridge", baseUrl.replace(/^http:/, "ws:"));
    bridgeUrl.searchParams.set("deviceName", "Script Smoke Bridge");
    bridgeUrl.searchParams.set("engine", "codex");
    bridgeUrl.searchParams.set("capabilities", JSON.stringify({ streaming: true, attachments: true }));
    bridgeWs = new WebSocket(bridgeUrl, [`aimashi-token.${login.token}`], {
      headers: { Origin: baseUrl }
    });
    bridgeWs.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type !== "run") return;
      bridgeWs.send(JSON.stringify({
        type: "run_result",
        runId: message.runId,
        ok: true,
        text: "aimashi-cloud-bridge-smoke-ok",
        attachments: []
      }));
    });
    await waitForMessage(bridgeWs, (message) => message.type === "bridge_ready");

    const scriptPath = path.join(__dirname, "..", "scripts", "smoke-cloud.js");
    const isolatedScriptPath = path.join(dataDir, "smoke-cloud.js");
    fs.copyFileSync(scriptPath, isolatedScriptPath);
    const { stdout } = await execFile(process.execPath, [isolatedScriptPath, baseUrl], {
      cwd: dataDir,
      env: {
        ...process.env,
        AIMASHI_SMOKE_USERNAME: "smoketest",
        AIMASHI_SMOKE_PASSWORD: "secret1",
        AIMASHI_SMOKE_REQUIRE_BRIDGE: "1",
        AIMASHI_SMOKE_BRIDGE_TIMEOUT_MS: "10000",
        AIMASHI_SMOKE_EXPECT_RELEASE_COMMIT: "smokecommit",
        AIMASHI_SMOKE_EXPECT_RELEASE_BUILT_AT: "2026-05-21T01:23:45.000Z"
      },
      timeout: 15_000
    });
    assert.match(stdout, /OK health - features=9 release=smokecommit/);
    assert.match(stdout, /OK security headers - CORS and browser policies/);
    assert.match(stdout, /OK web app - index favicon and manifest served/);
    assert.match(stdout, /OK events websocket query token - rejected/);
    assert.match(stdout, /OK bridge websocket query token - rejected/);
    assert.match(stdout, /OK file auth - anonymous fetch rejected/);
    assert.match(stdout, /OK file ownership - cross-account fetch rejected/);
    assert.match(stdout, /OK file policy - active svg rejected/);
    assert.match(stdout, /OK message validation - blank message rejected/);
    assert.match(stdout, /OK bridge devices - 1 online/);
    assert.match(stdout, /OK bridge run - Script Smoke Bridge -> run_/);
    assert.match(stdout, /OK logout - token invalidated/);
    assert.match(stdout, /OK logout websocket - token rejected/);
    assert.match(stdout, /Aimashi Cloud smoke passed:/);
  } finally {
    closeWs(bridgeWs);
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud smoke script can verify a standalone account-login bridge", async () => {
  const dataDir = tempDataDir();
  const server = createAimashiCloudServer({
    dataDir,
    releaseManifest: {
      product: "Aimashi Cloud",
      version: "0.1.0",
      builtAt: "2026-05-21T01:23:45.000Z",
      source: { gitCommit: "smokecommit", gitDirty: false },
      files: { "api/server.js": "hash" }
    }
  });
  const baseUrl = await listen(server);
  let bridge = null;
  try {
    await jsonFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { username: "accountbridge", password: "secret1" }
    });
    bridge = childProcess.spawn(process.execPath, [path.join(__dirname, "..", "scripts", "local-agent-bridge.js")], {
      cwd: path.join(__dirname, ".."),
      env: {
        ...process.env,
        AIMASHI_CLOUD_URL: baseUrl,
        AIMASHI_CLOUD_USERNAME: "accountbridge",
        AIMASHI_CLOUD_PASSWORD: "secret1",
        AIMASHI_BRIDGE_ENGINE: "echo",
        AIMASHI_BRIDGE_NAME: "Account Login Bridge",
        AIMASHI_BRIDGE_RECONNECT_MS: "60000"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    await waitForProcessOutput(bridge, /device online: bridge_/);

    const scriptPath = path.join(__dirname, "..", "scripts", "smoke-cloud.js");
    const { stdout } = await execFile(process.execPath, [scriptPath, baseUrl], {
      cwd: path.join(__dirname, ".."),
      env: {
        ...process.env,
        AIMASHI_SMOKE_USERNAME: "accountbridge",
        AIMASHI_SMOKE_PASSWORD: "secret1",
        AIMASHI_SMOKE_REQUIRE_BRIDGE: "1",
        AIMASHI_SMOKE_BRIDGE_TIMEOUT_MS: "10000",
        AIMASHI_SMOKE_EXPECT_RELEASE_COMMIT: "smokecommit",
        AIMASHI_SMOKE_EXPECT_RELEASE_BUILT_AT: "2026-05-21T01:23:45.000Z"
      },
      timeout: 15_000
    });
    assert.match(stdout, /OK auth - login accountbridge/);
    assert.match(stdout, /OK bridge devices - 1 online/);
    assert.match(stdout, /OK bridge run - Account Login Bridge -> run_/);
    assert.match(stdout, /Aimashi Cloud smoke passed:/);
  } finally {
    if (bridge && !bridge.killed) bridge.kill("SIGTERM");
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud smoke account helper registers then validates a fixed account without printing secrets", async () => {
  const dataDir = tempDataDir();
  const server = createAimashiCloudServer({ dataDir });
  const baseUrl = await listen(server);
  try {
    const env = {
      ...process.env,
      AIMASHI_SMOKE_USERNAME: "fixedsmoke",
      AIMASHI_SMOKE_PASSWORD: "secret1"
    };
    const first = await execFile(process.execPath, [path.join(__dirname, "..", "scripts", "prepare-cloud-smoke-account.js"), baseUrl], {
      cwd: path.join(__dirname, ".."),
      env
    });
    assert.match(first.stdout, /OK smoke account - register fixedsmoke/);
    assert.match(first.stdout, /OK bridge devices - 0 online for fixedsmoke/);
    assert.doesNotMatch(first.stdout, /secret1|Bearer\s+[A-Za-z0-9._-]{8,}/i);

    const second = await execFile(process.execPath, [path.join(__dirname, "..", "scripts", "prepare-cloud-smoke-account.js"), baseUrl], {
      cwd: path.join(__dirname, ".."),
      env
    });
    assert.match(second.stdout, /OK smoke account - login fixedsmoke/);
    assert.doesNotMatch(second.stdout, /secret1|Bearer\s+[A-Za-z0-9._-]{8,}/i);
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud smoke account helper rejects an existing account with the wrong password", async () => {
  const dataDir = tempDataDir();
  const server = createAimashiCloudServer({ dataDir });
  const baseUrl = await listen(server);
  try {
    await jsonFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { username: "fixedsmoke", password: "secret1" }
    });
    await assert.rejects(
      execFile(process.execPath, [path.join(__dirname, "..", "scripts", "prepare-cloud-smoke-account.js"), baseUrl], {
        cwd: path.join(__dirname, ".."),
        env: {
          ...process.env,
          AIMASHI_SMOKE_USERNAME: "fixedsmoke",
          AIMASHI_SMOKE_PASSWORD: "wrongpass"
        }
      }),
      (error) => {
        assert.match(error.stderr, /already exists but the supplied password did not log in/);
        assert.doesNotMatch(error.stderr, /wrongpass|secret1/);
        return true;
      }
    );
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud smoke script requires a fixed account for bridge smoke", async () => {
  const dataDir = tempDataDir();
  const server = createAimashiCloudServer({
    dataDir,
    releaseManifest: {
      product: "Aimashi Cloud",
      version: "0.1.0",
      builtAt: "2026-05-21T01:23:45.000Z",
      source: { gitCommit: "smokecommit", gitDirty: false },
      files: { "api/server.js": "hash" }
    }
  });
  const baseUrl = await listen(server);
  try {
    const scriptPath = path.join(__dirname, "..", "scripts", "smoke-cloud.js");
    const isolatedScriptPath = path.join(dataDir, "smoke-cloud.js");
    fs.copyFileSync(scriptPath, isolatedScriptPath);
    await assert.rejects(
      execFile(process.execPath, [isolatedScriptPath, baseUrl], {
        cwd: dataDir,
        env: {
          ...process.env,
          AIMASHI_SMOKE_REQUIRE_BRIDGE: "1",
          AIMASHI_SMOKE_EXPECT_RELEASE_COMMIT: "smokecommit",
          AIMASHI_SMOKE_EXPECT_RELEASE_BUILT_AT: "2026-05-21T01:23:45.000Z"
        },
        timeout: 15_000
      }),
      /AIMASHI_SMOKE_USERNAME and AIMASHI_SMOKE_PASSWORD are required/
    );
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
