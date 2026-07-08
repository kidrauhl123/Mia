const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  compactModelFromClientSettings,
  coreProviderSummaries,
  createRuntimeStatusCoreSnapshot,
  resolveCodexModelSelection
} = require("../src/main/runtime-status-core-snapshot.js");

test("compact model settings keep UI selection fields only", () => {
  const model = compactModelFromClientSettings({
    settings: {
      provider: "anthropic",
      providerConnectionId: "anthropic-main",
      providerLabel: "Anthropic",
      authType: "api_key",
      model: "claude-sonnet-4.6",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      baseUrl: "https://api.anthropic.com",
      apiMode: "messages"
    }
  });

  assert.deepEqual(model, {
    provider: "anthropic",
    providerConnectionId: "anthropic-main",
    providerLabel: "Anthropic",
    authType: "api_key",
    model: "claude-sonnet-4.6",
    modelProfileId: "anthropic-main:claude-sonnet-4.6"
  });
});

test("Core provider summaries expose display metadata without transport config", () => {
  const summaries = coreProviderSummaries(
    {
      providers: [
        {
          id: "anthropic-main",
          kind: "anthropic",
          displayName: "Anthropic",
          enabled: true,
          models: ["claude-sonnet-4.6"]
        }
      ]
    },
    {
      provider: "anthropic",
      providerConnectionId: "anthropic-main",
      authType: "api_key"
    },
    { codexLoggedIn: true }
  );

  assert.deepEqual(summaries, [
    {
      provider: "anthropic",
      providerConnectionId: "anthropic-main",
      providerLabel: "Anthropic",
      authType: "api_key",
      hasApiKey: true,
      models: ["claude-sonnet-4.6"]
    },
    {
      provider: "openai-codex",
      providerConnectionId: "openai-codex",
      providerLabel: "OpenAI Codex",
      authType: "oauth_external",
      hasApiKey: true,
      models: []
    }
  ]);
});

test("runtime status snapshot overlays model and providers from Rust Core", async () => {
  const calls = [];
  const snapshot = createRuntimeStatusCoreSnapshot({
    authStatus: () => ({ codexLoggedIn: false }),
    coreRequest: async (request) => {
      calls.push(request);
      if (request.route === "/api/settings/client") {
        return {
          settings: {
            provider: "anthropic",
            providerConnectionId: "anthropic-main",
            providerLabel: "Anthropic",
            authType: "api_key",
            model: "claude-sonnet-4.6",
            apiKeyEnv: "ANTHROPIC_API_KEY"
          }
        };
      }
      if (request.route === "/api/providers") {
        return {
          providers: [
            {
              id: "anthropic-main",
              kind: "anthropic",
              displayName: "Anthropic",
              enabled: true,
              models: ["claude-sonnet-4.6"]
            }
          ]
        };
      }
      throw new Error(`unexpected route ${request.route}`);
    }
  });

  const result = await snapshot.apply({
    model: {
      provider: "old",
      apiKeyEnv: "OLD_KEY",
      baseUrl: "https://old.example",
      apiMode: "old"
    },
    connectedProviders: [{ provider: "old", apiKeyEnv: "OLD_KEY" }]
  });

  assert.deepEqual(calls.map((request) => `${request.method} ${request.route}`).sort(), [
    "GET /api/providers",
    "GET /api/settings/client"
  ]);
  assert.deepEqual(result.model, {
    provider: "anthropic",
    providerConnectionId: "anthropic-main",
    providerLabel: "Anthropic",
    authType: "api_key",
    model: "claude-sonnet-4.6",
    modelProfileId: "anthropic-main:claude-sonnet-4.6",
    hasApiKey: true
  });
  assert.deepEqual(result.connectedProviders, [
    {
      provider: "anthropic",
      providerConnectionId: "anthropic-main",
      providerLabel: "Anthropic",
      authType: "api_key",
      hasApiKey: true,
      models: ["claude-sonnet-4.6"]
    }
  ]);
});

test("runtime status snapshot keeps local status when Rust Core is unavailable", async () => {
  const snapshot = createRuntimeStatusCoreSnapshot({
    coreRequest: async () => {
      throw new Error("offline");
    }
  });
  const original = { model: { provider: "fallback" }, connectedProviders: [] };

  assert.equal(await snapshot.apply(original), original);
});

test("Codex model selection falls back to default when saved model is not in Core model list", () => {
  const selection = resolveCodexModelSelection(
    {
      provider: "openai-codex",
      model: "gpt-5.3-codex"
    },
    {
      models: [
        { slug: "gpt-5.5", displayName: "gpt-5.5" },
        { slug: "gpt-5.3-codex-spark", displayName: "gpt-5.3-codex-spark" }
      ]
    }
  );

  assert.deepEqual(selection, {
    provider: "openai-codex",
    providerConnectionId: "openai-codex",
    providerLabel: "OpenAI Codex",
    authType: "oauth_external",
    model: "default",
    modelProfileId: "openai-codex:default"
  });
});

test("Codex model selection does not preserve stale saved model when Core model list is unavailable", () => {
  const selection = resolveCodexModelSelection(
    {
      provider: "openai-codex",
      model: "gpt-5.3-codex"
    },
    {}
  );

  assert.equal(selection.model, "default");
  assert.equal(selection.modelProfileId, "openai-codex:default");
});
