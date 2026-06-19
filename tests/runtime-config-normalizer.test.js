const assert = require("node:assert/strict");
const { test } = require("node:test");

const { normalizeTurnRuntimeConfig } = require("../src/main/runtime-config-normalizer.js");

test("normalizeTurnRuntimeConfig preserves model provider metadata for Mia managed models", () => {
  assert.deepEqual(normalizeTurnRuntimeConfig({
    provider: "mia",
    provider_label: "Mia",
    auth_type: "mia_account",
    model: "mia-deepseek",
    model_profile_id: "mia:mia-deepseek",
    api_key_env: "MIA_CLOUD_MODEL_TOKEN",
    base_url: "https://mia.example/api/me/model-proxy/v1",
    api_mode: "chat_completions",
    effort_level: "medium",
    permission_mode: "ask",
    ignored: "value"
  }), {
    model: "mia-deepseek",
    provider: "mia",
    providerLabel: "Mia",
    authType: "mia_account",
    modelProfileId: "mia:mia-deepseek",
    apiKeyEnv: "MIA_CLOUD_MODEL_TOKEN",
    baseUrl: "https://mia.example/api/me/model-proxy/v1",
    apiMode: "chat_completions",
    effortLevel: "medium",
    permissionMode: "ask"
  });
});
