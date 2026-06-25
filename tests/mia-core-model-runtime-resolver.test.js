const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  createMiaCoreModelRuntimeResolver,
  isMiaManagedRuntime
} = require("../src/main/mia-core/model-runtime-resolver.js");

function createResolver(overrides = {}) {
  return createMiaCoreModelRuntimeResolver({
    cloudStatus: () => ({ enabled: true, token: "cloud-token", url: "https://mia.example/" }),
    normalizeCloudUrl: (value) => String(value || "").replace(/\/+$/, ""),
    providerConnection: (id) => {
      if (id === "deepseek") {
        return {
          provider: "deepseek",
          providerLabel: "DeepSeek",
          authType: "api_key",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          apiKey: "deepseek-token",
          baseUrl: "https://api.deepseek.com/v1",
          apiMode: "chat_completions"
        };
      }
      if (id === "deepseek-team") {
        return {
          provider: "deepseek",
          providerLabel: "DeepSeek Team",
          authType: "api_key",
          apiKeyEnv: "DEEPSEEK_TEAM_API_KEY",
          apiKey: "deepseek-team-token",
          baseUrl: "https://team.deepseek.example/v1",
          apiMode: "chat_completions"
        };
      }
      return null;
    },
    modelSettings: () => ({ provider: "deepseek", model: "deepseek-chat" }),
    ...overrides
  });
}

test("resolves profileless mia-auto binding through Mia Cloud", () => {
  const resolver = createResolver();

  const runtime = resolver.resolveModelRuntime({ model: "mia-auto" }, { engine: "hermes" });

  assert.equal(runtime.provider, "mia");
  assert.equal(runtime.providerConnectionId, "mia");
  assert.equal(runtime.model, "mia-auto");
  assert.equal(runtime.modelProfileId, "mia:mia-auto");
  assert.equal(runtime.apiKey, "cloud-token");
  assert.equal(runtime.baseUrl, "https://mia.example/api/me/model-proxy/v1");
  assert.equal(runtime.anthropicBaseUrl, "https://mia.example/api/me/model-proxy");
  assert.equal(runtime.managedByMia, true);
  assert.equal(isMiaManagedRuntime(runtime), true);
});

test("resolves provider connection references without renderer credentials", () => {
  const resolver = createResolver();

  const runtime = resolver.resolveModelRuntime({
    providerConnectionId: "deepseek",
    model: "deepseek-chat",
    modelProfileId: "deepseek:deepseek-chat"
  }, { engine: "hermes" });

  assert.deepEqual(runtime, {
    provider: "deepseek",
    providerConnectionId: "deepseek",
    providerLabel: "DeepSeek",
    authType: "api_key",
    model: "deepseek-chat",
    modelProfileId: "deepseek:deepseek-chat",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    apiKey: "deepseek-token",
    baseUrl: "https://api.deepseek.com/v1",
    apiMode: "chat_completions",
    managedByMia: false,
    source: "mia-core"
  });
});

test("returns null for native codex default model", () => {
  const resolver = createResolver();

  assert.equal(resolver.resolveModelRuntime({
    providerConnectionId: "codex",
    model: ""
  }, { engine: "codex" }), null);
});

test("returns null for native codex default model when provider id is openai-codex", () => {
  const resolver = createResolver();

  assert.equal(resolver.resolveModelRuntime({
    providerConnectionId: "openai-codex",
    model: ""
  }, { engine: "codex" }), null);
});

test("requires Mia Cloud login for Mia managed profiles", () => {
  const resolver = createResolver({
    cloudStatus: () => ({ enabled: false, token: "", url: "" })
  });

  assert.throws(
    () => resolver.resolveModelRuntime({ modelProfileId: "mia:mia-auto", model: "mia-auto" }),
    /请先登录 Mia Cloud/
  );
});

test("preserves stable providerConnectionId when provider kind differs", () => {
  const resolver = createResolver();

  const runtime = resolver.resolveModelRuntime({
    providerConnectionId: "deepseek-team",
    model: "deepseek-chat"
  }, { engine: "hermes" });

  assert.equal(runtime.provider, "deepseek");
  assert.equal(runtime.providerConnectionId, "deepseek-team");
  assert.equal(runtime.modelProfileId, "deepseek-team:deepseek-chat");
});

test("fails explicitly when a referenced provider connection is missing", () => {
  const resolver = createResolver();

  assert.throws(
    () => resolver.resolveModelRuntime({
      providerConnectionId: "missing-provider",
      model: "missing-model"
    }, { engine: "hermes" }),
    /Provider connection missing-provider is not available/
  );
  assert.throws(
    () => resolver.resolveModelRuntime({
      providerConnectionId: "missing-provider",
      model: "mia-auto"
    }, { engine: "hermes" }),
    /Provider connection missing-provider is not available/
  );
  assert.throws(
    () => resolver.resolveModelRuntime({
      modelProfileId: "missing-provider:mia-auto",
      model: "mia-auto"
    }, { engine: "hermes" }),
    /Provider connection missing-provider is not available/
  );
});

test("resolveMiaManagedModelSettings returns compact managed references only", () => {
  const resolver = createResolver();

  const settings = resolver.resolveMiaManagedModelSettings({
    provider: "mia",
    model: "mia-auto",
    apiKeyEnv: "SHOULD_BE_STRIPPED",
    apiKey: "should-be-stripped",
    baseUrl: "https://should-not-persist.example/v1",
    apiMode: "responses"
  });

  assert.deepEqual(settings, {
    provider: "mia",
    providerConnectionId: "mia",
    providerLabel: "Mia",
    authType: "mia_account",
    model: "mia-auto",
    modelProfileId: "mia:mia-auto"
  });
  assert.equal("apiKeyEnv" in settings, false);
  assert.equal("apiKey" in settings, false);
  assert.equal("baseUrl" in settings, false);
  assert.equal("apiMode" in settings, false);
});

test("resolveMiaManagedModelSettings does not require cloud login", () => {
  const resolver = createResolver({
    cloudStatus: () => ({ enabled: false, token: "", url: "" })
  });

  const settings = resolver.resolveMiaManagedModelSettings({ model: "mia-auto" });

  assert.deepEqual(settings, {
    provider: "mia",
    providerConnectionId: "mia",
    providerLabel: "Mia",
    authType: "mia_account",
    model: "mia-auto",
    modelProfileId: "mia:mia-auto"
  });
});
