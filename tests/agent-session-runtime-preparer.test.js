const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createAgentSessionRuntimePreparer
} = require("../src/main/agent-session-runtime-preparer.js");

function coreSkillRuntimePlan(overrides = {}) {
  return {
    deliveryMode: "native-link",
    nativeSkillsDirs: [".codex/skills"],
    resolvedSkillIds: [],
    resolvedSkills: [],
    turnSelectedSkills: [],
    skillExternalDirs: [],
    skillFingerprint: "abcdef1234567890",
    selectedSkillPrompt: "",
    initialPromptPrefix: "",
    skillMaterialization: null,
    managedSkillTargets: [],
    manifestPath: "",
    ...overrides
  };
}

async function resolveSkillRuntimeWithCore() {
  return coreSkillRuntimePlan();
}

test("AgentSession runtime preparer does not assemble provider transport config in JS", async () => {
  const preparer = createAgentSessionRuntimePreparer({
    resolveSkillRuntimeWithCore,
    hermesCommandPath: () => "C:\\Users\\mia\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\hermes.exe",
    resolveManagedModelRuntime: () => {
      throw new Error("provider runtime resolution must stay in Rust Core");
    }
  });

  const runtime = await preparer.prepare({
    engineId: "hermes",
    runtimeConfig: {
      agentEngine: "hermes",
      providerConnectionId: "mia",
      modelProfileId: "mia:mia-auto",
      model: "mia-auto",
      apiKeyEnv: "MIA_CLOUD_MODEL_TOKEN",
      apiKey: "cloud-token",
      baseUrl: "https://mia.example/api/me/model-proxy/v1",
      apiMode: "chat_completions"
    }
  });

  assert.equal(runtime.skillDeliveryMode, "native-link");
  assert.match(runtime.skillFingerprint, /^[a-f0-9]{16}$/);
  assert.equal(runtime.runtimeKey, undefined);
  assert.equal(runtime.env, undefined);
  assert.equal(runtime.engineSpec.command, "C:\\Users\\mia\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\hermes.exe");
  assert.deepEqual(runtime.engineSpec.args, ["acp"]);
});

test("prepares ACP MCP servers and scoped context prelude for AgentSession", async () => {
  const contextWrites = [];
  const preparer = createAgentSessionRuntimePreparer({
    getMiaAppMcpSpec: (context) => {
      contextWrites.push(["mia-app-spec", context]);
      return {
        type: "stdio",
        command: "/usr/bin/node",
        args: ["/tmp/mia-app-mcp-server.js"],
        env: {
          MIA_CORE_URL: "http://127.0.0.1:27861",
          MIA_CORE_TOKEN: "tok"
        }
      };
    },
    getSchedulerMcpSpec: () => ({
      type: "stdio",
      command: "/usr/bin/node",
      args: ["/tmp/scheduler-mcp-server.js"],
      env: {
        MIA_CORE_URL: "http://127.0.0.1:27861",
        MIA_CORE_TOKEN: "tok"
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
    writeSchedulerMcpContext: (context) => contextWrites.push(["scheduler-context", context]),
    resolveSkillRuntimeWithCore
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
      { name: "MIA_CORE_TOKEN", value: "tok" },
      { name: "MIA_CORE_URL", value: "http://127.0.0.1:27861" }
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
      skillRuntimeAdapter: {
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
