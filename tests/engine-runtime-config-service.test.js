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
    hermesHome: path.join(dir, ".hermes"),
    apiKey: path.join(dir, ".hermes", "mia-api-server.key"),
    config: path.join(dir, ".hermes", "config.yaml"),
    botManifest: path.join(dir, "engine-home", "bots", "manifest.json"),
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

test("writeRuntimeConfig writes the native Hermes config with auth, model, approvals, effort, and skill dirs", (t) => {
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

  const parsed = yaml.load(fs.readFileSync(runtime.config, "utf8"));
  assert.equal(parsed.model.provider, "openai");
  assert.equal(parsed.model.default, "gpt-5");
  assert.equal(parsed.model.base_url, "https://api.example.test/v1");
  assert.equal(parsed.model.api_mode, "responses");
  assert.equal(parsed.platforms.api_server.port, 19191);
  assert.equal(parsed.platforms.api_server.key, "a".repeat(64));
  assert.equal(parsed.approvals.mode, "ask");
  assert.equal(parsed.agent.reasoning_effort, "high");
  assert.deepEqual(parsed.agent.disabled_toolsets, ["cronjob"]);
  assert.deepEqual(parsed.skills.external_dirs, [path.join(dir, "skills-a")]);
  assert.equal(parsed.mia.runtime_schema, 1);
  assert.equal(parsed.mia.bots_manifest, runtime.botManifest);
  // No scheduler spec supplied → no mcp_servers block.
  assert.equal(parsed.mcp_servers, undefined);
});

test("writeRuntimeConfig preserves user-owned Hermes config while replacing Mia-owned entries", (t) => {
  const { runtime, service } = setup(t);
  fs.mkdirSync(path.dirname(runtime.config), { recursive: true });
  fs.writeFileSync(runtime.config, yaml.dump({
    model: { provider: "anthropic", default: "claude" },
    platforms: {
      telegram: { enabled: true },
      api_server: { host: "0.0.0.0", port: 1234, key: "old" }
    },
    agent: { disabled_toolsets: ["browser"] },
    mcp_servers: { user_server: { command: "uvx", args: ["tool"] } },
    custom_providers: { local: { base_url: "http://localhost:1234" } }
  }));

  service.writeRuntimeConfig(19191);

  const parsed = yaml.load(fs.readFileSync(runtime.config, "utf8"));
  assert.equal(parsed.model.provider, "anthropic");
  assert.equal(parsed.model.default, "claude");
  assert.equal(parsed.platforms.telegram.enabled, true);
  assert.equal(parsed.platforms.api_server.host, "127.0.0.1");
  assert.equal(parsed.platforms.api_server.port, 19191);
  assert.deepEqual(parsed.agent.disabled_toolsets, ["browser", "cronjob"]);
  assert.equal(parsed.mcp_servers.user_server.command, "uvx");
  assert.equal(parsed.custom_providers.local.base_url, "http://localhost:1234");
});

test("writeRuntimeConfig clears stale Mia-owned Hermes model config when Mia has no selected model", (t) => {
  const { runtime, service } = setup(t);
  fs.mkdirSync(path.dirname(runtime.config), { recursive: true });
  fs.writeFileSync(runtime.config, yaml.dump({
    mia: { runtime_schema: 1 },
    model: {
      provider: "openai",
      default: "gpt-x",
      base_url: "https://gui.example/v1"
    },
    providers: {
      openai: {
        name: "OpenAI",
        base_url: "https://gui.example/v1",
        default_model: "gpt-x"
      }
    },
    platforms: { api_server: { port: 1234 } }
  }));

  service.writeRuntimeConfig(19191);

  const parsed = yaml.load(fs.readFileSync(runtime.config, "utf8"));
  assert.equal(parsed.model, undefined);
  assert.equal(parsed.providers?.openai, undefined);
  assert.equal(parsed.platforms.api_server.port, 19191);
  assert.equal(parsed.mia.runtime_schema, 1);
});

