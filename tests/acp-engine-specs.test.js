const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildAcpEngineSpecs,
  execFileAsync,
  getAcpEngineSpec,
  openClawCommandSpec,
  spawnOpenClaw
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
  const openclaw = specByEngineId(specs, "openclaw");

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
    args: ["-y", "@zed-industries/codex-acp@0.14.0"],
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

  assert.equal(openclaw?.engineId, "openclaw");
  assert.equal(openclaw?.transport, "acp");
  assert.equal(openclaw?.supportsSteerInput, false);
  assert.equal(openclaw?.supportsQueuedInput, true);
  assert.equal(openclaw?.command, "openclaw");
  assert.ok(Array.isArray(openclaw?.args), "expected OpenClaw args");
  assert.ok(openclaw.args.length > 0, "expected OpenClaw args");
});

test("getAcpEngineSpec returns a single engine spec by id", () => {
  const spec = getAcpEngineSpec("claude");
  assert.equal(spec?.engineId, "claude");
  assert.equal(spec?.command, "npx");
  assert.deepEqual(spec?.args, ["-y", "@agentclientprotocol/claude-agent-acp@0.39.0"]);
});

test("openClawCommandSpec resolves Windows shell shims to the bundled OpenClaw script when present", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-engine-specs-"));
  try {
    const shimPath = path.join(tempDir, "openclaw.cmd");
    const scriptPath = path.join(tempDir, "node_modules", "openclaw", "openclaw.mjs");
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, "export default {};", "utf8");

    const spec = openClawCommandSpec(shimPath, ["acp", "--no-prefix-cwd"], {
      platform: "win32",
      nodePath: "/custom/node"
    });

    assert.deepEqual(spec, {
      file: "/custom/node",
      args: [scriptPath, "acp", "--no-prefix-cwd"]
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("execFileAsync and spawnOpenClaw use the shared OpenClaw command resolution", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-engine-specs-"));
  try {
    const shimPath = path.join(tempDir, "openclaw.cmd");
    const scriptPath = path.join(tempDir, "node_modules", "openclaw", "openclaw.mjs");
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, "export default {};", "utf8");

    const execCalls = [];
    await execFileAsync((file, args, options, callback) => {
      execCalls.push({ file, args, options });
      callback(null, "ok", "");
      return { stdin: { end() {} }, kill() {} };
    }, shimPath, ["acp"], {}, { platform: "win32", nodePath: "/custom/node" });

    assert.deepEqual(execCalls[0], {
      file: "/custom/node",
      args: [scriptPath, "acp"],
      options: { windowsHide: true }
    });

    const spawnCalls = [];
    spawnOpenClaw((file, args, options) => {
      spawnCalls.push({ file, args, options });
      return {};
    }, shimPath, ["acp"], {}, { platform: "win32", nodePath: "/custom/node" });

    assert.deepEqual(spawnCalls[0], {
      file: "/custom/node",
      args: [scriptPath, "acp"],
      options: { windowsHide: true }
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
