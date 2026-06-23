const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { test } = require("node:test");

const {
  choicesFromHelp,
  createEngineCatalogService,
  normalizeOpenClawModels
} = require("../src/main/engine-catalog-service.js");
const { createCodexAppServerConnection } = require("../src/main/codex-app-server-runner.js");
const { createSchedulerMcpBridge } = require("../src/main/scheduler-mcp-bridge.js");

function createHarness(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-engine-catalog-"));
  const engine = path.join(dir, "engine");
  const home = path.join(dir, "home");
  const hermesHome = path.join(dir, ".hermes");
  const userHome = path.join(dir, "user");
  fs.mkdirSync(engine, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(hermesHome, { recursive: true });
  fs.mkdirSync(userHome, { recursive: true });
  const calls = { python: [], logs: [], timed: [] };
  const service = createEngineCatalogService({
    isEngineInstalled: () => true,
    initializeRuntime: () => {},
    runtimePaths: () => ({ engine, home, hermesHome }),
    userHome: () => userHome,
    effectiveHermesHome: () => hermesHome,
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
  return { calls, dir, engine, home, hermesHome, userHome, service };
}

test("loadHermesModelCatalog returns fallback without running Python when engine is missing", async () => {
  const { calls, service } = createHarness({ isEngineInstalled: () => false });

  const rows = await service.loadHermesModelCatalog();

  assert.equal(rows[0].provider, "openai-codex");
  assert.equal(rows.some((row) => row.provider === "anthropic"), true);
  assert.equal(calls.python.length, 0);
});

test("loadHermesModelCatalog parses rows from the Hermes runtime and logs fallback failures", async () => {
  const { calls, service, engine, hermesHome } = createHarness({
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
  assert.equal(calls.python[0].options.env.HERMES_HOME, hermesHome);
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
      "claude-code": {
        available: false,
        cliPath: "",
        models: [],
        currentModel: "",
        currentEffortLevel: "",
        effortLevels: [],
        effortOptions: [],
        permissionModes: [],
        permissionOptions: [],
        source: "claude-code",
        error: ""
      },
      codex: { models: [], effortLevels: [], effortOptions: [], permissionProfiles: [] },
      openclaw: {
        available: false,
        cliPath: "",
        models: [],
        effortLevels: [],
        effortOptions: [],
        permissionModes: ["default", "acceptEdits", "readOnly", "bypassPermissions"],
        permissionOptions: [
          { value: "default", label: "Ask", title: "OpenClaw 通过 Mia 权限弹窗逐次确认工具调用。", source: "mia-acp-adapter" },
          { value: "acceptEdits", label: "Edits", title: "OpenClaw 自动接受编辑类工具调用，其他危险操作仍按规则处理。", source: "mia-acp-adapter" },
          { value: "readOnly", label: "Read", title: "OpenClaw 只读模式。", source: "mia-acp-adapter" },
          { value: "bypassPermissions", label: "YOLO", title: "OpenClaw 自动允许工具调用，只在完全信任时使用。", source: "mia-acp-adapter" }
        ],
        permissionSource: "mia-acp-adapter",
        source: "openclaw",
        error: ""
      }
    }
  });
  assert.deepEqual(await service.loadHermesSlashCommands(), [{ command: "/goal", description: "Set goal" }]);
});

test("choicesFromHelp parses Claude Code and OpenClaw CLI choice text", () => {
  const help = `
  --model <model>            Model alias such as 'fable', 'opus', 'sonnet' or model's full name (e.g. 'claude-fable-5')
  --effort <level>           Reasoning effort (choices: low, medium, high, xhigh, max)
  --permission-mode <mode>   Permission mode: "acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"
  --thinking <level>         Thinking level: off | minimal | low | medium | high
                             | xhigh | adaptive | max where supported
`;

  assert.deepEqual(choicesFromHelp(help, "--effort"), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(choicesFromHelp(help, "--permission-mode"), ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"]);
  assert.deepEqual(choicesFromHelp(help, "--thinking"), ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max"]);
});

test("normalizeOpenClawModels accepts current models list JSON shape", () => {
  assert.deepEqual(normalizeOpenClawModels({
    count: 4,
    models: [
      { key: "openai/gpt-5.5", name: "gpt-5.5", contextWindow: 200000, available: false, tags: ["default"], missing: false },
      { key: "missing/model", name: "Missing", missing: true },
      { key: "mia/mia-auto", name: "Auto", contextWindow: 200000, available: true, missing: false },
      { key: "openai/gpt-5.6", name: "gpt-5.6", contextWindow: 200000, available: true, tags: ["default"], missing: false }
    ]
  }), [{
    id: "openai/gpt-5.6",
    provider: "openclaw",
    providerLabel: "OpenClaw",
    model: "openai/gpt-5.6",
    label: "gpt-5.6",
    source: "openclaw-models-list",
    description: "",
    available: true,
    contextWindow: 200000,
    tags: ["default"]
  }]);
});

test("loadEngineCapabilities probes Claude Code SDK settings and CLI help", async () => {
  const execCalls = [];
  const { service } = createHarness({
    shellCommandPath: (command) => command === "claude" ? "/opt/claude-node/bin/claude" : "",
    processEnvStrings: () => ({ PATH: "/bad-node/bin:/usr/bin:/opt/claude-node/bin" }),
    claudeAgentSdk: async () => ({
      resolveSettings: async () => ({ effective: { model: "opus[1m]", effortLevel: "high" } })
    }),
    execFile: (file, args, options, callback) => {
      execCalls.push({ file, args, options });
      callback(null, `
  --model <model>            Model alias such as 'fable', 'opus', 'sonnet' or model's full name (e.g. 'claude-fable-5')
  --effort <level>           Reasoning effort (choices: low, medium, high, xhigh, max)
  --permission-mode <mode>   Permission mode: "acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"
`, "");
    }
  });

  const caps = await service.loadEngineCapabilities();
  const claude = caps.engines["claude-code"];

  assert.equal(execCalls[0].file, "/opt/claude-node/bin/claude");
  assert.deepEqual(execCalls[0].args, ["--help"]);
  assert.equal(execCalls[0].options.env.PATH, "/opt/claude-node/bin:/bad-node/bin:/usr/bin");
  assert.equal(claude.available, true);
  assert.equal(claude.currentModel, "opus[1m]");
  assert.equal(claude.currentEffortLevel, "high");
  assert.deepEqual(claude.effortLevels, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(claude.permissionModes, ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"]);
  assert.equal(claude.models[0].model, "opus[1m]");
  assert.equal(claude.models.some((entry) => entry.model === "sonnet"), true);
  assert.equal(claude.models.some((entry) => entry.model === "claude-fable-5"), true);
  assert.equal(claude.models.some((entry) => entry.model.includes("full name")), false);
});

test("loadEngineCapabilities probes OpenClaw models and thinking levels from the CLI", async () => {
  const execCalls = [];
  const { service } = createHarness({
    shellCommandPath: (command) => command === "openclaw" ? "/opt/openclaw-node/bin/openclaw" : "",
    processEnvStrings: () => ({ PATH: "/bad-node/bin:/usr/bin:/opt/openclaw-node/bin" }),
    execFile: (file, args, options, callback) => {
      execCalls.push({ file, args, options });
      if (args.join(" ") === "agent --help") {
        callback(null, `
  --thinking <level>         Thinking level: off | minimal | low | medium | high
                             | xhigh | adaptive | max where supported
`, "");
        return;
      }
      callback(null, JSON.stringify({
        models: [{ key: "openai/gpt-5.6", name: "gpt-5.6", contextWindow: 200000, available: true, tags: ["default"] }]
      }), "");
    }
  });

  const caps = await service.loadEngineCapabilities();
  const openclaw = caps.engines.openclaw;

  assert.deepEqual(execCalls.map((call) => call.args), [["agent", "--help"], ["models", "list", "--json"]]);
  assert.deepEqual(execCalls.map((call) => call.options.env.PATH), [
    "/opt/openclaw-node/bin:/bad-node/bin:/usr/bin",
    "/opt/openclaw-node/bin:/bad-node/bin:/usr/bin"
  ]);
  assert.equal(openclaw.available, true);
  assert.deepEqual(openclaw.effortLevels, ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max"]);
  assert.deepEqual(openclaw.permissionModes, ["default", "acceptEdits", "readOnly", "bypassPermissions"]);
  assert.equal(openclaw.models[0].model, "openai/gpt-5.6");
});

test("loadEngineCapabilities falls back to OpenClaw dev help only for thinking levels", async () => {
  const execCalls = [];
  const { service } = createHarness({
    shellCommandPath: (command) => command === "openclaw" ? "/opt/openclaw-node/bin/openclaw" : "",
    processEnvStrings: () => ({ PATH: "/bad-node/bin:/usr/bin:/opt/openclaw-node/bin" }),
    execFile: (file, args, options, callback) => {
      execCalls.push({ file, args, options });
      if (args.join(" ") === "agent --help") {
        const error = new Error("bad config");
        error.code = 1;
        callback(error, "", "invalid config");
        return;
      }
      if (args.join(" ") === "--dev agent --help") {
        callback(null, "  --thinking <level>         Thinking level: off | minimal | adaptive | max where supported\n", "");
        return;
      }
      const error = new Error("bad config");
      error.code = 1;
      callback(error, "", "invalid config");
    }
  });

  const caps = await service.loadEngineCapabilities();
  const openclaw = caps.engines.openclaw;

  assert.deepEqual(execCalls.map((call) => call.args), [
    ["agent", "--help"],
    ["--dev", "agent", "--help"],
    ["models", "list", "--json"]
  ]);
  assert.deepEqual(openclaw.effortLevels, ["off", "minimal", "adaptive", "max"]);
  assert.deepEqual(openclaw.models, []);
  assert.match(openclaw.error, /models-list/);
});

test("loadEngineCapabilities probes Codex app-server models and permission profiles", async () => {
  const requests = [];
  const ensureCodexHomeCalls = [];
  const { service } = createHarness({
    shellCommandPath: (command) => command === "codex" ? "/bin/codex" : "",
    processEnvStrings: () => ({ PATH: "/bin" }),
    ensureCodexHome: (options) => {
      ensureCodexHomeCalls.push(options);
      return "/tmp/codex-home";
    },
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

  assert.deepEqual(ensureCodexHomeCalls, [{ syncSchedulerMcp: false }]);
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

test("loadEngineCapabilities uses a Mia-owned probe CODEX_HOME and does not create native .codex", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-codex-probe-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = {
    runtime: path.join(dir, "runtime"),
    engine: path.join(dir, "runtime", "hermes-engine"),
    home: path.join(dir, "runtime", "engine-home")
  };
  const userHome = path.join(dir, "user-home");
  const schedulerScriptPath = path.join(dir, "fixtures", "scheduler-mcp-server.js");
  fs.mkdirSync(runtime.engine, { recursive: true });
  fs.mkdirSync(runtime.home, { recursive: true });
  fs.mkdirSync(userHome, { recursive: true });
  fs.mkdirSync(path.dirname(schedulerScriptPath), { recursive: true });
  fs.writeFileSync(schedulerScriptPath, "console.log('scheduler');\n");

  const schedulerBridge = createSchedulerMcpBridge({
    runtimePaths: () => runtime,
    daemonStatus: () => ({ baseUrl: "http://127.0.0.1:27861" }),
    daemonSettings: () => ({ host: "127.0.0.1", port: 27861 }),
    daemonToken: () => "token_1",
    nodePath: () => process.execPath,
    serverScriptPath: () => schedulerScriptPath,
    homeDir: () => userHome
  });

  const spawnCalls = [];
  const spawn = (command, args, options) => {
    spawnCalls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdin = {
      destroyed: false,
      write(line) {
        const request = JSON.parse(line);
        if (request.method === "initialize") {
          queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result: { ok: true } }) + "\n"));
          return;
        }
        if (request.method === "model/list") {
          queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result: { data: [] } }) + "\n"));
          return;
        }
        if (request.method === "permissionProfile/list") {
          queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result: { data: [] } }) + "\n"));
        }
      }
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      child.stdout.end();
      child.stderr.end();
      child.emit("exit", 0, null);
    };
    return child;
  };

  const service = createEngineCatalogService({
    isEngineInstalled: () => true,
    initializeRuntime: () => {},
    runtimePaths: () => runtime,
    userHome: () => userHome,
    effectiveHermesHome: () => runtime.home,
    buildPythonPath: () => "/pythonpath",
    runPythonScript: async () => ({ status: 0, stdout: "[]", stderr: "" }),
    appendEngineLog: () => {},
    timeEngineStepAsync: async (_label, fn) => fn(),
    shellCommandPath: (command) => command === "codex" ? "/opt/codex/bin/codex" : "",
    processEnvStrings: () => ({ PATH: "/usr/bin" }),
    ensureCodexHome: schedulerBridge.ensureCodexHome,
    createCodexAppServerConnection: (options) => createCodexAppServerConnection({ ...options, spawn })
  });

  const caps = await service.loadEngineCapabilities();
  const nativeCodexHome = path.join(userHome, ".codex");
  const probeCodexHome = path.join(runtime.runtime, "codex-probe-home");

  assert.equal(caps.engines.codex.models.length, 0);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, "/opt/codex/bin/codex");
  assert.equal(spawnCalls[0].options.env.CODEX_HOME, probeCodexHome);
  assert.equal(spawnCalls[0].options.env.PATH, "/opt/codex/bin:/usr/bin");
  assert.notEqual(spawnCalls[0].options.env.CODEX_HOME, nativeCodexHome);
  assert.equal(fs.existsSync(probeCodexHome), true);
  assert.equal(fs.existsSync(nativeCodexHome), false);
  assert.equal(fs.existsSync(path.join(nativeCodexHome, "config.toml")), false);
});
