const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildAcpEngineSpecs,
  getAcpEngineSpec,
  spawnAcpEngineProcess
} = require("../src/main/agent-session/acp-engine-specs.js");

function specByEngineId(specs, engineId) {
  if (Array.isArray(specs)) {
    return specs.find((spec) => spec?.engineId === engineId) || null;
  }
  if (specs && typeof specs === "object") {
    return specs[engineId] || null;
  }
  return null;
}

test("buildAcpEngineSpecs does not invent Claude/Codex ACP launchers without managed runtimes", () => {
  const specs = buildAcpEngineSpecs();

  assert.ok(specs, "expected ACP engine specs");

  const claude = specByEngineId(specs, "claude");
  const codex = specByEngineId(specs, "codex");
  const hermes = specByEngineId(specs, "hermes");

  assert.equal(claude, null);
  assert.equal(codex, null);

  assert.deepEqual(hermes, {
    engineId: "hermes",
    transport: "acp",
    command: "hermes",
    args: ["acp"],
    supportsSteerInput: false,
    supportsQueuedInput: true
  });
  assert.equal(specByEngineId(specs, "openclaw"), null);
});

test("buildAcpEngineSpecs uses real managed runtimes for Claude and Codex", () => {
  const calls = [];
  const specs = buildAcpEngineSpecs({
    managedAgentRuntime: {
      resolve(engine, options) {
        calls.push({ engine, options });
        if (engine === "claude-code") {
          return {
            source: "managed",
            path: "/managed/claude-acp",
            command: "/managed/claude-acp",
            args: ["--stdio"],
            version: "claude-acp 0.39.0",
            protocol: "claude-code-cli"
          };
        }
        if (engine === "codex") {
          return {
            source: "managed",
            path: "/managed/codex-acp",
            command: "/managed/codex-acp",
            args: ["--stdio"],
            version: "codex-acp 1.1.0",
            protocol: "codex-app-server"
          };
        }
        return null;
      }
    }
  });

  assert.deepEqual(specByEngineId(specs, "claude"), {
    engineId: "claude",
    transport: "acp",
    command: "/managed/claude-acp",
    args: ["--stdio"],
    source: "managed",
    managed: true,
    runtimePath: "/managed/claude-acp",
    runtimeVersion: "claude-acp 0.39.0",
    runtimeProtocol: "claude-code-cli",
    supportsSteerInput: false,
    supportsQueuedInput: true
  });
  assert.deepEqual(specByEngineId(specs, "codex"), {
    engineId: "codex",
    transport: "acp",
    command: "/managed/codex-acp",
    args: ["--stdio"],
    source: "managed",
    managed: true,
    runtimePath: "/managed/codex-acp",
    runtimeVersion: "codex-acp 1.1.0",
    runtimeProtocol: "codex-app-server",
    supportsSteerInput: false,
    supportsQueuedInput: true
  });
  assert.deepEqual(calls.map((call) => call.engine), ["claude-code", "codex"]);
});

test("getAcpEngineSpec returns null for Claude without a managed runtime", () => {
  const spec = getAcpEngineSpec("claude");
  assert.equal(spec, null);
});

test("legacy Hermes discovery spec can use the resolved system executable", () => {
  const hermesPath = process.platform === "win32"
    ? "C:\\Users\\alice\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\hermes.exe"
    : "/Users/alice/.local/bin/hermes";
  const spec = getAcpEngineSpec("hermes", { hermesCommandPath: hermesPath });

  assert.equal(spec?.engineId, "hermes");
  assert.equal(spec?.command, hermesPath);
  assert.deepEqual(spec?.args, ["acp"]);
});

test("spawnAcpEngineProcess launches engine specs with Windows child options", () => {
  const spawnCalls = [];
  spawnAcpEngineProcess((file, args, options) => {
    spawnCalls.push({ file, args, options });
    return {};
  }, {
    engineId: "codex",
    command: "/managed/codex-acp",
    args: ["--stdio"]
  }, {
    stdio: ["pipe", "pipe", "inherit"]
  }, {
    platform: "win32"
  });

  assert.deepEqual(spawnCalls[0], {
    file: "/managed/codex-acp",
    args: ["--stdio"],
    options: {
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true
    }
  });
});
