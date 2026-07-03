const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createCoreBotExecution } = require("../src/core/mia-core.js");
const { createLocalAgentEngineService } = require("../src/main/local-agent-engine-service.js");
const { getAcpEngineSpec, listAcpEngineSpecs } = require("../src/main/agent-session/index.js");
const { createRuntimePaths } = require("../src/main/runtime-paths.js");

test("Task 7: all four bot conversation engines resolve to AgentSession ACP specs", () => {
  const specs = listAcpEngineSpecs();

  assert.deepEqual(
    specs.map((spec) => spec.engineId),
    ["claude", "codex", "hermes", "openclaw"]
  );

  for (const spec of specs) {
    assert.equal(spec.transport, "acp");
    assert.equal(spec.supportsNativeSession, true);
    assert.equal(spec.supportsQueuedInput, true);
  }
});

test("Task 7: app-facing engine ids resolve through getAcpEngineSpec()", () => {
  const cases = [
    ["claude-code", "claude"],
    ["codex", "codex"],
    ["hermes", "hermes"],
    ["openclaw", "openclaw"],
    ["open-claw", "openclaw"]
  ];

  for (const [inputEngineId, expectedEngineId] of cases) {
    const spec = getAcpEngineSpec(inputEngineId);
    assert.ok(spec, `${inputEngineId} should resolve to an AgentSession ACP spec`);
    assert.equal(spec.engineId, expectedEngineId, `${inputEngineId} should normalize to ${expectedEngineId}`);
    assert.equal(spec.transport, "acp");
    assert.equal(spec.supportsNativeSession, true);
    assert.equal(spec.supportsQueuedInput, true);
  }
});