test("writeRuntimeConfig can apply per-turn Mia managed model settings", (t) => {
  const { runtime, service } = setup(t);

  service.writeRuntimeConfig(19191, {
    modelSettings: {
      provider: "mia",
      providerConnectionId: "mia",
      providerLabel: "Mia",
      authType: "mia_account",
      model: "mia-deepseek",
      modelProfileId: "mia:mia-deepseek",
      apiKeyEnv: "MIA_CLOUD_MODEL_TOKEN",
      apiKey: "cloud-token",
      baseUrl: "https://mia.example/api/me/model-proxy/v1",
      apiMode: "chat_completions"
    }
  });

  const parsed = yaml.load(fs.readFileSync(runtime.config, "utf8"));
  assert.equal(parsed.model.provider, "mia");
  assert.equal(parsed.model.default, "mia-deepseek");
  assert.equal(parsed.model.base_url, "https://mia.example/api/me/model-proxy/v1");
  assert.equal(parsed.providers.mia.name, "Mia");
  assert.equal(parsed.providers.mia.base_url, "https://mia.example/api/me/model-proxy/v1");
  assert.equal(parsed.providers.mia.key_env, "MIA_CLOUD_MODEL_TOKEN");
  assert.equal(parsed.providers.mia.api_key, "cloud-token");
  assert.equal(parsed.providers.mia.default_model, "mia-deepseek");
  assert.equal(parsed.providers.mia.api_mode, "chat_completions");
});

test("writeRuntimeConfig resolves compact global Mia model settings through Core", (t) => {
  const { runtime, service } = setup(t, {
    resolveModelRuntime: (settings, context) => {
      assert.equal(context.engine, "hermes");
      assert.deepEqual(settings, {
        provider: "mia",
        providerConnectionId: "mia",
        providerLabel: "Mia",
        authType: "mia_account",
        model: "mia-auto",
        modelProfileId: "mia:mia-auto",
        apiKeyEnv: "",
        apiKey: "",
        baseUrl: "",
        apiMode: ""
      });
      return {
        provider: "mia",
        providerConnectionId: "mia",
        providerLabel: "Mia",
        authType: "mia_account",
        model: "mia-auto",
        modelProfileId: "mia:mia-auto",
        apiKeyEnv: "MIA_CLOUD_MODEL_TOKEN",
        apiKey: "cloud-token",
        baseUrl: "https://mia.example/api/me/model-proxy/v1",
        apiMode: "chat_completions",
        managedByMia: true
      };
    }
  });
  fs.mkdirSync(path.dirname(runtime.modelSettings), { recursive: true });
  fs.writeFileSync(runtime.modelSettings, JSON.stringify({
    provider: "mia",
    providerConnectionId: "mia",
    providerLabel: "Mia",
    authType: "mia_account",
    model: "mia-auto",
    modelProfileId: "mia:mia-auto"
  }));

  service.writeRuntimeConfig(19191);

  const parsed = yaml.load(fs.readFileSync(runtime.config, "utf8"));
  assert.equal(parsed.model.provider, "mia");
  assert.equal(parsed.model.default, "mia-auto");
  assert.equal(parsed.model.base_url, "https://mia.example/api/me/model-proxy/v1");
  assert.equal(parsed.providers.mia.name, "Mia");
  assert.equal(parsed.providers.mia.key_env, "MIA_CLOUD_MODEL_TOKEN");
  assert.equal(parsed.providers.mia.api_key, "cloud-token");
  assert.equal(parsed.providers.mia.default_model, "mia-auto");
});

test("writeRuntimeConfig defaults empty global model settings to Mia Auto when Cloud is available", (t) => {
  const { runtime, service } = setup(t, {
    resolveModelRuntime: (settings, context) => {
      assert.equal(context.engine, "hermes");
      assert.deepEqual(settings, {
        provider: "mia",
        providerConnectionId: "mia",
        providerLabel: "Mia",
        authType: "mia_account",
        model: "mia-auto",
        modelProfileId: "mia:mia-auto"
      });
      return {
        provider: "mia",
        providerConnectionId: "mia",
        providerLabel: "Mia",
        authType: "mia_account",
        model: "mia-auto",
        modelProfileId: "mia:mia-auto",
        apiKeyEnv: "MIA_CLOUD_MODEL_TOKEN",
        apiKey: "cloud-token",
        baseUrl: "https://mia.example/api/me/model-proxy/v1",
        apiMode: "chat_completions",
        managedByMia: true
      };
    }
  });

  service.writeRuntimeConfig(19191);

  const parsed = yaml.load(fs.readFileSync(runtime.config, "utf8"));
  assert.equal(parsed.model.provider, "mia");
  assert.equal(parsed.model.default, "mia-auto");
  assert.equal(parsed.providers.mia.key_env, "MIA_CLOUD_MODEL_TOKEN");
  assert.equal(parsed.providers.mia.api_key, "cloud-token");
  assert.equal(parsed.providers.mia.default_model, "mia-auto");
});

test("modelRuntimeEnv exposes resolved Mia Auto token for Hermes spawn", (t) => {
  const { service } = setup(t, {
    resolveModelRuntime: () => ({
      provider: "mia",
      providerConnectionId: "mia",
      authType: "mia_account",
      model: "mia-auto",
      modelProfileId: "mia:mia-auto",
      apiKeyEnv: "MIA_CLOUD_MODEL_TOKEN",
      apiKey: "cloud-token",
      baseUrl: "https://mia.example/api/me/model-proxy/v1",
      apiMode: "chat_completions",
      managedByMia: true
    })
  });

  assert.deepEqual(service.modelRuntimeEnv(), { MIA_CLOUD_MODEL_TOKEN: "cloud-token" });
});

