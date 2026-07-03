const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createCodexStatelessAdapter,
  mapCodexPermissionMode
} = require("../src/main/codex-stateless-adapter.js");

function createDeps(overrides = {}) {
  const calls = [];
  return {
    calls,
    appendEngineLog: () => {},
    chatCompletionResponse: () => {
      throw new Error("chatCompletionResponse should not run for stateless tests");
    },
    cwd: () => "/repo",
    expandLeadingSkillCommand: (text) => text,
    ensureCodexHome: () => overrides.codexHomePath ?? "/Users/test/.codex",
    ensureMiaCodexProxy: async () => {
      throw new Error("ensureMiaCodexProxy should not run for stateless tests");
    },
    runCodexAppServerTurn: async (args) => {
      calls.push(["app-server", args]);
      return {
        threadId: args.threadId || "thread_1",
        finalResponse: Object.hasOwn(overrides, "finalResponse") ? overrides.finalResponse : "stateless out",
        items: []
      };
    },
    enginePermissionMode: () => "default",
    getMiaAppMcpSpec: () => null,
    getMcpFingerprint: () => "",
    getSchedulerMcpSpec: () => null,
    getAgentSessionId: () => "",
    getUserMcpSpecs: () => ({}),
    injectGroupContextForSdk: (prompt, contextBlock) => `GROUP:${contextBlock}\n${prompt}`,
    currentUserPrompt: () => "hello",
    normalizeEffortLevel: (level, engine) => `${engine}:${level}`,
    processEnvStrings: () => overrides.env || { PATH: "/bin" },
    readBotPersona: () => "persona",
    resolveModelRuntime: () => null,
    resolveManagedModelRuntime: () => null,
    setAgentSessionId: () => {},
    shellCommandPath: (command) => command === "codex" ? (overrides.commandPath || "/bin/codex") : "",
    writeSchedulerMcpContext: () => {},
    ...overrides
  };
}

test("mapCodexPermissionMode maps known permission modes", () => {
  assert.deepEqual(mapCodexPermissionMode("acceptEdits"), {
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request"
  });
  assert.deepEqual(mapCodexPermissionMode("bypassPermissions"), {
    sandboxMode: "danger-full-access",
    approvalPolicy: "never"
  });
  assert.deepEqual(mapCodexPermissionMode("readOnly"), {
    sandboxMode: "read-only",
    approvalPolicy: "never"
  });
  assert.deepEqual(mapCodexPermissionMode(":workspace"), {
    permissionProfile: ":workspace",
    sandboxMode: "workspace-write",
    approvalPolicy: "never"
  });
  assert.deepEqual(mapCodexPermissionMode("other"), {
    sandboxMode: "workspace-write",
    approvalPolicy: "untrusted"
  });
});

test("createCodexStatelessAdapter exposes only stateless send", async () => {
  const adapter = createCodexStatelessAdapter(createDeps());

  assert.equal(typeof adapter.sendStateless, "function");
  assert.equal("sendChat" in adapter, false);
});

test("sendStateless starts a fresh default thread", async () => {
  const deps = createDeps({ finalResponse: "stateless out" });
  const adapter = createCodexStatelessAdapter(deps);
  const response = await adapter.sendStateless({
    systemPrompt: "sys",
    userPrompt: "user",
    signal: null
  });

  const call = deps.calls.find((entry) => entry[0] === "app-server")[1];
  assert.equal(call.prompt, "sys\n\nuser");
  assert.equal(call.options.modelReasoningEffort, "codex:medium");
  assert.equal(call.options.approvalPolicy, "never");
  assert.equal(call.reuseKey, undefined);
  assert.deepEqual(response, { content: "stateless out" });
});

test("sendStateless puts the selected codex bin dir first in app-server env", async () => {
  const deps = createDeps({
    commandPath: "/opt/codex-node/bin/codex",
    env: { PATH: "/bad-node/bin:/usr/bin:/opt/codex-node/bin" }
  });
  const adapter = createCodexStatelessAdapter(deps);

  await adapter.sendStateless({
    systemPrompt: "sys",
    userPrompt: "user",
    signal: null
  });

  const call = deps.calls.find((entry) => entry[0] === "app-server")[1];
  assert.equal(call.codexPath, "/opt/codex-node/bin/codex");
  assert.equal(call.env.PATH, "/opt/codex-node/bin:/bad-node/bin:/usr/bin");
  assert.equal(call.env.CODEX_HOME, "/Users/test/.codex");
});

test("sendStateless routes Codex Mia managed runtime through Mia proxy and model catalog", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-codex-stateless-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const catalogPath = path.join(dir, "models.json");
  const runtimeCalls = [];
  const proxyCalls = [];
  const deps = createDeps({
    codexModelCatalogPath: catalogPath,
    resolveManagedModelRuntime: (config, context) => {
      runtimeCalls.push({ config, context });
      return {
        provider: "mia",
        providerConnectionId: "mia",
        modelProfileId: "mia:mia-auto",
        model: "mia-auto",
        baseUrl: "https://mia.example/api/me/model-proxy/v1",
        apiKey: "mia-cloud-token",
        managedByMia: true
      };
    },
    codexMiaProxy: {
      createSession: async (runtime) => {
        proxyCalls.push(runtime);
        return {
          baseUrl: "http://127.0.0.1:54321/v1",
          apiKey: "mia-codex-session-token",
          model: "mia-auto"
        };
      }
    }
  });
  const adapter = createCodexStatelessAdapter(deps);

  await adapter.sendStateless({
    systemPrompt: "sys",
    userPrompt: "user",
    runtimeConfig: {
      agentEngine: "codex",
      providerConnectionId: "mia",
      modelProfileId: "mia:mia-auto",
      model: "mia-auto"
    },
    signal: null
  });

  const call = deps.calls.find((entry) => entry[0] === "app-server")[1];
  assert.equal(runtimeCalls.length, 1);
  assert.equal(runtimeCalls[0].context.engine, "codex");
  assert.equal(proxyCalls.length, 1);
  assert.equal(call.apiKey, "mia-codex-session-token");
  assert.equal(call.baseUrl, "");
  assert.equal(call.options.model, "mia-auto");
  assert.ok(call.options.configOverrides.includes('model_provider="custom"'));
  assert.ok(call.options.configOverrides.includes(`model_catalog_json="${catalogPath}"`));
  assert.ok(call.options.configOverrides.includes('model_providers.custom.base_url="http://127.0.0.1:54321/v1"'));
  assert.equal(fs.existsSync(catalogPath), true);
  assert.equal(JSON.parse(fs.readFileSync(catalogPath, "utf8")).models[0].slug, "mia-auto");
});

test("sendStateless fails closed when Codex home cannot be prepared", async () => {
  const deps = createDeps({
    ensureCodexHome: () => {
      throw new Error("disk denied");
    }
  });
  const adapter = createCodexStatelessAdapter(deps);

  await assert.rejects(
    () => adapter.sendStateless({
      systemPrompt: "sys",
      userPrompt: "user",
      signal: null
    }),
    /Mia Codex home setup failed: disk denied/
  );
});
