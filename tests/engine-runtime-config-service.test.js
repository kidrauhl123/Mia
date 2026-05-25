const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const yaml = require("js-yaml");

const { createEngineRuntimeConfigService } = require("../src/main/engine-runtime-config-service.js");

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-engine-runtime-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = {
    home: path.join(dir, "engine-home"),
    apiKey: path.join(dir, "engine-home", "api-server.key"),
    modelSettings: path.join(dir, "engine-home", "mia-model.json")
  };
  const service = createEngineRuntimeConfigService({
    runtimePaths: () => runtime,
    readJson,
    randomBytes: () => Buffer.from("a".repeat(64), "hex"),
    defaultModelSettings: () => ({
      provider: "",
      model: "",
      apiKeyEnv: "",
      apiKey: "",
      baseUrl: "",
      apiMode: ""
    }),
    permissionSettings: () => ({ mode: "ask" }),
    effortSettings: () => ({ level: "high" }),
    engineSource: () => "managed",
    ...overrides
  });
  return { dir, runtime, service };
}

test("apiKey creates a private key once and then reuses it", (t) => {
  const { runtime, service } = setup(t);

  assert.equal(service.apiKey(), "a".repeat(64));
  assert.equal(fs.statSync(runtime.apiKey).mode & 0o777, 0o600);
  fs.writeFileSync(runtime.apiKey, "existing\n");
  assert.equal(service.apiKey(), "existing");
});

test("modelSettings returns defaults until model, provider, or api key is configured", (t) => {
  const { runtime, service } = setup(t);

  assert.deepEqual(service.modelSettings(), {
    provider: "",
    model: "",
    apiKeyEnv: "",
    apiKey: "",
    baseUrl: "",
    apiMode: ""
  });

  fs.mkdirSync(path.dirname(runtime.modelSettings), { recursive: true });
  fs.writeFileSync(runtime.modelSettings, JSON.stringify({ provider: "openai", model: "gpt-5" }));

  assert.deepEqual(service.modelSettings(), {
    provider: "openai",
    model: "gpt-5",
    apiKeyEnv: "",
    apiKey: "",
    baseUrl: "",
    apiMode: ""
  });
});

test("writeRuntimeConfig writes the private Hermes config with auth, model, approvals, effort, and skill dirs", (t) => {
  const { dir, runtime, service } = setup(t, {
    externalSkillDirs: () => [
      path.join(dir, "skills-a"),
      path.join(dir, "missing"),
      path.join(dir, "skills-a")
    ]
  });
  fs.mkdirSync(path.join(dir, "skills-a"), { recursive: true });
  fs.mkdirSync(path.dirname(runtime.modelSettings), { recursive: true });
  fs.writeFileSync(runtime.modelSettings, JSON.stringify({
    provider: "openai",
    model: "gpt-5",
    apiKeyEnv: "OPENAI_API_KEY",
    apiKey: "secret",
    baseUrl: "https://api.example.test/v1",
    apiMode: "responses"
  }));

  service.writeRuntimeConfig(19191);

  const config = fs.readFileSync(path.join(runtime.home, "config.yaml"), "utf8");
  assert.match(config, /provider: "openai"/);
  assert.match(config, /default: "gpt-5"/);
  assert.match(config, /base_url: "https:\/\/api\.example\.test\/v1"/);
  assert.match(config, /api_mode: "responses"/);
  assert.match(config, /port: 19191/);
  assert.match(config, new RegExp(`key: ${"a".repeat(64)}`));
  assert.match(config, /approvals:\n  mode: "ask"/);
  assert.match(config, /agent:\n  reasoning_effort: "high"\n  disabled_toolsets:\n    - cronjob/);
  assert.match(config, /skills:\n  external_dirs:\n/);
  assert.equal((config.match(/skills-a/g) || []).length, 1);
  assert.match(config, /mia:\n  runtime_schema: 1\n  fellows_manifest: fellows\/manifest\.json/);
  // No scheduler spec supplied → no mcp_servers block.
  assert.ok(!/mcp_servers:/.test(config));
});

test("writeRuntimeConfig adds the mia-scheduler MCP server when a spec is available", (t) => {
  const { runtime, service } = setup(t, {
    getSchedulerMcpSpec: () => ({
      type: "stdio",
      command: "/usr/local/bin/node",
      args: ["/opt/mia/scheduler-mcp-server.js"],
      env: {
        MIA_DAEMON_URL: "http://127.0.0.1:8765",
        MIA_DAEMON_TOKEN: "tok-123",
        MIA_SCHEDULER_CONTEXT_FILE: "/tmp/ctx.json"
      },
      alwaysLoad: true
    })
  });

  service.writeRuntimeConfig(19191);

  const config = fs.readFileSync(path.join(runtime.home, "config.yaml"), "utf8");
  const parsed = yaml.load(config);
  assert.deepEqual(parsed.mcp_servers["mia-scheduler"], {
    command: "/usr/local/bin/node",
    args: ["/opt/mia/scheduler-mcp-server.js"],
    env: {
      MIA_DAEMON_URL: "http://127.0.0.1:8765",
      MIA_DAEMON_TOKEN: "tok-123",
      MIA_SCHEDULER_CONTEXT_FILE: "/tmp/ctx.json"
    }
  });
  // The SDK-only keys are not carried into the Hermes config.
  assert.ok(!("type" in parsed.mcp_servers["mia-scheduler"]));
  assert.ok(!("alwaysLoad" in parsed.mcp_servers["mia-scheduler"]));
});

test("readConfiguredPort returns the configured API server port or the Mia default", (t) => {
  const { runtime, service } = setup(t);

  assert.equal(service.readConfiguredPort(), 18642);
  fs.mkdirSync(runtime.home, { recursive: true });
  fs.writeFileSync(path.join(runtime.home, "config.yaml"), [
    "platforms:",
    "  api_server:",
    "    port: 20001"
  ].join("\n"));

  assert.equal(service.readConfiguredPort(), 20001);
});