test("writeRuntimeConfig adds the mia-scheduler MCP server when a spec is available", (t) => {
  const { runtime, service } = setup(t, {
    getMiaAppMcpSpec: () => ({
      type: "stdio",
      command: "/usr/local/bin/node",
      args: ["/opt/mia/mia-app-mcp-server.js"],
      env: {
        MIA_DAEMON_URL: "http://127.0.0.1:8765",
        MIA_DAEMON_TOKEN: "tok-123",
        MIA_APP_CONTEXT_FILE: "/tmp/mia-app-ctx.json"
      },
      alwaysLoad: true
    }),
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

  const config = fs.readFileSync(runtime.config, "utf8");
  const parsed = yaml.load(config);
  assert.deepEqual(parsed.mcp_servers["mia-app"], {
    command: "/usr/local/bin/node",
    args: ["/opt/mia/mia-app-mcp-server.js"],
    env: {
      MIA_DAEMON_URL: "http://127.0.0.1:8765",
      MIA_DAEMON_TOKEN: "tok-123",
      MIA_APP_CONTEXT_FILE: "/tmp/mia-app-ctx.json"
    }
  });
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
  assert.ok(!("type" in parsed.mcp_servers["mia-app"]));
  assert.ok(!("alwaysLoad" in parsed.mcp_servers["mia-app"]));
  assert.ok(!("type" in parsed.mcp_servers["mia-scheduler"]));
  assert.ok(!("alwaysLoad" in parsed.mcp_servers["mia-scheduler"]));
});

test("writeRuntimeConfig merges user MCP specs into Hermes config", (t) => {
  const { runtime, service } = setup(t, {
    getUserMcpSpecs: () => ({
      xhs: { type: "http", url: "http://127.0.0.1:18060/mcp", headers: {} }
    })
  });

  service.writeRuntimeConfig(19191);

  const parsed = yaml.load(fs.readFileSync(runtime.config, "utf8"));
  assert.deepEqual(parsed.mcp_servers.xhs, {
    url: "http://127.0.0.1:18060/mcp",
    headers: {}
  });
});

test("writeRuntimeConfig keeps reserved built-in MCP servers when user specs collide", (t) => {
  const { runtime, service } = setup(t, {
    getMiaAppMcpSpec: () => ({
      type: "stdio",
      command: "/usr/local/bin/node",
      args: ["/opt/mia/mia-app-mcp-server.js"],
      env: { MIA_APP_CONTEXT_FILE: "/tmp/mia-app-ctx.json" }
    }),
    getSchedulerMcpSpec: () => ({
      type: "stdio",
      command: "/usr/local/bin/node",
      args: ["/opt/mia/scheduler-mcp-server.js"],
      env: { MIA_SCHEDULER_CONTEXT_FILE: "/tmp/ctx.json" }
    }),
    getUserMcpSpecs: () => ({
      "mia-app": { type: "http", url: "http://127.0.0.1:18061/mcp", headers: { Authorization: "bad" } },
      "mia-scheduler": { type: "http", url: "http://127.0.0.1:18062/mcp", headers: { Authorization: "bad" } },
      xhs: { type: "http", url: "http://127.0.0.1:18060/mcp", headers: {} }
    })
  });

  service.writeRuntimeConfig(19191);

  const parsed = yaml.load(fs.readFileSync(runtime.config, "utf8"));
  assert.equal(parsed.mcp_servers["mia-app"].command, "/usr/local/bin/node");
  assert.equal(parsed.mcp_servers["mia-app"].url, undefined);
  assert.equal(parsed.mcp_servers["mia-scheduler"].command, "/usr/local/bin/node");
  assert.equal(parsed.mcp_servers["mia-scheduler"].url, undefined);
  assert.equal(parsed.mcp_servers.xhs.url, "http://127.0.0.1:18060/mcp");
});

test("readConfiguredPort returns the configured API server port or the Mia default", (t) => {
  const { runtime, service } = setup(t);

  assert.equal(service.readConfiguredPort(), 18642);
  fs.mkdirSync(path.dirname(runtime.config), { recursive: true });
  fs.writeFileSync(runtime.config, [
    "platforms:",
    "  api_server:",
    "    port: 20001"
  ].join("\n"));

  assert.equal(service.readConfiguredPort(), 20001);
});
