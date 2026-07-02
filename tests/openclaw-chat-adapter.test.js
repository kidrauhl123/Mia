const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const {
  buildOpenClawAcpArgs,
  buildOpenClawGlobalArgs
} = require("../src/main/agent-session/acp-engine-specs.js");
const {
  closeOpenClawAcpRuntimes,
  createOpenClawStatelessAdapter
} = require("../src/main/openclaw-chat-adapter.js");

function fakeChildProcess() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.emit("exit", null, "SIGTERM");
    return true;
  };
  return child;
}

function fakeAcpSdk(calls, overrides = {}) {
  class FakeClientSideConnection {
    constructor(toClient, stream) {
      calls.push(["acp-connect", Boolean(stream?.readable), Boolean(stream?.writable)]);
      this.handlers = toClient(this);
    }

    async initialize(params) {
      calls.push(["acp-initialize", params]);
      return overrides.initializeResult || {
        protocolVersion: 1,
        agentCapabilities: { promptCapabilities: { image: true } },
        agentInfo: { name: "openclaw-acp", version: "test" }
      };
    }

    async newSession(params) {
      calls.push(["acp-new-session", params]);
      return {
        sessionId: overrides.acpSessionId || "acp-session",
        configOptions: [],
        modes: { currentModeId: "adaptive", availableModes: [] }
      };
    }

    async setSessionMode(params) {
      calls.push(["acp-set-mode", params]);
      return {};
    }

    async prompt(params) {
      calls.push(["acp-prompt", params]);
      const reply = Object.prototype.hasOwnProperty.call(overrides, "reply") ? overrides.reply : "OpenClaw reply";
      await this.handlers.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: reply }
        }
      });
      return overrides.promptResponse || { stopReason: "end_turn" };
    }
  }

  return {
    ClientSideConnection: FakeClientSideConnection,
    PROTOCOL_VERSION: 1,
    ndJsonStream: (writable, readable) => ({ writable, readable })
  };
}

function createDeps(overrides = {}) {
  const calls = [];
  return {
    calls,
    appendEngineLog: (line) => calls.push(["log", line]),
    chatCompletionResponse: () => {
      throw new Error("chatCompletionResponse should not be used by stateless OpenClaw tests");
    },
    currentUserPrompt: () => "",
    cwd: () => "/tmp/mia-workspace",
    enginePermissionMode: () => "default",
    ensureUserMcpReady: async () => {},
    expandLeadingSkillCommand: (text) => text,
    getAgentSessionId: () => "",
    getMcpFingerprint: () => "",
    getUserMcpServers: () => [],
    injectGroupContextForSdk: (text) => text,
    normalizeEffortLevel: (level) => `normalized-${level}`,
    processEnvStrings: () => ({ PATH: "/usr/local/bin" }),
    readBotPersona: () => "",
    runtimePaths: () => ({ home: path.join(os.tmpdir(), "mia-openclaw-test-home") }),
    setAgentSessionId: () => {},
    shellCommandPath: (command) => (command === "openclaw" ? "/bin/openclaw" : ""),
    importAcpSdk: async () => fakeAcpSdk(calls, overrides),
    spawn: (file, args, options) => {
      calls.push(["spawn", file, args, options.cwd, options.env.PATH, options.windowsHide]);
      return fakeChildProcess();
    },
    execFile: (file, args, options, callback) => {
      let payload = options.input || "";
      const batchFileIndex = Array.isArray(args) ? args.indexOf("--batch-file") : -1;
      if (batchFileIndex >= 0 && args[batchFileIndex + 1]) {
        payload = fs.readFileSync(args[batchFileIndex + 1], "utf8");
      }
      calls.push(["exec", file, args, options.cwd, options.env.PATH, payload, options.windowsHide]);
      callback(null, overrides.stdout || JSON.stringify({ response: "OpenClaw reply", session_id: "oc-session" }), "");
      return { kill() {} };
    },
    ...overrides
  };
}

test("OpenClaw command builders support an isolated profile before the subcommand", () => {
  assert.deepEqual(buildOpenClawGlobalArgs({ openclawProfile: "mia" }), ["--profile", "mia"]);
  assert.deepEqual(buildOpenClawAcpArgs({
    engineConfig: {
      openclawProfile: "mia",
      openclawGatewayUrl: "ws://127.0.0.1:18789",
      openclawGatewayTokenFile: "/tmp/token"
    }
  }), [
    "--profile",
    "mia",
    "acp",
    "--no-prefix-cwd",
    "--url",
    "ws://127.0.0.1:18789",
    "--token-file",
    "/tmp/token"
  ]);
  assert.throws(() => buildOpenClawGlobalArgs({ openclawProfile: "../default" }), /profile 名称/);
});

test("stateless OpenClaw adapter export surface does not expose bot sendChat", () => {
  const adapter = createOpenClawStatelessAdapter(createDeps());
  assert.equal(typeof adapter.sendStateless, "function");
  assert.equal("sendChat" in adapter, false);
});

test("sendStateless runs OpenClaw through the ACP backend without a durable bot session", async (t) => {
  t.after(() => closeOpenClawAcpRuntimes());

  const deps = createDeps();
  const adapter = createOpenClawStatelessAdapter(deps);
  const response = await adapter.sendStateless({
    systemPrompt: "system prompt",
    userPrompt: "user prompt"
  });

  assert.deepEqual(response, { content: "OpenClaw reply" });
  const spawnCall = deps.calls.find((call) => call[0] === "spawn");
  assert.equal(spawnCall[1], "/bin/openclaw");
  assert.deepEqual(spawnCall[2].slice(0, 2), ["acp", "--no-prefix-cwd"]);
  assert.equal(spawnCall[2][2], "--session");
  assert.match(spawnCall[2][3], /^openclaw:mia:stateless:stateless-/);
  const promptCall = deps.calls.find((call) => call[0] === "acp-prompt");
  assert.equal(promptCall[1].prompt[0].text, "system prompt\n\nuser prompt");
  assert.equal(promptCall[1]._meta.prefixCwd, false);
});