test("Task 6: Mia Core constructs the Core MCP service without the main wrapper", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "core", "mia-core.js"), "utf8");
  assert.match(src, /createCoreMcpService/);
  assert.match(src, /require\("\.\/mcp\/service\.js"\)/);
  assert.match(src, /createManagedConnectorSupervisor/);
  assert.match(src, /managedSupervisor:\s*createManagedConnectorSupervisor\(\{/);
  assert.doesNotMatch(src, /const \{ createMcpService \}/);
  assert.doesNotMatch(src, /createMcpService\(\{/);
  assert.doesNotMatch(src, /require\("\.\.\/main\/mcp\/mcp-service\.js"\)/);
});

function makeRuntimePaths(home) {
  return createRuntimePaths({
    app: { getPath: () => os.homedir() },
    MIA_GATEWAY_SERVICE_LABEL: "ai.mia.hermes.gateway",
    MIA_DAEMON_SERVICE_LABEL: "ai.mia.daemon",
    env: { MIA_HOME: home }
  }).runtimePaths;
}

const settingsStore = {
  daemonSettings: () => ({ enabled: false }),
  cloudSettings: () => ({ enabled: false, url: "", token: "" }),
  normalizeCloudUrl: (v) => String(v || ""),
  normalizeStoredEffortLevel: (v) => String(v || "").trim(),
  enginePermissionMode: () => "default",
  normalizeEffortLevel: (v) => String(v || "medium").trim() || "medium"
};

const loggedInSettingsStore = {
  ...settingsStore,
  cloudSettings: () => ({ enabled: true, url: "https://cloud.mia.test", token: "tok-xyz" }),
  normalizeCloudUrl: (v) => String(v || "").replace(/\/+$/, "")
};

function recordingAgentSessionManager(calls) {
  return {
    sendUserInput: async (input) => {
      calls.push(input);
      return {
        ok: true,
        mode: "started",
        conversationId: input.conversationId,
        engineId: input.engineId,
        turnId: input.turnId
      };
    },
    closeAllSessions: async () => {}
  };
}

function makeLocalAgentService(t, overrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-engine-health-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const execCalls = [];
  const service = createLocalAgentEngineService({
    homeDir: () => home,
    env: { PATH: "" },
    platform: "darwin",
    fs: {
      accessSync: () => {
        throw new Error("missing");
      }
    },
    spawnSync: () => ({ status: 1, stdout: "", stderr: "" }),
    execFile: (file, args, options, cb) => {
      execCalls.push({ file, args, options });
      return cb(new Error("not found"), "", "");
    },
    ...overrides
  });
  return { service, execCalls };
}

for (const [inputEngineId, expectedEngineId] of [
  ["claude-code", "claude"],
  ["codex", "codex"],
  ["hermes", "hermes"],
  ["openclaw", "openclaw"]
]) {
  test(`interactive ${inputEngineId} turns in Mia Core route through AgentSession ACP`, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `mia-core-engine-${expectedEngineId}-`));
    try {
      const managerCalls = [];
      const core = createCoreBotExecution({
        runtimePaths: makeRuntimePaths(home),
        settingsStore: inputEngineId === "claude-code" ? loggedInSettingsStore : settingsStore,
        agentSessionManager: recordingAgentSessionManager(managerCalls)
      });

      const response = await core.sendChat({
        botKey: `bot-${expectedEngineId}`,
        botSnapshot: { key: `bot-${expectedEngineId}`, name: expectedEngineId, agentEngine: inputEngineId, capabilities: {} },
        sessionId: "conversation:s1",
        messages: [{ role: "user", id: "turn_1", content: "hi" }]
      });

      assert.deepEqual(response, {
        ok: true,
        mode: "started",
        conversationId: "conversation:s1",
        engineId: expectedEngineId,
        turnId: "turn_1"
      });
      assert.equal(managerCalls.length, 1);
      assert.deepEqual(managerCalls[0], {
        conversationId: "conversation:s1",
        engineId: expectedEngineId,
        workspacePath: makeRuntimePaths(home)().workspace,
        turnId: "turn_1",
        text: "hi"
      });

      await core.closeAgentEngines();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

test("Claude Code turns using Mia Auto receive Mia proxy env in Core AgentSession", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-claude-mia-runtime-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const managerCalls = [];
  const proxyCalls = [];
  const core = createCoreBotExecution({
    runtimePaths: makeRuntimePaths(home),
    settingsStore: loggedInSettingsStore,
    agentSessionManager: recordingAgentSessionManager(managerCalls),
    claudeCodeMiaProxy: {
      createSession: async (runtime) => {
        proxyCalls.push(runtime);
        return {
          baseUrl: "http://127.0.0.1:4321",
          authToken: "proxy-token",
          model: "mia-auto"
        };
      },
      stop: async () => {}
    }
  });

  await core.sendChat({
    botKey: "bot-claude",
    botSnapshot: { key: "bot-claude", name: "Claude", agentEngine: "claude-code", capabilities: {} },
    sessionId: "conversation:s1",
    runtimeConfig: {
      agentEngine: "claude-code",
      providerConnectionId: "mia",
      modelProfileId: "mia:mia-auto",
      model: "mia-auto"
    },
    messages: [{ role: "user", id: "turn_1", content: "hi" }]
  });

  assert.equal(proxyCalls.length, 1);
  assert.equal(proxyCalls[0].baseUrl, "https://cloud.mia.test/api/me/model-proxy/v1");
  assert.equal(proxyCalls[0].apiKey, "tok-xyz");
  assert.deepEqual(managerCalls[0], {
    conversationId: "conversation:s1",
    engineId: "claude",
    workspacePath: makeRuntimePaths(home)().workspace,
    runtimeKey: "mia:mia-auto",
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4321",
      ANTHROPIC_AUTH_TOKEN: "proxy-token"
    },
    turnId: "turn_1",
    text: "hi"
  });

  await core.closeAgentEngines();
});

test("native Claude Code model profiles do not require provider connections in Core AgentSession", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-claude-native-runtime-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const managerCalls = [];
  const core = createCoreBotExecution({
    runtimePaths: makeRuntimePaths(home),
    settingsStore: loggedInSettingsStore,
    agentSessionManager: recordingAgentSessionManager(managerCalls),
    claudeCodeMiaProxy: {
      createSession: async () => {
        throw new Error("native Claude Code model should not start the Mia proxy");
      }
    }
  });

  await core.sendChat({
    botKey: "bot-claude",
    botSnapshot: { key: "bot-claude", name: "Claude", agentEngine: "claude-code", capabilities: {} },
    sessionId: "conversation:s1",
    runtimeConfig: {
      providerConnectionId: "anthropic",
      modelProfileId: "anthropic:claude",
      model: "claude"
    },
    messages: [{ role: "user", id: "turn_1", content: "hi" }]
  });

  assert.deepEqual(managerCalls[0], {
    conversationId: "conversation:s1",
    engineId: "claude",
    workspacePath: makeRuntimePaths(home)().workspace,
    turnId: "turn_1",
    text: "hi"
  });

  await core.closeAgentEngines();
});

