const assert = require("node:assert/strict");
const { test } = require("node:test");

const { normalizeTurnRuntimeConfig } = require("../src/main/runtime-config-normalizer.js");

test("normalizeTurnRuntimeConfig prefers Core profile references", () => {
  assert.deepEqual(normalizeTurnRuntimeConfig({
    provider_connection_id: "mia",
    model_profile_id: "mia:mia-auto",
    model: "mia-auto",
    agent_engine: "openclaw",
    device_id: "mac-1",
    device_name: "MacBook Pro",
    effort_level: "medium",
    permission_mode: "ask",
    base_url: "https://renderer-should-not-own-this.example",
    api_key_env: "RENDERER_SHOULD_NOT_OWN_THIS",
    ignored: "value"
  }), {
    agentEngine: "openclaw",
    deviceId: "mac-1",
    deviceName: "MacBook Pro",
    providerConnectionId: "mia",
    modelProfileId: "mia:mia-auto",
    model: "mia-auto",
    effortLevel: "medium",
    permissionMode: "ask"
  });
});
