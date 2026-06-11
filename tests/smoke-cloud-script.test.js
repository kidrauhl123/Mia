const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { test } = require("node:test");
const WebSocket = require("ws");

const { createMiaCloudServer } = require("../scripts/serve-cloud");
const { loginCloudUser } = require("./helpers/cloud-auth.js");

const execFile = promisify(childProcess.execFile);

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mia-smoke-script-"));
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
  const server = createMiaCloudServer({
    dataDir,
    releaseManifest: {
      product: "Mia Cloud",
      version: "0.1.0",
      builtAt: "2026-05-21T01:23:45.000Z",
      source: { gitCommit: "smokecommit", gitDirty: false },
      files: { "api/server.js": "hash" }
    }
  });
  const baseUrl = await listen(server);
  let bridgeWs = null;
  try {
    const account = loginCloudUser(server.mia.cloudStore, "smoketest");
    const peer = loginCloudUser(server.mia.cloudStore, "smokepeer");
    const bridgeUrl = new URL("/api/bridge", baseUrl.replace(/^http:/, "ws:"));
    bridgeUrl.searchParams.set("deviceName", "Script Smoke Bridge");
    bridgeUrl.searchParams.set("engine", "codex");
    bridgeUrl.searchParams.set("capabilities", JSON.stringify({ streaming: true, attachments: true }));
    bridgeWs = new WebSocket(bridgeUrl, [`mia-token.${account.token}`], {
      headers: { Origin: baseUrl }
    });
    bridgeWs.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type !== "run") return;
      bridgeWs.send(JSON.stringify({
        type: "run_result",
        runId: message.runId,
        ok: true,
        text: "mia-cloud-bridge-smoke-ok",
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
        MIA_CLOUD_TOKEN: account.token,
        MIA_CLOUD_PEER_TOKEN: peer.token,
        MIA_SMOKE_REQUIRE_BRIDGE: "1",
        MIA_SMOKE_BRIDGE_TIMEOUT_MS: "10000",
        MIA_SMOKE_EXPECT_RELEASE_COMMIT: "smokecommit",
        MIA_SMOKE_EXPECT_RELEASE_BUILT_AT: "2026-05-21T01:23:45.000Z"
      },
      timeout: 15_000
    });
    assert.match(stdout, /OK health - features=\d+ release=smokecommit/);
    assert.match(stdout, /OK security headers - CORS and browser policies/);
    assert.match(stdout, /OK web app - index favicon and manifest served/);
    assert.match(stdout, /OK auth - token smoketest/);
    assert.match(stdout, /OK events websocket query token - rejected/);
    assert.match(stdout, /OK bridge websocket query token - rejected/);
    assert.match(stdout, /OK file auth - anonymous fetch rejected/);
    assert.match(stdout, /OK file ownership - cross-account fetch rejected/);
    assert.match(stdout, /OK file policy - active svg rejected/);
    // (was: OK message validation - blank message rejected. /api/messages
    //  deleted in Phase 4 cutover; blank-message validation now lives in
    //  /api/conversations/:id/messages and is covered by op-idempotency tests.)
    assert.match(stdout, /OK bridge devices - 1 online/);
    assert.match(stdout, /OK bridge run - Script Smoke Bridge -> run_/);
    assert.match(stdout, /OK logout - token invalidated/);
    assert.match(stdout, /OK logout websocket - token rejected/);
    assert.match(stdout, /Mia Cloud smoke passed:/);
  } finally {
    closeWs(bridgeWs);
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud smoke script can verify a standalone token bridge", async () => {
  const dataDir = tempDataDir();
  const server = createMiaCloudServer({
    dataDir,
    releaseManifest: {
      product: "Mia Cloud",
      version: "0.1.0",
      builtAt: "2026-05-21T01:23:45.000Z",
      source: { gitCommit: "smokecommit", gitDirty: false },
      files: { "api/server.js": "hash" }
    }
  });
  const baseUrl = await listen(server);
  let bridge = null;
  try {
    const account = loginCloudUser(server.mia.cloudStore, "accountbridge");
    bridge = childProcess.spawn(process.execPath, [path.join(__dirname, "..", "scripts", "local-agent-bridge.js")], {
      cwd: path.join(__dirname, ".."),
      env: {
        ...process.env,
        MIA_CLOUD_URL: baseUrl,
        MIA_CLOUD_TOKEN: account.token,
        MIA_BRIDGE_ENGINE: "echo",
        MIA_BRIDGE_NAME: "Account Login Bridge",
        MIA_BRIDGE_RECONNECT_MS: "60000"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    await waitForProcessOutput(bridge, /device online: bridge_/);

    const scriptPath = path.join(__dirname, "..", "scripts", "smoke-cloud.js");
    const { stdout } = await execFile(process.execPath, [scriptPath, baseUrl], {
      cwd: path.join(__dirname, ".."),
      env: {
        ...process.env,
        MIA_CLOUD_TOKEN: account.token,
        MIA_SMOKE_REQUIRE_BRIDGE: "1",
        MIA_SMOKE_BRIDGE_TIMEOUT_MS: "10000",
        MIA_SMOKE_EXPECT_RELEASE_COMMIT: "smokecommit",
        MIA_SMOKE_EXPECT_RELEASE_BUILT_AT: "2026-05-21T01:23:45.000Z"
      },
      timeout: 15_000
    });
    assert.match(stdout, /OK auth - token accountbridge/);
    assert.match(stdout, /OK bridge devices - 1 online/);
    assert.match(stdout, /OK bridge run - Account Login Bridge -> run_/);
    assert.match(stdout, /Mia Cloud smoke passed:/);
  } finally {
    if (bridge && !bridge.killed) bridge.kill("SIGTERM");
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud smoke account helper validates a fixed account token without printing secrets", async () => {
  const dataDir = tempDataDir();
  const server = createMiaCloudServer({ dataDir });
  const baseUrl = await listen(server);
  try {
    const account = loginCloudUser(server.mia.cloudStore, "fixedsmoke");
    const env = {
      ...process.env,
      MIA_CLOUD_TOKEN: account.token
    };
    const first = await execFile(process.execPath, [path.join(__dirname, "..", "scripts", "prepare-cloud-smoke-account.js"), baseUrl], {
      cwd: path.join(__dirname, ".."),
      env
    });
    assert.match(first.stdout, /OK smoke account - fixedsmoke/);
    assert.match(first.stdout, /OK bridge devices - 0 online for fixedsmoke/);
    assert.doesNotMatch(first.stdout, new RegExp(account.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const second = await execFile(process.execPath, [path.join(__dirname, "..", "scripts", "prepare-cloud-smoke-account.js"), baseUrl], {
      cwd: path.join(__dirname, ".."),
      env
    });
    assert.match(second.stdout, /OK smoke account - fixedsmoke/);
    assert.doesNotMatch(second.stdout, new RegExp(account.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud smoke account helper rejects an invalid token without printing it", async () => {
  const dataDir = tempDataDir();
  const server = createMiaCloudServer({ dataDir });
  const baseUrl = await listen(server);
  try {
    const badToken = "invalid-smoke-token";
    await assert.rejects(
      execFile(process.execPath, [path.join(__dirname, "..", "scripts", "prepare-cloud-smoke-account.js"), baseUrl], {
        cwd: path.join(__dirname, ".."),
        env: {
          ...process.env,
          MIA_CLOUD_TOKEN: badToken
        }
      }),
      (error) => {
        assert.match(error.stderr, /Smoke account token check failed/);
        assert.doesNotMatch(error.stderr, new RegExp(badToken));
        return true;
      }
    );
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud smoke script requires a cloud token", async () => {
  const dataDir = tempDataDir();
  const server = createMiaCloudServer({
    dataDir,
    releaseManifest: {
      product: "Mia Cloud",
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
          MIA_SMOKE_REQUIRE_BRIDGE: "1",
          MIA_SMOKE_EXPECT_RELEASE_COMMIT: "smokecommit",
          MIA_SMOKE_EXPECT_RELEASE_BUILT_AT: "2026-05-21T01:23:45.000Z"
        },
        timeout: 15_000
      }),
      /MIA_CLOUD_TOKEN is required/
    );
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
