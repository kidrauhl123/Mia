const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createEngineCatalogCoreAdapter,
  normalizeCapabilities
} = require("../src/main/engine-catalog-core-adapter.js");

test("engine catalog Core adapter maps legacy IPC methods to typed Rust Core routes", async () => {
  const calls = [];
  const adapter = createEngineCatalogCoreAdapter({
    coreRequest: async (request) => {
      calls.push(request);
      if (request.route === "/api/engines/model-catalog") return { models: [{ provider: "anthropic" }] };
      if (request.route === "/api/engines/codex/models") return { models: [{ slug: "gpt-test" }] };
      if (request.route === "/api/engines/capabilities") {
        return {
          approvalModes: ["ask"],
          effortLevels: ["low"],
          engines: { codex: { models: [{ slug: "gpt-test" }] } }
        };
      }
      if (request.route === "/api/engines/slash-commands") {
        return { commands: [{ command: "/goal", description: "Set goal" }] };
      }
      throw new Error(`unexpected route ${request.route}`);
    }
  });

  assert.deepEqual(await adapter.loadHermesModelCatalog(), [{ provider: "anthropic" }]);
  assert.deepEqual(await adapter.loadCodexModels(), [{ slug: "gpt-test" }]);
  assert.deepEqual(await adapter.loadEngineCapabilities(), {
    approvalModes: ["ask"],
    effortLevels: ["low"],
    engines: { codex: { models: [{ slug: "gpt-test" }] } }
  });
  assert.deepEqual(await adapter.loadHermesSlashCommands(), [{ command: "/goal", description: "Set goal" }]);
  assert.deepEqual(calls, [
    { method: "GET", route: "/api/engines/model-catalog" },
    { method: "GET", route: "/api/engines/codex/models" },
    { method: "GET", route: "/api/engines/capabilities" },
    { method: "GET", route: "/api/engines/slash-commands" }
  ]);
});

test("engine catalog Core adapter preserves empty capabilities for malformed Core replies", () => {
  assert.deepEqual(normalizeCapabilities({}), {
    approvalModes: [],
    effortLevels: [],
    engines: {}
  });
});
