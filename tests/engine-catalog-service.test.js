const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createEngineCatalogService } = require("../src/main/engine-catalog-service.js");

function createHarness(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-engine-catalog-"));
  const engine = path.join(dir, "engine");
  const home = path.join(dir, "home");
  const userHome = path.join(dir, "user");
  fs.mkdirSync(engine, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(userHome, { recursive: true });
  const calls = { python: [], logs: [], timed: [] };
  const service = createEngineCatalogService({
    isEngineInstalled: () => true,
    initializeRuntime: () => {},
    runtimePaths: () => ({ engine, home }),
    userHome: () => userHome,
    effectiveHermesHome: () => home,
    buildPythonPath: () => "/pythonpath",
    runPythonScript: async (args, options) => {
      calls.python.push({ args, options });
      return { status: 0, stdout: "[]", stderr: "" };
    },
    appendEngineLog: (line) => calls.logs.push(line),
    timeEngineStepAsync: async (label, fn) => {
      calls.timed.push(label);
      return fn();
    },
    ...overrides
  });
  return { calls, dir, engine, home, userHome, service };
}

test("loadHermesModelCatalog returns fallback without running Python when engine is missing", async () => {
  const { calls, service } = createHarness({ isEngineInstalled: () => false });

  const rows = await service.loadHermesModelCatalog();

  assert.equal(rows[0].provider, "openai-codex");
  assert.equal(rows.some((row) => row.provider === "anthropic"), true);
  assert.equal(calls.python.length, 0);
});

test("loadHermesModelCatalog parses rows from the Hermes runtime and logs fallback failures", async () => {
  const { calls, service, engine, home } = createHarness({
    runPythonScript: async (args, options) => {
      calls.python.push({ args, options });
      return {
        status: 0,
        stdout: JSON.stringify([{ id: "p::m", provider: "p", providerLabel: "P", model: "m", label: "M" }]),
        stderr: ""
      };
    }
  });

  const rows = await service.loadHermesModelCatalog();

  assert.deepEqual(rows, [{ id: "p::m", provider: "p", providerLabel: "P", model: "m", label: "M" }]);
  assert.equal(calls.timed[0], "Load Hermes model catalog");
  assert.equal(calls.python[0].options.cwd, engine);
  assert.equal(calls.python[0].options.env.HERMES_HOME, home);
  assert.equal(calls.python[0].options.env.PYTHONPATH, "/pythonpath");
});

test("loadCodexModels reads the Codex cache, filters hidden rows, and sorts by priority", () => {
  const { service, userHome } = createHarness();
  const cachePath = path.join(userHome, ".codex", "models_cache.json");
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify({
    models: [
      { slug: "hidden", display_name: "Hidden", priority: 1, visibility: "hide" },
      { slug: "z-model", display_name: "Zed", priority: 20 },
      { slug: "a-model", priority: 2 }
    ]
  }));

  assert.deepEqual(service.loadCodexModels(), [
    { slug: "a-model", displayName: "a-model", priority: 2 },
    { slug: "z-model", displayName: "Zed", priority: 20 }
  ]);
});

test("loadEngineCapabilities and loadHermesSlashCommands parse runtime output with fallbacks", async () => {
  const { service } = createHarness({
    runPythonScript: async (args) => {
      const script = String(args[1] || "");
      if (script.includes("SETTINGS_SCHEMA")) {
        return { status: 0, stdout: JSON.stringify({ approvalModes: ["ask"], effortLevels: ["low", "high"] }), stderr: "" };
      }
      return { status: 0, stdout: JSON.stringify([{ command: "goal", description: "Set goal" }]), stderr: "" };
    }
  });

  assert.deepEqual(await service.loadEngineCapabilities(), { approvalModes: ["ask"], effortLevels: ["low", "high"] });
  assert.deepEqual(await service.loadHermesSlashCommands(), [{ command: "/goal", description: "Set goal" }]);
});
