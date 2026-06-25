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

test("requires Mia Cloud login for Mia managed profiles", () => {
  const resolver = createResolver({
    cloudStatus: () => ({ enabled: false, token: "", url: "" })
  });

  assert.throws(
    () => resolver.resolveModelRuntime({ modelProfileId: "mia:mia-auto", model: "mia-auto" }),
    /请先登录 Mia Cloud/
  );
});
