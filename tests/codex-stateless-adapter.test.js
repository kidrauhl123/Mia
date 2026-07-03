const { test } = require("node:test");
const assert = require("node:assert/strict");
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
