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

test("buildAcpEngineSpecs ports the built-in AION ACP launch specs", () => {
  const specs = buildAcpEngineSpecs();

  assert.ok(specs, "expected ACP engine specs");

  const claude = specByEngineId(specs, "claude");
  const codex = specByEngineId(specs, "codex");
  const hermes = specByEngineId(specs, "hermes");

  assert.deepEqual(claude, {
    engineId: "claude",
    transport: "acp",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.39.0"],
    supportsSteerInput: false,
    supportsQueuedInput: true
  });

  assert.deepEqual(codex, {
    engineId: "codex",
    transport: "acp",
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp@1.1.0"],
    supportsSteerInput: false,
    supportsQueuedInput: true
  });

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

test("getAcpEngineSpec returns a single engine spec by id", () => {
  const spec = getAcpEngineSpec("claude");
  assert.equal(spec?.engineId, "claude");
  assert.equal(spec?.command, "npx");
  assert.deepEqual(spec?.args, ["-y", "@agentclientprotocol/claude-agent-acp@0.39.0"]);
});

test("Hermes ACP spec can use the resolved system Hermes executable", () => {
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
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp@1.1.0"]
  }, {
    stdio: ["pipe", "pipe", "inherit"]
  }, {
    platform: "win32"
  });

  assert.deepEqual(spawnCalls[0], {
    file: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp@1.1.0"],
    options: {
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true
    }
  });
});
