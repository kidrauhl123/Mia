const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createExternalAgentCommandService } = require("../src/main/external-agent-command-service.js");

function makeService(overrides = {}) {
  const calls = [];
  const service = createExternalAgentCommandService({
    agentCommandProvider: {
      agentCommandRoots: (_engine, projectPath) => [
        { namespace: "project", root: path.join(projectPath, ".claude", "commands") }
      ],
      loadExternalAgentCommands: async (input) => ({ rows: [{ command: "/resume" }], input })
    },
    cwd: () => "/repo",
    homeDir: () => "/home/alice",
    normalizeBotAgentEngine: (engine) => String(engine || "codex"),
    normalizeBotEngineConfig: (config = {}) => config,
    normalizeEffortLevel: (level) => String(level || "medium"),
    localAgentEngines: () => ({
      claudeCode: { path: "/bin/claude", version: "claude 1.2.3" },
      codex: { path: "/bin/codex", version: "codex 2.3.4" }
    }),
    getAgentSessionId: () => "",
    setAgentSessionId: (...args) => calls.push(["set-id", ...args]),
    setAgentSessionEntry: (...args) => calls.push(["set-entry", ...args]),
    ensureClaudeBridgePlugin: () => ({ fingerprint: "bridge_fp" }),
    loadAgentSessionMap: () => ({}),
    listExternalAgentSessions: () => [],
    sourceDeviceId: () => "device_1",
    ...overrides
  });
  return { service, calls };
}

test("executeCommand renders a custom command only from allowed command roots", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-agent-command-"));
  const projectPath = path.join(dir, "repo");
  const commandRoot = path.join(projectPath, ".claude", "commands");
  const commandPath = path.join(commandRoot, "review.md");
  fs.mkdirSync(commandRoot, { recursive: true });
  fs.writeFileSync(commandPath, [
    "---",
    "description: Review a target",
    "---",
    "Review $1 with $ARGUMENTS.",
    "Read @README.md and run !npm test."
  ].join("\n"));

  const { service } = makeService({
    agentCommandProvider: {
      agentCommandRoots: () => [{ namespace: "project", root: commandRoot }],
      loadExternalAgentCommands: async () => ({ rows: [] })
    }
  });

  const result = service.executeCommand({
    engine: "claude-code",
    commandName: "/review",
    args: ["src/main.js", "--fast"],
    commandPath,
    context: { projectPath }
  });

  assert.equal(result.type, "custom");
  assert.equal(result.command, "/review");
  assert.equal(result.content, "Review src/main.js with src/main.js --fast.\nRead @README.md and run !npm test.");
  assert.deepEqual(result.metadata, { description: "Review a target" });
  assert.equal(result.hasFileIncludes, true);
  assert.equal(result.hasBashCommands, true);
});

test("executeCommand rejects a custom command outside allowed command roots", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-agent-command-"));
  const projectPath = path.join(dir, "repo");
  const commandRoot = path.join(projectPath, ".claude", "commands");
  const outsidePath = path.join(dir, "outside.md");
  fs.mkdirSync(commandRoot, { recursive: true });
  fs.writeFileSync(outsidePath, "Outside command");

  const { service } = makeService({
    agentCommandProvider: {
      agentCommandRoots: () => [{ namespace: "project", root: commandRoot }],
      loadExternalAgentCommands: async () => ({ rows: [] })
    }
  });

  assert.throws(
    () => service.executeCommand({
      engine: "claude-code",
      commandName: "/outside",
      commandPath: outsidePath,
      context: { projectPath }
    }),
    /allowed \.claude\/commands/
  );
});

test("runSlashCommand reports external agent status from injected engine and session state", () => {
  const { service } = makeService({
    getAgentSessionId: () => "thread_1"
  });

  const result = service.runSlashCommand({
    text: "/status",
    engine: "codex",
    sessionId: "local_1",
    bot: {
      key: "alice",
      name: "Alice",
      engineConfig: { model: "gpt-5.1-codex", permissionMode: "never", effortLevel: "high" }
    }
  });

  assert.match(result, /Alice 使用 Codex 本地引擎/);
  assert.match(result, /模型：gpt-5\.1-codex/);
  assert.match(result, /推理强度：high/);
  assert.match(result, /权限：never/);
  assert.match(result, /CLI：\/bin\/codex/);
  assert.match(result, /版本：codex 2\.3\.4/);
  assert.match(result, /外部会话：thread_1/);
});

test("runSlashCommand lists Mia-bound external sessions before raw CLI history", () => {
  const candidateId = "22222222-2222-4333-8444-555555555555";
  const currentId = "11111111-2222-4333-8444-555555555555";
  const { service } = makeService({
    getAgentSessionId: () => currentId,
    loadAgentSessionMap: () => ({
      [`codex:alice:bot:u_1:alice`]: candidateId,
      [`codex:bob:local_3`]: "33333333-2222-4333-8444-555555555555"
    }),
    listExternalAgentSessions: () => [
      { id: candidateId, title: "Raw CLI title", preview: "raw", project: "/repo", updatedAt: 1 }
    ]
  });

  const result = service.runSlashCommand({
    text: "/resume",
    engine: "codex",
    sessionId: "local_1",
    bot: { key: "alice", name: "Alice" }
  });

  assert.equal(result.commandResult.type, "session-list");
  assert.equal(result.commandResult.sourceDeviceId, "device_1");
  assert.deepEqual(result.commandResult.rows, [
    {
      id: candidateId,
      title: "Mia 云端对话",
      preview: "Alice 的 Mia 对话 · /repo",
      project: "/repo",
      updatedAt: 1
    }
  ]);
});

test("runSlashCommand binds resume ids through the engine-specific session writer", () => {
  const nextId = "44444444-2222-4333-8444-555555555555";
  const { service, calls } = makeService();

  const result = service.runSlashCommand({
    text: `/resume ${nextId}`,
    engine: "claude-code",
    sessionId: "local_1",
    bot: { key: "alice", name: "Alice" }
  });

  assert.match(result, new RegExp(nextId));
  assert.deepEqual(calls, [["set-entry", "claude-code", "alice", "local_1", nextId, "bridge_fp"]]);
});
