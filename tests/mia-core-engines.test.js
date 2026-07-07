const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createCoreBotExecution } = require("../src/core/mia-core.js");
const { createLocalAgentEngineService } = require("../src/main/local-agent-engine-service.js");
const { getAcpEngineSpec, listAcpEngineSpecs } = require("../src/main/agent-session/index.js");
const { createRuntimePaths } = require("../src/main/runtime-paths.js");
const { createSettingsStore } = require("../src/main/settings-store.js");

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

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function makeSettingsStore(runtimePaths) {
  return createSettingsStore({
    runtimePaths,
    readJson,
    writeRuntimeConfig: () => {},
    readConfiguredPort: () => 27861,
    getEngineState: () => ({}),
    MIA_DAEMON_DEFAULT_PORT: 27861,
    MIA_CLOUD_DEFAULT_URL: "https://cloud.mia.test"
  });
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

function assertManagedAgentTurn(call, {
  conversationId,
  engineId,
  workspacePath,
  turnId,
  text
}) {
  assert.equal(call.conversationId, conversationId);
  assert.equal(call.engineId, engineId);
  assert.equal(call.workspacePath, workspacePath);
  assert.equal(call.turnId, turnId);
  assert.equal(call.text, text);
  assert.match(call.skillFingerprint, /^[a-f0-9]{16}$/);
  assert.equal(call.initialPromptPrefix, undefined);
  assert.equal(call.turnPromptPrefix, undefined);
}

function installTestSkill(home, {
  dirName = "deep-research",
  skillName = "deep-research",
  description = "Deep research skill."
} = {}) {
  const skillDir = path.join(home, "skills", dirName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: ${description}\n---\n# ${skillName}\n`,
    "utf8"
  );
  return {
    skillDir,
    skillPath: path.join(skillDir, "SKILL.md")
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
      assertManagedAgentTurn(managerCalls[0], {
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

for (const [inputEngineId, expectedEngineId] of [
  ["claude-code", "claude"],
  ["codex", "codex"],
  ["hermes", "hermes"],
  ["openclaw", "openclaw"]
]) {
  test(`selected skill chips in Mia Core resolve to local SKILL.md paths for ${inputEngineId}`, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `mia-core-skill-path-${expectedEngineId}-`));
    try {
      const managerCalls = [];
      const { skillPath } = installTestSkill(home);
      const core = createCoreBotExecution({
        runtimePaths: makeRuntimePaths(home),
        settingsStore,
        agentSessionManager: recordingAgentSessionManager(managerCalls)
      });

      await core.sendChat({
        botKey: `bot-${expectedEngineId}`,
        botSnapshot: { key: `bot-${expectedEngineId}`, name: expectedEngineId, agentEngine: inputEngineId, capabilities: {} },
        sessionId: "conversation:skill-chip",
        activeSkillIds: ["mia:deep-research"],
        runtimeConfig: { agentEngine: inputEngineId },
        messages: [{ role: "user", id: "turn_skill", content: "这个呢" }]
      });

      assert.equal(managerCalls.length, 1);
      assert.match(String(managerCalls[0].turnPromptPrefix || ""), /<selected_skill_paths>/);
      assert.match(String(managerCalls[0].turnPromptPrefix || ""), new RegExp(skillPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

      await core.closeAgentEngines();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

test("Mia Core AgentSession turns honor the persisted custom workspace setting", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-workspace-home-"));
  const customWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-custom-workspace-"));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(customWorkspace, { recursive: true, force: true });
  });
  const runtimePaths = makeRuntimePaths(home);
  const realSettingsStore = makeSettingsStore(runtimePaths);
  realSettingsStore.writeAgentWorkspace(customWorkspace);
  const managerCalls = [];
  const core = createCoreBotExecution({
    runtimePaths,
    settingsStore: realSettingsStore,
    agentSessionManager: recordingAgentSessionManager(managerCalls)
  });
  t.after(async () => {
    try { await core.closeAgentEngines(); } catch { /* best effort */ }
  });

  await core.sendChat({
    botKey: "bot-codex",
    botSnapshot: { key: "bot-codex", name: "Codex", agentEngine: "codex", capabilities: {} },
    sessionId: "conversation:workspace",
    messages: [{ role: "user", id: "turn_1", content: "hi" }]
  });

  assert.equal(managerCalls[0].workspacePath, customWorkspace);
});

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
  assertManagedAgentTurn(managerCalls[0], {
    conversationId: "conversation:s1",
    engineId: "claude",
    workspacePath: makeRuntimePaths(home)().workspace,
    turnId: "turn_1",
    text: "hi"
  });
  assert.equal(managerCalls[0].runtimeKey, "mia:mia-auto");
  assert.deepEqual(managerCalls[0].env, {
    ANTHROPIC_BASE_URL: "http://127.0.0.1:4321",
    ANTHROPIC_AUTH_TOKEN: "proxy-token"
  });

  await core.closeAgentEngines();
});

test("Codex turns using Mia Auto receive Mia proxy env in Core AgentSession", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-codex-mia-runtime-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const managerCalls = [];
  const core = createCoreBotExecution({
    runtimePaths: makeRuntimePaths(home),
    settingsStore: loggedInSettingsStore,
    agentSessionManager: recordingAgentSessionManager(managerCalls)
  });

  await core.sendChat({
    botKey: "bot-codex",
    botSnapshot: { key: "bot-codex", name: "Codex", agentEngine: "codex", capabilities: {} },
    sessionId: "conversation:s1",
    runtimeConfig: {
      agentEngine: "codex",
      providerConnectionId: "mia",
      modelProfileId: "mia:mia-auto",
      model: "mia-auto"
    },
    messages: [{ role: "user", id: "turn_1", content: "hi" }]
  });

  assert.equal(managerCalls[0].conversationId, "conversation:s1");
  assert.equal(managerCalls[0].engineId, "codex");
  assert.equal(managerCalls[0].runtimeKey, "mia:mia-auto");
  assert.match(managerCalls[0].skillFingerprint, /^[a-f0-9]{16}$/);
  assert.equal(managerCalls[0].initialPromptPrefix, undefined);
  assert.equal(managerCalls[0].turnPromptPrefix, undefined);
  assert.equal(managerCalls[0].env.MODEL_PROVIDER, "custom");
  assert.equal(managerCalls[0].env.OPENAI_API_KEY, undefined);
  assert.match(managerCalls[0].env.CODEX_API_KEY, /^mia_codex_/);
  const codexConfig = JSON.parse(managerCalls[0].env.CODEX_CONFIG);
  assert.equal(codexConfig.model, "mia-auto");
  assert.equal(codexConfig.model_provider, "custom");
  assert.equal(typeof codexConfig.model_catalog_json, "string");
  assert.equal(fs.existsSync(codexConfig.model_catalog_json), true);
  assert.equal(JSON.parse(fs.readFileSync(codexConfig.model_catalog_json, "utf8")).models[0].slug, "mia-auto");
  assert.equal(codexConfig.disable_response_storage, true);
  assert.equal(codexConfig.model_providers.custom.base_url.startsWith("http://127.0.0.1:"), true);
  assert.equal(codexConfig.model_providers.custom.wire_api, "responses");
  assert.equal(codexConfig.model_providers.custom.env_key, "CODEX_API_KEY");
  assert.equal(codexConfig.model_providers.custom.requires_openai_auth, false);

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

  assertManagedAgentTurn(managerCalls[0], {
    conversationId: "conversation:s1",
    engineId: "claude",
    workspacePath: makeRuntimePaths(home)().workspace,
    turnId: "turn_1",
    text: "hi"
  });

  await core.closeAgentEngines();
});

test("Hermes Codex OAuth model profiles resolve through Core AgentSession", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-hermes-codex-runtime-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({
    providers: {
      "openai-codex": {
        tokens: {
          access_token: "codex-access-token",
          refresh_token: "codex-refresh-token"
        }
      }
    }
  }, null, 2));
  const managerCalls = [];
  const runtimePaths = makeRuntimePaths(home);
  const core = createCoreBotExecution({
    runtimePaths,
    settingsStore: loggedInSettingsStore,
    agentSessionManager: recordingAgentSessionManager(managerCalls)
  });

  await core.sendChat({
    botKey: "bot-hermes",
    botSnapshot: { key: "bot-hermes", name: "Hermes", agentEngine: "hermes", capabilities: {} },
    sessionId: "conversation:s1",
    runtimeConfig: {
      agentEngine: "hermes",
      providerConnectionId: "openai-codex",
      modelProfileId: "openai-codex:gpt-5.5",
      model: "gpt-5.5"
    },
    messages: [{ role: "user", id: "turn_1", content: "hi" }]
  });

  assert.equal(managerCalls[0].conversationId, "conversation:s1");
  assert.equal(managerCalls[0].engineId, "hermes");
  assert.equal(managerCalls[0].runtimeKey, "openai-codex:gpt-5.5");
  assert.equal(managerCalls[0].text, "hi");
  assert.match(managerCalls[0].env.HERMES_HOME, /openai-codex_gpt-5\.5-/);

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
      if (file === "/bin/npx" && args.includes("@agentclientprotocol/codex-acp@1.1.0")) return cb(null, "codex acp help\n", "");
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
  assert.ok(execCalls.some((call) => call.file === "/bin/npx" && call.args.includes("@agentclientprotocol/codex-acp@1.1.0")));
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
