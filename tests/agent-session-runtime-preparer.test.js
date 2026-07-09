const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const yaml = require("js-yaml");

const {
  createAgentSessionRuntimePreparer
} = require("../src/main/agent-session-runtime-preparer.js");

test("prepares Claude Code Mia managed model proxy env for AgentSession", async () => {
  const proxyCalls = [];
  const managedModel = {
    provider: "mia",
    providerConnectionId: "mia",
    modelProfileId: "mia:mia-auto",
    model: "mia-auto",
    baseUrl: "https://mia.example/api/me/model-proxy/v1",
    apiKey: "cloud-token",
    managedByMia: true
  };
  const preparer = createAgentSessionRuntimePreparer({
    resolveManagedModelRuntime: (runtimeConfig, context) => {
      assert.deepEqual(context, { engine: "claude-code" });
      assert.equal(runtimeConfig.modelProfileId, "mia:mia-auto");
      return managedModel;
    },
    claudeCodeMiaProxy: {
      createSession: async (runtime) => {
        proxyCalls.push(runtime);
        return {
          baseUrl: "http://127.0.0.1:4321",
          authToken: "proxy-token",
          model: "mia-auto"
        };
      }
    }
  });

  const runtime = await preparer.prepare({
    engineId: "claude",
    runtimeConfig: {
      agentEngine: "claude-code",
      providerConnectionId: "mia",
      modelProfileId: "mia:mia-auto",
      model: "mia-auto"
    }
  });

  assert.equal(proxyCalls.length, 1);
  assert.equal(proxyCalls[0], managedModel);
  assert.equal(runtime.runtimeKey, "mia:mia-auto");
  assert.equal(runtime.skillDeliveryMode, "native-link");
  assert.match(runtime.skillFingerprint, /^[a-f0-9]{16}$/);
  assert.deepEqual(runtime.env, {
    ANTHROPIC_BASE_URL: "http://127.0.0.1:4321",
    ANTHROPIC_AUTH_TOKEN: "proxy-token"
  });
});

test("does not prepare proxy env for native Claude Code runtime", async () => {
  const preparer = createAgentSessionRuntimePreparer({
    resolveManagedModelRuntime: () => null,
    claudeCodeMiaProxy: {
      createSession: async () => {
        throw new Error("proxy should not start");
      }
    }
  });

  const runtime = await preparer.prepare({
    engineId: "claude",
    runtimeConfig: {
      agentEngine: "claude-code",
      providerConnectionId: "claude-code",
      modelProfileId: "claude-code:sonnet",
      model: "sonnet"
    }
  });

  assert.equal(runtime.skillDeliveryMode, "native-link");
  assert.match(runtime.skillFingerprint, /^[a-f0-9]{16}$/);
  assert.equal(runtime.runtimeKey, undefined);
  assert.equal(runtime.env, undefined);
});

