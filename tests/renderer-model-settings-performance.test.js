const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");

test("model settings reuse the compact runtime-control request across one runtime snapshot", () => {
  const source = fs.readFileSync(path.join(root, "src/renderer/settings/model-settings.js"), "utf8");
  const runtimeControl = require("../src/shared/bot-runtime-control");
  const runtime = {
    user: { avatarImage: `data:image/png;base64,${"a".repeat(2_640_000)}` },
    model: { provider: "openai-codex", model: "gpt-5" },
    permissions: { engines: { codex: ":danger-full-access" } }
  };
  const engineConfig = { model: "gpt-5", effortLevel: "medium" };
  const modelCatalog = [{ id: "openai-codex::gpt-5", provider: "openai-codex", model: "gpt-5" }];
  const state = {
    runtime,
    modelCatalog,
    platformModels: [],
    engineCapabilities: {},
    codexModels: []
  };
  let stringifyCalls = 0;
  let requestCalls = 0;
  const contextJson = {
    parse: JSON.parse,
    stringify(...args) {
      stringifyCalls += 1;
      return JSON.stringify(...args);
    }
  };
  const window = {
    miaBotRuntimeControl: runtimeControl,
    miaRequestBackoff: {
      createRequestBackoff: () => ({ canRun: () => true, fail: () => {}, succeed: () => {} })
    },
    miaEngineOptions: {
      activeAgentEngine: () => "codex",
      engineConfigForPersona: () => engineConfig
    },
    miaModelHelpers: { catalogEntries: () => modelCatalog },
    mia: {
      getSettingsRuntimeControlOptions: () => {
        requestCalls += 1;
        return new Promise(() => {});
      }
    }
  };
  vm.runInContext(source, vm.createContext({ window, JSON: contextJson, console }));
  window.miaModelSettings.initModelSettings({
    state,
    els: {},
    escapeHtml: String,
    setText: () => {},
    updateModelFieldVisibility: () => {},
    render: () => {}
  });

  const request = window.miaModelSettings.runtimeControlOptionsRequest(runtime);
  assert.equal(Object.hasOwn(request.runtime, "user"), false);
  assert.equal(JSON.stringify(request).length < 2_000, true);

  for (let index = 0; index < 10; index += 1) {
    window.miaModelSettings.runtimeControlOptions(runtime);
  }

  assert.equal(stringifyCalls, 1, "the cache key should be serialized once for a stable runtime snapshot");
  assert.equal(requestCalls, 1, "the in-flight Core request should remain deduplicated");
});
