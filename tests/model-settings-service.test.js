const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createModelSettingsService } = require("../src/main/model-settings-service.js");

function setup(overrides = {}) {
  const calls = {
    providerSaves: [],
    modelWrites: [],
    restarts: 0,
    statuses: 0
  };
  const service = createModelSettingsService({
    modelSettings: () => ({ provider: "openai", model: "old-model", apiKeyEnv: "OPENAI_API_KEY", apiKey: "old-key" }),
    providerConnection: (provider) => provider === "anthropic"
      ? { provider, providerLabel: "Anthropic", authType: "api_key", apiKeyEnv: "ANTHROPIC_KEY", apiKey: "stored-key", baseUrl: "", apiMode: "" }
      : null,
    saveProviderConnection: (connection) => calls.providerSaves.push(connection),
    writeModelSettings: (settings) => calls.modelWrites.push(settings),
    restartEngineIfRunning: async () => {
      calls.restarts += 1;
      return { restarted: true };
    },
    getRuntimeStatus: () => {
      calls.statuses += 1;
      return { runtime: true };
    },
    ...overrides
  });
  return { calls, service };
}

test("saveModelSelection shares provider metadata and stored key fallback", async () => {
  const { calls, service } = setup();

  const result = await service.saveModelSelection({
    provider: "anthropic",
    providerLabel: "Claude",
    authType: "api_key",
    model: "claude-3-5-sonnet",
    baseUrl: "https://api.anthropic.com",
    apiMode: "messages"
  });

  assert.deepEqual(calls.modelWrites, [{
    provider: "anthropic",
    model: "claude-3-5-sonnet",
    apiKeyEnv: "ANTHROPIC_KEY",
    apiKey: "stored-key",
    baseUrl: "https://api.anthropic.com",
    apiMode: "messages"
  }]);
  assert.deepEqual(calls.providerSaves, [{
    provider: "anthropic",
    providerLabel: "Claude",
    authType: "api_key",
    apiKeyEnv: "ANTHROPIC_KEY",
    apiKey: "stored-key",
    baseUrl: "https://api.anthropic.com",
    apiMode: "messages"
  }]);
  assert.deepEqual(result, { runtime: true });
  assert.equal(calls.restarts, 0);
});

test("saveModelSelection restarts the engine only when a new api key is submitted", async () => {
  const { calls, service } = setup();

  const result = await service.saveModelSelection({
    provider: "openai",
    providerLabel: "OpenAI",
    model: "gpt-5.3",
    apiKey: "new-key",
    apiKeyEnv: "MIA_OPENAI_KEY"
  });

  assert.deepEqual(calls.modelWrites, [{
    provider: "openai",
    model: "gpt-5.3",
    apiKeyEnv: "MIA_OPENAI_KEY",
    apiKey: "new-key",
    baseUrl: "",
    apiMode: ""
  }]);
  assert.deepEqual(calls.providerSaves, [{
    provider: "openai",
    providerLabel: "OpenAI",
    authType: "api_key",
    apiKeyEnv: "MIA_OPENAI_KEY",
    apiKey: "new-key",
    baseUrl: "",
    apiMode: ""
  }]);
  assert.deepEqual(result, { restarted: true });
  assert.equal(calls.restarts, 1);
  assert.equal(calls.statuses, 0);
});

test("saveModelSelection preserves no-key lmstudio provider connections", async () => {
  const { calls, service } = setup();

  await service.saveModelSelection({
    provider: "lmstudio",
    providerLabel: "LM Studio",
    model: "local-model",
    baseUrl: "http://127.0.0.1:1234/v1"
  });

  assert.deepEqual(calls.providerSaves, [{
    provider: "lmstudio",
    providerLabel: "LM Studio",
    authType: "api_key",
    apiKeyEnv: "OPENAI_API_KEY",
    apiKey: "",
    baseUrl: "http://127.0.0.1:1234/v1",
    apiMode: ""
  }]);
});

test("saveModelSelection persists compact Mia-managed settings without transport defaults", async () => {
  const { calls, service } = setup();

  const result = await service.saveModelSelection({
    provider: "mia",
    providerConnectionId: "mia",
    providerLabel: "Mia",
    authType: "mia_account",
    model: "mia-auto",
    modelProfileId: "mia:mia-auto"
  });

  assert.deepEqual(calls.providerSaves, []);
  assert.deepEqual(calls.modelWrites, [{
    provider: "mia",
    providerConnectionId: "mia",
    providerLabel: "Mia",
    authType: "mia_account",
    model: "mia-auto",
    modelProfileId: "mia:mia-auto"
  }]);
  assert.equal("apiKeyEnv" in calls.modelWrites[0], false);
  assert.equal("apiKey" in calls.modelWrites[0], false);
  assert.equal("baseUrl" in calls.modelWrites[0], false);
  assert.equal("apiMode" in calls.modelWrites[0], false);
  assert.deepEqual(result, { runtime: true });
  assert.equal(calls.restarts, 0);
  assert.equal(calls.statuses, 1);
});

test("saveModelSelection treats profileless mia-auto as compact Mia-managed settings", async () => {
  const { calls, service } = setup();

  const result = await service.saveModelSelection({ model: "mia-auto" });

  assert.deepEqual(calls.providerSaves, []);
  assert.deepEqual(calls.modelWrites, [{
    provider: "mia",
    providerConnectionId: "mia",
    providerLabel: "Mia",
    authType: "mia_account",
    model: "mia-auto",
    modelProfileId: "mia:mia-auto"
  }]);
  assert.equal("apiKeyEnv" in calls.modelWrites[0], false);
  assert.equal("apiKey" in calls.modelWrites[0], false);
  assert.equal("baseUrl" in calls.modelWrites[0], false);
  assert.equal("apiMode" in calls.modelWrites[0], false);
  assert.deepEqual(result, { runtime: true });
  assert.equal(calls.restarts, 0);
  assert.equal(calls.statuses, 1);
});
