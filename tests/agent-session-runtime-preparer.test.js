const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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
  assert.deepEqual(runtime, {
    runtimeKey: "mia:mia-auto",
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4321",
      ANTHROPIC_AUTH_TOKEN: "proxy-token"
    }
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

  assert.deepEqual(runtime, {});
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

  assert.deepEqual(runtime, {});
});

test("prepares OpenClaw Mia profile for Mia managed model runtime", async () => {
  const calls = [];
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
      calls.push(["resolve", runtimeConfig, context]);
      return managedModel;
    },
    openClawMiaProfile: {
      ensure: async (runtime) => {
        calls.push(["ensure", runtime]);
        return {
          profile: "mia"
        };
      }
    }
  });

  const runtime = await preparer.prepare({
    engineId: "openclaw",
    runtimeConfig: {
      agentEngine: "openclaw",
      providerConnectionId: "mia",
      modelProfileId: "mia:mia-auto",
      model: "mia-auto"
    }
  });

  assert.deepEqual(calls, [
    ["resolve", {
      agentEngine: "openclaw",
      providerConnectionId: "mia",
      modelProfileId: "mia:mia-auto",
      model: "mia-auto"
    }, { engine: "openclaw" }],
    ["ensure", managedModel]
  ]);
  assert.deepEqual(runtime, {
    runtimeKey: "mia:mia-auto",
    env: {
      MIA_OPENCLAW_PROFILE: "mia"
    }
  });
});

test("does not touch OpenClaw profile for native OpenClaw runtime", async () => {
  const preparer = createAgentSessionRuntimePreparer({
    resolveManagedModelRuntime: () => null,
    openClawMiaProfile: {
      ensure: async () => {
        throw new Error("profile should not be prepared");
      }
    }
  });

  const runtime = await preparer.prepare({
    engineId: "openclaw",
    runtimeConfig: {
      agentEngine: "openclaw",
      providerConnectionId: "openclaw",
      modelProfileId: "openclaw:auto",
      model: "auto"
    }
  });

  assert.deepEqual(runtime, {});
});
