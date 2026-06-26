const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const yaml = require("js-yaml");

const { createCoreBotExecution } = require("../src/core/mia-core.js");
const { createRuntimePaths } = require("../src/main/runtime-paths.js");

// PART A proof: a Mia-managed-model bot turn (cloud settings present) →
//   (1) Core resolves the managed provider (the Mia cloud model-proxy), and
//   (2) Core writes the model/provider block into the Hermes config.yaml, and
//   (3) the turn runs (the run payload is built by the real adapter graph).
// We fake only the lowest layer (fetchImpl), so the REAL hermesAdapter.sendChat
// runs the REAL resolveManagedModelRuntime + writeModelRuntimeConfig wired in Core.

function jsonResponse(obj) {
  const text = JSON.stringify(obj);
  return { ok: true, status: 200, statusText: "OK", text: () => Promise.resolve(text), json: () => Promise.resolve(obj) };
}

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

function makeRuntimePaths(home) {
  return createRuntimePaths({
    app: { getPath: () => os.homedir() },
    MIA_GATEWAY_SERVICE_LABEL: "ai.mia.hermes.gateway",
    MIA_DAEMON_SERVICE_LABEL: "ai.mia.daemon",
    env: { MIA_HOME: home }
  }).runtimePaths;
}

function loggedInSettingsStore(home) {
  // Seed the single-owner cloud settings the way settings-store writes them.
  return {
    daemonSettings: () => ({ enabled: false }),
    cloudSettings: () => ({ enabled: true, url: "https://cloud.mia.test", token: "tok-xyz", user: { id: "u1" } }),
    normalizeCloudUrl: (value) => String(value || "").replace(/\/+$/, ""),
    normalizeStoredEffortLevel: (value) => String(value || "").trim()
  };
}