test("prepares Codex Mia managed model proxy env for AgentSession", async (t) => {
  const catalogDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-codex-catalog-"));
  t.after(() => fs.rmSync(catalogDir, { recursive: true, force: true }));
  const catalogPath = path.join(catalogDir, "models.json");
  const launcherPath = path.join(catalogDir, process.platform === "win32" ? "codex-launcher.cmd" : "codex-launcher.sh");
  const proxyCalls = [];
  const managedModel = {
    provider: "mia",
    providerConnectionId: "mia",
    modelProfileId: "mia:mia-auto",
    model: "mia-auto",
    baseUrl: "https://mia.example/api/me/model-proxy/v1",
    apiKey: "cloud-token",
    managedByMia: true
  };
  const preparer = createAgentSessionRuntimePreparer({
    resolveManagedModelRuntime: (runtimeConfig, context) => {
      assert.deepEqual(context, { engine: "codex" });
      assert.equal(runtimeConfig.modelProfileId, "mia:mia-auto");
      return managedModel;
    },
    codexMiaProxy: {
      createSession: async (runtime) => {
        proxyCalls.push(runtime);
        return {
          baseUrl: "http://127.0.0.1:7654/v1",
          apiKey: "mia-codex-session-token",
          model: "mia-auto"
        };
      }
    },
    codexModelCatalogPath: catalogPath,
    codexLauncherPath: launcherPath,
    codexRealPath: "/usr/local/bin/codex-real"
  });

  const runtime = await preparer.prepare({
    engineId: "codex",
    permissionMode: ":danger-full-access",
    runtimeConfig: {
      agentEngine: "codex",
      providerConnectionId: "mia",
      modelProfileId: "mia:mia-auto",
      model: "mia-auto"
    }
  });

  assert.equal(proxyCalls.length, 1);
  assert.equal(proxyCalls[0], managedModel);
  assert.equal(runtime.runtimeKey, "mia:mia-auto");
  assert.equal(runtime.env.CODEX_API_KEY, "mia-codex-session-token");
  assert.equal(runtime.env.OPENAI_API_KEY, undefined);
  assert.equal(runtime.env.MODEL_PROVIDER, "custom");
  assert.equal(runtime.env.CODEX_PATH, launcherPath);
  assert.equal(runtime.env.MIA_CODEX_MODEL_CATALOG_JSON, catalogPath);
  assert.equal(runtime.env.MIA_CODEX_REAL_PATH, "/usr/local/bin/codex-real");
  assert.equal(fs.existsSync(launcherPath), true);
  assert.match(fs.readFileSync(launcherPath, "utf8"), /model_catalog_json/);
  const codexConfig = JSON.parse(runtime.env.CODEX_CONFIG);
  assert.equal(codexConfig.model_catalog_json, catalogPath);
  assert.equal(fs.existsSync(catalogPath), true);
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  assert.equal(catalog.models[0].slug, "mia-auto");
  assert.equal(catalog.models[0].display_name, "Auto");
  assert.equal(catalog.models[0].base_instructions.length > 0, true);
  assert.deepEqual(catalog.models[0].supported_reasoning_levels.map((entry) => entry.effort), ["none", "low", "medium", "high"]);
  assert.deepEqual(codexConfig, {
    model: "mia-auto",
    model_provider: "custom",
    model_catalog_json: catalogPath,
    approval_policy: "never",
    sandbox_mode: "danger-full-access",
    disable_response_storage: true,
    model_providers: {
      custom: {
        name: "Mia",
        base_url: "http://127.0.0.1:7654/v1",
        wire_api: "responses",
        env_key: "CODEX_API_KEY",
        requires_openai_auth: false
      }
    }
  });
});

