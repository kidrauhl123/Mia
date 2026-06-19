const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createAuthService } = require("../src/main/auth-service.js");

function jsonResponse(body, ok = true, status = 200, statusText = "OK") {
  return { ok, status, statusText, json: async () => body };
}

function createHarness(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-auth-service-"));
  const paths = {
    authJson: path.join(dir, "auth.json"),
    engine: path.join(dir, "engine"),
    home: path.join(dir, "home"),
    hermesHome: path.join(dir, ".hermes")
  };
  const calls = {
    fetch: [],
    opened: [],
    providerSaves: [],
    codexApplied: 0,
    restarted: 0,
    spawned: [],
    spawnedProcesses: []
  };
  fs.mkdirSync(paths.engine, { recursive: true });
  fs.mkdirSync(paths.home, { recursive: true });
  const service = createAuthService({
    runtimePaths: () => paths,
    readJson: (filePath, fallback) => {
      try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch {
        return fallback;
      }
    },
    fetchImpl: async (url, options) => {
      calls.fetch.push({ url, options });
      if (String(url).includes("/deviceauth/usercode")) {
        return jsonResponse({ user_code: "ABCD-1234", device_auth_id: "device-1", interval: 0 });
      }
      if (String(url).includes("/deviceauth/token")) {
        return jsonResponse({ authorization_code: "auth-code", code_verifier: "verifier" });
      }
      if (String(url).includes("/oauth/token")) {
        return jsonResponse({ access_token: "access-token", refresh_token: "refresh-token" });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    spawnProcess: (...args) => {
      calls.spawned.push(args);
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = (signal) => {
        proc.killedWith = signal;
      };
      calls.spawnedProcesses.push(proc);
      return proc;
    },
    shellOpenExternal: async (url) => {
      calls.opened.push(url);
    },
    initializeRuntime: () => {},
    isEngineInstalled: () => true,
    getRuntimeStatus: () => ({ runtime: true }),
    enginePython: () => "/python",
    effectiveHermesHome: () => paths.hermesHome,
    buildPythonPath: () => "/pythonpath",
    applyCodexModelSettings: () => {
      calls.codexApplied += 1;
    },
    saveProviderConnection: (connection) => {
      calls.providerSaves.push(connection);
    },
    restartEngineIfRunning: async () => {
      calls.restarted += 1;
    },
    sleep: async () => {},
    nowIso: () => "2026-05-25T00:00:00.000Z",
    nowMs: (() => {
      let value = 0;
      return () => {
        value += 1;
        return value;
      };
    })(),
    ...overrides
  });
  return { calls, paths, service };
}

test("status reads codex auth tokens and credential pools", () => {
  const { paths, service } = createHarness();
  fs.writeFileSync(paths.authJson, JSON.stringify({
    providers: { "openai-codex": { tokens: { access_token: "access" } } },
    credential_pool: {}
  }));

  const status = service.status();

  assert.equal(status.codexLoggedIn, true);
  assert.equal(status.codexAuthPath, paths.authJson);
});

test("appendLog redacts token values and captures device code hints", () => {
  const { service } = createHarness();

  service.appendLog("Open https://auth.example/device and access_token: abc123");
  service.appendLog("Enter ABCD-123456");

  const status = service.status();
  assert.equal(status.codexVerificationUrl, "https://auth.example/device");
  assert.equal(status.codexUserCode, "ABCD-123456");
  assert.match(status.codexLogs.join("\n"), /access_token=\[REDACTED\]/);
});

test("startCodexOAuth completes device auth in the background and persists tokens", async () => {
  const { calls, paths, service } = createHarness();

  const started = await service.startCodexOAuth();
  await service.waitForIdle();

  const auth = JSON.parse(fs.readFileSync(paths.authJson, "utf8"));
  assert.deepEqual(started, { runtime: true });
  assert.equal(calls.opened[0], "https://auth.openai.com/codex/device");
  assert.equal(auth.active_provider, "openai-codex");
  assert.equal(auth.providers["openai-codex"].tokens.access_token, "access-token");
  assert.equal(auth.providers["openai-codex"].tokens.refresh_token, "refresh-token");
  assert.equal(calls.codexApplied, 1);
  assert.equal(calls.restarted, 1);
  assert.equal(service.status().codexStarting, false);
});

test("startProviderOAuth spawns hermes auth and saves provider on success", async () => {
  const { calls, paths, service } = createHarness();

  await service.startProviderOAuth({
    provider: "anthropic",
    providerLabel: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    apiMode: "messages"
  });

  assert.equal(calls.spawned[0][0], "/python");
  assert.deepEqual(calls.spawned[0][1], ["-m", "hermes_cli.main", "auth", "add", "anthropic", "--type", "oauth"]);
  assert.equal(calls.spawned[0][2].env.HERMES_HOME, paths.hermesHome);
  assert.equal(calls.spawned[0][2].env.MIA_HOME, paths.home);
  assert.notEqual(calls.spawned[0][2].env.HERMES_HOME, calls.spawned[0][2].env.MIA_HOME);

  calls.spawnedProcesses[0].stdout.emit("data", "Open https://auth.anthropic.example\n");
  calls.spawnedProcesses[0].emit("exit", 0, null);
  await service.waitForIdle();

  assert.deepEqual(calls.providerSaves, [{
    provider: "anthropic",
    providerLabel: "Anthropic",
    authType: "oauth_external",
    apiKeyEnv: "",
    apiKey: "",
    baseUrl: "https://api.anthropic.com",
    apiMode: "messages"
  }]);
  assert.equal(calls.restarted, 1);
  assert.equal(service.status().oauthProvider, "");
});