test("PART A: a Mia-managed-model bot turn resolves the managed provider, writes the model block, and runs", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-managed-"));
  try {
    const runtimePaths = makeRuntimePaths(home);
    const hermesHome = runtimePaths().hermesHome;

    // Seed a pre-existing config.yaml with a richer block Core must PRESERVE.
    fs.mkdirSync(hermesHome, { recursive: true });
    fs.writeFileSync(
      path.join(hermesHome, "config.yaml"),
      yaml.dump({
        platforms: { api_server: { enabled: true, host: "127.0.0.1", port: 18642, key: "k" } },
        approvals: { mode: "ask", timeout: 60 },
        agent: { reasoning_effort: "high" },
        mcp_servers: { "mia-app": { command: "node", args: ["x"] } }
      }),
      "utf8"
    );

    let capturedRunBody = null;
    const fetchImpl = (url, init = {}) => {
      const u = String(url);
      if (u.endsWith("/v1/runs")) {
        capturedRunBody = JSON.parse(init.body);
        return Promise.resolve(jsonResponse({ run_id: "run_managed" }));
      }
      if (/\/v1\/runs\/.+\/events$/.test(u)) {
        return Promise.resolve(sseStreamResponse([{ event: "run.completed", data: { text: "done" } }]));
      }
      return Promise.resolve(jsonResponse({}));
    };

    const core = createCoreBotExecution({
      runtimePaths,
      settingsStore: loggedInSettingsStore(home),
      hermesBaseUrl: "http://hermes.local",
      apiKey: "test-key",
      fetchImpl,
      hermesHome: () => hermesHome,
      // Core OWNS the engine (spawned) → the model write must happen.
      engineOwnedByCore: () => true
    });

    const response = await core.sendChat({
      botKey: "botM",
      botSnapshot: {
        key: "botM",
        name: "Managed Bot",
        agentEngine: "hermes",
        engineConfig: { provider: "mia", authType: "mia_account", model: "mia-pro" }
      },
      sessionId: "s1",
      messages: [{ role: "user", content: "hi" }]
    });

    assert.equal(response.choices[0].message.content, "done");
    assert.ok(capturedRunBody, "expected a run body");

    // (2) config.yaml model/provider block written with the managed provider.
    const written = yaml.load(fs.readFileSync(path.join(hermesHome, "config.yaml"), "utf8"));
    assert.equal(written.model.provider, "mia", "model.provider");
    assert.equal(written.model.default, "mia-pro", "model.default");
    assert.equal(written.model.base_url, "https://cloud.mia.test/api/me/model-proxy/v1", "model.base_url");
    assert.equal(written.model.api_mode, "chat_completions", "model.api_mode");
    assert.ok(written.providers && written.providers.mia, "providers.mia present");
    assert.equal(written.providers.mia.base_url, "https://cloud.mia.test/api/me/model-proxy/v1");
    assert.equal(written.providers.mia.key_env, "MIA_CLOUD_MODEL_TOKEN");
    assert.equal(written.providers.mia.api_key, "tok-xyz");
    assert.equal(written.providers.mia.default_model, "mia-pro");

    // PRESERVED keys (read-modify-write, only the model block touched).
    assert.equal(written.platforms.api_server.port, 18642, "api_server preserved");
    assert.equal(written.approvals.mode, "ask", "approvals preserved");
    assert.equal(written.agent.reasoning_effort, "high", "agent preserved");
    assert.ok(written.mcp_servers["mia-app"], "mcp_servers preserved");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("PART A: a profileless mia-auto bot turn is injected as the Mia managed provider", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-mia-auto-"));
  try {
    const runtimePaths = makeRuntimePaths(home);
    const hermesHome = runtimePaths().hermesHome;
    fs.mkdirSync(hermesHome, { recursive: true });
    fs.writeFileSync(
      path.join(hermesHome, "config.yaml"),
      yaml.dump({
        platforms: { api_server: { enabled: true, host: "127.0.0.1", port: 18642, key: "k" } },
        model: { provider: "openai", default: "gpt-x" }
      }),
      "utf8"
    );

    let capturedRunBody = null;
    const fetchImpl = (url, init = {}) => {
      const u = String(url);
      if (u.endsWith("/v1/runs")) {
        capturedRunBody = JSON.parse(init.body);
        return Promise.resolve(jsonResponse({ run_id: "run_auto" }));
      }
      if (/\/v1\/runs\/.+\/events$/.test(u)) {
        return Promise.resolve(sseStreamResponse([{ event: "run.completed", data: { text: "done" } }]));
      }
      return Promise.resolve(jsonResponse({}));
    };

    const core = createCoreBotExecution({
      runtimePaths,
      settingsStore: loggedInSettingsStore(home),
      hermesBaseUrl: "http://hermes.local",
      apiKey: "test-key",
      fetchImpl,
      hermesHome: () => hermesHome,
      engineOwnedByCore: () => true
    });

    await core.sendChat({
      botKey: "botAuto",
      botSnapshot: {
        key: "botAuto",
        name: "Mia Auto Bot",
        agentEngine: "hermes",
        engineConfig: { model: "mia-auto" }
      },
      sessionId: "s1",
      messages: [{ role: "user", content: "hi" }]
    });

    const written = yaml.load(fs.readFileSync(path.join(hermesHome, "config.yaml"), "utf8"));
    assert.equal(written.model.provider, "mia");
    assert.equal(written.model.default, "mia-auto");
    assert.equal(written.providers.mia.base_url, "https://cloud.mia.test/api/me/model-proxy/v1");
    assert.equal(written.providers.mia.api_key, "tok-xyz");
    assert.equal(capturedRunBody.model, "mia-auto");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("PART A: when Core ADOPTED the GUI engine (does not own config), the model block is NOT written", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-adopt-"));
  try {
    const runtimePaths = makeRuntimePaths(home);
    const hermesHome = runtimePaths().hermesHome;
    fs.mkdirSync(hermesHome, { recursive: true });
    const original = yaml.dump({
      platforms: { api_server: { port: 18642 } },
      model: { provider: "openai", default: "gpt-x", base_url: "https://gui.example/v1" }
    });
    fs.writeFileSync(path.join(hermesHome, "config.yaml"), original, "utf8");

    const fetchImpl = (url, init = {}) => {
      const u = String(url);
      if (u.endsWith("/v1/runs")) return Promise.resolve(jsonResponse({ run_id: "run_adopt" }));
      if (/\/v1\/runs\/.+\/events$/.test(u)) {
        return Promise.resolve(sseStreamResponse([{ event: "run.completed", data: { text: "done" } }]));
      }
      return Promise.resolve(jsonResponse({}));
    };

    const core = createCoreBotExecution({
      runtimePaths,
      settingsStore: loggedInSettingsStore(home),
      hermesBaseUrl: "http://hermes.local",
      apiKey: "test-key",
      fetchImpl,
      hermesHome: () => hermesHome,
      // Core ADOPTED the GUI's engine → must NOT fight the GUI's config.
      engineOwnedByCore: () => false
    });

    await core.sendChat({
      botKey: "botM",
      botSnapshot: { key: "botM", agentEngine: "hermes", engineConfig: { provider: "mia", authType: "mia_account", model: "mia-pro" } },
      sessionId: "s1",
      messages: [{ role: "user", content: "hi" }]
    });

    // Untouched: the GUI's model block remains.
    const after = fs.readFileSync(path.join(hermesHome, "config.yaml"), "utf8");
    assert.equal(after, original, "adopted-engine config.yaml must be untouched");
    const parsed = yaml.load(after);
    assert.equal(parsed.model.provider, "openai", "GUI model preserved");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