test("Codex Mia launcher injects model catalog config into app-server startup", async (t) => {
  if (process.platform === "win32") return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-codex-launcher-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const realCodex = path.join(dir, "codex-real.sh");
  const argsFile = path.join(dir, "args.txt");
  fs.writeFileSync(realCodex, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\n`, { mode: 0o755 });
  const launcherPath = path.join(dir, "codex-launcher.sh");
  const catalogPath = path.join(dir, "models.json");
  const preparer = createAgentSessionRuntimePreparer({
    codexLauncherPath: launcherPath,
    codexModelCatalogPath: catalogPath,
    codexRealPath: realCodex,
    resolveManagedModelRuntime: () => ({ provider: "mia", modelProfileId: "mia:mia-auto", model: "mia-auto", managedByMia: true }),
    codexMiaProxy: {
      createSession: async () => ({
        baseUrl: "http://127.0.0.1:7654/v1",
        apiKey: "mia-codex-session-token",
        model: "mia-auto"
      })
    }
  });

  await preparer.prepare({
    engineId: "codex",
    runtimeConfig: { agentEngine: "codex", providerConnectionId: "mia", modelProfileId: "mia:mia-auto", model: "mia-auto" }
  });

  await new Promise((resolve, reject) => {
    const spawned = require("node:child_process").spawn(launcherPath, ["app-server"], {
      env: {
        ...process.env,
        MIA_CODEX_REAL_PATH: realCodex,
        MIA_CODEX_MODEL_CATALOG_JSON: catalogPath
      },
      stdio: "ignore"
    });
    spawned.on("error", reject);
    spawned.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`launcher exited ${code}`)));
  });
  const args = fs.readFileSync(argsFile, "utf8").trim().split(/\n/);
  assert.deepEqual(args, ["app-server", "-c", `model_catalog_json="${catalogPath}"`]);
});

test("does not prepare Codex proxy env for native Codex runtime", async () => {
  const preparer = createAgentSessionRuntimePreparer({
    resolveManagedModelRuntime: () => null,
    codexMiaProxy: {
      createSession: async () => {
        throw new Error("proxy should not start");
      }
    }
  });

  const runtime = await preparer.prepare({
    engineId: "codex",
    runtimeConfig: {
      agentEngine: "codex",
      providerConnectionId: "codex",
      modelProfileId: "codex:gpt-5-codex",
      model: "gpt-5-codex"
    }
  });

  assert.equal(runtime.skillDeliveryMode, "native-link");
  assert.match(runtime.skillFingerprint, /^[a-f0-9]{16}$/);
  assert.equal(runtime.runtimeKey, undefined);
  assert.equal(runtime.env, undefined);
});

test("prepares Hermes Mia managed runtime in a session-scoped Hermes home", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-hermes-session-runtime-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hermesHome = path.join(dir, "native-hermes");
  const miaHome = path.join(dir, "mia-home");
  const profilesRoot = path.join(dir, "profiles");
  const hermesCommand = path.join(dir, "bin", process.platform === "win32" ? "hermes.exe" : "hermes");
  fs.mkdirSync(hermesHome, { recursive: true });
  fs.writeFileSync(path.join(hermesHome, "config.yaml"), yaml.dump({
    model: {
      provider: "openai-codex",
      default: "gpt-5.5",
      base_url: "https://chatgpt.com/backend-api/codex",
      api_mode: "codex_responses"
    },
    providers: {
      "openai-codex": {
        name: "OpenAI Codex",
        base_url: "https://chatgpt.com/backend-api/codex",
        default_model: "gpt-5.5",
        api_mode: "codex_responses"
      }
    },
    skills: {
      external_dirs: ["/skills/a"]
    }
  }), "utf8");
  fs.writeFileSync(path.join(hermesHome, "auth.json"), JSON.stringify({
    credential_pool: {
      "openai-codex": [{ access_token: "codex-access", refresh_token: "codex-refresh" }]
    }
  }, null, 2));

  const preparer = createAgentSessionRuntimePreparer({
    resolveManagedModelRuntime: (runtimeConfig, context) => {
      assert.deepEqual(context, { engine: "hermes" });
      assert.deepEqual(runtimeConfig, {
        agentEngine: "hermes",
        providerConnectionId: "mia",
        modelProfileId: "mia:mia-auto",
        model: "mia-auto",
        effortLevel: "medium",
        permissionMode: "yolo"
      });
      return {
        provider: "mia",
        providerConnectionId: "mia",
        providerLabel: "Mia",
        authType: "mia_account",
        modelProfileId: "mia:mia-auto",
        model: "mia-auto",
        apiKeyEnv: "MIA_CLOUD_MODEL_TOKEN",
        apiKey: "cloud-token",
        baseUrl: "https://mia.example/api/me/model-proxy/v1",
        apiMode: "chat_completions",
        managedByMia: true
      };
    },
    hermesCommandPath: () => hermesCommand,
    hermesHomePath: hermesHome,
    miaHomePath: miaHome,
    hermesSessionProfilesRoot: profilesRoot
  });

  const runtime = await preparer.prepare({
    engineId: "hermes",
    runtimeConfig: {
      agentEngine: "hermes",
      providerConnectionId: "mia",
      modelProfileId: "mia:mia-auto",
      model: "mia-auto",
      effortLevel: "medium",
      permissionMode: "yolo"
    }
  });

  assert.equal(runtime.runtimeKey, "mia:mia-auto");
  assert.equal(runtime.engineSpec.command, hermesCommand);
  assert.deepEqual(runtime.engineSpec.args, ["acp"]);
  assert.equal(runtime.env.MIA_HOME, miaHome);
  assert.equal(runtime.env.MIA_CLOUD_MODEL_TOKEN, "cloud-token");
  assert.ok(runtime.env.HERMES_HOME.startsWith(profilesRoot));
  assert.notEqual(runtime.env.HERMES_HOME, hermesHome);
  const parsed = yaml.load(fs.readFileSync(path.join(runtime.env.HERMES_HOME, "config.yaml"), "utf8"));
  assert.equal(parsed.model.provider, "mia");
  assert.equal(parsed.model.default, "mia-auto");
  assert.equal(parsed.model.base_url, "https://mia.example/api/me/model-proxy/v1");
  assert.equal(parsed.providers.mia.api_key, "cloud-token");
  assert.equal(parsed.providers.mia.key_env, "MIA_CLOUD_MODEL_TOKEN");
  assert.equal(parsed.providers.mia.default_model, "mia-auto");
  assert.equal(parsed.approvals.mode, "yolo");
  assert.equal(parsed.agent.reasoning_effort, "medium");
  assert.equal(parsed.skills?.external_dirs, undefined);
  const copiedAuth = JSON.parse(fs.readFileSync(path.join(runtime.env.HERMES_HOME, "auth.json"), "utf8"));
  assert.equal(copiedAuth.credential_pool["openai-codex"][0].access_token, "codex-access");
});

test("prepares Hermes Mia managed runtime with session-level skill external dirs in the session profile", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-hermes-session-selected-skill-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hermesHome = path.join(dir, "native-hermes");
  const miaHome = path.join(dir, "mia-home");
  const profilesRoot = path.join(dir, "profiles");
  const selectedSkillDir = path.join(dir, "skills", "deep-research");
  fs.mkdirSync(hermesHome, { recursive: true });
  fs.mkdirSync(selectedSkillDir, { recursive: true });
  fs.writeFileSync(path.join(hermesHome, "config.yaml"), yaml.dump({
    model: {
      provider: "openai-codex",
      default: "gpt-5.5"
    }
  }), "utf8");

  const preparer = createAgentSessionRuntimePreparer({
    resolveManagedModelRuntime: () => ({
      provider: "mia",
      providerConnectionId: "mia",
      providerLabel: "Mia",
      modelProfileId: "mia:mia-auto",
      model: "mia-auto",
      apiKeyEnv: "MIA_CLOUD_MODEL_TOKEN",
      apiKey: "cloud-token",
      baseUrl: "https://mia.example/api/me/model-proxy/v1",
      apiMode: "chat_completions",
      managedByMia: true
    }),
    hermesHomePath: hermesHome,
    miaHomePath: miaHome,
    hermesSessionProfilesRoot: profilesRoot,
    skillRuntimeOwner: {
      async prepareAgentSessionSkillRuntime() {
        return {
          skillFingerprint: "skills:selected",
          skillDeliveryMode: "native-link",
          skillExternalDirs: [selectedSkillDir]
        };
      }
    }
  });

  const runtime = await preparer.prepare({
    engineId: "hermes",
    runtimeConfig: {
      agentEngine: "hermes",
      providerConnectionId: "mia",
      modelProfileId: "mia:mia-auto",
      model: "mia-auto"
    }
  });

  const parsed = yaml.load(fs.readFileSync(path.join(runtime.env.HERMES_HOME, "config.yaml"), "utf8"));
  assert.deepEqual(parsed.skills?.external_dirs, [selectedSkillDir]);
});

test("prepares ACP MCP servers and scoped context prelude for AgentSession", async () => {
  const contextWrites = [];
  const preparer = createAgentSessionRuntimePreparer({
    resolveManagedModelRuntime: () => null,
    getMiaAppMcpSpec: (context) => {
      contextWrites.push(["mia-app-spec", context]);
      return {
        type: "stdio",
        command: "/usr/bin/node",
        args: ["/tmp/mia-app-mcp-server.js"],
        env: {
          MIA_DAEMON_URL: "http://127.0.0.1:27861",
          MIA_DAEMON_TOKEN: "tok"
        }
      };
    },
    getSchedulerMcpSpec: () => ({
      type: "stdio",
      command: "/usr/bin/node",
      args: ["/tmp/scheduler-mcp-server.js"],
      env: {
        MIA_DAEMON_URL: "http://127.0.0.1:27861",
        MIA_DAEMON_TOKEN: "tok"
      }
    }),
    getUserMcpServers: (engineId, options) => {
      assert.equal(engineId, "codex");
      assert.deepEqual(options, { supportsHttp: false, supportsSse: false });
      return [{
        name: "docs",
        command: "/usr/bin/node",
        args: ["/tmp/docs-mcp.js"],
        env: [{ name: "DOCS_TOKEN", value: "secret" }]
      }];
    },
    getMcpFingerprint: () => "user-mcp-fingerprint",
    writeMiaAppMcpContext: (context) => contextWrites.push(["mia-app-context", context]),
    writeSchedulerMcpContext: (context) => contextWrites.push(["scheduler-context", context])
  });

  const runtime = await preparer.prepare({
    engineId: "codex",
    conversationId: "conversation:abc",
    botId: "bot-1",
    runtimeConfig: { agentEngine: "codex" }
  });

  assert.equal(runtime.mcpServers.length, 3);
  assert.deepEqual(runtime.mcpServers.map((server) => server.name), ["docs", "mia-app", "mia-scheduler"]);
  assert.deepEqual(runtime.mcpServers[1], {
    name: "mia-app",
    command: "/usr/bin/node",
    args: ["/tmp/mia-app-mcp-server.js"],
    env: [
      { name: "MIA_DAEMON_TOKEN", value: "tok" },
      { name: "MIA_DAEMON_URL", value: "http://127.0.0.1:27861" }
    ]
  });
  assert.equal(runtime.initialPromptPrefix, undefined);
  assert.equal(runtime.skillDeliveryMode, "native-link");
  assert.match(runtime.skillFingerprint, /^[a-f0-9]{16}$/);
  assert.equal(typeof runtime.refreshMcpContext, "function");
  assert.match(runtime.mcpFingerprint, /^mcp:/);

  await runtime.refreshMcpContext({ turnId: "msg-1" });
  assert.deepEqual(contextWrites, [
    ["mia-app-spec", { botId: "bot-1", sessionId: "conversation:abc" }],
    ["mia-app-context", { botId: "bot-1", sessionId: "conversation:abc", originMessageId: "msg-1" }],
    ["scheduler-context", { botId: "bot-1", sessionId: "conversation:abc", originMessageId: "msg-1" }]
  ]);
});

test("prepare wires native skill runtime state into the AgentSession result", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-agent-session-runtime-"));
  try {
    const preparer = createAgentSessionRuntimePreparer({
      resolveManagedModelRuntime: () => null,
      skillRuntimeOwner: {
        async prepareAgentSessionSkillRuntime(input) {
          assert.equal(input.engineId, "claude");
          fs.mkdirSync(path.join(dir, ".claude", "skills"), { recursive: true });
          fs.mkdirSync(path.join(dir, ".claude", "skills", "pdf"));
          return {
            skillFingerprint: "skills:1234",
            skillDeliveryMode: "native-link",
            initialPromptPrefix: ""
          };
        }
      }
    });

    const runtime = await preparer.prepare({
      engineId: "claude",
      conversationId: "conversation_1",
      botId: "bot1",
      botSnapshot: { key: "bot1", agentEngine: "claude-code" },
      runtimeConfig: { agentEngine: "claude-code" },
      workspacePath: dir
    });

    assert.equal(runtime.skillFingerprint, "skills:1234");
    assert.equal(runtime.skillDeliveryMode, "native-link");
    assert.equal(fs.existsSync(path.join(dir, ".claude", "skills", "pdf")), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
