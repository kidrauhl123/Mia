const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  claudeMessageText,
  createClaudeCodeProcessSpawner,
  createClaudeCodeStatelessAdapter,
  normalizeClaudePermissionMode
} = require("../src/main/claude-code-stateless-adapter.js");

async function* streamOf(items) {
  for (const item of items) yield item;
}

function createDeps(messages, overrides = {}) {
  const calls = [];
  return {
    calls,
    appendEngineLog: () => {},
    chatCompletionResponse: () => {
      throw new Error("chatCompletionResponse should not run for stateless tests");
    },
    claudeAgentSdk: async () => ({
      query: (input) => {
        calls.push(["query", input]);
        if (typeof overrides.query === "function") return overrides.query(input, calls);
        return streamOf(messages);
      }
    }),
    cwd: () => "/repo",
    ensureClaudeBridgePlugin: () => ({ path: "/bridge", fingerprint: "fp1" }),
    expandLeadingSkillCommand: (text) => text,
    getAgentSessionEntry: () => ({}),
    getMcpFingerprint: () => "",
    getMiaAppMcpSpec: () => null,
    getSchedulerMcpSpec: () => null,
    getUserMcpSpecs: () => ({}),
    injectGroupContextForSdk: (prompt, contextBlock) => `GROUP:${contextBlock}\n${prompt}`,
    currentUserPrompt: () => "hello",
    normalizeEffortLevel: (level, engine) => `${engine}:${level}`,
    processEnvStrings: () => ({ PATH: "/bin" }),
    readBotPersona: () => "persona",
    resolveManagedModelRuntime: () => null,
    clearAgentSessionEntry: () => false,
    setAgentSessionEntry: () => {},
    shellCommandPath: (command) => command === "claude" ? "/bin/claude" : "",
    writeSchedulerMcpContext: () => {},
    ...overrides
  };
}

test("normalizeClaudePermissionMode preserves supported modes", () => {
  assert.equal(normalizeClaudePermissionMode("bypassPermissions"), "bypassPermissions");
  assert.equal(normalizeClaudePermissionMode(":danger-full-access"), "bypassPermissions");
  assert.equal(normalizeClaudePermissionMode("yolo"), "bypassPermissions");
  assert.equal(normalizeClaudePermissionMode("nope"), "default");
});

test("claudeMessageText extracts nested assistant text", () => {
  assert.equal(claudeMessageText({ message: { content: [{ text: "hi" }] } }), "hi");
  assert.equal(claudeMessageText({ delta: "chunk" }), "chunk");
});

test("createClaudeCodeStatelessAdapter exposes only stateless send", async () => {
  const adapter = createClaudeCodeStatelessAdapter(createDeps([
    { type: "assistant", message: { content: [{ text: "ok" }] } }
  ]));

  assert.equal(typeof adapter.sendStateless, "function");
  assert.equal("sendChat" in adapter, false);
});

test("sendStateless uses prompt without persona append or resume", async () => {
  const deps = createDeps([
    { type: "assistant", message: { content: [{ text: "stateless out" }] } }
  ]);
  const adapter = createClaudeCodeStatelessAdapter(deps);
  const response = await adapter.sendStateless({
    systemPrompt: "sys",
    userPrompt: "user",
    signal: null
  });

  const queryCall = deps.calls.find((call) => call[0] === "query")[1];
  assert.equal(queryCall.prompt, "sys\n\nuser");
  assert.deepEqual(queryCall.options.systemPrompt, { type: "preset", preset: "claude_code" });
  assert.equal(queryCall.options.resume, undefined);
  assert.deepEqual(response, { content: "stateless out" });
});

test("sendStateless dedupes progressive assistant snapshots", async () => {
  const adapter = createClaudeCodeStatelessAdapter(createDeps([
    { type: "assistant", message: { content: [{ text: "我先试试。" }] } },
    { type: "assistant", message: { content: [{ text: "我先试试。\n\n还是不行。" }] } }
  ]));

  const response = await adapter.sendStateless({
    systemPrompt: "sys",
    userPrompt: "user",
    signal: null
  });

  assert.deepEqual(response, { content: "我先试试。\n\n还是不行。" });
});

test("createClaudeCodeProcessSpawner runs direct executables hidden", () => {
  const spawnCalls = [];
  const fakeChild = {
    stdin: {},
    stdout: {},
    stderr: null,
    killed: false,
    exitCode: null,
    kill() {},
    on() {},
    once() {},
    off() {}
  };
  const spawner = createClaudeCodeProcessSpawner({
    platform: "win32",
    spawn: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return fakeChild;
    }
  });

  const child = spawner({
    command: "C:\\Program Files\\Claude\\claude.exe",
    args: ["--version"],
    cwd: "C:\\repo",
    env: { PATH: "C:\\Program Files\\Claude" }
  });

  assert.equal(child, fakeChild);
  assert.equal(spawnCalls[0].command, "C:\\Program Files\\Claude\\claude.exe");
  assert.deepEqual(spawnCalls[0].args, ["--version"]);
  assert.equal(spawnCalls[0].options.windowsHide, true);
});

test("createClaudeCodeProcessSpawner leaves non-Windows executables unwrapped", () => {
  const spawnCalls = [];
  const fakeChild = {
    stdin: {},
    stdout: {},
    stderr: null,
    killed: false,
    exitCode: null,
    kill() {},
    on() {},
    once() {},
    off() {}
  };
  const spawner = createClaudeCodeProcessSpawner({
    platform: "darwin",
    spawn: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return fakeChild;
    }
  });

  const child = spawner({
    command: "/opt/homebrew/bin/claude",
    args: ["--version"],
    cwd: "/repo",
    env: { PATH: "/opt/homebrew/bin" }
  });

  assert.equal(child, fakeChild);
  assert.equal(spawnCalls[0].command, "/opt/homebrew/bin/claude");
  assert.deepEqual(spawnCalls[0].args, ["--version"]);
  assert.equal(spawnCalls[0].options.windowsHide, undefined);
});
