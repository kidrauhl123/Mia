const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createCoreBotExecution,
  coreHermesBaseUrl,
  coreReadHermesApiKey,
  coreReadHermesPort
} = require("../src/core/mia-core.js");
const { createRuntimePaths } = require("../src/main/runtime-paths.js");

// PROOF: in production the daemon env does NOT set MIA_HERMES_BASE_URL /
// MIA_HERMES_API_KEY (the resolver's daemonEnvOverlay omits them), so Core must
// discover the running Hermes engine from the on-disk runtime home it OWNS:
//   - PORT  : <hermesHome>/config.yaml  →  platforms.api_server.port  (default 18642)
//   - apiKey: <hermesHome>/mia-api-server.key  (trimmed; "" if missing)
//   - baseUrl: http://127.0.0.1:<port>
//
// runtime-paths derives hermesHome as path.join(app.getPath("home"), ".hermes")
// (it does NOT read HERMES_HOME). To avoid touching the real <os.homedir>/.hermes,
// the test builds its OWN runtimePaths with app.getPath("home") pointed at a
// temp dir, seeds <tempHome>/.hermes/{config.yaml,mia-api-server.key}, then
// replicates createMiaCore's resolver wiring (env override → else config/key
// discovery) as the FUNCTIONS passed to createCoreBotExecution. A faked fetchImpl
// captures the exact /v1/runs request URL + Authorization header. No network,
// deterministic, temp dirs torn down.

function sseStreamResponse(frames) {
  const text = frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data || {})}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    body: {
      getReader() {
        return {
          read() {
            if (sent) return Promise.resolve({ value: undefined, done: true });
            sent = true;
            return Promise.resolve({ value: bytes, done: false });
          },
          cancel() { return Promise.resolve(); }
        };
      }
    }
  };
}

function jsonResponse(obj) {
  const text = JSON.stringify(obj);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(obj)
  };
}

// runtimePaths rooted at a temp MIA_HOME (data home) with app.getPath("home")
// pointed at a temp dir so hermesHome = <tempHome>/.hermes (never the real ~/.hermes).
function makeRuntimePaths(tempHome) {
  const { runtimePaths } = createRuntimePaths({
    app: { getPath: () => tempHome },
    MIA_GATEWAY_SERVICE_LABEL: "ai.mia.hermes.gateway",
    MIA_DAEMON_SERVICE_LABEL: "ai.mia.daemon",
    env: { MIA_HOME: path.join(tempHome, "engine-home") }
  });
  return runtimePaths;
}

// Replicate the EXACT resolver wiring createMiaCore builds in botExecution():
// env override if set, else config.yaml-derived baseUrl / key-file apiKey,
// passed as FUNCTIONS (re-read each turn). Mirrors src/core/mia-core.js.
function makeResolvers(env, runtimePaths) {
  const envBaseUrl = String(env.MIA_HERMES_BASE_URL || "").trim();
  const envApiKey = String(env.MIA_HERMES_API_KEY || "").trim();
  // Use the REAL exported discovery helpers so this proves the production path,
  // not a reimplementation. Mirrors src/core/mia-core.js botExecution() wiring.
  return {
    baseUrl: () => (envBaseUrl ? envBaseUrl : coreHermesBaseUrl(runtimePaths().hermesHome)),
    apiKey: () => (envApiKey ? envApiKey : coreReadHermesApiKey(runtimePaths().hermesHome))
  };
}

function buildExec({ env, runtimePaths }) {
  let capturedUrl = null;
  let capturedAuth = null;
  const fetchImpl = (url, init = {}) => {
    const u = String(url);
    const headers = (init && init.headers) || {};
    if (u.endsWith("/v1/runs")) {
      capturedUrl = u;
      capturedAuth = headers.Authorization || headers.authorization || null;
      return Promise.resolve(jsonResponse({ run_id: "run_endpoint" }));
    }
    if (/\/v1\/runs\/.+\/events$/.test(u)) {
      return Promise.resolve(sseStreamResponse([{ event: "run.completed", data: { text: "done" } }]));
    }
    return Promise.resolve(jsonResponse({}));
  };
  const { baseUrl, apiKey } = makeResolvers(env, runtimePaths);
  const exec = createCoreBotExecution({
    runtimePaths,
    settingsStore: { daemonSettings: () => ({ enabled: false }) },
    hermesBaseUrl: baseUrl,
    apiKey,
    fetchImpl
  });
  return { exec, getCaptured: () => ({ url: capturedUrl, auth: capturedAuth }) };
}

