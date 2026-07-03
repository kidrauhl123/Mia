const { test } = require("node:test");
const assert = require("node:assert/strict");

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

test("does not prepare proxy env for non-Claude AgentSession engines", async () => {
  const preparer = createAgentSessionRuntimePreparer({
    resolveManagedModelRuntime: () => {
      throw new Error("resolver should not run");
    },
    claudeCodeMiaProxy: {
      createSession: async () => {
        throw new Error("proxy should not start");
      }
    }
  });

  assert.deepEqual(await preparer.prepare({
    engineId: "codex",
    runtimeConfig: {
      agentEngine: "codex",
      providerConnectionId: "mia",
      modelProfileId: "mia:mia-auto",
      model: "mia-auto"
    }
  }), {});
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
