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
      {
        slug: "z-model",
        display_name: "Zed",
        priority: 20,
        default_reasoning_level: "high",
        supported_reasoning_levels: [{ effort: "low", description: "Fast" }, { effort: "high" }]
      },
      { slug: "a-model", priority: 2 }
    ]
  }));

  assert.deepEqual(service.loadCodexModels(), [
    { slug: "a-model", displayName: "a-model", description: "", priority: 2, defaultReasoningLevel: "", supportedReasoningLevels: [] },
    {
      slug: "z-model",
      displayName: "Zed",
      description: "",
      priority: 20,
      defaultReasoningLevel: "high",
      supportedReasoningLevels: [{ effort: "low", description: "Fast" }, { effort: "high", description: "" }]
    }
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

  assert.deepEqual(await service.loadEngineCapabilities(), {
    approvalModes: ["ask"],
    effortLevels: ["low", "high"],
    engines: {
      hermes: { approvalModes: ["ask"], effortLevels: ["low", "high"] },
      codex: { models: [], effortLevels: [], effortOptions: [], permissionProfiles: [] }
    }
  });
  assert.deepEqual(await service.loadHermesSlashCommands(), [{ command: "/goal", description: "Set goal" }]);
});

test("loadEngineCapabilities probes Codex app-server models and permission profiles", async () => {
  const requests = [];
  const { service } = createHarness({
    shellCommandPath: (command) => command === "codex" ? "/bin/codex" : "",
    processEnvStrings: () => ({ PATH: "/bin" }),
    ensureCodexHome: () => "/tmp/codex-home",
    createCodexAppServerConnection: ({ codexPath, env }) => {
      requests.push(["connect", codexPath, env]);
      return {
        close: () => requests.push(["close"]),
        request: async (method, params) => {
          requests.push(["request", method, params]);
          if (method === "model/list") {
            return {
              data: [{
                id: "gpt-test",
                model: "gpt-test",
                displayName: "GPT Test",
                hidden: false,
                defaultReasoningEffort: "medium",
                supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }, { reasoningEffort: "medium" }]
              }]
            };
          }
          if (method === "permissionProfile/list") {
            return { data: [{ id: ":workspace", description: null }, { id: ":read-only", description: "Read files only" }] };
          }
          return {};
        }
      };
    }
  });

  const caps = await service.loadEngineCapabilities();

  assert.equal(requests[0][1], "/bin/codex");
  assert.equal(requests[0][2].CODEX_HOME, "/tmp/codex-home");
  assert.deepEqual(caps.engines.codex.models, [{
    slug: "gpt-test",
    displayName: "GPT Test",
    description: "",
    priority: 0,
    defaultReasoningLevel: "medium",
    supportedReasoningLevels: [{ effort: "low", description: "Fast" }, { effort: "medium", description: "" }]
  }]);
  assert.deepEqual(caps.engines.codex.effortLevels, ["low", "medium"]);
  assert.deepEqual(caps.engines.codex.permissionProfiles, [
    { id: ":workspace", description: null },
    { id: ":read-only", description: "Read files only" }
  ]);
});