test("Task 13: local agent deep checks probe the ACP launch commands each interactive engine now requires", async (t) => {
  const { service, execCalls } = makeLocalAgentService(t, {
    execFile: (file, args, options, cb) => {
      execCalls.push({ file, args, options });
      if (file === "zsh" && args[1] === "command -v npx") return cb(null, "/bin/npx\n", "");
      if (file === "zsh" && args[1] === "command -v hermes") return cb(null, "/bin/hermes\n", "");
      if (file === "zsh" && args[1] === "command -v openclaw") return cb(null, "/bin/openclaw\n", "");
      if (file === "/bin/npx" && args[0] === "--version") return cb(null, "10.9.0\n", "");
      if (file === "/bin/hermes" && args[0] === "--version") return cb(null, "Hermes Agent v0.16.0\n", "");
      if (file === "/bin/openclaw" && args[0] === "--version") return cb(null, "openclaw 0.1.0\n", "");
      if (file === "/bin/npx" && args.includes("@agentclientprotocol/claude-agent-acp@0.39.0")) return cb(null, "claude acp help\n", "");
      if (file === "/bin/npx" && args.includes("@zed-industries/codex-acp@0.14.0")) return cb(null, "codex acp help\n", "");
      if (file === "/bin/hermes" && args[0] === "acp") return cb(null, "hermes acp help\n", "");
      if (file === "/bin/openclaw" && args[0] === "acp") return cb(null, "openclaw acp help\n", "");
      return cb(new Error("not found"), "", "");
    }
  });

  const inventory = await service.scanAgentsAsync();
  const agentsById = Object.fromEntries(inventory.agents.map((agent) => [agent.id, agent]));

  assert.equal(agentsById["claude-code"].usableInMia, true);
  assert.equal(agentsById["claude-code"].readiness.status, "ready");
  assert.equal(agentsById.codex.usableInMia, true);
  assert.equal(agentsById.codex.readiness.status, "ready");
  assert.equal(agentsById.hermes.usableInMia, true);
  assert.equal(agentsById.hermes.readiness.status, "ready");
  assert.equal(agentsById.openclaw.usableInMia, true);
  assert.equal(agentsById.openclaw.readiness.status, "ready");

  assert.ok(execCalls.some((call) => call.file === "/bin/npx" && call.args.includes("@agentclientprotocol/claude-agent-acp@0.39.0")));
  assert.ok(execCalls.some((call) => call.file === "/bin/npx" && call.args.includes("@zed-industries/codex-acp@0.14.0")));
  assert.ok(execCalls.some((call) => call.file === "/bin/hermes" && call.args[0] === "acp"));
  assert.ok(execCalls.some((call) => call.file === "/bin/openclaw" && call.args[0] === "acp"));
});

test("Task 13: blocked readiness identifies the missing ACP command path instead of legacy engine health", async (t) => {
  const { service } = makeLocalAgentService(t, {
    isHermesInstalled: () => true,
    isHermesApiRuntimeReady: () => false,
    hermesSource: () => "system",
    execFile: (file, args, _options, cb) => {
      if (file === "zsh" && args[1] === "command -v hermes") return cb(null, "/bin/hermes\n", "");
      if (file === "zsh" && args[1] === "command -v openclaw") return cb(null, "/bin/openclaw\n", "");
      if (file === "/bin/hermes" && args[0] === "--version") return cb(null, "Hermes Agent v0.16.0\n", "");
      if (file === "/bin/openclaw" && args[0] === "--version") return cb(null, "openclaw 0.1.0\n", "");
      if (file === "/bin/hermes" && args[0] === "acp") return cb(new Error("spawn failed"), "", "missing hermes acp");
      if (file === "/bin/openclaw" && args[0] === "acp") return cb(new Error("spawn failed"), "", "missing openclaw acp");
      return cb(new Error("not found"), "", "");
    }
  });

  const inventory = await service.scanAgentsAsync();
  const agentsById = Object.fromEntries(inventory.agents.map((agent) => [agent.id, agent]));

  assert.equal(agentsById.hermes.health, "blocked");
  assert.equal(agentsById.hermes.readiness.status, "blocked");
  assert.match(agentsById.hermes.readiness.detail, /hermes acp/i);
  assert.doesNotMatch(agentsById.hermes.readiness.summary, /Hermes API/i);

  assert.equal(agentsById.openclaw.health, "blocked");
  assert.equal(agentsById.openclaw.readiness.status, "blocked");
  assert.match(agentsById.openclaw.readiness.detail, /openclaw.*acp/i);
});
