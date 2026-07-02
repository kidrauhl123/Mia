const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createCoreBotExecution } = require("../src/core/mia-core.js");
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