async function runHermesTurn(exec) {
  return exec.sendChat({
    botKey: "bot1",
    botSnapshot: { key: "bot1", name: "Bot One", agentEngine: "hermes" },
    sessionId: "s1",
    messages: [{ role: "user", content: "hi" }]
  });
}

function seedHermesHome(hermesHome, { port, key }) {
  fs.mkdirSync(hermesHome, { recursive: true });
  fs.writeFileSync(
    path.join(hermesHome, "config.yaml"),
    `platforms:\n  api_server:\n    enabled: true\n    host: 127.0.0.1\n    port: ${port}\n    key: ${key}\n`,
    "utf8"
  );
  fs.writeFileSync(path.join(hermesHome, "mia-api-server.key"), `${key}\n`, "utf8");
}

test("coreReadHermesPort / coreHermesBaseUrl / coreReadHermesApiKey read the on-disk source of truth", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-endpoint-unit-"));
  try {
    const hermesHome = path.join(tempHome, ".hermes");
    // Missing files → defaults.
    assert.equal(coreReadHermesPort(hermesHome), 18642);
    assert.equal(coreHermesBaseUrl(hermesHome), "http://127.0.0.1:18642");
    assert.equal(coreReadHermesApiKey(hermesHome), "");
    // Seeded files → discovered values.
    seedHermesHome(hermesHome, { port: 28642, key: "unit-key-xyz" });
    assert.equal(coreReadHermesPort(hermesHome), 28642);
    assert.equal(coreHermesBaseUrl(hermesHome), "http://127.0.0.1:28642");
    assert.equal(coreReadHermesApiKey(hermesHome), "unit-key-xyz");
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test("Core discovers the Hermes endpoint from <hermesHome>/config.yaml + key file (no env)", async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-endpoint-"));
  try {
    const runtimePaths = makeRuntimePaths(tempHome);
    seedHermesHome(runtimePaths().hermesHome, { port: 28642, key: "seeded-key-abc123" });

    const { exec, getCaptured } = buildExec({ env: {}, runtimePaths });
    const response = await runHermesTurn(exec);
    assert.equal(response.choices[0].message.content, "done");

    const { url, auth } = getCaptured();
    assert.ok(url, "expected the real Hermes adapter to POST a run body");
    assert.ok(
      url.startsWith("http://127.0.0.1:28642/"),
      `expected request to seeded port 28642, got ${url}`
    );
    assert.equal(auth, "Bearer seeded-key-abc123", `expected seeded key in Authorization, got ${auth}`);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test("MIA_HERMES_BASE_URL / MIA_HERMES_API_KEY env override wins over config.yaml", async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-endpoint-env-"));
  try {
    const runtimePaths = makeRuntimePaths(tempHome);
    // Seed a DIFFERENT port/key on disk to prove the env override wins.
    seedHermesHome(runtimePaths().hermesHome, { port: 28642, key: "config-key" });

    const env = {
      MIA_HERMES_BASE_URL: "http://127.0.0.1:39999",
      MIA_HERMES_API_KEY: "env-override-key"
    };
    const { exec, getCaptured } = buildExec({ env, runtimePaths });
    await runHermesTurn(exec);

    const { url, auth } = getCaptured();
    assert.ok(
      url.startsWith("http://127.0.0.1:39999/"),
      `expected env baseUrl 39999, got ${url}`
    );
    assert.equal(auth, "Bearer env-override-key", `expected env key, got ${auth}`);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test("missing config.yaml falls back to default port 18642 and empty key", async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-endpoint-default-"));
  try {
    const runtimePaths = makeRuntimePaths(tempHome);
    // Do NOT seed: <tempHome>/.hermes does not exist → default port + "" key.
    const { exec, getCaptured } = buildExec({ env: {}, runtimePaths });
    await runHermesTurn(exec);

    const { url, auth } = getCaptured();
    assert.ok(url.startsWith("http://127.0.0.1:18642/"), `expected default port 18642, got ${url}`);
    assert.equal(auth, "Bearer ", `expected empty Bearer for missing key, got ${auth}`);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});
